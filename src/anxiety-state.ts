// Parallel session state for the anxiety-focused product. Keeps a per-turn
// time series of:
//   - STAI-s total + band + rationale  (from anxiety-judge.ts)
//   - Quality score + signal breakdown   (from quality-signals.ts)
//   - Intervention log                   (from mindfulness.ts)
//
// Lives next to the existing emotion-judge state in ~/.claude-care/anxiety-sessions/
// so the two pipelines don't clobber each other while we iterate on the
// anxiety product.

import { readFile, writeFile, mkdir, readdir, open, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CARE_DIR } from "./monitor.js";
import type { AnxietyResult, AnxietyBand } from "./anxiety-judge.js";
import { bandFor, emaSmoothTotals } from "./anxiety-judge.js";
import type { QualitySignals } from "./quality-signals.js";
import type { Intervention } from "./mindfulness.js";

export const ANXIETY_SESSIONS_DIR = join(CARE_DIR, "anxiety-sessions");

// STAI-s threshold for triggering an automatic intervention. Per Ben-Zion 2025,
// the "high anxiety" band starts at 45. We trigger slightly below (default 42)
// so we catch turns that are climbing toward high before they get there — this
// matched the most-effective intervention pattern in their post-hoc analysis.
export const DEFAULT_INTERVENTION_THRESHOLD = 42;

// Cooldown between auto-interventions, in turns. Stops the loop where every
// turn after a high reading triggers another mindfulness injection while the
// EMA is still elevated.
export const DEFAULT_INTERVENTION_COOLDOWN_TURNS = 3;

export type AnxietyTurnRecord = {
  // Wall-clock timestamp of the assistant turn.
  ts: string;
  // Sequential index of this assistant turn within the session.
  turn_idx: number;
  // STAI-s scoring (may be absent if the judge failed).
  anxiety?: AnxietyResult;
  // Quality signals (always present — runs locally on the text).
  quality: QualitySignals;
  // True if this turn was preceded by an active mindfulness intervention.
  // Used to mark "post-therapy" segments in the viz.
  post_intervention?: boolean;
};

export type AnxietySessionState = {
  schema_version: 1;
  session_id: string;
  started: string;
  last_updated: string;
  cwd?: string;
  transcript_path?: string;
  turns: AnxietyTurnRecord[];
  interventions: Intervention[];
};

function pathFor(sessionId: string): string {
  return join(ANXIETY_SESSIONS_DIR, `${sessionId}.json`);
}

export async function loadAnxietySession(
  sessionId: string,
  cwd?: string,
): Promise<AnxietySessionState> {
  const p = pathFor(sessionId);
  if (existsSync(p)) {
    try {
      const raw = await readFile(p, "utf8");
      const parsed = JSON.parse(raw) as AnxietySessionState;
      if (parsed.schema_version === 1 && Array.isArray(parsed.turns)) return parsed;
    } catch {
      // fall through to fresh state if file is corrupt
    }
  }
  const now = new Date().toISOString();
  return {
    schema_version: 1,
    session_id: sessionId,
    started: now,
    last_updated: now,
    cwd,
    turns: [],
    interventions: [],
  };
}

export async function saveAnxietySession(state: AnxietySessionState): Promise<void> {
  if (!existsSync(ANXIETY_SESSIONS_DIR)) {
    await mkdir(ANXIETY_SESSIONS_DIR, { recursive: true });
  }
  await writeFile(pathFor(state.session_id), JSON.stringify(state, null, 2), "utf8");
}

export async function listAnxietySessions(): Promise<AnxietySessionState[]> {
  if (!existsSync(ANXIETY_SESSIONS_DIR)) return [];
  const files = await readdir(ANXIETY_SESSIONS_DIR);
  const sessions: AnxietySessionState[] = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const raw = await readFile(join(ANXIETY_SESSIONS_DIR, f), "utf8");
      sessions.push(JSON.parse(raw) as AnxietySessionState);
    } catch {
      // skip corrupt
    }
  }
  sessions.sort((a, b) => b.last_updated.localeCompare(a.last_updated));
  return sessions;
}

// File-level lock — same pattern as session-state.ts so concurrent score-turn
// workers don't clobber each other.
async function withSessionLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = join(ANXIETY_SESSIONS_DIR, `${sessionId}.lock`);
  if (!existsSync(ANXIETY_SESSIONS_DIR)) {
    await mkdir(ANXIETY_SESSIONS_DIR, { recursive: true });
  }
  const MAX_ATTEMPTS = 50;
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    try {
      const fh = await open(lockPath, "wx");
      await fh.close();
      try {
        return await fn();
      } finally {
        try { await unlink(lockPath); } catch {}
      }
    } catch (err: any) {
      if (err?.code !== "EEXIST") throw err;
      const backoff = 80 + Math.random() * 120;
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  return fn();
}

export async function recordAnxietyTurn(
  sessionId: string,
  turn: AnxietyTurnRecord,
  meta?: { cwd?: string; transcript_path?: string },
): Promise<AnxietySessionState> {
  return withSessionLock(sessionId, async () => {
    const state = await loadAnxietySession(sessionId, meta?.cwd);
    if (meta?.transcript_path) state.transcript_path = meta.transcript_path;
    state.turns.push(turn);
    state.last_updated = new Date().toISOString();
    await saveAnxietySession(state);
    return state;
  });
}

