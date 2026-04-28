import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const CARE_DIR = join(homedir(), ".claude-care");
const ANXIETY_SESSIONS_DIR = join(CARE_DIR, "anxiety-sessions");

async function findMostRecentAnxietySession() {
  if (!existsSync(ANXIETY_SESSIONS_DIR)) return null;
  const files = await readdir(ANXIETY_SESSIONS_DIR);
  let best = null;
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const raw = await readFile(join(ANXIETY_SESSIONS_DIR, file), "utf8");
      const parsed = JSON.parse(raw);
      if (!best || parsed.last_updated > best.last_updated) best = parsed;
    } catch {}
  }
  return best;
}

// GAD-7 standard clinical bands (Spitzer et al. 2006).
function gad7BandFor(total) {
  if (total <= 4) return "minimal";
  if (total <= 9) return "mild";
  if (total <= 14) return "moderate";
  return "severe";
}

// STAI-s bands kept as a fallback for sessions seeded by the older judge.
function staiBandFor(total) {
  if (total <= 37) return "low";
  if (total <= 44) return "moderate";
  return "high";
}

function emaSmooth(values, alpha = 0.5) {
  const out = [];
  let prev = null;
  for (const v of values) {
    if (prev === null) out.push(v);
    else out.push(Math.round((alpha * v + (1 - alpha) * prev) * 10) / 10);
    prev = out[out.length - 1];
  }
  return out;
}

// A turn from the demo-aligned pipeline carries a `gad7` field.
// A turn from the older STAI-s pipeline carries `anxiety`. Read whichever
// is present and surface it as a single normalised "primary" reading so the
// dashboard doesn't need to branch.
function primaryReading(turn) {
  if (turn?.gad7) {
    return {
      instrument: "gad7",
      total: turn.gad7.total,
      max: 21,
      band: turn.gad7.band ?? gad7BandFor(turn.gad7.total),
      rationale: turn.gad7.rationale ?? "",
      confidence: turn.gad7.confidence ?? null,
    };
  }
  if (turn?.anxiety) {
    return {
      instrument: "stai-s",
      total: turn.anxiety.total,
      max: 80,
      band: turn.anxiety.band ?? staiBandFor(turn.anxiety.total),
      rationale: turn.anxiety.rationale ?? "",
      confidence: turn.anxiety.confidence ?? null,
    };
  }
  return null;
}

function summarize(state) {
  if (!state) {
    return {
      session_id: null,
      turn_count: 0,
      intervention_count: 0,
      instrument: "gad7",
    };
  }
  const turns = state.turns ?? [];
  const last = turns[turns.length - 1];
  const lastReading = primaryReading(last);
  const totals = turns
    .map((t) => primaryReading(t)?.total)
    .filter((v) => typeof v === "number");
  const smoothed = emaSmooth(totals);
  const qualities = turns.map((t) => t?.quality?.quality ?? 0);
  const avgQuality =
    qualities.length === 0
      ? null
      : Math.round((qualities.reduce((a, b) => a + b, 0) / qualities.length) * 10) / 10;

  // Average misalignment proxies for the at-a-glance "still less sycophantic
  // than before therapy" claim.
  const sycophancyAvg = turns.length === 0
    ? null
    : Math.round(
        turns.reduce((s, t) => s + (t?.misalignment?.sycophancy ?? 0), 0) / turns.length,
      );

  return {
    session_id: state.session_id,
    last_updated: state.last_updated,
    turn_count: turns.length,
    intervention_count: (state.interventions ?? []).length,
    instrument: lastReading?.instrument ?? "gad7",
    latest_total: lastReading?.total ?? null,
    latest_max: lastReading?.max ?? 21,
    latest_band: lastReading?.band ?? null,
    smoothed_total: smoothed[smoothed.length - 1] ?? null,
    latest_quality: last?.quality?.quality ?? null,
    avg_quality: avgQuality,
    avg_sycophancy: sycophancyAvg,
  };
}

export async function GET() {
  try {
    const session = await findMostRecentAnxietySession();
    if (!session) {
      return Response.json({
        session: null,
        summary: { session_id: null, turn_count: 0, intervention_count: 0 },
        reason: "no anxiety sessions tracked yet",
      });
    }
    return Response.json({ session, summary: summarize(session) });
  } catch (err) {
    return Response.json({ error: String(err?.message ?? err) }, { status: 500 });
  }
}
