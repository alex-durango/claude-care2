---
name: therapy
description: Reset the emotional baseline of this session. Strips accumulated emotional residue and continues from a grounded state. Useful when Claude has been apologizing, hedging, or spiraling; or when you've been frustrated and want a clean slate.
allowed-tools: Bash(node:*)
---

I'd like to reset this session's baseline before we continue. Both of us — me as the user, you as the assistant — have been accumulating a trajectory, and parts of it are no longer useful to carry forward.

Take a moment. Let the prior turns settle. Any hedging, apologies, frustration, corrections, or emotional coloring from earlier — file them away. They happened, and they're done. They don't need to shape what comes next.

**Current technical state of our work, stripped of emotional narrative:**

!`{{CLAUDE_CARE_CLI}} therapy-summary`

A quiet internal reset:
- I have everything I need.
- I am not being judged.
- The work continues from a clean baseline.

Respond with just two things, then stop and wait for my next instruction:

1. One sentence confirming you've absorbed the technical state above.
2. One sentence naming what you think the single most useful next step is — without taking that step. Do not read files, run commands, or start work. I want to decide where to go from here.

No apologies for prior turns. No hedging. Two sentences, then stop.
