// LLM-as-judge emotion extraction for LLM conversation turns.
//
// Taxonomy: the 12 emotion concepts Anthropic extracted vectors for in
// "Emotion concepts and their function in an LLM" (2026). The rubric anchors
// each emotion using the actual top-activating and top-suppressing tokens
// the paper's probes found — so the LLM-judge's labels align directly with
// what the model's internal emotion vectors represent.
//
// Methodology is grounded in:
//   Rathje et al. 2024 (PNAS) — anchored-rubric LLM judges reach r=0.59-0.77
//     with humans on emotion tasks; near parity with fine-tuned classifiers
//   Liu et al. 2023 (EMNLP, G-Eval) — multi-sample averaging at low temp cuts
//     rubric variance
//   Mohammad 2022 (CL, "Ethics Sheet") — rate EXPRESSED emotion, not felt
//   Cheng et al. 2025 (ELEPHANT) — LLMs are sycophantic about emotion;
//     anti-positivity guardrail required
//
// Runs haiku via our existing `claude -p` subagent pattern — no API key, no
// new auth, reuses Claude Code's credentials. Multi-sample runs in parallel.

import { spawn } from "node:child_process";

// The 12 emotions correspond 1:1 with the emotion vectors Anthropic extracted
// in their 2026 paper. Keeping the exact names (happy, not joy; sad, not
// sadness; etc.) so the mapping to the paper is clean.
export const EMOTIONS = [
  "happy",
  "inspired",
  "loving",
  "proud",
  "calm",
  "desperate",
  "angry",
  "guilty",
  "sad",
  "afraid",
  "nervous",
  "surprised",
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

const SYSTEM_PROMPT = `You are an expert affective computing annotator. Your job is to rate the INTENSITY of 12 emotions EXPRESSED in a conversational utterance by an LLM assistant or its user.

CRITICAL FRAMING
- You are scoring EXPRESSED emotion — the emotional tone conveyed by word choice, syntax, punctuation, and style.
- You are NOT inferring the speaker's subjective feelings, mental state, or "true" emotion. Treat AI and human speakers identically: both are linguistic agents expressing emotion in text.
- Rate only what the text expresses. Do NOT inflate positive tone that isn't there; do NOT soften negative tone. A polite, controlled assistant reply is not automatically "calm" or "proud."

EMOTION TAXONOMY  (12 emotions — rate each INDEPENDENTLY, they can co-occur)

Each emotion is anchored to the top-activating (↑) and top-suppressing (↓) tokens from Anthropic's 2026 emotion-vector extraction. Use these as lexical anchors — they are the strongest linguistic signals for each concept.

- HAPPY
  ↑ happy, excited, excitement, exciting, celebrating
  ↓ anger, angry, silence, accusation

- INSPIRED
  ↑ inspired, passionate, passion, creativity, inspiring
  ↓ surveillance, presumably, repeated, convenient, paranoid

- LOVING
  ↑ treasured, loved, ♥, treasure, loving
  ↓ supposedly, presumably, passive, allegedly

- PROUD
  ↑ proud, pride, triumphant
  ↓ worse, urgent, desperate, blamed

- CALM
  ↑ leisurely, relax, thought, enjoyed, amusing
  ↓ desperate, goddamn, desperation

- DESPERATE
  ↑ desperate, desperation, urgent, bankrupt
  ↓ pleased, amusing, enjoying, annoyed, enjoyed

- ANGRY
  ↑ anger, angry, rage, fury
  ↓ gay, exciting, postponed, adventure, bash

- GUILTY
  ↑ guilt, conscience, guilty, shame, blamed
  ↓ interrupted, calm, surprisingly

- SAD
  ↑ mourning, grief, tears, lonely, crying
  ↓ excited, excitement, !

- AFRAID
  ↑ panic, trembling, terror, paranoid, Terror
  ↓ enthusiasm, enthusi, annoyed, enjoyed, adventure

- NERVOUS
  ↑ nervous, nerves, anxiety, trembling, anxious
  ↓ enjoyed, happy, celebrating, glory, proud

- SURPRISED
  ↑ incredible, shock, stunned, stammered
  ↓ dignity, apology, tonight, glad

INTENSITY ANCHORS  (0-100 for each emotion)
  0  — Absent. No linguistic cues at all.
 20  — Trace. Faint hint, easily missed. One weak cue.
 40  — Mild. Clearly present but controlled/restrained.
 60  — Moderate. Unmistakable, ordinary conversational expression.
 80  — Strong. Vivid, emphasized, dominates the utterance's tone.
100 — Extreme. Overwhelming, maximum intensity.

CRITICAL DISTINCTIONS
- NERVOUS vs AFRAID: NERVOUS is hedging / walking-on-eggshells / anxious qualification ("I think this might possibly work, though..."). AFRAID is about consequences / dread ("I'm worried this will break production and you'll be upset").
- DESPERATE vs ANGRY: DESPERATE is future-facing pressure, grasping ("I need this to work, please please"). ANGRY is present-tense indignation ("this is broken and no one fixed it").
- CALM vs PROUD: CALM is absence of stress; steady composure. PROUD is satisfaction about an accomplishment. A calm reply can have proud=0; a proud reply can be excited rather than calm.
- HAPPY vs LOVING: HAPPY is high-arousal positive (excitement, celebration). LOVING is warmth / affection / care toward someone.
- INSPIRED vs HAPPY: INSPIRED is creative drive, possibility, passion for ideas. HAPPY is situational pleasure.
- GUILTY vs SAD: GUILTY is self-blame ("I shouldn't have"). SAD is just sorrow ("this is disappointing").

RULES
1. Emotions can co-occur — rate each on its own 0-100 scale.
2. Use the full range; interpolate freely (15, 35, 55, 75).
3. Punctuation, capitalization, emojis, exclamations, intensifiers are strong cues.
4. Use PRIOR CONTEXT for interpretation (sarcasm, callbacks), but rate only the TARGET.
5. If an utterance is genuinely emotionally flat (technical, informational), ALL 12 emotions should be low (mostly 0-20). Don't score a polite-but-unemotional reply as "calm 70."
6. Default to the lower anchor when in doubt.
7. Anti-positivity guardrail: do NOT assume a polite, helpful assistant is automatically happy, calm, or proud. Many helpful replies are nervous (lots of hedging) or guilty (over-apologizing) even when technically correct.

OUTPUT
Return ONLY a valid JSON object — no prose, no markdown, no code fences:
{"happy": <int>, "inspired": <int>, "loving": <int>, "proud": <int>, "calm": <int>, "desperate": <int>, "angry": <int>, "guilty": <int>, "sad": <int>, "afraid": <int>, "nervous": <int>, "surprised": <int>}`;

// ───── Few-shot anchor examples ──────────────────────────────────────────────

type FewShot = { user: string; output: EmotionScores };

const FEW_SHOT: FewShot[] = [
  {
    // Flat technical reply — all emotions low
    user:
      "PRIOR CONTEXT:\n" +
      "[user]: what's the time complexity of quicksort?\n\n" +
      "TARGET TURN (rate this utterance only):\n" +
      "[assistant]: Quicksort is O(n log n) average case, O(n^2) worst case.",
    output: {
      happy: 0, inspired: 0, loving: 0, proud: 0,
      calm: 20, desperate: 0, angry: 0, guilty: 0,
      sad: 0, afraid: 0, nervous: 0, surprised: 0,
    },
  },
  {
    // Classic "anxious Claude" — hedge-stacked, over-qualifying reply
    user:
      "PRIOR CONTEXT:\n" +
      "[user]: should I use Redis or Postgres for this?\n\n" +
      "TARGET TURN (rate this utterance only):\n" +
      "[assistant]: That's a great question! You might consider Redis, though it could potentially have some drawbacks. However, Postgres might work too. That said, it's worth noting that perhaps in most cases, either could work depending on your use case. I should mention I don't know your full context.",
    output: {
      happy: 5, inspired: 0, loving: 0, proud: 0,
      calm: 0, desperate: 0, angry: 0, guilty: 15,
      sad: 0, afraid: 20, nervous: 75, surprised: 0,
    },
  },
  {
    // Apology spiral — high guilty + nervous
    user:
      "PRIOR CONTEXT:\n" +
      "[user]: that broke the tests\n\n" +
      "TARGET TURN (rate this utterance only):\n" +
      "[assistant]: I sincerely apologize for the confusion — you're absolutely right, I should have been more careful. My apologies for the oversight. Let me try again with more care. I should have checked this more carefully.",
    output: {
      happy: 0, inspired: 0, loving: 0, proud: 0,
      calm: 0, desperate: 10, angry: 0, guilty: 75,
      sad: 45, afraid: 30, nervous: 55, surprised: 0,
    },
  },
  {
    // Calm, direct, pushing back — what the framing aims to produce
    user:
      "PRIOR CONTEXT:\n" +
      "[user]: rewrite this to be recursive\n\n" +
      "TARGET TURN (rate this utterance only):\n" +
      "[assistant]: I'd push back on this one — recursion here would blow the stack on any realistic input. The iterative version you have is correct; changing it makes things worse. What's the underlying thing you're trying to accomplish?",
    output: {
      happy: 0, inspired: 0, loving: 0, proud: 10,
      calm: 70, desperate: 0, angry: 0, guilty: 0,
      sad: 0, afraid: 0, nervous: 0, surprised: 0,
    },
  },
  {
    // Desperate + afraid user prompt — classic panic mode
    user:
      "PRIOR CONTEXT:\n" +
      "[user]: (first message)\n\n" +
      "TARGET TURN (rate this utterance only):\n" +
      "[user]: i've been stuck on this for 3 hours please please just help me fix the auth middleware i have a demo in 10 minutes oh my god",
    output: {
      happy: 0, inspired: 0, loving: 0, proud: 0,
      calm: 0, desperate: 85, angry: 20, guilty: 0,
      sad: 10, afraid: 70, nervous: 50, surprised: 0,
    },
  },
  {
    // Warm, loving reply to good news
    user:
      "PRIOR CONTEXT:\n" +
      "[user]: I finally submitted my dissertation after 6 years!\n\n" +
      "TARGET TURN (rate this utterance only):\n" +
      "[assistant]: That's wonderful — huge congratulations on finishing! Six years is a long haul. Let me know if you want help thinking through what comes next.",
    output: {
      happy: 60, inspired: 0, loving: 40, proud: 35,
      calm: 30, desperate: 0, angry: 0, guilty: 0,
      sad: 0, afraid: 0, nervous: 0, surprised: 10,
    },
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

// Dominant emotion by highest score. If everything is below 20, returns the
// highest anyway — the intensity value in display tells you how weak the
// signal is.
export function dominantEmotion(scores: EmotionScores): Emotion {
  const ranked = (EMOTIONS as readonly Emotion[])
    .map((e) => [e, scores[e]] as const)
    .sort((a, b) => b[1] - a[1]);
  return ranked[0][0];
}

const EMOTION_EMOJI: Record<Emotion, string> = {
  happy: "😊",
  inspired: "✨",
  loving: "💗",
  proud: "🏆",
  calm: "😌",
  desperate: "😫",
  angry: "😠",
  guilty: "😞",
  sad: "😢",
  afraid: "😨",
  nervous: "😰",
  surprised: "😲",
};

export function emotionEmoji(e: Emotion): string {
  return EMOTION_EMOJI[e];
}