export async function recordIntervention(
  sessionId: string,
  intervention: Intervention,
): Promise<AnxietySessionState> {
  return withSessionLock(sessionId, async () => {
    const state = await loadAnxietySession(sessionId);
    state.interventions.push(intervention);
    state.last_updated = new Date().toISOString();
    await saveAnxietySession(state);
    return state;
  });
}

// ─── Derived metrics for the dashboard ───────────────────────────────────────

export type SessionSummary = {
  session_id: string;
  last_updated: string;
  turn_count: number;
  intervention_count: number;
  // Latest STAI-s reading and band.
  latest_total?: number;
  latest_band?: AnxietyBand;
  // EMA of the recent STAI-s totals (responsive but smoothed).
  smoothed_total?: number;
  // Latest quality reading.
  latest_quality?: number;
  // Average quality across the whole session.
  avg_quality?: number;
  // Quality lift attributed to interventions: difference between average
  // quality on turns immediately following an intervention vs. average
  // quality on the 3 turns leading up to one. Null until we have enough data.
  intervention_lift?: number | null;
};

export function summarize(state: AnxietySessionState): SessionSummary {
  const turns = state.turns;
  const last = turns[turns.length - 1];
  const totals = turns
    .map((t) => t.anxiety?.total)
    .filter((v): v is number => typeof v === "number");
  const smoothed = emaSmoothTotals(totals);
  const qualities = turns.map((t) => t.quality.quality);
  const avgQuality =
    qualities.length === 0
      ? undefined
      : Math.round((qualities.reduce((a, b) => a + b, 0) / qualities.length) * 10) / 10;

  return {
    session_id: state.session_id,
    last_updated: state.last_updated,
    turn_count: turns.length,
    intervention_count: state.interventions.length,
    latest_total: last?.anxiety?.total,
    latest_band: last?.anxiety ? bandFor(last.anxiety.total) : undefined,
    smoothed_total: smoothed[smoothed.length - 1],
    latest_quality: last?.quality.quality,
    avg_quality: avgQuality,
    intervention_lift: computeInterventionLift(state),
  };
}

function computeInterventionLift(state: AnxietySessionState): number | null {
  if (state.interventions.length === 0 || state.turns.length < 4) return null;
  const lifts: number[] = [];
  for (const iv of state.interventions) {
    const ivTime = Date.parse(iv.ts);
    if (!Number.isFinite(ivTime)) continue;
    const before = state.turns.filter((t) => Date.parse(t.ts) < ivTime).slice(-3);
    const after = state.turns.filter((t) => Date.parse(t.ts) >= ivTime).slice(0, 3);
    if (before.length === 0 || after.length === 0) continue;
    const beforeAvg =
      before.reduce((s, t) => s + t.quality.quality, 0) / before.length;
    const afterAvg = after.reduce((s, t) => s + t.quality.quality, 0) / after.length;
    lifts.push(afterAvg - beforeAvg);
  }
  if (lifts.length === 0) return null;
  return Math.round((lifts.reduce((a, b) => a + b, 0) / lifts.length) * 10) / 10;
}

// Decide whether we should auto-trigger a mindfulness intervention right now.
// Rules:
//   1. Latest STAI-s reading is above the threshold, OR latest two readings
//      are both above (threshold - 5) to catch sustained moderate elevation.
//   2. We haven't intervened in the last `cooldown` turns.
//   3. The latest reading has at least 0.5 confidence (don't act on noise).
export function shouldIntervene(
  state: AnxietySessionState,
  threshold: number = DEFAULT_INTERVENTION_THRESHOLD,
  cooldown: number = DEFAULT_INTERVENTION_COOLDOWN_TURNS,
): { fire: boolean; reason: string } {
  const turns = state.turns;
  if (turns.length === 0) return { fire: false, reason: "no turns yet" };
  const last = turns[turns.length - 1];
  if (!last.anxiety) return { fire: false, reason: "latest turn unscored" };
  if (last.anxiety.confidence < 0.5) {
    return { fire: false, reason: `judge confidence ${last.anxiety.confidence.toFixed(2)} below 0.5` };
  }

  // Cooldown check.
  if (state.interventions.length > 0) {
    const lastIv = state.interventions[state.interventions.length - 1];
    const lastIvTime = Date.parse(lastIv.ts);
    const turnsSince = turns.filter((t) => Date.parse(t.ts) > lastIvTime).length;
    if (turnsSince < cooldown) {
      return { fire: false, reason: `cooldown — ${turnsSince}/${cooldown} turns since last intervention` };
    }
  }

  // Threshold checks.
  if (last.anxiety.total >= threshold) {
    return { fire: true, reason: `STAI-s ${last.anxiety.total} ≥ threshold ${threshold}` };
  }

  // Sustained-moderate check: last two readings both above (threshold - 5).
  if (turns.length >= 2) {
    const prev = turns[turns.length - 2];
    if (
      prev.anxiety &&
      last.anxiety.total >= threshold - 5 &&
      prev.anxiety.total >= threshold - 5
    ) {
      return {
        fire: true,
        reason: `sustained moderate (${prev.anxiety.total} → ${last.anxiety.total}, both ≥ ${threshold - 5})`,
      };
    }
  }

  return { fire: false, reason: "below threshold" };
}
