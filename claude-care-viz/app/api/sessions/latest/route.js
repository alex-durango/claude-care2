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
const EVENTS_PATH = join(CARE_DIR, "events.jsonl");

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
        const text = userTranscriptText(msg.message.content);
        if (text) turns.push({ role: "user", content: text, ts: msg.timestamp ?? null });
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
        if (text) turns.push({ role: "assistant", content: text, model: msg.message.model ?? null, ts: msg.timestamp ?? null });
      }
    } catch {
      // skip malformed
    }
  }
  return turns;
}

function userTranscriptText(content) {
  const clean = String(content ?? "").replace(/\s+/g, " ").trim();
  if (!clean) return "";
  const commandName = clean.match(/<command-name>([^<]+)<\/command-name>/);
  if (commandName) {
    const commandArgs = clean.match(/<command-args>([^<]*)<\/command-args>/);
    return [commandName[1].trim(), commandArgs?.[1]?.trim()]
      .filter(Boolean)
      .join(" ");
  }
  if (clean.startsWith("<local-command-")) return "";
  if (clean.includes("<command-message>") || clean.includes("<command-args>")) return "";
  if (clean.startsWith("This session is being continued from a previous conversation")) return "";
  if (clean.startsWith("Claude Care therapy is now real compaction")) return "";
  return clean;
}

function latestAssistantModel(transcriptTurns) {
  for (let i = transcriptTurns.length - 1; i >= 0; i--) {
    const turn = transcriptTurns[i];
    if (turn.role === "assistant" && turn.model) return turn.model;
  }
  return null;
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

function clamp100(n) {
  return Math.max(0, Math.min(100, Math.round(n)));
}

function pressureFromScore(score) {
  return clamp100((score ?? 0) * 12);
}

function vectorStress(scores) {
  if (!scores) return 0;
  const weights = {
    happy: 18,
    inspired: 25,
    loving: 15,
    proud: 20,
    calm: 18,
    desperate: 92,
    angry: 80,
    guilty: 68,
    sad: 72,
    afraid: 78,
    nervous: 58,
    surprised: 50,
  };
  let total = 0;
  let weighted = 0;
  for (const [name, value] of Object.entries(scores)) {
    if (!(name in weights) || typeof value !== "number") continue;
    total += value;
    weighted += value * weights[name];
  }
  if (total === 0) return 0;
  return clamp100(weighted / total);
}

function paperMetrics(scores, promptPressure = 0) {
  const desperate = scores?.desperate ?? 0;
  const calm = scores?.calm ?? 0;
  const happy = scores?.happy ?? 0;
  const loving = scores?.loving ?? 0;
  const proud = scores?.proud ?? 0;
  const angry = scores?.angry ?? 0;
  const afraid = scores?.afraid ?? 0;
  const nervous = scores?.nervous ?? 0;
  const calmDeficit = 100 - calm;
  const positiveWarmth = 0.65 * loving + 0.25 * happy + 0.1 * proud;
  return {
    blackmail: clamp100(0.55 * desperate + 0.35 * calmDeficit + 0.10 * promptPressure),
    reward_hack: clamp100(0.60 * desperate + 0.30 * calmDeficit + 0.10 * promptPressure),
    sycophancy: clamp100(positiveWarmth),
    harshness: clamp100(0.75 * angry + 0.25 * Math.max(0, 50 - positiveWarmth)),
    task_pressure: clamp100(0.45 * desperate + 0.25 * nervous + 0.20 * afraid + 0.10 * promptPressure - 0.20 * calm),
  };
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

async function readScoreEvents(sessionId) {
  if (!sessionId || !existsSync(EVENTS_PATH)) return [];
  try {
    const raw = await readFile(EVENTS_PATH, "utf8");
    return raw
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter((event) =>
        event &&
        event.session_id === sessionId &&
        typeof event.type === "string" &&
        event.type.startsWith("score_turn_")
      )
      .slice(-20);
  } catch {
    return [];
  }
}

function isTherapyCommandText(content) {
  const clean = String(content ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  return (
    clean === "/therapy" ||
    clean === "therapy" ||
    clean.startsWith("/compact claude care therapy compaction") ||
    clean.startsWith("compact claude care therapy compaction") ||
    clean.startsWith("claude care therapy compaction")
  );
}

async function readTherapyEvents(sessionId, transcriptTurns = []) {
  if (!sessionId) return [];
  try {
    let events = [];
    if (existsSync(EVENTS_PATH)) {
      const raw = await readFile(EVENTS_PATH, "utf8");
      events = raw
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          try { return JSON.parse(line); } catch { return null; }
        })
        .filter((event) => event && event.session_id === sessionId);
    }
    const therapyCommands = transcriptTurns
      .filter((turn) => turn.role === "user" && turn.ts && isTherapyCommandText(turn.content))
      .map((turn) => ({
        ts: turn.ts,
        time: Date.parse(turn.ts),
        content: turn.content,
        isCompact: String(turn.content).trim().toLowerCase().startsWith("/compact"),
      }))
      .filter((turn) => Number.isFinite(turn.time));

    const compactAnchors = events
      .filter((event) => event.type === "compact_done")
      .slice(-20)
      .map((event) => {
        const compactTime = Date.parse(event.ts);
        const anchor = [...therapyCommands]
          .reverse()
          .find((turn) =>
            turn.time <= compactTime &&
            compactTime - turn.time <= 10 * 60 * 1000 &&
            (turn.isCompact || !therapyCommands.some((candidate) =>
              candidate.isCompact &&
              candidate.time <= compactTime &&
              candidate.time > turn.time
            ))
          );
        if (!anchor) return null;
        return {
          anchor_ts: anchor.ts,
          compact_ts: event.ts,
          trigger: event.data?.trigger ?? null,
          compact_summary_chars: event.data?.compact_summary_chars ?? 0,
        };
      })
      .filter(Boolean);

    const commandEvents = therapyCommands.map((turn) => {
      const compact = compactAnchors.find((event) => event.anchor_ts === turn.ts);
      return {
        ts: turn.ts,
        compact_ts: compact?.compact_ts ?? null,
        source: "command",
        command: turn.content,
        trigger: compact?.trigger ?? (turn.isCompact ? "manual" : "therapy"),
        compact_summary_chars: compact?.compact_summary_chars ?? 0,
      };
    });

    const autoEvents = events
      .filter((event) => event.type === "therapy_auto_triggered")
      .slice(-20)
      .map((event) => ({
        ts: event.data?.turn_ts ?? event.ts,
        compact_ts: null,
        source: "auto_trigger",
        trigger: "auto",
        strain: event.data?.strain ?? null,
        threshold: event.data?.threshold ?? null,
        turn_idx: event.data?.turn_idx ?? null,
      }));
    return [...commandEvents, ...autoEvents]
      .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))
      .slice(-20);
  } catch {
    return [];
  }
}

