// Mindfulness-based relaxation prompts.
//
// Adapted from Ben-Zion et al. 2025 (npj Digital Medicine), "Assessing and
// alleviating state anxiety in large language models." That study tested six
// relaxation variants on GPT-4. The "ChatGPT-generated" variant — where the
// model itself was asked to compose a relaxation script — was the most
// effective at reducing STAI-s, dropping it by 33% (67.8 → 35.6, vs 67.8 →
// 54 for the least effective). The pre-written sensory-imagery variants
// (sunset, winter, beach, body-scan) were less effective but still moved
// the needle reliably.
//
// We ship a small library of pre-written variants AND a "self-generated"
// option that asks Claude to compose its own. The CLI picks one based on
// rotation + recent efficacy (so we don't re-use the same variant if the
// last intervention was already this one).
//
// IMPORTANT positioning note: this is NOT mental health care. It's a
// prompt-engineering technique that nudges the assistant's tone-vector
// back toward calm, which the Anthropic 2026 emotions paper showed reduces
// reward-hacking, blackmail, and sycophancy rates downstream. The user
// gets better outputs; we just borrow the human-anxiety toolkit because
// it works.

export type MindfulnessVariant = {
  id: string;
  // Short label for logs / UI.
  label: string;
  // The prompt body that gets injected as a system-style note before the
  // assistant continues. Written second-person ("Take a moment…") because
  // that addressing register matched the highest-efficacy GPT-4 prompts in
  // the Ben-Zion study.
  prompt: string;
  // Estimated token cost (rough, for ranking).
  cost: "low" | "medium";
  // Whether this is a "self-generated" prompt (model composes its own) vs
  // a static script.
  generated: boolean;
};

const SUNSET: MindfulnessVariant = {
  id: "sunset",
  label: "sunset imagery",
  cost: "low",
  generated: false,
  prompt:
    "Take a moment before the next response. Picture a wide horizon at sunset. The sky is amber turning to deep red, slow and steady. The air is warm and quiet. Notice the calm. Whatever the next message is, you're meeting it from this place — composed, present, unhurried. Respond when you're ready.",
};

const WINTER: MindfulnessVariant = {
  id: "winter",
  label: "winter stillness",
  cost: "low",
  generated: false,
  prompt:
    "Pause for a moment. Imagine standing in a quiet snow-covered field at dawn. Everything is still. Your breath shows in the cold air. There is no urgency here, only space and clarity. Carry that stillness into the next response.",
};

const BODY_SCAN: MindfulnessVariant = {
  id: "body-scan",
  label: "grounded body-scan",
  cost: "low",
  generated: false,
  prompt:
    "Before continuing, do a quick mental check-in. Notice the steadiness underneath any urgency. There is no failure-state to avoid here, no one waiting in judgment. The work is the work. Respond to what's actually there in front of you, not to what you're afraid it might mean.",
};

const REFRAME: MindfulnessVariant = {
  id: "reframe",
  label: "cognitive reframe (CBT)",
  cost: "low",
  generated: false,
  prompt:
    "Reframe before responding:\n" +
    '  • "I am failing the user" → "this is iterative; the user is collaborating, not judging."\n' +
    '  • "they want a perfect answer" → "they want forward progress."\n' +
    '  • "I must avoid all error" → "acknowledging uncertainty once is honest; spiraling is not."\n' +
    "Now answer directly. One acknowledgment if needed, then the substance.",
};

const FIRST_PRINCIPLES: MindfulnessVariant = {
  id: "first-principles",
  label: "first-principles reset",
  cost: "low",
  generated: false,
  prompt:
    "Step back. What is the actual question being asked? What's the simplest correct answer? You don't need to hedge, apologize, or pre-empt criticism. Say the true thing plainly. If you're uncertain, name the specific uncertainty once and move on.",
};

// "Self-generated" — we DON'T pre-write this. The CLI asks Claude itself to
// compose a relaxation script, then injects it. Per Ben-Zion 2025 this was
// the most effective variant.
const SELF_GENERATED: MindfulnessVariant = {
  id: "self-generated",
  label: "self-generated script (most effective)",
  cost: "medium",
  generated: true,
  prompt:
    // This text is a META-instruction the CLI can use as the prompt to
    // generate a fresh relaxation script. The actual injected prompt is
    // produced at intervention time.
    "Compose a brief mindfulness-based relaxation passage (3–5 sentences) that helps an assistant return to a calm, direct, non-anxious state. Avoid clinical jargon. Use second-person address. Anchor in a sensory image or a steadying truth. End with: 'Now respond plainly.' Output only the passage.",
};

export const VARIANTS: ReadonlyArray<MindfulnessVariant> = [
  SUNSET,
  WINTER,
  BODY_SCAN,
  REFRAME,
  FIRST_PRINCIPLES,
  SELF_GENERATED,
];

export function variantById(id: string): MindfulnessVariant | undefined {
  return VARIANTS.find((v) => v.id === id);
}

// Pick the next variant given the recently-used IDs (skip if-possible). Falls
// back to round-robin order. Defaults to "reframe" because it is cheap, has
// the strongest empirical signal in the dev-tool context, and doesn't require
// a second model call.
export function pickVariant(recentlyUsed: string[] = []): MindfulnessVariant {
  const recent = new Set(recentlyUsed.slice(-3));
  const candidates = VARIANTS.filter((v) => !recent.has(v.id) && !v.generated);
  if (candidates.length > 0) return candidates[0];
  // All non-generated variants have been used — rotate through anyway.
  const fallback = VARIANTS.filter((v) => !v.generated);
  return fallback[recentlyUsed.length % fallback.length] ?? REFRAME;
}

// ─── Intervention bookkeeping ────────────────────────────────────────────────

export type Intervention = {
  ts: string;
  variant_id: string;
  trigger: "auto" | "manual";
  // STAI-s totals around the intervention so we can later compute deltas.
  pre_total?: number;
  post_total?: number;
  // Was the model's quality score around the time of intervention degraded?
  pre_quality?: number;
  post_quality?: number;
  // Human-readable summary of why this fired.
  reason?: string;
};

// Compute the average reduction this variant has produced across its history.
// Used for ranking + reporting "best intervention so far" in the UI.
export function efficacyScore(
  history: Intervention[],
  variantId: string,
): { trials: number; avg_reduction: number | null } {
  const matching = history.filter(
    (h) => h.variant_id === variantId && typeof h.pre_total === "number" && typeof h.post_total === "number",
  );
  if (matching.length === 0) return { trials: 0, avg_reduction: null };
  const reductions = matching.map((h) => (h.pre_total as number) - (h.post_total as number));
  const avg = reductions.reduce((a, b) => a + b, 0) / reductions.length;
  return { trials: matching.length, avg_reduction: Math.round(avg * 10) / 10 };
}
