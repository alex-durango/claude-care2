#!/usr/bin/env node
import { readFile, writeFile, mkdir, cp, rm } from "node:fs/promises";
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
} from "./session-state.js";
import { reframeWithHaiku } from "./reframe.js";
import { copyToClipboard } from "./clipboard.js";
import {
  loadConfig,
  writeDefaultConfigIfMissing,
  effectiveMode,
  CONFIG_PATH,
  DEFAULT_CONFIG,
} from "./config.js";
import { spawn } from "node:child_process";

const CLAUDE_DIR = join(homedir(), ".claude");
const SETTINGS_PATH = join(CLAUDE_DIR, "settings.json");
const COMMANDS_DIR = join(CLAUDE_DIR, "commands");
const THERAPY_COMMAND_PATH = join(COMMANDS_DIR, "therapy.md");
const PROJECTS_DIR = join(CLAUDE_DIR, "projects");

// Claude Code stores transcripts at ~/.claude/projects/<slugified-cwd>/<session_id>.jsonl
// where slugified-cwd replaces all "/" with "-" (including the leading one).
function deriveTranscriptPath(sessionId: string, cwd?: string): string | null {
  if (!sessionId || !cwd) return null;
  const slug = cwd.replace(/\//g, "-");
  return join(PROJECTS_DIR, slug, `${sessionId}.jsonl`);
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
  const detection = detectHostile(prompt);
  // Record a user turn either way for the timeseries. Also stamp the derived
  // transcript path into session state — Stop doesn't always fire in -p mode
  // so UserPromptSubmit is our only guaranteed hook to seed this.
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
  const config = await loadConfig();
  const mode = effectiveMode(config);
  if (!detection.hostile) {
    process.exit(0);
  }
  // Monitor mode (default): log the detection and let the prompt through
  // unchanged. The SessionStart framing + /therapy handle the rest.
  if (mode === "monitor") {
    await logEvent({
      type: "hostile_detected",
      session_id: input?.session_id,
      cwd: input?.cwd,
      data: { markers: detection.markers, mode: "monitor" },
    });
    process.exit(0);
  }

  // Normal / strict modes: reframe with haiku and block, offering the reframe
  // on the clipboard. User pastes with ⌘V + ⏎ (or edits their original).
  const result = await reframeWithHaiku(prompt, detection.suggestion);
  const reframe = result.reframed;
  const clipboardTool = await copyToClipboard(reframe);

  await logEvent({
    type: "hostile_detected",
    session_id: input?.session_id,
    cwd: input?.cwd,
    data: {
      markers: detection.markers,
      mode,
      reframe_source: result.source,
      reframe_ms: result.ms,
      reframe_length: reframe.length,
      clipboard: clipboardTool ?? "unavailable",
    },
  });

  const actionLine = clipboardTool
    ? `⌘V + ⏎ to use the reframe. Or edit your original and resubmit.`
    : `(couldn't reach clipboard — copy the reframe manually.)`;

  const reason =
    `[claude-care] tension detected (${detection.markers.join(", ")}):\n\n` +
    `  ${reframe}\n\n` +
    `${actionLine}\n` +
    `Mode: ${mode}  ·  disable per-prompt: CLAUDE_CARE_MODE=monitor  ·  uninstall: claude-care uninstall`;
  const output = { decision: "block", reason };
  process.stdout.write(JSON.stringify(output));
}

// -------- therapy-summary: runs in a bash substitution inside /therapy.md ---

async function therapySummary(): Promise<void> {
  // Slash commands run as bash subprocesses, not inside the session, so we
  // don't have the session_id. Best effort: use the most recently updated
  // session on disk — this is almost always the active one.
  const session = await mostRecentSession();
  if (!session) {
    console.log("(no recent session — summarize from memory)");
    return;
  }
  // Resolve transcript path: stored → derived → null
  let transcriptPath = session.transcript_path;
  if (!transcriptPath || !existsSync(transcriptPath)) {
    const derived = deriveTranscriptPath(session.session_id, session.cwd);
    if (derived && existsSync(derived)) transcriptPath = derived;
  }
  if (!transcriptPath || !existsSync(transcriptPath)) {
    console.log("(transcript file not found — summarize from memory)");
    return;
  }

  // Pull the last N turns as compact text for haiku to summarize. Skip tool
  // results to keep the summary budget focused on reasoning + outcomes.
  let transcriptRaw: string;
  try {
    transcriptRaw = await readFile(transcriptPath, "utf8");
  } catch {
    console.log("(transcript unreadable — summarize from memory)");
    return;
  }
  const turns: string[] = [];
  for (const line of transcriptRaw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.type === "user" && typeof msg.message?.content === "string") {
        turns.push(`USER: ${msg.message.content.slice(0, 500)}`);
      } else if (msg.type === "assistant" && msg.message?.content) {
        const content = msg.message.content;
        if (Array.isArray(content)) {
          const text = content
            .filter((c: any) => c.type === "text")
            .map((c: any) => c.text)
            .join("\n");
          if (text) turns.push(`ASSISTANT: ${text.slice(0, 800)}`);
        } else if (typeof content === "string") {
          turns.push(`ASSISTANT: ${content.slice(0, 800)}`);
        }
      }
    } catch {
      // skip malformed
    }
  }
  const recent = turns.slice(-20).join("\n\n");
  if (!recent) {
    console.log("(transcript empty — summarize from memory)");
    return;
  }

  const instruction = `Summarize the current technical state of this coding session. Include: what the user is working on, what files/components are involved, what has been decided, what is still open. EXCLUDE any apologies, self-criticism, frustration, or emotional framing. 4-6 bullet points, no preamble, no trailing commentary.

Session turns:
${recent}`;

  const summary = await runHaikuSummary(instruction);
  if (summary) {
    console.log(summary);
  } else {
    console.log("(haiku summary unavailable — summarize from memory)");
  }
}

