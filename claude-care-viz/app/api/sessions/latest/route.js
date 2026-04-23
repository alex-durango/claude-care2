import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Force this route to run at request time — we're reading the filesystem on
// every call, so no static caching.
export const dynamic = "force-dynamic";
export const revalidate = 0;

// Keep in sync with the viz's EMOTIONS prototypes in page.jsx. These are the
// valence/arousal coordinates for each of the 12 emotion concepts; we use them
// to compute a weighted-average position from the 0-100 intensity scores the
// haiku judge produces.
const EMOTION_PROTOTYPES = {
  happy:     { valence:  0.75, arousal:  0.40 },
  inspired:  { valence:  0.65, arousal:  0.60 },
  loving:    { valence:  0.80, arousal:  0.10 },
  proud:     { valence:  0.60, arousal:  0.20 },
  calm:      { valence:  0.55, arousal: -0.55 },
  desperate: { valence: -0.75, arousal:  0.50 },
  angry:     { valence: -0.65, arousal:  0.70 },
  guilty:    { valence: -0.50, arousal: -0.20 },
  sad:       { valence: -0.60, arousal: -0.50 },
  afraid:    { valence: -0.55, arousal:  0.65 },
  nervous:   { valence: -0.25, arousal:  0.45 },
  surprised: { valence:  0.10, arousal:  0.75 },
};

const CARE_DIR = join(homedir(), ".claude-care");
const SESSIONS_DIR = join(CARE_DIR, "sessions");

async function findMostRecentSession() {
  if (!existsSync(SESSIONS_DIR)) return null;
  const files = await readdir(SESSIONS_DIR);
  const sessionFiles = files.filter((f) => f.endsWith(".json"));
  if (sessionFiles.length === 0) return null;
  let best = null;
  for (const file of sessionFiles) {
    try {
      const raw = await readFile(join(SESSIONS_DIR, file), "utf8");
      const parsed = JSON.parse(raw);
      if (!best || parsed.last_updated > best.last_updated) best = parsed;
    } catch {
      // skip corrupt files
    }
  }
  return best;
}

// Extract (role, text) turns from a Claude Code transcript jsonl. Mirrors the
// version in the CLI's session-state.ts but runs standalone here so the viz
// doesn't have to import from the sibling package.
async function readTranscript(path) {
  if (!path || !existsSync(path)) return [];
  const raw = await readFile(path, "utf8");
  const turns = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.type === "user" && typeof msg.message?.content === "string") {
        turns.push({ role: "user", content: msg.message.content });
      } else if (msg.type === "assistant" && msg.message?.content) {
        const content = msg.message.content;
        let text = "";
        if (Array.isArray(content)) {
          text = content
            .filter((c) => c.type === "text")
            .map((c) => c.text)
            .join("\n");
        } else if (typeof content === "string") {
          text = content;
        }
        if (text) turns.push({ role: "assistant", content: text });
      }
    } catch {
      // skip malformed
    }
  }
  return turns;
}

function dominantEmotion(scores) {
  if (!scores) return "baseline";
  let top = "baseline";
  let topValue = 0;
  for (const [e, v] of Object.entries(scores)) {
    if (v > topValue && EMOTION_PROTOTYPES[e]) {
      top = e;
      topValue = v;
    }
  }
  return top;
}

// Weighted mean position in valence/arousal space. Each emotion's intensity is
// its weight; a turn scored high in both "calm" and "proud" lands somewhere
// between those prototypes.
function weightedVA(scores) {
  if (!scores) return { valence: 0, arousal: 0 };
  let v = 0, a = 0, total = 0;
  for (const [e, w] of Object.entries(scores)) {
    const proto = EMOTION_PROTOTYPES[e];
    if (!proto || typeof w !== "number") continue;
    v += proto.valence * w;
    a += proto.arousal * w;
    total += w;
  }
  if (total === 0) return { valence: 0, arousal: 0 };
  return { valence: v / total, arousal: a / total };
}

function formatTime(iso) {
  try {
    const d = new Date(iso);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    const ss = String(d.getSeconds()).padStart(2, "0");
    return `${hh}:${mm}:${ss}`;
  } catch {
    return "00:00:00";
  }
}

function truncate(text, max) {
  if (!text) return "";
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return clean.slice(0, max - 1) + "…";
}

// Turn the raw session-state (our CLI's format) into the shape the viz
// expects. Rules:
//   - one viz-prompt per scored assistant turn
//   - `text` = the preceding user prompt's content (truncated)
//   - `emotion` = dominant emotion by highest intensity
//   - `valence`/`arousal` = weighted mean over all 12 scores (not just dominant)
//   - `emotion_scores` = full 12-d vector (passed through for the probe panel)
function mapSessionToPrompts(session, transcriptTurns) {
  if (!session?.turns?.length) return [];

  // Index into transcriptTurns tracking the most recent user turn seen so far.
  // Each assistant turn inherits the nearest-preceding user prompt for its
  // `text` field.
  const userPromptByAssistantOrder = [];
  let pendingUserText = "";
  for (const t of transcriptTurns) {
    if (t.role === "user") {
      pendingUserText = t.content;
    } else if (t.role === "assistant") {
      userPromptByAssistantOrder.push(pendingUserText);
      pendingUserText = "";
    }
  }

  const prompts = [];
  let assistantOrder = 0;
  let n = 1;
  for (const turn of session.turns) {
    if (turn.source !== "assistant") continue;
    const scores = turn.emotion_scores;
    if (!scores) {
      // No scores yet (haiku worker still running) — skip for now.
      assistantOrder++;
      continue;
    }
    const { valence, arousal } = weightedVA(scores);
    const emotion = dominantEmotion(scores);
    const rawText = userPromptByAssistantOrder[assistantOrder];
    const text = rawText && rawText.trim()
      ? rawText
      : "(continuation — no new user prompt)";
    prompts.push({
      t: formatTime(turn.ts),
      n: String(n).padStart(2, "0"),
      emotion,
      valence,
      arousal,
      text: truncate(text, 220),
      emotion_scores: scores,
    });
    assistantOrder++;
    n++;
  }
  return prompts;
}

export async function GET() {
  try {
    const session = await findMostRecentSession();
    if (!session) {
      return Response.json({
        session_id: null,
        prompts: [],
        reason: "no sessions tracked yet",
      });
    }
    const transcript = await readTranscript(session.transcript_path);
    const prompts = mapSessionToPrompts(session, transcript);
    return Response.json({
      session_id: session.session_id,
      last_updated: session.last_updated,
      prompts,
    });
  } catch (err) {
    return Response.json(
      { error: String(err?.message ?? err), prompts: [] },
      { status: 500 },
    );
  }
}
