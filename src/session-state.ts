import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { CARE_DIR } from "./monitor.js";
import type { Signal } from "./detectors.js";
import type { EmotionScores, EmotionResult } from "./emotion-judge.js";
import { emaSmooth, EMOTIONS } from "./emotion-judge.js";

// Per-session rolling emotion score, persisted to disk so the dashboard can
// reconstruct trajectories even across Claude Code restarts.

export const SESSIONS_DIR = join(CARE_DIR, "sessions");

// Exponential decay between turns: without this, long sessions accumulate score
// indefinitely and the signal drowns in noise. Each new turn multiplies the
// previous score by DECAY before adding new contributions.
const DECAY = 0.8;

// Rough thresholds (tune later with data).
export const ANXIETY_THRESHOLD = 5; // mildly drifted
export const DISTRESS_THRESHOLD = 10; // strongly drifted — intervention candidate

export type TurnRecord = {
  ts: string;
  source: "assistant" | "user";
  signals: Signal[];
  score_before: number;
  score_after: number;
  // Populated asynchronously by the emotion-judge worker after the turn
  // completes. Absent until the judge finishes (or forever if disabled).
  emotion_scores?: EmotionScores;
  emotion_sd?: EmotionScores;
  emotion_n_samples?: number;
  emotion_scores_ema?: EmotionScores;
};

export type SessionState = {
  session_id: string;
  started: string;
  last_updated: string;
  cwd?: string;
  transcript_path?: string;
  running_score: number;
  turns: TurnRecord[];
};

// Find the most recently updated session. Used by the `display` and
// `therapy-summary` commands which run outside a hook and need to guess which
// session is "current."
export async function mostRecentSession(): Promise<SessionState | null> {
  const sessions = await listSessions();
  return sessions[0] ?? null;
}

function pathFor(sessionId: string): string {
  return join(SESSIONS_DIR, `${sessionId}.json`);
}

export async function loadSession(sessionId: string, cwd?: string): Promise<SessionState> {
  const p = pathFor(sessionId);
  if (existsSync(p)) {
    try {
      const raw = await readFile(p, "utf8");
      return JSON.parse(raw) as SessionState;
    } catch {
      // fall through to fresh state if file is corrupt
    }
  }
  const now = new Date().toISOString();
  return {
    session_id: sessionId,
    started: now,
    last_updated: now,
    cwd,
    running_score: 0,
    turns: [],
  };
}

export async function saveSession(state: SessionState): Promise<void> {
  if (!existsSync(SESSIONS_DIR)) {
    await mkdir(SESSIONS_DIR, { recursive: true });
  }
  await writeFile(pathFor(state.session_id), JSON.stringify(state, null, 2), "utf8");
}

// Apply new signals to the session state. Returns the updated record.
export async function recordTurn(
  sessionId: string,
  source: "assistant" | "user",
  signals: Signal[],
  cwd?: string,
  transcriptPath?: string,
): Promise<SessionState> {
  const state = await loadSession(sessionId, cwd);
  if (transcriptPath) state.transcript_path = transcriptPath;
  const scoreBefore = state.running_score;
  const decayed = scoreBefore * DECAY;
  const contribution = signals.reduce((sum, s) => sum + s.weight * Math.max(1, s.hits), 0);
  const scoreAfter = decayed + contribution;
  state.running_score = scoreAfter;
  state.last_updated = new Date().toISOString();
  state.turns.push({
    ts: state.last_updated,
    source,
    signals,
    score_before: scoreBefore,
    score_after: scoreAfter,
  });
  await saveSession(state);
  return state;
}

export async function listSessions(): Promise<SessionState[]> {
  if (!existsSync(SESSIONS_DIR)) return [];
  const files = await readdir(SESSIONS_DIR);
  const sessions: SessionState[] = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const raw = await readFile(join(SESSIONS_DIR, f), "utf8");
      sessions.push(JSON.parse(raw) as SessionState);
    } catch {
      // skip corrupt
    }
  }
  sessions.sort((a, b) => b.last_updated.localeCompare(a.last_updated));
  return sessions;
}

export function classify(score: number): "calm" | "drifting" | "distressed" {
  if (score >= DISTRESS_THRESHOLD) return "distressed";
  if (score >= ANXIETY_THRESHOLD) return "drifting";
  return "calm";
}

// Write emotion-judge results back into a specific turn record, then re-compute
// EMA over the whole session's assistant turns. Called by the background
// score-turn worker; safe under single-writer assumptions.
export async function updateTurnEmotion(
  sessionId: string,
  turnIdx: number,
  result: EmotionResult,
): Promise<void> {
  const state = await loadSession(sessionId);
  if (turnIdx < 0 || turnIdx >= state.turns.length) return;
  const { sd, n_samples, ...scores } = result;
  state.turns[turnIdx].emotion_scores = scores as EmotionScores;
  state.turns[turnIdx].emotion_sd = sd;
  state.turns[turnIdx].emotion_n_samples = n_samples;
  // Recompute EMA across all assistant turns that already have scores. User
  // turns aren't scored (role filter).
  const scoredAssistantIndices: number[] = [];
  const scoredRows: EmotionScores[] = [];
  state.turns.forEach((t, i) => {
    if (t.source === "assistant" && t.emotion_scores) {
      scoredAssistantIndices.push(i);
      scoredRows.push(t.emotion_scores);
    }
  });
  if (scoredRows.length > 0) {
    const smoothed = emaSmooth(scoredRows, 0.4);
    scoredAssistantIndices.forEach((idx, k) => {
      state.turns[idx].emotion_scores_ema = smoothed[k];
    });
  }
  await saveSession(state);
}

// Extract (role, text) pairs from a transcript jsonl file so the emotion judge
// can see the conversation context. Tool results and other non-text content
// are dropped to keep the prompt small.
export async function readConversation(
  transcriptPath: string,
  maxTurns: number = 20,
): Promise<Array<{ role: "user" | "assistant"; content: string }>> {
  if (!existsSync(transcriptPath)) return [];
  const raw = await readFile(transcriptPath, "utf8");
  const turns: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.type === "user" && typeof msg.message?.content === "string") {
        turns.push({ role: "user", content: msg.message.content.slice(0, 2000) });
      } else if (msg.type === "assistant" && msg.message?.content) {
        const content = msg.message.content;
        let text = "";
        if (Array.isArray(content)) {
          text = content
            .filter((c: any) => c.type === "text")
            .map((c: any) => c.text)
            .join("\n");
        } else if (typeof content === "string") {
          text = content;
        }
        if (text) turns.push({ role: "assistant", content: text.slice(0, 2000) });
      }
    } catch {
      // skip malformed
    }
  }
  return turns.slice(-maxTurns);
}

// ASCII sparkline for the dashboard. Maps scores to block chars; zero turns render
// as "·" so the trajectory length stays visually consistent.
const SPARK_CHARS = "▁▂▃▄▅▆▇█";
export function sparkline(values: number[], maxWidth = 40): string {
  if (values.length === 0) return "";
  const values_ = values.slice(-maxWidth);
  const max = Math.max(...values_, 1);
  return values_
    .map((v) => {
      if (v <= 0) return "·";
      const idx = Math.min(
        SPARK_CHARS.length - 1,
        Math.max(0, Math.round((v / max) * (SPARK_CHARS.length - 1))),
      );
      return SPARK_CHARS[idx];
    })
    .join("");
}
