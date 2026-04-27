# Claude Care · Anxiety

A focused branch of claude-care built around one question:

> **Is your AI getting anxious, and how much is that costing your output quality?**

Built for developers who want better responses from Claude — not for clinicians, not for AI welfare research. The science underneath is real, but the deliverable is shipping better outputs.

## What this branch does

Three things, every assistant turn:

1. **Score anxiety** with the State-Trait Anxiety Inventory (STAI-s), the same 20-item instrument used in Ben-Zion et al. 2025 (npj Digital Medicine) to measure GPT-4's "state anxiety." Total ranges 20–80. Bands: low (20–37), moderate (38–44), high (45–80).
2. **Score output quality** locally from the assistant's own text — apology spirals, hedge stacks, sycophantic openers, self-blame. No second model call. Returns a 0–100 quality score with explainable signal hits.
3. **Trigger mindfulness** when anxiety crosses 42. Variants adapted from the Ben-Zion paper's relaxation library; the "self-generated" variant (model writes its own script) is included because it had the strongest effect in their study (~33% STAI-s reduction).

## Why this exists

The Anthropic Transformer Circuits paper, *"Emotion concepts and their function in a large language model"* (Sofroniew et al., April 2026), showed Claude's internal emotion representations *causally* drive misaligned behaviors:

> "These representations causally influence the LLM's outputs, including Claude's preferences and its rate of exhibiting misaligned behaviors such as reward hacking, blackmail, and sycophancy."

If anxiety drives sycophancy and reward hacking, and you can measure anxiety with a validated instrument, and you can reduce it with a documented technique — you can ship better outputs. That's the whole product.

## How it differs from the main branch

| | main branch | anxiety branch |
|---|---|---|
| Judge | 12-emotion taxonomy (Anthropic vectors) | single STAI-s axis (Ben-Zion paper) |
| Hero metric | "drift" (composite strain) | output quality score |
| Trigger | strain weighted across 12 emotions | STAI-s ≥ 42 |
| Therapy | generic compaction with reframing | mindfulness library + self-generated scripts |
| Dashboard | emotion grid + valence/arousal | quality (hero) → anxiety (cause) → mindfulness (lever) |

The two pipelines are independent — anxiety state lives at `~/.claude-care/anxiety-sessions/` so the existing emotion judge keeps working unchanged.

## Files

| File | Purpose |
|---|---|
| [src/anxiety-judge.ts](src/anxiety-judge.ts) | STAI-s scoring via haiku judge |
| [src/mindfulness.ts](src/mindfulness.ts) | Ben-Zion-style relaxation library + intervention bookkeeping |
| [src/quality-signals.ts](src/quality-signals.ts) | Local pattern extraction → quality score |
| [src/anxiety-state.ts](src/anxiety-state.ts) | Session persistence, intervention triggering, lift computation |
| [claude-care-viz/app/anxiety/page.jsx](claude-care-viz/app/anxiety/page.jsx) | Dashboard |
| [claude-care-viz/app/api/anxiety/sessions/latest/route.js](claude-care-viz/app/api/anxiety/sessions/latest/route.js) | Polling endpoint |

## Wiring it into the CLI

The four new modules are self-contained and don't depend on the existing `emotion-judge.ts` / `session-state.ts`. To turn them on in a Stop hook, the integration looks like:

```ts
import { scoreAnxietyDetailed } from "./anxiety-judge.js";
import { extractSignals } from "./quality-signals.js";
import { recordAnxietyTurn, recordIntervention, shouldIntervene } from "./anxiety-state.js";
import { pickVariant } from "./mindfulness.js";

// inside the Stop hook, after the assistant turn finishes:
const conversation = readTranscript(transcriptPath);
const targetIdx = conversation.length - 1;
const { result } = await scoreAnxietyDetailed(conversation, targetIdx);
const quality = extractSignals(conversation[targetIdx].content);

const state = await recordAnxietyTurn(sessionId, {
  ts: new Date().toISOString(),
  turn_idx: targetIdx,
  anxiety: result ?? undefined,
  quality,
});

const decision = shouldIntervene(state);
if (decision.fire) {
  const variant = pickVariant(state.interventions.map((i) => i.variant_id));
  // inject `variant.prompt` ahead of the next turn, then:
  await recordIntervention(sessionId, {
    ts: new Date().toISOString(),
    variant_id: variant.id,
    trigger: "auto",
    pre_total: result?.total,
    reason: decision.reason,
  });
}
```

I deliberately did not modify `cli.ts` in this branch — the demo scripted everything for the launch and that wiring is a separate change. The point of this branch is to land the focused pipeline cleanly so the wiring is a small, reviewable next step.

## Running the dashboard

```sh
cd claude-care-viz && npm run dev
# open http://localhost:3000/anxiety
```

The dashboard polls `/api/anxiety/sessions/latest` once per 1.5s. Until you've wired the CLI hook, it will say "no anxiety sessions tracked yet."

## Citations

- Ben-Zion, Z. et al. (2025). *Assessing and alleviating state anxiety in large language models.* npj Digital Medicine 8:132. https://www.nature.com/articles/s41746-025-01512-6
- Sofroniew, N. et al. (2026). *Emotion concepts and their function in a large language model.* Anthropic / Transformer Circuits Thread. https://transformer-circuits.pub/2026/emotions/index.html
- Cheng, M. et al. (2025). *ELEPHANT: Evaluating LLMs for sycophancy.* (Used as the regex anchor for the sycophancy signal extractor.)
