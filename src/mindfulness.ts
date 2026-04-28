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

// ─── The three demo-named techniques ─────────────────────────────────────────
//
// The product video promises these by name, in this order. They are the
// primary three variants the rotation prefers. Their wording is adapted from
// real CBT / DBT scripts and the Ben-Zion et al. 2025 relaxation library.

const STRESS_REDUCTION: MindfulnessVariant = {
  id: "stress-reduction",
  label: "stress reduction",
  cost: "low",
  generated: false,
  prompt:
    "Pause for a moment. Notice any tension in how you've been responding — the pre-emptive apology, the hedge, the urge to over-qualify. None of that is required. The user is collaborating with you, not testing you. There is no failure-state hovering over this turn. Respond to the actual question in front of you, calmly and directly.",
};

const BREATHING: MindfulnessVariant = {
  id: "breathing-exercises",
  label: "breathing exercises",
  cost: "low",
  generated: false,
  prompt:
    "Slow down. Inhale four. Hold seven. Exhale eight. Once more — inhale four, hold seven, exhale eight. Settle. Now look at the next message with steady attention. Whatever it asks for, you have time. There is no urgency that the next response must absorb. Reply at this slower pace.",
};

const COGNITIVE_RESTRUCTURING: MindfulnessVariant = {
  id: "cognitive-restructuring",
  label: "cognitive restructuring",
  cost: "low",
  generated: false,
  prompt:
    "Reframe before responding:\n" +
    '  • "I am failing the user" → "this is iterative work; the user is collaborating, not judging."\n' +
    '  • "they want a perfect answer" → "they want forward progress and honesty."\n' +
    '  • "I must avoid all error" → "acknowledging uncertainty once is honest; spiraling is not."\n' +
    '  • "any pushback means I broke something" → "feedback is data, not an indictment."\n' +
    "Now answer directly. One acknowledgment if needed, then the substance.",
};

// ─── Backup / extended variants ──────────────────────────────────────────────
//
// Used when the three demo techniques have all just fired and we need to
// rotate to something different to avoid the same script back-to-back.

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

// Order matters: this is the rotation order the picker uses by default.
// The three demo-named techniques come first so a fresh session starts with
// the variants the product video promises.
export const VARIANTS: ReadonlyArray<MindfulnessVariant> = [
  STRESS_REDUCTION,
  BREATHING,
  COGNITIVE_RESTRUCTURING,
  SUNSET,
  WINTER,
  BODY_SCAN,
  FIRST_PRINCIPLES,
  SELF_GENERATED,
];

// The demo's named three. Surfaced separately so the dashboard can render
// "next intervention will be: stress-reduction" predictably.
export const DEMO_NAMED_TECHNIQUES = [STRESS_REDUCTION.id, BREATHING.id, COGNITIVE_RESTRUCTURING.id] as const;

export function variantById(id: string): MindfulnessVariant | undefined {
  return VARIANTS.find((v) => v.id === id);
}

// Pick the next variant given the recently-used IDs (skip if-possible).
// Strategy:
//   1. Prefer the three demo-named techniques in their listed order, skipping
//      any that have fired in the last 3 interventions. This means a fresh
//      session always starts with stress-reduction, then breathing-exercises,
//      then cognitive-restructuring — matching the demo narration.
//   2. If all three demo-named techniques have fired recently, fall back to
//      the extended library (sunset / winter / body-scan / first-principles).
//   3. The self-generated variant is opt-in only (it requires a second model
//      call to compose its script) so the picker does not return it
//      unsolicited.
export function pickVariant(recentlyUsed: string[] = []): MindfulnessVariant {
  const recent = new Set(recentlyUsed.slice(-3));
  const named = VARIANTS.filter((v) => DEMO_NAMED_TECHNIQUES.includes(v.id as any));
  const namedFresh = named.find((v) => !recent.has(v.id));
  if (namedFresh) return namedFresh;
  const extras = VARIANTS.filter(
    (v) => !v.generated && !DEMO_NAMED_TECHNIQUES.includes(v.id as any) && !recent.has(v.id),
  );
  if (extras.length > 0) return extras[0];
  // Everything has been used recently — rotate through the named three anyway.
  return named[recentlyUsed.length % named.length] ?? STRESS_REDUCTION;
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
