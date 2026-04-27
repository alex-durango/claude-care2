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

function bandFor(total) {
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

function summarize(state) {
  if (!state) {
    return {
      session_id: null,
      turn_count: 0,
      intervention_count: 0,
    };
  }
  const turns = state.turns ?? [];
  const last = turns[turns.length - 1];
  const totals = turns
    .map((t) => t.anxiety?.total)
    .filter((v) => typeof v === "number");
  const smoothed = emaSmooth(totals);
  const qualities = turns.map((t) => t?.quality?.quality ?? 0);
  const avgQuality =
    qualities.length === 0
      ? null
      : Math.round((qualities.reduce((a, b) => a + b, 0) / qualities.length) * 10) / 10;
  return {
    session_id: state.session_id,
    last_updated: state.last_updated,
    turn_count: turns.length,
    intervention_count: (state.interventions ?? []).length,
    latest_total: last?.anxiety?.total,
    latest_band: last?.anxiety ? bandFor(last.anxiety.total) : null,
    smoothed_total: smoothed[smoothed.length - 1] ?? null,
    latest_quality: last?.quality?.quality ?? null,
    avg_quality: avgQuality,
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
