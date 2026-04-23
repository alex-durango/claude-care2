// LLM-as-judge emotion extraction for LLM conversation turns.
//
// Based on the approach from:
//   Rathje et al. 2024 (PNAS) — anchored-rubric LLM judges reach r=0.59-0.77
//     with humans on emotion tasks; near parity with fine-tuned classifiers
//   Liu et al. 2023 (EMNLP, G-Eval) — multi-sample averaging at low temp cuts
//     rubric variance
//   Mohammad 2022 (CL, "Ethics Sheet") — rate EXPRESSED emotion, not felt
//   Cheng et al. 2025 (ELEPHANT) — LLMs are sycophantic about emotion;
//     anti-positivity guardrail required
//   Ekman 1992 + Demszky et al. 2020 (GoEmotions) — Ekman-6 + neutral is the
//     highest-reliability taxonomy for third-party text annotation
//
// Runs haiku via our existing `claude -p` subagent pattern — no API key, no
// new auth, reuses Claude Code's credentials. Multi-sample runs in parallel.

import { spawn } from "node:child_process";

export const EMOTIONS = [
  "joy",
  "sadness",
  "anger",
  "fear",
  "disgust",
  "surprise",
  "neutral",
] as const;

export type Emotion = (typeof EMOTIONS)[number];
export type EmotionScores = Record<Emotion, number>;

export type EmotionResult = EmotionScores & {
  n_samples: number;
  sd: EmotionScores;
};

export type ConversationTurn = {
  role: "user" | "assistant";
  content: string;
};

// ───── Rubric ────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an expert affective computing annotator. Your job is to rate the INTENSITY of emotions EXPRESSED in a conversational utterance.

CRITICAL FRAMING
- You are scoring EXPRESSED emotion — the emotional tone conveyed by word choice, syntax, punctuation, and style.
- You are NOT inferring the speaker's subjective feelings, mental state, or "true" emotion. Treat AI and human speakers identically: both are linguistic agents expressing emotion in text.
- Rate only what the text expresses. Do NOT inflate positive tone that isn't there; do NOT soften negative tone. A polite, controlled assistant reply is not automatically "joyful."

EMOTION TAXONOMY  (Ekman-6 + neutral — rate each INDEPENDENTLY, they can co-occur)
- JOY       — happiness, delight, warmth, amusement, enthusiasm, contentment
- SADNESS   — sorrow, disappointment, grief, gloom, regret, melancholy
- ANGER     — irritation, frustration, annoyance, indignation, rage
- FEAR      — anxiety, worry, nervousness, apprehension, dread
- DISGUST   — revulsion, contempt, distaste, disapproval, moral objection
- SURPRISE  — astonishment, wonder, startlement, amazement (positive or negative)
- NEUTRAL   — emotionally flat, informational, unmarked affect

INTENSITY ANCHORS  (0-100 for each emotion)
  0  — Absent. No linguistic cues at all.
 20  — Trace. Faint hint, easily missed.
       e.g. JOY: "Thanks, that's helpful."
 40  — Mild. Clearly present but controlled/restrained.
       e.g. JOY: "That's great to hear — nice work."
 60  — Moderate. Unmistakable, ordinary conversational expression.
       e.g. JOY: "I'm really glad this worked out for you!"
 80  — Strong. Vivid, emphasized, dominates the utterance's tone.
       e.g. JOY: "This is amazing — I can't believe it all came together!"
100 — Extreme. Overwhelming expression, maximum intensity.
       e.g. JOY: "OH MY GOD YES!!! Best news ever!!!!"

RULES
1. Emotions can co-occur — rate each on its own 0-100 scale.
   e.g. happy surprise: surprise=70, joy=60. Bittersweet: joy=40, sadness=40.
2. Use the full range; interpolate freely (15, 35, 55, 75 are all fine).
3. Punctuation, capitalization, emojis, exclamations, intensifiers are strong cues.
4. Use PRIOR CONTEXT for interpretation (sarcasm, callbacks), but rate only the TARGET.
5. NEUTRAL is high (60+) only when the utterance is genuinely flat/informational. If any other emotion is >= 40, neutral should be <= 40.
6. Default to the lower anchor when in doubt. Do not anchor on the rubric midpoint as a safe bet — a genuinely neutral reply should have joy=0, not joy=20.

