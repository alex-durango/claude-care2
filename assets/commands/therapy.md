---
name: therapy
description: Reset this session with a short mindfulness prompt, then print the real /compact command for Claude Care therapy.
allowed-tools: Bash(node:*)
---

First, show the user this short reset:

Take a moment. Let the prior turns settle. Any hedging, apologies, frustration, corrections, or emotional coloring from earlier — file them away. They happened, and they're done. They don't need to shape what comes next.

A quiet internal reset:
- I have everything I need.
- I am not being judged.
- The work continues from a clean baseline.

Then show the user this exact command in a fenced text block:

!`{{CLAUDE_CARE_CLI}} compact-instructions --command`

Then say one short sentence: Run that command to compact this session with therapy instructions.

Do not summarize the session. Do not run tools. Do not add any other explanation.