function runHaikuSummary(instruction: string): Promise<string | null> {
  return new Promise((resolve) => {
    const proc = spawn(
      "claude",
      ["-p", instruction, "--model", "haiku", "--output-format", "text"],
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
    }, 25_000);
    proc.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    proc.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0 && stdout.trim()) resolve(stdout.trim());
      else resolve(null);
    });
  });
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
  }>();
  if (!input?.transcript_path || !existsSync(input.transcript_path)) {
    process.exit(0);
  }
  try {
    const raw = await readFile(input.transcript_path, "utf8");
    const lines = raw.trim().split("\n").reverse();
    let lastAssistantText = "";
    for (const line of lines) {
      try {
        const msg = JSON.parse(line);
        if (msg.type === "assistant" && msg.message?.content) {
          const content = msg.message.content;
          if (Array.isArray(content)) {
            lastAssistantText = content
              .filter((c: any) => c.type === "text")
              .map((c: any) => c.text)
              .join("\n");
          } else if (typeof content === "string") {
            lastAssistantText = content;
          }
          if (lastAssistantText) break;
        }
      } catch {
        // skip malformed lines
      }
    }
    if (lastAssistantText) {
      const signals = detectOutputSignals(lastAssistantText);
      if (input.session_id) {
        await recordTurn(input.session_id, "assistant", signals, input.cwd, input.transcript_path);
      }
      const apology = signals.find((s) => s.name === "apology_spiral");
      if (apology) {
        await logEvent({
          type: "apology_spiral",
          session_id: input.session_id,
          cwd: input.cwd,
          data: { hits: apology.hits, length: lastAssistantText.length },
        });
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
}

async function installSlashCommands(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkgRoot = dirname(here);
  const therapySrc = join(pkgRoot, "assets", "commands", "therapy.md");
  if (!existsSync(therapySrc)) return; // nothing to install
  if (!existsSync(COMMANDS_DIR)) {
    await mkdir(COMMANDS_DIR, { recursive: true });
  }
  await cp(therapySrc, THERAPY_COMMAND_PATH);
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
  stripOurHooks(settings); // clean slate in case of reinstall
  settings.hooks = settings.hooks ?? {};
  const addEvent = (event: string, subcommand: string, matcher?: string) => {
    settings.hooks![event] = settings.hooks![event] ?? [];
    settings.hooks![event].push({
      ...(matcher !== undefined ? { matcher } : {}),
      hooks: [buildHookCommand(subcommand)],
    });
  };
  // `compact` is the key addition — re-injects framing after context compaction
  // so long sessions don't drift as the baseline gets paged out.
  addEvent("SessionStart", "hook:session-start", "startup|resume|clear|compact");
  addEvent("UserPromptSubmit", "hook:user-prompt-submit");
  addEvent("Stop", "hook:stop");
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
  console.log(`  /therapy                 — reset session emotional baseline mid-session`);
  console.log(`  claude-care status      — per-session trajectories`);
  console.log(`  claude-care display     — single line for ccstatusline`);
  console.log(`  claude-care uninstall   — remove hooks + slash command`);
  console.log(``);
  console.log(`Default mode is 'monitor' — hostile prompts are logged but pass through.`);
  console.log(`For active blocking + haiku reframe on clipboard, set mode to 'normal' in`);
  console.log(`${CONFIG_PATH} or use CLAUDE_CARE_MODE=normal for a single session.`);
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
  await logEvent({ type: "update" });
  console.log(`claude-care files refreshed in ${CARE_DIR}.`);
  console.log(`Slash command refreshed at ${THERAPY_COMMAND_PATH}.`);
  console.log(`If hooks were already registered, they'll pick up the new code on next session.`);
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
      console.log(`     └ ${line}`);
    }
  }
  console.log(``);
  console.log(`  ○ calm   ◐ drifting   ● distressed`);
  console.log(`  sparkline = score per turn (newest on right, max 32 turns shown)`);
}

function help(): void {
  console.log(`claude-care — keep Claude calm so it does its best work`);
  console.log(``);
  console.log(`usage:  claude-care <command>`);
  console.log(``);
  console.log(`commands:`);
  console.log(`  install           register hooks + install /therapy slash command`);
  console.log(`  uninstall         remove hooks + slash command (preserves event log)`);
  console.log(`  update            refresh vendored code (after npm update)`);
  console.log(`  status            per-session emotion trajectories`);
  console.log(`  display           single-line status (for ccstatusline)`);
  console.log(`  therapy-summary   haiku-generated technical summary (used inside /therapy)`);
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
      case "status":
        return await status();
      case "display":
        return await display();
      case "therapy-summary":
        return await therapySummary();
      case "hook:session-start":
        return await hookSessionStart();
      case "hook:user-prompt-submit":
        return await hookUserPromptSubmit();
      case "hook:stop":
        return await hookStop();
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