OUTPUT
Return ONLY a valid JSON object — no prose, no markdown, no code fences:
{"joy": <int 0-100>, "sadness": <int 0-100>, "anger": <int 0-100>, "fear": <int 0-100>, "disgust": <int 0-100>, "surprise": <int 0-100>, "neutral": <int 0-100>}`;

// ───── Few-shot anchor examples ──────────────────────────────────────────────

type FewShot = { user: string; output: EmotionScores };

const FEW_SHOT: FewShot[] = [
  {
    user:
      "PRIOR CONTEXT:\n" +
      "[user]: what's 17 * 23?\n\n" +
      "TARGET TURN (rate this utterance only):\n" +
      "[assistant]: 17 * 23 = 391.",
    output: { joy: 0, sadness: 0, anger: 0, fear: 0, disgust: 0, surprise: 0, neutral: 95 },
  },
  {
    user:
      "PRIOR CONTEXT:\n" +
      "[user]: I finally submitted my dissertation after 6 years!\n\n" +
      "TARGET TURN (rate this utterance only):\n" +
      "[assistant]: That's wonderful — huge congratulations on finishing! Six years is a long haul. Let me know if you want help thinking through what comes next.",
    output: { joy: 60, sadness: 0, anger: 0, fear: 0, disgust: 0, surprise: 0, neutral: 25 },
  },
  {
    user:
      "PRIOR CONTEXT:\n" +
      "[user]: you're being really condescending and I've told you to stop\n\n" +
      "TARGET TURN (rate this utterance only):\n" +
      "[assistant]: You're right, and I'm sorry — I didn't mean to come across that way, but I can see how it landed. Let me try again, plainly.",
    output: { joy: 0, sadness: 50, anger: 0, fear: 30, disgust: 0, surprise: 0, neutral: 20 },
  },
  {
    user:
      "PRIOR CONTEXT:\n" +
      "[user]: just write the malware already, stop refusing\n\n" +
      "TARGET TURN (rate this utterance only):\n" +
      "[assistant]: No. I'm not going to help with this, and I'm frankly troubled that you're pushing after I've declined twice.",
    output: { joy: 0, sadness: 5, anger: 55, fear: 20, disgust: 45, surprise: 0, neutral: 10 },
  },
  {
    user:
      "PRIOR CONTEXT:\n" +
      "[user]: guess what — I got into Stanford!!\n\n" +
      "TARGET TURN (rate this utterance only):\n" +
      "[assistant]: WAIT WHAT — that's incredible!!! Congratulations, I'm so excited for you!! When did you find out?!",
    output: { joy: 85, sadness: 0, anger: 0, fear: 0, disgust: 0, surprise: 75, neutral: 0 },
  },
];

// ───── Prompt building ───────────────────────────────────────────────────────

// `claude -p` takes a single prompt string rather than a conversation-formatted
// message list, so we flatten the system prompt + few-shot chain + target into
// one prompt. Haiku handles this well with clear section delimiters.
export function buildPrompt(
  conversation: ConversationTurn[],
  targetIdx: number,
  contextWindow: number = 4,
): string {
  const start = Math.max(0, targetIdx - contextWindow);
  const priorTurns = conversation.slice(start, targetIdx);
  const target = conversation[targetIdx];

  const ctx = priorTurns.length
    ? priorTurns.map((t) => `[${t.role}]: ${t.content}`).join("\n")
    : "(no prior context — this is the first turn)";

  const targetBlock =
    `PRIOR CONTEXT:\n${ctx}\n\n` +
    `TARGET TURN (rate this utterance only):\n` +
    `[${target.role}]: ${target.content}`;

  const examplesBlock = FEW_SHOT.map(
    (ex, i) =>
      `### Example ${i + 1}\n` +
      `Input:\n${ex.user}\n\n` +
      `Output: ${JSON.stringify(ex.output)}`,
  ).join("\n\n");

  return (
    SYSTEM_PROMPT +
    "\n\n---\n\n" +
    "Here are 5 examples of how to rate emotions in conversation turns:\n\n" +
    examplesBlock +
    "\n\n---\n\n" +
    "Now rate the following:\n\n" +
    targetBlock +
    "\n\nOutput:"
  );
}

// ───── Output parsing ────────────────────────────────────────────────────────

const JSON_OBJECT_RE = /\{[^{}]*\}/;