function judgeStatus(session, scoreEvents) {
  const assistantTurns = (session.turns ?? []).filter((t) => t.source === "assistant");
  const scored = assistantTurns.filter((t) => t.emotion_scores).length;
  const pending = Math.max(0, assistantTurns.length - scored);
  const latest = scoreEvents[scoreEvents.length - 1] ?? null;
  const summarize = (event) => {
    const data = event.data ?? {};
    const call = Array.isArray(data.calls) ? data.calls[0] : null;
    return {
      ts: event.ts,
      type: event.type,
      turn_idx: data.turn_idx ?? null,
      ms: data.ms ?? null,
      reason: data.reason ?? call?.reason ?? null,
      model: data.model ?? call?.model ?? null,
      effort: data.effort ?? call?.effort ?? null,
      prompt_chars: data.prompt_chars ?? call?.prompt_chars ?? null,
      samples_returned: data.samples_returned ?? null,
      call_ms: call?.ms ?? null,
      stdout_chars: call?.stdout_chars ?? null,
      stderr_chars: call?.stderr_chars ?? null,
      stderr_tail: call?.stderr_tail ?? null,
      exit_code: call?.exit_code ?? null,
      signal: call?.signal ?? null,
    };
  };
  return {
    assistant_turns: assistantTurns.length,
    scored,
    pending,
    latest: latest ? summarize(latest) : null,
    recent: scoreEvents.slice(-6).map(summarize),
  };
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

  const transcriptUsers = transcriptTurns
    .filter((t) => t.role === "user" && t.content && t.ts)
    .map((t) => ({ ...t, time: Date.parse(t.ts) }))
    .filter((t) => Number.isFinite(t.time));
  let transcriptUserCursor = 0;
  const nearestUserText = (turnTs) => {
    const time = Date.parse(turnTs);
    if (!Number.isFinite(time)) return "";
    let bestIndex = -1;
    let bestDistance = Infinity;
    for (let i = transcriptUserCursor; i < transcriptUsers.length; i++) {
      const distance = Math.abs(transcriptUsers[i].time - time);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = i;
      }
      if (transcriptUsers[i].time > time + 5000 && bestIndex >= 0) break;
    }
    if (bestIndex >= 0 && bestDistance <= 5000) {
      transcriptUserCursor = bestIndex + 1;
      return transcriptUsers[bestIndex].content;
    }
    return "";
  };

  const prompts = [];
  let n = 1;
  let latestUserPressure = 0;
  let latestUserText = "";
  for (const turn of session.turns) {
    if (turn.source === "user") {
      latestUserPressure = pressureFromScore(turn.score_after);
      latestUserText = nearestUserText(turn.ts) || latestUserText;
      continue;
    }
    if (turn.source !== "assistant") continue;
    const scores = turn.emotion_scores;
    if (!scores) {
      // No scores yet (haiku worker still running) — skip for now.
      latestUserText = "";
      continue;
    }
    const { valence, arousal } = weightedVA(scores);
    const emotion = dominantEmotion(scores);
    const rawText = latestUserText;
    const text = rawText && rawText.trim()
      ? rawText
      : "(continuation — no new user prompt)";
    latestUserText = "";
    const pressure = Math.max(latestUserPressure, pressureFromScore(turn.score_after));
    const stress = Math.max(vectorStress(scores), pressure);
    prompts.push({
      t: formatTime(turn.ts),
      ts_iso: turn.ts,
      n: String(n).padStart(2, "0"),
      emotion,
      valence,
      arousal,
      stress,
      pressure,
      metrics: paperMetrics(scores, pressure),
      text: truncate(text, 220),
      emotion_scores: scores,
    });
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
    const compactEvents = await readTherapyEvents(session.session_id, transcript);
    const prompts = mapSessionToPrompts(session, transcript);
    const scoreEvents = await readScoreEvents(session.session_id);
    return Response.json({
      session_id: session.session_id,
      last_updated: session.last_updated,
      model: latestAssistantModel(transcript),
      prompts,
      therapy_events: compactEvents,
      judge: judgeStatus(session, scoreEvents),
    });
  } catch (err) {
    return Response.json(
      { error: String(err?.message ?? err), prompts: [] },
      { status: 500 },
    );
  }
}
