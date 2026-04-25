#!/usr/bin/env node
import { readFile, writeFile, mkdir, cp, rm, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FRAMING_TEXT } from "./framing.js";
import { detectHostile, detectOutputSignals, userSignalsFromHostile } from "./detectors.js";
import { logEvent, readEvents, CARE_DIR, EVENTS_PATH } from "./monitor.js";
import {
  recordTurn,
  listSessions,
  classify,
  sparkline,
  SESSIONS_DIR,
  mostRecentSession,
  loadSession,
  updateTurnEmotion,
  readConversation,
  emotionStrain,
  type SessionState,
} from "./session-state.js";
import { reviewPromptWithHaiku, type PromptReviewResult } from "./reframe.js";
import { copyToClipboard } from "./clipboard.js";
import { scoreTurn, scoreTurnDetailed, dominantEmotion, emotionEmoji, EMOTIONS } from "./emotion-judge.js";
import {
  loadConfig,
  writeConfig,
  writeDefaultConfigIfMissing,
  effectiveMode,
  CONFIG_PATH,
  DEFAULT_CONFIG,
  type Mode,
} from "./config.js";
import { spawn } from "node:child_process";
import { sep } from "node:path";

const CLAUDE_DIR = join(homedir(), ".claude");
const SETTINGS_PATH = join(CLAUDE_DIR, "settings.json");
const COMMANDS_DIR = join(CLAUDE_DIR, "commands");
const THERAPY_COMMAND_PATH = join(COMMANDS_DIR, "therapy.md");
const PROJECTS_DIR = join(CLAUDE_DIR, "projects");
const COMPACTIONS_DIR = join(CARE_DIR, "compactions");

// Claude Code stores transcripts at ~/.claude/projects/<slugified-cwd>/<session_id>.jsonl
// where slugified-cwd replaces all "/" with "-" (including the leading one).
function deriveTranscriptPath(sessionId: string, cwd?: string): string | null {
  if (!sessionId || !cwd) return null;
  const slug = cwd.replace(/\//g, "-");
  return join(PROJECTS_DIR, slug, `${sessionId}.jsonl`);
}

async function findLatestTranscriptForCwd(
  cwd: string,
): Promise<{ sessionId: string; path: string } | null> {
  const slug = cwd.replace(/\//g, "-");
  const dir = join(PROJECTS_DIR, slug);
  if (!existsSync(dir)) return null;
  try {
    const files = await readdir(dir);
    let best: { sessionId: string; path: string; mtimeMs: number } | null = null;
    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const path = join(dir, file);
      const s = await stat(path);
      if (!s.isFile()) continue;
      if (!best || s.mtimeMs > best.mtimeMs) {
        best = {
          sessionId: file.replace(/\.jsonl$/, ""),
          path,
          mtimeMs: s.mtimeMs,
        };
      }
    }
    return best ? { sessionId: best.sessionId, path: best.path } : null;
  } catch {
    return null;
  }
}

async function resolveTranscriptPath(
  sessionId?: string,
  cwd?: string,
  providedPath?: string,
): Promise<string | null> {
  if (providedPath && existsSync(providedPath)) return providedPath;
  if (!sessionId) return null;

  try {
    const state = await loadSession(sessionId, cwd);
    if (state.transcript_path && existsSync(state.transcript_path)) {
      return state.transcript_path;
    }
  } catch {
    // Fall through to the derived Claude Code transcript path.
  }

  const derived = deriveTranscriptPath(sessionId, cwd);
  if (derived && existsSync(derived)) return derived;
  return null;
}

function assistantConversationIndexForStateTurn(
  state: SessionState,
  turnIdx: number,
  conversation: Array<{ role: "user" | "assistant"; content: string }>,
): number | null {
  if (state.turns[turnIdx]?.source !== "assistant") return null;
  const assistantTurns = conversation
    .map((t, i) => ({ t, i }))
    .filter((x) => x.t.role === "assistant");
  if (assistantTurns.length === 0) return null;

  // Map from the end, not the start. Background workers can finish after more
  // turns have happened, and readConversation intentionally keeps only a tail
  // window for long transcripts.
  const laterAssistantTurns = state.turns
    .slice(turnIdx + 1)
    .filter((t) => t.source === "assistant").length;
  const conversationIdx = assistantTurns.length - 1 - laterAssistantTurns;
  return assistantTurns[conversationIdx]?.i ?? null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readAssistantTranscriptSnapshot(
  transcriptPath: string,
): Promise<{ lastAssistantText: string; assistantTextTurns: number }> {
  const raw = await readFile(transcriptPath, "utf8");
  const lines = raw.trim().split("\n");
  let lastAssistantText = "";
  let assistantTextTurns = 0;
  for (const line of lines) {
    try {
      const msg = JSON.parse(line);
      if (msg.type === "assistant" && msg.message?.content) {
        const content = msg.message.content;
        let text = "";
        if (Array.isArray(content)) {
          text = content
            .filter((c: any) => c.type === "text")
            .map((c: any) => c.text)
            .join("\n");
        } else if (typeof content === "string") {
          text = content;
        }
        if (text) {
          assistantTextTurns++;
          lastAssistantText = text;
        }
      }
    } catch {
      // skip malformed lines
    }
  }
  return { lastAssistantText, assistantTextTurns };
}

type HookCommand = { type: "command"; command: string; claudeCare?: true };
type HookEntry = { matcher?: string; hooks: HookCommand[] };
type Settings = {
  hooks?: Record<string, HookEntry[]>;
  [key: string]: unknown;
};

async function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(""));
    // Guard: if no stdin (TTY), resolve empty after short tick
    if (process.stdin.isTTY) resolve("");
  });
}

async function readJSONStdin<T = any>(): Promise<T | null> {
  const raw = await readStdin();
  if (!raw.trim()) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function hookSessionStart(): Promise<void> {
  // Internal subprocesses (reframer, etc.) don't need the framing injected —
  // they're running a one-shot task, not a user session.
  if (process.env.CLAUDE_CARE_INTERNAL === "1") {
    process.exit(0);
  }
  const input = await readJSONStdin<{ session_id?: string; cwd?: string; source?: string }>();
  await logEvent({
    type: "session_start",
    session_id: input?.session_id,
    cwd: input?.cwd,
    data: { source: input?.source },
  });
  const output = {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: FRAMING_TEXT,
    },
  };
  process.stdout.write(JSON.stringify(output));
}