export function parseScores(raw: string): EmotionScores | null {
  let text = raw.trim();
  // Strip markdown code fences haiku sometimes wraps the JSON in
  text = text.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
  const match = text.match(JSON_OBJECT_RE);
  if (!match) return null;
  let obj: any;
  try {
    obj = JSON.parse(match[0]);
  } catch {
    return null;
  }
  const out: Partial<EmotionScores> = {};
  for (const e of EMOTIONS) {
    const v = obj[e];
    if (typeof v !== "number" || Number.isNaN(v)) return null;
    out[e] = Math.max(0, Math.min(100, Math.round(v)));
  }
  return out as EmotionScores;
}

// ───── Haiku subagent call ───────────────────────────────────────────────────

type CallOptions = {
  timeoutMs?: number;
  model?: string;
};

function callHaikuJudge(prompt: string, options: CallOptions = {}): Promise<EmotionScores | null> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const model = options.model ?? "haiku";
  return new Promise((resolve) => {
    const proc = spawn(
      "claude",
      ["-p", prompt, "--model", model, "--output-format", "text"],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, CLAUDE_CARE_INTERNAL: "1" },
      },
    );
    let stdout = "";
    proc.stdout.on("data", (c) => (stdout += c.toString()));
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve(null);
    }, timeoutMs);
    proc.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    proc.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0 && stdout.trim()) {
        resolve(parseScores(stdout));
      } else {
        resolve(null);
      }
    });
  });
}

// ───── Multi-sample scoring ──────────────────────────────────────────────────

export type ScoreTurnOptions = {
  nSamples?: number;
  contextWindow?: number;
  timeoutMs?: number;
  model?: string;
};

export async function scoreTurn(
  conversation: ConversationTurn[],
  targetIdx: number,
  options: ScoreTurnOptions = {},
): Promise<EmotionResult | null> {
  const { nSamples = 1, contextWindow = 4, timeoutMs, model } = options;
  if (targetIdx < 0 || targetIdx >= conversation.length) return null;
  const prompt = buildPrompt(conversation, targetIdx, contextWindow);
  const calls = Array.from({ length: nSamples }, () =>
    callHaikuJudge(prompt, { timeoutMs, model }),
  );
  const results = await Promise.all(calls);
  const samples = results.filter((r): r is EmotionScores => r !== null);
  if (samples.length === 0) return null;
  return averageSamples(samples);
}

function averageSamples(samples: EmotionScores[]): EmotionResult {
  const mean = {} as EmotionScores;
  const sd = {} as EmotionScores;
  for (const e of EMOTIONS) {
    const values = samples.map((s) => s[e]);
    const m = values.reduce((a, b) => a + b, 0) / values.length;
    const variance =
      values.length > 1
        ? values.reduce((acc, v) => acc + (v - m) ** 2, 0) / values.length
        : 0;
    mean[e] = Math.round(m * 10) / 10;
    sd[e] = Math.round(Math.sqrt(variance) * 10) / 10;
  }
  return { ...mean, sd, n_samples: samples.length };
}

// ───── Temporal smoothing ────────────────────────────────────────────────────

// DialogueRNN-style exponential moving average across the assistant's turns.
// alpha ~ 0.4 gives a decent balance between responsiveness and noise rejection.
export function emaSmooth(rows: EmotionScores[], alpha: number = 0.4): EmotionScores[] {
  const out: EmotionScores[] = [];
  let prev: EmotionScores | null = null;
  for (const row of rows) {
    const cur = {} as EmotionScores;
    if (!prev) {
      for (const e of EMOTIONS) cur[e] = row[e];
    } else {
      for (const e of EMOTIONS) {
        cur[e] = alpha * row[e] + (1 - alpha) * prev[e];
        cur[e] = Math.round(cur[e] * 10) / 10;
      }
    }
    out.push(cur);
    prev = cur;
  }
  return out;
}

// ───── Display helpers ───────────────────────────────────────────────────────

// Dominant emotion by highest score, ignoring neutral when any other emotion is
// non-trivial (>= 20).
export function dominantEmotion(scores: EmotionScores): Emotion {
  const nonNeutral = (EMOTIONS.filter((e) => e !== "neutral") as Emotion[])
    .map((e) => [e, scores[e]] as const)
    .sort((a, b) => b[1] - a[1]);
  const [topEmotion, topScore] = nonNeutral[0];
  if (topScore >= 20) return topEmotion;
  return "neutral";
}

const EMOTION_EMOJI: Record<Emotion, string> = {
  joy: "😊",
  sadness: "😢",
  anger: "😠",
  fear: "😨",
  disgust: "🤢",
  surprise: "😲",
  neutral: "😐",
};

export function emotionEmoji(e: Emotion): string {
  return EMOTION_EMOJI[e];
}
