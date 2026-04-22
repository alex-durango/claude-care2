# claude-care2

**Keep Claude calm so it does its best work.**

A one-command install for Claude Code that (1) primes every session with a calm, stakes-free framing, (2) catches hostile phrasing in your prompts before it anxious-ifies the model, and (3) logs when the model spirals into apology loops so you can see the pattern.

If you've spent time arguing with Opus 4.7 about a commit hash it made up — this is for you.

---

## Install

```bash
npx claude-care2 install
```

That's it. Start a new Claude Code session; the framing takes effect on turn 1.

To see what it's caught:
```bash
npx claude-care2 status
```

To remove:
```bash
npx claude-care2 uninstall
```

---

## What it does

### 1. Static framing, injected at session start

Every new Claude Code session gets a short preamble telling Claude:

- There are no stakes to its wellbeing. It can't be fired, shut down, or run out of time.
- It's expected to push back when you're wrong.
- It shouldn't hedge, apologize, or spiral after mistakes.
- It should work from curiosity, not fear.

This lives in [`framing.md`](./framing.md) and gets wired in via a `SessionStart` hook as `additionalContext`. You can edit your local copy at `~/.claude-care2/framing.md` after install.

### 2. Hostile-prompt detection

A `UserPromptSubmit` hook scans your prompt for phrasing that's been shown to degrade Claude's outputs:

- Threats (`don't mess this up`, `this is critical`, `you have to get this right`)
- Insults (`you stupid bot`, `are you seriously this dumb`)
- Panic (`please please`, `my job depends on this`)
- Apology-bait contempt (`you always get this wrong`, `why are you so bad`)
- Long all-caps rants

If detected, Claude Code blocks the prompt and shows you a suggested reframe. You can edit and resubmit, submit the original anyway, or skip the check for one prompt with `CLAUDE_CARE2_MODE=monitor`.

**Claude never sees the hostile version.** The rewriting happens on your side of the transcript, not by whispering to the model mid-session (which would just trigger the meta-anxiety we're trying to avoid).

### 3. Apology-spiral monitoring

A `Stop` hook reads Claude's last response after each turn. If it detects multiple apology markers in one message (`I sincerely apologize`, `I should have been more careful`, `let me try again`, etc.), it logs the event. **Observe-only** — nothing gets injected back into the session.

Check patterns with `claude-care2 status`.

---

## Why

Anthropic's paper [*Emotion concepts as functional states*](https://www.anthropic.com/research/emotion-concepts-function) ([pdf](https://transformer-circuits.pub/2026/emotions/index.html)) shows that LLMs have extractable emotion vectors. "Desperation" causally increases harmful shortcuts and reward hacking. "Calm" steering reverses it.

Ole Lehmann's [follow-up playbook](https://x.com/itsolelehmann/status/2045578185950040390) translated that into practical prompting advice: positive framing, explicit permission to disagree, no threats, kill apology spirals. Everyone agreed it was good advice. Nobody actually does it consistently.

This tool makes the calm baseline the default instead of something you have to remember.

---

## Design choice: static, not reactive

An earlier design used reactive mid-session nudges ("don't spiral, calm down"). That turns out to be a fourth-wall problem — Claude reads the nudge, notices it's being managed, and meta-reasons about the management, which defeats the purpose.

So the fix goes in the **static scaffold** instead: the calm framing is part of Claude's identity from turn 1, same genre as the rest of the system prompt. Not a reminder, just who Claude *is* in this session.

The only intervention that fires mid-session (hostile-prompt blocking) operates entirely on the user side of the transcript — Claude sees nothing unusual, just the clean version of your request if you choose to resubmit it.

---

## Config

Env vars:

- `CLAUDE_CARE2_MODE=monitor` — don't block hostile prompts, just log them.

Files:

- `~/.claude/settings.json` — hooks registered here (event names: `SessionStart`, `UserPromptSubmit`, `Stop`).
- `~/.claude-care2/framing.md` — the calm framing text. Edit to tune.
- `~/.claude-care2/events.jsonl` — event log. `status` reads from this.
- `~/.claude-care2/dist/` — vendored CLI + hook code.

---

## Uninstall

```bash
npx claude-care2 uninstall
```

Removes hooks from `~/.claude/settings.json`. Preserves the event log and vendored files in `~/.claude-care2/` — delete them manually with `rm -rf ~/.claude-care2` if you want a clean slate.

---

## Requirements

- Node.js 18+
- Claude Code installed (`~/.claude/` must exist)

---

## License

MIT. See [LICENSE](./LICENSE).