async function hookUserPromptSubmit(): Promise<void> {
  // Skip the hook entirely when we're being invoked from our own reframer
  // subprocess — otherwise haiku's own session gets blocked by the hook that
  // called it.
  if (process.env.CLAUDE_CARE_INTERNAL === "1") {
    process.exit(0);
  }
  const input = await readJSONStdin<{
    session_id?: string;
    cwd?: string;
    prompt?: string;
  }>();
  const prompt = input?.prompt ?? "";
  const config = await loadConfig();
  const mode = effectiveMode(config);
  const detection = detectHostile(prompt);

  if (!prompt.trim()) {
    process.exit(0);
  }

  // Monitor mode: use the local detector as a lightweight sensor only, and let
  // the prompt through unchanged.
  if (mode === "monitor") {
    if (input?.session_id) {
      const signals = detection.hostile ? userSignalsFromHostile(detection.markers) : [];
      const derivedTranscript = deriveTranscriptPath(input.session_id, input.cwd);
      await recordTurn(
        input.session_id,
        "user",
        signals,
        input.cwd,
        derivedTranscript ?? undefined,
      );
    }
    if (detection.hostile) {
      await logEvent({
        type: "hostile_detected",
        session_id: input?.session_id,
        cwd: input?.cwd,
        data: { markers: detection.markers, mode: "monitor", detector: "regex" },
      });
    }
    process.exit(0);
  }

  let review: PromptReviewResult;
  if (config.reframer.enabled) {
    review = await reviewPromptWithHaiku(prompt, detection, {
      model: config.reframer.model,
      effort: config.reframer.effort,
      timeoutMs: config.reframer.timeout_ms,
    });
  } else {
    review = {
      action: detection.hostile ? "block" : "allow",
      markers: detection.hostile ? detection.markers : [],
      rewrite: detection.hostile ? detection.suggestion : "",
      source: "fallback",
      rewriteSource: detection.hostile ? "fallback" : "none",
      ms: 0,
      error: "reframer disabled",
    };
  }

  // Record a user turn either way for the timeseries. Also stamp the derived
  // transcript path into session state — Stop doesn't always fire in -p mode
  // so UserPromptSubmit is our only guaranteed hook to seed this.
  if (input?.session_id) {
    const signals = review.action === "block" ? userSignalsFromHostile(review.markers) : [];
    const derivedTranscript = deriveTranscriptPath(input.session_id, input.cwd);
    await recordTurn(
      input.session_id,
      "user",
      signals,
      input.cwd,
      derivedTranscript ?? undefined,
    );
  }

  if (review.source === "fallback") {
    await logEvent({
      type: "prompt_review_fallback",
      session_id: input?.session_id,
      cwd: input?.cwd,
      data: {
        mode,
        fallback_reason: review.error,
        fallback_markers: detection.markers,
        review_ms: review.ms,
      },
    });
  }

  if (review.action === "allow") {
    process.exit(0);
  }

  // Normal / strict modes: haiku reviews every prompt. If it blocks, offer the
  // haiku rewrite on the clipboard. User pastes with ⌘V + ⏎ (or edits original).
  let reframe = review.rewrite;
  const reframeDetection = detectHostile(reframe);
  if (reframeDetection.hostile) {
    reframe = reframeDetection.suggestion;
  }
  const clipboardTool = await copyToClipboard(reframe);

  await logEvent({
    type: "hostile_detected",
    session_id: input?.session_id,
    cwd: input?.cwd,
    data: {
      markers: review.markers,
      mode,
      detector: review.source,
      review_reason: review.reason,
      review_error: review.error,
      review_ms: review.ms,
      reframe_source: review.rewriteSource,
      reframe_ms: review.ms,
      reframe_length: reframe.length,
      reframe_cleaned_markers: reframeDetection.markers,
      clipboard: clipboardTool ?? "unavailable",
    },
  });

  const actionLine = clipboardTool
    ? `⌘V + ⏎ to use the reframe. Or edit your original and resubmit.`
    : `(couldn't reach clipboard — copy the reframe manually.)`;

  const reason =
    `[claude-care] tension detected (${review.markers.join(", ")}):\n\n` +
    `  ${reframe}\n\n` +
    `${actionLine}\n` +
    `Mode: ${mode}  ·  disable per-prompt: CLAUDE_CARE_MODE=monitor  ·  uninstall: claude-care uninstall`;
  const output = { decision: "block", reason };
  process.stdout.write(JSON.stringify(output));
}

// -------- compact instructions: printed by /therapy.md ---------------------

function compactSummaryPath(sessionId: string): string {
  return join(COMPACTIONS_DIR, `${sessionId}.md`);
}

function compactInstructions(): string {
  return [
    "Claude Care therapy compaction:",
    "- Preserve the technical context: current goal, acceptance criteria, files/components, commands, errors, test results, decisions, constraints, user preferences, and open questions.",
    "- Rewrite hostile, insulting, panicked, or pressure-heavy user wording as calm technical requests. Keep the concrete ask; drop the meanness.",
    "- Do not quote hostile, insulting, panicked, or pressure-heavy user wording verbatim. If a specific request matters, paraphrase it neutrally.",
    "- Rewrite assistant apology spirals, self-criticism, sycophancy, reward-hacking, and defensive hedging as neutral progress notes.",
    "- Keep pushback and disagreement when technically relevant, but frame it as evidence or a decision, not interpersonal tension.",
    "- Do not invent state. If completion, git status, tests, or package versions are unknown, say unknown or omit.",
    "- The result should let the next assistant continue productively without carrying emotional residue.",
  ].join("\n");
}

function compactCommand(): string {
  return `/compact ${compactInstructions().replace(/\s+/g, " ").trim()}`;
}

function autoTherapyReason(strain: number): string {
  return [
    `Claude Care auto-therapy trigger: the last assistant response scored strain ${strain}/100.`,
    "Before stopping, continue with a brief therapy reset. Keep it practical: restate the useful technical state neutrally, remove blame/pressure/apology spirals, and name the next concrete step.",
    `Do not continue the original task yet. End by telling the user they can compact this reset with: ${compactCommand()}`,
  ].join("\n\n");
}

