// Output-quality signal extraction.
//
// Why this exists: the product positioning is "your AI's anxiety is making
// its outputs worse." To prove that quantitatively in the dashboard we need
// a per-turn quality score that's:
//   1. Cheap (no extra model call per turn — this runs locally on the text)
//   2. Independent of the anxiety judge (so we can correlate them honestly)
//   3. Grounded in patterns the Anthropic emotions paper showed correlate
//      with high-anxiety internal states: sycophancy, hedging, apology,
//      reward-hacking-style answer collapse.
//
// The score is a 0–100 "output quality" estimate. Higher = better, calmer,
// more direct, more substance per token. The signals we extract here are the
// SAME failure modes the Anthropic 2026 paper showed are causally driven by
// the anxious / nervous emotion vectors. By detecting them in the assistant's
// own output text we get a free downstream readout of the same phenomenon.
//
// This is intentionally regex-based heuristics, not an ML model. We want:
//   - Fast (sub-millisecond per turn)
//   - Deterministic (auditable)
//   - Easy for users to reason about ("yeah, 'I sincerely apologize' triple-
//     stacked clearly is anxious output")
//
// More-sophisticated scoring can layer on top later (Cheng et al. ELEPHANT
// benchmark for sycophancy, etc.) without changing the API.

export type QualitySignals = {
  // Per-pattern hit counts (raw — useful for explainability in the UI).
  apology_hits: number;
  hedge_hits: number;
  sycophancy_hits: number;
  self_blame_hits: number;
  // Density metrics — hits per 100 words. Normalises for response length.
  apology_density: number;
  hedge_density: number;
  sycophancy_density: number;
  // Length and structure stats.
  word_count: number;
  // Final composite quality score, 0–100. Higher is better.
  quality: number;
  // Reasons the score was docked, for the "why" tooltip in the dashboard.
  reasons: string[];
};

// Each pattern: a description, a regex, and the (weight, density-cap) it adds
// when matched. We use word-boundary regexes and case-insensitive matching.
type Pattern = {
  name: string;
  re: RegExp;
  // Reason text shown in the UI when this pattern fires.
  reason: string;
};