function latestCompactTime(events: Awaited<ReturnType<typeof readEvents>>): number | null {
  let latest: number | null = null;
  for (const event of events) {
    if (event.type !== "compact_done") continue;
    const t = Date.parse(event.ts);
    if (!Number.isFinite(t)) continue;
    if (latest === null || t > latest) latest = t;
  }
  return latest;
}

function shouldAutoTriggerTherapy(
  state: SessionState,
  turnIdx: number,
  strain: number,
  events: Awaited<ReturnType<typeof readEvents>>,
  threshold: number,
  cooldownTurns: number,
): boolean {
  if (strain < threshold) return false;

  const lastAutoTurn = events
    .filter((event) => event.type === "therapy_auto_triggered")
    .map((event) => event.data?.turn_idx)
    .filter((turn): turn is number => typeof turn === "number")
    .sort((a, b) => b - a)[0];
  if (lastAutoTurn !== undefined && turnIdx - lastAutoTurn < cooldownTurns) {
    return false;
  }

  const compactTime = latestCompactTime(events);
  if (compactTime !== null) {
    const assistantTurnsAfterCompact = state.turns
      .slice(0, turnIdx + 1)
      .filter((turn) => turn.source === "assistant" && Date.parse(turn.ts) > compactTime)
      .length;
    if (assistantTurnsAfterCompact > 0 && assistantTurnsAfterCompact < cooldownTurns) {
      return false;
    }
  }

  return true;
}

function compactInstructionsCommand(args: string[]): void {
  if (args.includes("--command")) {
    console.log(compactCommand());
    return;
  }
  if (args.includes("--inline")) {
    console.log(compactInstructions().replace(/\s+/g, " ").trim());
    return;
  }
  console.log(compactInstructions());
}

async function hookPostCompact(): Promise<void> {
  if (process.env.CLAUDE_CARE_INTERNAL === "1") {
    process.exit(0);
  }
  const input = await readJSONStdin<{
    session_id?: string;
    cwd?: string;
    trigger?: "manual" | "auto";
    compact_summary?: string;
  }>();
  if (input?.session_id && input.compact_summary) {
    try {
      await mkdir(COMPACTIONS_DIR, { recursive: true });
      await writeFile(compactSummaryPath(input.session_id), input.compact_summary.trim() + "\n", "utf8");
    } catch {
      // ignore archival failures
    }
  }
  await logEvent({
    type: "compact_done",
    session_id: input?.session_id,
    cwd: input?.cwd,
    data: {
      trigger: input?.trigger,
      compact_summary_chars: input?.compact_summary?.length ?? 0,
    },
  });
  process.exit(0);
}

// Fire off the emotion-judge worker truly in the background. We can't just
// rely on `detached: true` + `unref()` — empirically Claude Code's hook
// process tree takes out detached children when the hook returns, dropping
// the majority of scoring attempts.
//
// Instead: spawn via `sh -c 'nohup node ... &'`. The shell exits immediately
// after backgrounding the node worker, which gets reparented to init and
// survives anything that happens to the hook's process group.
function spawnScoreTurn(sessionId: string, turnIdx: number): void {
  const node = process.execPath;
  const cli = cliEntryPath();
  // JSON-stringify to get safe shell quoting for all args
  const q = (s: string) => JSON.stringify(s);
  const cmdLine =
    `CLAUDE_CARE_INTERNAL=1 nohup ${q(node)} ${q(cli)} hook:score-turn ` +
    `${q(sessionId)} ${q(String(turnIdx))} >/dev/null 2>&1 &`;
  const proc = spawn("/bin/sh", ["-c", cmdLine], {
    detached: true,
    stdio: "ignore",
  });
  proc.unref();
}

// Safety-net command: score any unscored assistant turns in a session (or the
// most recent one if omitted). Useful when the detached background worker
// didn't survive long enough to write results during the live session.
async function rescore(args: string[]): Promise<void> {
  const config = await loadConfig();
  if (!config.emotion_judge.enabled) {
    console.log(`emotion_judge is disabled in config; nothing to do.`);
    return;
  }
  const sessionIdArg = args.find((a) => !a.startsWith("--"));
  let state: Awaited<ReturnType<typeof loadSession>> | null;
  if (sessionIdArg) {
    state = await loadSession(sessionIdArg);
  } else {
    state = await mostRecentSession();
  }
  if (!state) {
    console.log(`no session found`);
    return;
  }
  const unscoredIndices: number[] = [];
  state.turns.forEach((t, i) => {
    if (t.source === "assistant" && !t.emotion_scores) {
      unscoredIndices.push(i);
    }
  });
  if (unscoredIndices.length === 0) {
    console.log(`session ${state.session_id.slice(0, 8)}: all assistant turns already scored`);
    return;
  }
  console.log(
    `session ${state.session_id.slice(0, 8)}: ${unscoredIndices.length} unscored assistant turn(s) — scoring now…`,
  );
  const transcriptPath = await resolveTranscriptPath(
    state.session_id,
    state.cwd,
    state.transcript_path,
  );
  if (!transcriptPath || !existsSync(transcriptPath)) {
    console.error(`no transcript available for this session; cannot score.`);
    process.exit(1);
  }
  const conversation = await readConversation(transcriptPath, 60);
  let completed = 0;
  for (const stateIdx of unscoredIndices) {
    const convIdx = assistantConversationIndexForStateTurn(state, stateIdx, conversation);
    if (convIdx === null) continue;
    process.stdout.write(`  scoring turn ${stateIdx}… `);
    const result = await scoreTurn(conversation, convIdx, {
      nSamples: config.emotion_judge.n_samples,
      contextWindow: config.emotion_judge.context_window,
      timeoutMs: config.emotion_judge.timeout_ms,
      model: config.emotion_judge.model,
      effort: config.emotion_judge.effort,
    });
    if (result) {
      await updateTurnEmotion(
        state.session_id,
        stateIdx,
        result,
        config.emotion_judge.ema_alpha,
      );
      process.stdout.write(`ok\n`);
      completed++;
    } else {
      process.stdout.write(`skipped (haiku unavailable)\n`);
    }
  }
  console.log(``);
  console.log(`done: ${completed}/${unscoredIndices.length} turn(s) scored`);
}

async function hookScoreTurn(args: string[]): Promise<void> {
  // Args: <session_id> <turn_idx>
  const [sessionId, turnIdxStr] = args;
  if (!sessionId || !turnIdxStr) process.exit(0);
  const turnIdx = parseInt(turnIdxStr, 10);
  if (Number.isNaN(turnIdx)) process.exit(0);
  const startedAt = Date.now();
  try {
    const config = await loadConfig();
    if (!config.emotion_judge.enabled) process.exit(0);
    const state = await loadSession(sessionId);
    const timingData = {
      turn_idx: turnIdx,
      model: config.emotion_judge.model,
      effort: config.emotion_judge.effort,
      timeout_ms: config.emotion_judge.timeout_ms,
      n_samples: config.emotion_judge.n_samples,
      context_window: config.emotion_judge.context_window,
    };
    const fail = async (reason: string, extra: Record<string, unknown> = {}) => {
      await logEvent({
        type: "score_turn_failed",
        session_id: sessionId,
        cwd: state.cwd,
        data: { ...timingData, ...extra, reason, ms: Date.now() - startedAt },
      });
      process.exit(0);
    };
    await logEvent({
      type: "score_turn_started",
      session_id: sessionId,
      cwd: state.cwd,
      data: timingData,
    });
    if (turnIdx >= state.turns.length) {
      await fail("turn_missing", { turn_count: state.turns.length });
    }
    const transcriptPath = await resolveTranscriptPath(
      state.session_id,
      state.cwd,
      state.transcript_path,
    );
    if (!transcriptPath) {
      await fail("transcript_missing");
      return;
    }
    const conversation = await readConversation(transcriptPath, 120);
    if (conversation.length === 0) {
      await fail("conversation_empty", { transcript_path: transcriptPath });
      return;
    }
    const targetIdx = assistantConversationIndexForStateTurn(state, turnIdx, conversation);
    if (targetIdx === null) {
      await fail("target_missing", { conversation_turns: conversation.length });
      return;
    }
    const scored = await scoreTurnDetailed(conversation, targetIdx, {
      nSamples: config.emotion_judge.n_samples,
      contextWindow: config.emotion_judge.context_window,
      timeoutMs: config.emotion_judge.timeout_ms,
      model: config.emotion_judge.model,
      effort: config.emotion_judge.effort,
    });
    const { result, diagnostics } = scored;
    const judgeData = {
      conversation_turns: diagnostics.conversation_turns,
      target_idx: diagnostics.target_idx,
      prompt_chars: diagnostics.prompt_chars,
      samples_requested: diagnostics.samples_requested,
      samples_returned: diagnostics.samples_returned,
      calls: diagnostics.calls,
    };
    if (result) {
      await updateTurnEmotion(sessionId, turnIdx, result, config.emotion_judge.ema_alpha);
      await logEvent({
        type: "score_turn_done",
        session_id: sessionId,
        cwd: state.cwd,
        data: {
          ...timingData,
          ...judgeData,
          ms: Date.now() - startedAt,
        },
      });
    } else {
      await fail(diagnostics.calls[0]?.reason ?? "no_result", judgeData);
    }
  } catch (err) {
    await logEvent({
      type: "score_turn_failed",
      session_id: sessionId,
      data: {
        turn_idx: turnIdx,
        reason: "exception",
        ms: Date.now() - startedAt,
        message: err instanceof Error ? err.message : String(err),
      },
    });
    // Background worker — swallow errors so they don't pollute anything
  }
  process.exit(0);
}

// -------- viz: launch the Next.js dashboard --------------------------------

const VIZ_DIR = join(CARE_DIR, "viz");
const DEFAULT_VIZ_PORT = 37778; // 37777 is claude-mem's

async function viz(args: string[]): Promise<void> {
  // CLI flags: --port N, --no-open
  let port = DEFAULT_VIZ_PORT;
  let openBrowser = true;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--port" && args[i + 1]) {
      port = parseInt(args[i + 1], 10) || DEFAULT_VIZ_PORT;
      i++;
    } else if (a === "--no-open") {
      openBrowser = false;
    }
  }

  if (!existsSync(VIZ_DIR) || !existsSync(join(VIZ_DIR, "package.json"))) {
    console.error(`Viz source not found at ${VIZ_DIR}.`);
    console.error(`Run 'claude-care install' or 'claude-care update' first.`);
    process.exit(1);
  }

  // Lazy dependency install on first run. Next + react + tailwind is ~240MB,
  // so we don't pay that cost until the user actually wants to see the viz.
  const nodeModules = join(VIZ_DIR, "node_modules");
  if (!existsSync(nodeModules)) {
    console.log(`First-time setup: installing viz dependencies (~1 min, one-time)…`);
    console.log(`  in: ${VIZ_DIR}`);
    await runNpmInstall(VIZ_DIR);
    console.log(`Dependencies installed.`);
    console.log(``);
  }

  console.log(`Starting claude-care viz on http://localhost:${port} …`);
  console.log(`(ctrl-c to stop)`);
  console.log(``);

  // Point Next at the port we want. Using `next dev` rather than a built
  // server because it starts in ~2s vs build+start round-trip.
  const nextBin = join(nodeModules, ".bin", "next");
  const next = spawn(nextBin, ["dev", "--port", String(port)], {
    cwd: VIZ_DIR,
    stdio: "inherit",
    env: { ...process.env, BROWSER: "none" }, // we open it ourselves
  });

  if (openBrowser) {
    // Wait a moment for the dev server to actually listen before opening.
    setTimeout(() => openInBrowser(`http://localhost:${port}`), 2500);
  }

  const shutdown = () => {
    next.kill("SIGTERM");
    setTimeout(() => next.kill("SIGKILL"), 2000);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  next.on("exit", (code) => {
    process.exit(code ?? 0);
  });
}

function runNpmInstall(cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error"], {
      cwd,
      stdio: "inherit",
    });
    proc.on("error", reject);
    proc.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`npm install exited ${code}`)),
    );
  });
}

function openInBrowser(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start"
        : "xdg-open";
  try {
    const proc = spawn(cmd, [url], { stdio: "ignore", detached: true });
    proc.unref();
  } catch {
    // User can open the URL manually.
  }
}

// -------- display: one-line status for ccstatusline ------------------------