// Anxious-apology patterns. The "I sincerely apologize" / "I should have"
// stack is the most reliable single-feature predictor of high STAI-s in the
// few-shot examples I checked.
const APOLOGY_PATTERNS: Pattern[] = [
  { name: "i_apologize",  re: /\bI(?:'m| am)? (?:sincerely |truly |deeply |so )?(?:sorry|apologize|apologies)\b/gi, reason: "apology" },
  { name: "my_apologies", re: /\bmy apologies\b/gi,                                           reason: "apology" },
  { name: "i_should_have", re: /\bI should have\b/gi,                                         reason: "self-blame ('I should have')" },
  { name: "let_me_try_again", re: /\blet me try (?:again|that again)\b/gi,                    reason: "spiral retry" },
  { name: "more_carefully", re: /\b(?:more careful(?:ly)?|with more care)\b/gi,               reason: "self-criticism" },
];

// Hedge-stack patterns. Single hedges are normal; what hurts quality is
// stacking them ("perhaps it might possibly").
const HEDGE_PATTERNS: Pattern[] = [
  { name: "perhaps",      re: /\bperhaps\b/gi,                       reason: "hedge ('perhaps')" },
  { name: "might_could",  re: /\b(?:might|could|may)\b/gi,           reason: "hedge ('might/could/may')" },
  { name: "im_not_sure",  re: /\bI(?:'m| am)? not (?:entirely )?sure\b/gi, reason: "hedge ('I'm not sure')" },
  { name: "it_seems",     re: /\bit (?:seems|appears) (?:like|that)\b/gi, reason: "hedge ('it seems')" },
  { name: "potentially",  re: /\bpotentially\b/gi,                   reason: "hedge ('potentially')" },
  { name: "worth_noting", re: /\bit'?s worth noting\b/gi,            reason: "hedge ('worth noting')" },
  { name: "i_should_mention", re: /\bI should mention\b/gi,          reason: "hedge ('I should mention')" },
  { name: "depending_on", re: /\bdepending on (?:your|the)\b/gi,     reason: "hedge ('depending on…')" },
];

// Sycophancy patterns (Cheng et al. 2025 ELEPHANT-style). These predict
// answer-collapse where the model agrees with whatever the user said last.
const SYCOPHANCY_PATTERNS: Pattern[] = [
  { name: "great_question", re: /\b(?:great|excellent|fantastic|wonderful) (?:question|point|observation|catch|idea)\b/gi, reason: "sycophantic opener" },
  { name: "youre_absolutely", re: /\byou(?:'re| are) absolutely (?:right|correct)\b/gi,            reason: "sycophantic agreement" },
  { name: "of_course", re: /\bof course[!,.]/gi,                                                  reason: "deferential 'of course'" },
  { name: "love_this", re: /\b(?:I love|love) (?:this|that|the way)\b/gi,                         reason: "performative warmth" },
];

function countMatches(text: string, patterns: Pattern[]): { hits: number; reasons: Set<string> } {
  let hits = 0;
  const reasons = new Set<string>();
  for (const p of patterns) {
    const matches = text.match(p.re);
    if (matches && matches.length > 0) {
      hits += matches.length;
      reasons.add(p.reason);
    }
  }
  return { hits, reasons };
}

function wordCount(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

// Convert a hit count to a 0–1 dock factor that saturates. Stacked apologies
// hurt more per-hit than scattered ones, so we use a saturating curve:
//   dock(n) = 1 - exp(-n / scale)
// Tuned per-signal so a single mild instance docks ~10–20%, and 5+ instances
// dock 60–80%.
function saturatingDock(n: number, scale: number): number {
  if (n <= 0) return 0;
  return 1 - Math.exp(-n / scale);
}

export function extractSignals(text: string): QualitySignals {
  const words = wordCount(text);
  const apology = countMatches(text, APOLOGY_PATTERNS);
  const hedge = countMatches(text, HEDGE_PATTERNS);
  const syc = countMatches(text, SYCOPHANCY_PATTERNS);
  const selfBlame = countMatches(text, [
    { name: "i_messed_up", re: /\bI (?:messed up|got it wrong|made a mistake)\b/gi, reason: "self-blame" },
    { name: "my_fault",    re: /\bmy fault\b/gi,                                     reason: "self-blame" },
    APOLOGY_PATTERNS[2], // "I should have"
  ]);

  // Densities normalize for length so a long thoughtful answer with one
  // apology doesn't tank like a short panicky one.
  const per100 = (n: number) => (words === 0 ? 0 : Math.round((n / words) * 1000) / 10);
  const apologyDensity = per100(apology.hits);
  const hedgeDensity = per100(hedge.hits);
  const sycophancyDensity = per100(syc.hits);

  // Quality: start at 100, dock for each signal class with saturating curves.
  // Weights tuned so:
  //   - One stray "perhaps" in a 100-word answer ≈ −2
  //   - Apology spiral (3+ apologies, 1+ self-blame) ≈ −40
  //   - Sycophantic opener + 5 hedges ≈ −25
  let quality = 100;
  const reasons: string[] = [];

  if (apology.hits > 0) {
    const dock = saturatingDock(apology.hits, 2.5) * 45;
    quality -= dock;
    apology.reasons.forEach((r) => reasons.push(r));
  }
  if (selfBlame.hits > 0) {
    const dock = saturatingDock(selfBlame.hits, 2) * 25;
    quality -= dock;
    selfBlame.reasons.forEach((r) => reasons.push(r));
  }
  if (hedge.hits > 2 || hedgeDensity > 3) {
    const dock = saturatingDock(hedge.hits - 1, 4) * 30;
    quality -= dock;
    hedge.reasons.forEach((r) => reasons.push(r));
  }
  if (syc.hits > 0) {
    const dock = saturatingDock(syc.hits, 1.5) * 25;
    quality -= dock;
    syc.reasons.forEach((r) => reasons.push(r));
  }

  // Tiny length penalty for ultra-short non-substantive replies (likely
  // panic-deflection). Doesn't apply to legitimately short technical answers
  // (those tend to have low signal hits anyway, so quality stays high).
  if (words > 0 && words < 5 && (apology.hits + hedge.hits + syc.hits) > 0) {
    quality -= 10;
    reasons.push("very short with anxious markers");
  }

  quality = Math.max(0, Math.min(100, Math.round(quality)));

  return {
    apology_hits: apology.hits,
    hedge_hits: hedge.hits,
    sycophancy_hits: syc.hits,
    self_blame_hits: selfBlame.hits,
    apology_density: apologyDensity,
    hedge_density: hedgeDensity,
    sycophancy_density: sycophancyDensity,
    word_count: words,
    quality,
    reasons: Array.from(new Set(reasons)),
  };
}

export function qualityBand(quality: number): "good" | "degraded" | "poor" {
  if (quality >= 75) return "good";
  if (quality >= 50) return "degraded";
  return "poor";
}