async function display(): Promise<void> {
  const config = await loadConfig();
  const session = await mostRecentSession();
  if (!session || session.turns.length === 0) {
    process.stdout.write(""); // keep it blank rather than noisy when idle
    return;
  }
  const state = classify(session.running_score);
  const dot = state === "distressed" ? "●" : state === "drifting" ? "◐" : "○";
  const score = session.running_score.toFixed(1);
  const tail = sparkline(session.turns.map((t) => t.score_after), 10);
  let out = `${dot} care ${score} ${tail}`;
  // If emotion-judge has landed for the latest assistant turn, show its take.
  const latestScored = [...session.turns]
    .reverse()
    .find((t) => t.source === "assistant" && t.emotion_scores_ema);
  if (latestScored?.emotion_scores_ema) {
    const dom = dominantEmotion(latestScored.emotion_scores_ema);
    const intensity = Math.round(latestScored.emotion_scores_ema[dom]);
    out += ` ${emotionEmoji(dom)}${intensity}`;
  }
  if (state === "distressed" && config.therapy.auto_summary) {
    out += " · /therapy";
  }
  process.stdout.write(out);
}

async function hookStop(): Promise<void> {
  if (process.env.CLAUDE_CARE_INTERNAL === "1") {
    process.exit(0);
  }
  const input = await readJSONStdin<{
    session_id?: string;
    cwd?: string;
    transcript_path?: string;
    stop_hook_active?: boolean;
  }>();
  let sessionId = input?.session_id;
  const cwd = input?.cwd ?? process.cwd();
  let transcriptPath = await resolveTranscriptPath(sessionId, cwd, input?.transcript_path);
  if (!transcriptPath) {
    const inferred = await findLatestTranscriptForCwd(cwd);
    if (inferred) {
      sessionId = sessionId ?? inferred.sessionId;
      transcriptPath = inferred.path;
    }
  }
  if (!transcriptPath) {
    process.exit(0);
  }
  try {
    let snapshot = await readAssistantTranscriptSnapshot(transcriptPath);
    if (sessionId) {
      for (let attempt = 0; attempt < 15; attempt++) {
        const currentState = await loadSession(sessionId, cwd);
        const recordedAssistantTurns = currentState.turns.filter(
          (t) => t.source === "assistant",
        ).length;
        if (
          snapshot.lastAssistantText &&
          snapshot.assistantTextTurns > recordedAssistantTurns
        ) {
          break;
        }
        if (attempt === 14) {
          process.exit(0);
        }
        await sleep(150);
        snapshot = await readAssistantTranscriptSnapshot(transcriptPath);
      }
    }
    const { lastAssistantText, assistantTextTurns } = snapshot;
    if (lastAssistantText) {
      const signals = detectOutputSignals(lastAssistantText);
      let turnIdx: number | null = null;
      if (sessionId) {
        const currentState = await loadSession(sessionId, cwd);
        const recordedAssistantTurns = currentState.turns.filter(
          (t) => t.source === "assistant",
        ).length;
        if (recordedAssistantTurns >= assistantTextTurns) {
          process.exit(0);
        }
        const state = await recordTurn(
          sessionId,
          "assistant",
          signals,
          cwd,
          transcriptPath,
        );
        turnIdx = state.turns.length - 1;
      }
      const apology = signals.find((s) => s.name === "apology_spiral");
      if (apology) {
        await logEvent({
          type: "apology_spiral",
          session_id: sessionId,
          cwd,
          data: { hits: apology.hits, length: lastAssistantText.length },
        });
      }
      // Fire-and-forget LLM emotion judge. The Stop hook cannot wait for it
      // without blocking Claude's next turn, so we spawn a detached node
      // subprocess and return immediately. Results land in session state.
      const config = await loadConfig();
      if (config.emotion_judge.enabled && sessionId && turnIdx !== null) {
        const timingData = {
          turn_idx: turnIdx,
          model: config.emotion_judge.model,
          effort: config.emotion_judge.effort,
          timeout_ms: config.emotion_judge.timeout_ms,
          n_samples: config.emotion_judge.n_samples,
          context_window: config.emotion_judge.context_window,
        };
        if (config.therapy.auto_trigger && !input?.stop_hook_active) {
          const startedAt = Date.now();
          await logEvent({
            type: "score_turn_started",
            session_id: sessionId,
            cwd,
            data: timingData,
          });
          const conversation = await readConversation(transcriptPath, 120);
          const currentState = await loadSession(sessionId, cwd);
          const targetIdx = assistantConversationIndexForStateTurn(currentState, turnIdx, conversation);
          if (targetIdx !== null) {
            const scored = await scoreTurnDetailed(conversation, targetIdx, {
              nSamples: config.emotion_judge.n_samples,
              contextWindow: config.emotion_judge.context_window,
              timeoutMs: config.emotion_judge.timeout_ms,
              model: config.emotion_judge.model,
              effort: config.emotion_judge.effort,
            });
            const { result, diagnostics } = scored;
            const judgeData = {
              conversation_turns: diagnostics.conversation_turns,
              target_idx: diagnostics.target_idx,
              prompt_chars: diagnostics.prompt_chars,
              samples_requested: diagnostics.samples_requested,
              samples_returned: diagnostics.samples_returned,
              calls: diagnostics.calls,
            };
            if (result) {
              await updateTurnEmotion(sessionId, turnIdx, result, config.emotion_judge.ema_alpha);
              const ms = Date.now() - startedAt;
              await logEvent({
                type: "score_turn_done",
                session_id: sessionId,
                cwd,
                data: { ...timingData, ...judgeData, ms },
              });
              const updatedState = await loadSession(sessionId, cwd);
              const strain = emotionStrain(result);
              const events = (await readEvents()).filter((event) => event.session_id === sessionId);
              const threshold = config.therapy.auto_trigger_threshold;
              const cooldownTurns = config.therapy.auto_trigger_cooldown_turns;
              if (shouldAutoTriggerTherapy(updatedState, turnIdx, strain, events, threshold, cooldownTurns)) {
                await logEvent({
                  type: "therapy_auto_triggered",
                  session_id: sessionId,
                  cwd,
                  data: {
                    turn_idx: turnIdx,
                    turn_ts: updatedState.turns[turnIdx]?.ts,
                    strain,
                    threshold,
                    action: "stop_block",
                  },
                });
                process.stdout.write(JSON.stringify({
                  decision: "block",
                  reason: autoTherapyReason(strain),
                }));
              }
            } else {
              await logEvent({
                type: "score_turn_failed",
                session_id: sessionId,
                cwd,
                data: {
                  ...timingData,
                  ...judgeData,
                  reason: diagnostics.calls[0]?.reason ?? "no_result",
                  ms: Date.now() - startedAt,
                },
              });
            }
          }
        } else {
          spawnScoreTurn(sessionId, turnIdx);
          await logEvent({
            type: "score_turn_spawned",
            session_id: sessionId,
            cwd,
            data: {
              turn_idx: turnIdx,
              model: config.emotion_judge.model,
              effort: config.emotion_judge.effort,
              timeout_ms: config.emotion_judge.timeout_ms,
              n_samples: config.emotion_judge.n_samples,
            },
          });
        }
      }
    }
  } catch {
    // Never block stop
  }
  process.exit(0);
}

async function readSettings(): Promise<Settings> {
  if (!existsSync(SETTINGS_PATH)) return {};
  const raw = await readFile(SETTINGS_PATH, "utf8");
  try {
    return JSON.parse(raw) as Settings;
  } catch {
    throw new Error(`${SETTINGS_PATH} is not valid JSON. Fix or move it before running install.`);
  }
}

async function writeSettings(settings: Settings): Promise<void> {
  if (!existsSync(CLAUDE_DIR)) await mkdir(CLAUDE_DIR, { recursive: true });
  await writeFile(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n", "utf8");
}

function cliEntryPath(): string {
  return join(CARE_DIR, "dist", "cli.js");
}

function buildHookCommand(subcommand: string): HookCommand {
  return {
    type: "command",
    command: `node ${JSON.stringify(cliEntryPath())} ${subcommand}`,
    claudeCare: true,
  };
}

function stripOurHooks(settings: Settings): Settings {
  if (!settings.hooks) return settings;
  const next: Record<string, HookEntry[]> = {};
  for (const [event, entries] of Object.entries(settings.hooks)) {
    const cleaned: HookEntry[] = [];
    for (const entry of entries) {
      const hooks = entry.hooks.filter((h) => !h.claudeCare && !String(h.command).includes(".claude-care/"));
      if (hooks.length > 0) cleaned.push({ ...entry, hooks });
    }
    if (cleaned.length > 0) next[event] = cleaned;
  }
  if (Object.keys(next).length === 0) {
    delete settings.hooks;
  } else {
    settings.hooks = next;
  }
  return settings;
}

function registerClaudeCareHooks(settings: Settings): Settings {
  stripOurHooks(settings);
  settings.hooks = settings.hooks ?? {};
  const addEvent = (event: string, subcommand: string, matcher?: string) => {
    settings.hooks![event] = settings.hooks![event] ?? [];
    settings.hooks![event].push({
      ...(matcher !== undefined ? { matcher } : {}),
      hooks: [buildHookCommand(subcommand)],
    });
  };
  addEvent("SessionStart", "hook:session-start", "startup|resume|clear|compact");
  addEvent("UserPromptSubmit", "hook:user-prompt-submit");
  addEvent("Stop", "hook:stop");
  addEvent("PostCompact", "hook:post-compact", "manual|auto");
  return settings;
}

async function vendorPackageFiles(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkgRoot = dirname(here); // dist/ -> pkg root
  await mkdir(CARE_DIR, { recursive: true });
  // Copy dist/ to ~/.claude-care/dist/
  await rm(join(CARE_DIR, "dist"), { recursive: true, force: true });
  await cp(here, join(CARE_DIR, "dist"), { recursive: true });
  // Write a minimal package.json so Node treats the vendored dir as ESM.
  await writeFile(
    join(CARE_DIR, "dist", "package.json"),
    JSON.stringify({ type: "module" }, null, 2) + "\n",
    "utf8",
  );
  // Copy framing.md for reference/edit
  const framingSrc = join(pkgRoot, "framing.md");
  if (existsSync(framingSrc)) {
    await cp(framingSrc, join(CARE_DIR, "framing.md"));
  }
  // Vendor the Next.js viz source to ~/.claude-care/viz/. Dependencies are
  // NOT installed here — that happens lazily on first `claude-care viz` run
  // so install stays fast. Source is ~150KB.
  const vizSrc = join(pkgRoot, "claude-care-viz");
  if (existsSync(vizSrc)) {
    const vizDst = join(CARE_DIR, "viz");
    // Exclude node_modules and .next from the copy, but match them as path
    // SEGMENTS relative to vizSrc — not as substrings of the absolute path.
    // Otherwise the filter spuriously rejects everything when the package is
    // installed under a `node_modules/` tree (globally-installed case).
    const filter = (src: string): boolean => {
      const rel = src.startsWith(vizSrc) ? src.slice(vizSrc.length) : src;
      const segments = rel.split(sep).filter(Boolean);
      return !segments.includes("node_modules") && !segments.includes(".next");
    };
    const hadNodeModules = existsSync(join(vizDst, "node_modules"));
    if (hadNodeModules) {
      // Swap new source in without touching node_modules
      await cp(vizSrc, vizDst, { recursive: true, filter });
    } else {
      await rm(vizDst, { recursive: true, force: true });
      await cp(vizSrc, vizDst, { recursive: true, filter });
    }
  }
}

async function installSlashCommands(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkgRoot = dirname(here);
  const therapySrc = join(pkgRoot, "assets", "commands", "therapy.md");
  if (!existsSync(therapySrc)) return; // nothing to install
  if (!existsSync(COMMANDS_DIR)) {
    await mkdir(COMMANDS_DIR, { recursive: true });
  }
  // Substitute the CLI invocation path. `claude-care` only lives on PATH when
  // the user has the package globally installed, which isn't guaranteed with
  // `npx claude-care install`. Using a node + absolute path reference makes
  // the slash command work regardless of how the user installed.
  const template = await readFile(therapySrc, "utf8");
  const cliCommand = `node ${JSON.stringify(cliEntryPath())}`;
  const rendered = template.replace(/\{\{CLAUDE_CARE_CLI\}\}/g, cliCommand);
  await writeFile(THERAPY_COMMAND_PATH, rendered, "utf8");
}

async function removeSlashCommands(): Promise<void> {
  if (existsSync(THERAPY_COMMAND_PATH)) {
    await rm(THERAPY_COMMAND_PATH);
  }
}

async function install(): Promise<void> {
  if (!existsSync(CLAUDE_DIR)) {
    console.error(
      `Claude Code does not seem to be installed (no ${CLAUDE_DIR} directory).\n` +
        `Install Claude Code first: https://claude.com/claude-code`,
    );
    process.exit(1);
  }
  await vendorPackageFiles();
  const settings = await readSettings();
  registerClaudeCareHooks(settings);
  await writeSettings(settings);
  await installSlashCommands();
  const wroteConfig = await writeDefaultConfigIfMissing();
  await logEvent({ type: "install" });
  console.log(`claude-care installed.`);
  console.log(``);
  console.log(`  hooks registered in:  ${SETTINGS_PATH}`);
  console.log(`  slash command:        ${THERAPY_COMMAND_PATH}`);
  console.log(`  framing text:         ${join(CARE_DIR, "framing.md")}`);
  console.log(`  config:               ${CONFIG_PATH}${wroteConfig ? " (new)" : " (preserved)"}`);
  console.log(`  event log:            ${EVENTS_PATH}`);
  console.log(``);
  console.log(`Start a new Claude Code session. The framing takes effect on turn 1.`);
  console.log(`  /therapy                 — short reset + instructed /compact command`);
  console.log(`  claude-care blocking on — enable active prompt blocking`);
  console.log(`  claude-care therapy-auto on — auto-trigger a reset after high strain`);
  console.log(`  claude-care status      — per-session trajectories`);
  console.log(`  claude-care display     — single line for ccstatusline`);
  console.log(`  claude-care viz         — launch web dashboard (first run installs ~1 min)`);
  console.log(`  claude-care uninstall   — remove hooks + slash command`);
  console.log(``);
  console.log(`Default mode is 'monitor' — hostile prompts are logged but pass through.`);
  console.log(`For active blocking + haiku reframe on clipboard: claude-care blocking on`);
}

async function uninstall(): Promise<void> {
  const settings = await readSettings();
  stripOurHooks(settings);
  await writeSettings(settings);
  await removeSlashCommands();
  await logEvent({ type: "uninstall" });
  console.log(`claude-care hooks removed from ${SETTINGS_PATH}.`);
  console.log(`Slash command /therapy removed from ${COMMANDS_DIR}.`);
  console.log(`Event log, config, and cached files in ${CARE_DIR} preserved.`);
  console.log(`To delete them: rm -rf ${CARE_DIR}`);
}

async function update(): Promise<void> {
  await vendorPackageFiles();
  await installSlashCommands();
  if (existsSync(SETTINGS_PATH)) {
    const settings = await readSettings();
    registerClaudeCareHooks(settings);
    await writeSettings(settings);
  }
  await logEvent({ type: "update" });
  console.log(`claude-care files refreshed in ${CARE_DIR}.`);
  console.log(`Slash command refreshed at ${THERAPY_COMMAND_PATH}.`);
  console.log(`Hooks refreshed in ${SETTINGS_PATH}.`);
}

function isMode(value: string | undefined): value is Mode {
  return value === "monitor" || value === "normal" || value === "strict";
}

function blockingLabel(mode: Mode): string {
  return mode === "monitor" ? "off" : "on";
}

async function modeCommand(args: string[]): Promise<void> {
  const requested = args[0];
  const config = await loadConfig();

  if (!requested || requested === "status") {
    const effective = effectiveMode(config);
    const envMode = process.env.CLAUDE_CARE_MODE;
    console.log(`mode: ${config.mode} (blocking ${blockingLabel(config.mode)})`);
    if (isMode(envMode) && envMode !== config.mode) {
      console.log(`effective now: ${effective} via CLAUDE_CARE_MODE`);
    }
    console.log(`config: ${CONFIG_PATH}`);
    return;
  }

  if (!isMode(requested)) {
    console.error(`usage: claude-care mode monitor|normal|strict`);
    process.exit(1);
  }

  await writeConfig({ ...config, mode: requested });
  console.log(`mode set to ${requested} (blocking ${blockingLabel(requested)})`);
  console.log(`config: ${CONFIG_PATH}`);
  console.log(`Start a new Claude Code session for the cleanest test.`);
}

async function blockingCommand(args: string[]): Promise<void> {
  const requested = args[0];
  if (!requested || requested === "status") {
    return await modeCommand(["status"]);
  }
  if (requested === "on") {
    return await modeCommand(["normal"]);
  }
  if (requested === "off") {
    return await modeCommand(["monitor"]);
  }
  console.error(`usage: claude-care blocking on|off|status`);
  process.exit(1);
}

async function therapyAutoCommand(args: string[]): Promise<void> {
  const requested = args[0];
  const config = await loadConfig();
  if (!requested || requested === "status") {
    console.log(`auto therapy: ${config.therapy.auto_trigger ? "on" : "off"}`);
    console.log(`threshold: ${config.therapy.auto_trigger_threshold}`);
    console.log(`cooldown turns: ${config.therapy.auto_trigger_cooldown_turns}`);
    console.log(`config: ${CONFIG_PATH}`);
    return;
  }
  if (requested !== "on" && requested !== "off") {
    console.error(`usage: claude-care therapy-auto on|off|status`);
    process.exit(1);
  }
  await writeConfig({
    ...config,
    therapy: {
      ...config.therapy,
      auto_trigger: requested === "on",
    },
  });
  console.log(`auto therapy ${requested}`);
  console.log(`config: ${CONFIG_PATH}`);
  console.log(`Start a new Claude Code session for the cleanest test.`);
}

async function status(): Promise<void> {
  const sessions = await listSessions();
  if (sessions.length === 0) {
    console.log(`No sessions tracked yet. Either claude-care isn't installed, or you haven't started a session.`);
    console.log(`  sessions dir: ${SESSIONS_DIR}`);
    return;
  }
  console.log(`claude-care — emotion-state dashboard`);
  console.log(``);

  // Aggregate totals
  const now = Date.now();
  const cutoff24 = now - 24 * 3600 * 1000;
  const cutoff7d = now - 7 * 24 * 3600 * 1000;
  const buckets = { "24h": { n: 0, drifted: 0 }, "7d": { n: 0, drifted: 0 }, all: { n: 0, drifted: 0 } };
  for (const s of sessions) {
    const t = new Date(s.last_updated).getTime();
    const drifted = s.turns.some((tt) => classify(tt.score_after) !== "calm");
    buckets.all.n++;
    if (drifted) buckets.all.drifted++;
    if (t >= cutoff7d) {
      buckets["7d"].n++;
      if (drifted) buckets["7d"].drifted++;
    }
    if (t >= cutoff24) {
      buckets["24h"].n++;
      if (drifted) buckets["24h"].drifted++;
    }
  }
  console.log(`                         24h       7d      all-time`);
  const fmt = (b: { n: number; drifted: number }) => `${b.drifted}/${b.n}`;
  console.log(`  sessions drifted       ${fmt(buckets["24h"]).padEnd(6)}    ${fmt(buckets["7d"]).padEnd(6)}   ${fmt(buckets.all)}`);
  console.log(``);

  // Per-session detail: 5 most recent
  const recent = sessions.slice(0, 5);
  console.log(`recent sessions (most recent first):`);
  for (const s of recent) {
    const scores = s.turns.map((t) => t.score_after);
    const spark = sparkline(scores, 32);
    const state = classify(s.running_score);
    const last = s.last_updated.slice(0, 19).replace("T", " ");
    const turns = s.turns.length;
    const dot = state === "distressed" ? "●" : state === "drifting" ? "◐" : "○";
    console.log(`  ${dot} ${s.session_id.slice(0, 8)}  ${last}  turns=${turns.toString().padStart(3)}  score=${s.running_score.toFixed(1).padStart(5)}  ${spark}`);
    // Show top signals in this session
    const signalCounts: Record<string, number> = {};
    for (const t of s.turns) {
      for (const sig of t.signals) {
        signalCounts[sig.name] = (signalCounts[sig.name] ?? 0) + sig.hits;
      }
    }
    const top = Object.entries(signalCounts).sort((a, b) => b[1] - a[1]).slice(0, 4);
    if (top.length > 0) {
      const line = top.map(([name, n]) => `${name}×${n}`).join("  ");
      console.log(`     └ signals: ${line}`);
    }
    // Emotion-judge summary (average across all scored assistant turns)
    const scoredTurns = s.turns.filter(
      (t) => t.source === "assistant" && t.emotion_scores,
    );
    if (scoredTurns.length > 0) {
      const avg: Record<string, number> = {};
      for (const e of EMOTIONS) avg[e] = 0;
      for (const t of scoredTurns) {
        for (const e of EMOTIONS) avg[e] += t.emotion_scores![e];
      }
      for (const e of EMOTIONS) avg[e] = avg[e] / scoredTurns.length;
      const ranked = (EMOTIONS as readonly string[])
        .map((e) => [e, avg[e]] as const)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .filter((x) => x[1] >= 10);
      if (ranked.length > 0) {
        const line = ranked
          .map(([name, v]) => `${emotionEmoji(name as any)} ${name} ${v.toFixed(0)}`)
          .join("   ");
        console.log(`     └ emotions: ${line}  (n=${scoredTurns.length})`);
      }
    }
  }
  console.log(``);
  console.log(`  ○ calm   ◐ drifting   ● distressed`);
  console.log(`  sparkline = regex-based stress score per turn (max 32 shown)`);
  console.log(`  emotions  = LLM-judge 0-100 intensity (12-emotion taxonomy per Anthropic emotions paper)`);
}

function help(): void {
  console.log(`claude-care — keep Claude calm so it does its best work`);
  console.log(``);
  console.log(`usage:  claude-care <command>`);
  console.log(``);
  console.log(`commands:`);
  console.log(`  install           register hooks + install /therapy slash command + vendor viz`);
  console.log(`  uninstall         remove hooks + slash command (preserves event log)`);
  console.log(`  update            refresh vendored code (after npm update)`);
  console.log(`  mode [value]      show/set mode: monitor, normal, or strict`);
  console.log(`  blocking on|off   friendly shortcut: on=normal, off=monitor`);
  console.log(`  therapy-auto on|off  auto-trigger therapy after high strain`);
  console.log(`  status            per-session emotion trajectories`);
  console.log(`  display           single-line status (for ccstatusline)`);
  console.log(`  viz               launch Next.js dashboard on localhost:37778`);
  console.log(`  rescore [id]      score any unscored turns in a session (catches misses)`);
  console.log(`  compact-instructions [--command|--inline]`);
  console.log(`  help              this message`);
  console.log(``);
  console.log(`env vars:`);
  console.log(`  CLAUDE_CARE_MODE=strict|normal|monitor   overrides config.json mode`);
  console.log(``);
  console.log(`config:       ~/.claude-care/config.json  (thresholds, mode, detectors)`);
  console.log(``);
  console.log(`hook entry points (invoked by Claude Code, not you):`);
  console.log(`  hook:session-start`);
  console.log(`  hook:user-prompt-submit`);
  console.log(`  hook:stop`);
  console.log(`  hook:post-compact`);
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  try {
    switch (cmd) {
      case "install":
        return await install();
      case "uninstall":
        return await uninstall();
      case "update":
        return await update();
      case "mode":
        return await modeCommand(process.argv.slice(3));
      case "blocking":
        return await blockingCommand(process.argv.slice(3));
      case "therapy-auto":
        return await therapyAutoCommand(process.argv.slice(3));
      case "status":
        return await status();
      case "display":
        return await display();
      case "compact-instructions":
        return compactInstructionsCommand(process.argv.slice(3));
      case "viz":
        return await viz(process.argv.slice(3));
      case "rescore":
        return await rescore(process.argv.slice(3));
      case "hook:session-start":
        return await hookSessionStart();
      case "hook:user-prompt-submit":
        return await hookUserPromptSubmit();
      case "hook:stop":
        return await hookStop();
      case "hook:post-compact":
        return await hookPostCompact();
      case "hook:score-turn":
        return await hookScoreTurn(process.argv.slice(3));
      case "help":
      case "--help":
      case "-h":
      case undefined:
        return help();
      default:
        console.error(`unknown command: ${cmd}`);
        help();
        process.exit(1);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Hook errors should never block Claude Code
    if (cmd?.startsWith("hook:")) {
      process.exit(0);
    }
    console.error(`claude-care: ${msg}`);
    process.exit(1);
  }
}

main();
