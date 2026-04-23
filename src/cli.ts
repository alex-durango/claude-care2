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
} from "./session-state.js";
import { reframeWithHaiku } from "./reframe.js";
import { copyToClipboard } from "./clipboard.js";

const CLAUDE_DIR = join(homedir(), ".claude");
const SETTINGS_PATH = join(CLAUDE_DIR, "settings.json");
const HOOK_ID = "claude-care2";
const HOOK_MARKER = { source: HOOK_ID } as const;

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
  if (process.env.CLAUDE_CARE2_INTERNAL === "1") {
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
  if (process.env.CLAUDE_CARE2_INTERNAL === "1") {
    process.exit(0);
  }
  const input = await readJSONStdin<{
    session_id?: string;
    cwd?: string;
    prompt?: string;
  }>();
  const prompt = input?.prompt ?? "";
  const detection = detectHostile(prompt);
  // Record a user turn either way for the timeseries.
  if (input?.session_id) {
    const signals = detection.hostile ? userSignalsFromHostile(detection.markers) : [];
    await recordTurn(input.session_id, "user", signals, input.cwd);
  }
  if (!detection.hostile) {
    process.exit(0);
  }
  const mode = process.env.CLAUDE_CARE2_MODE ?? "block";
  if (mode === "monitor") {
    // Log only, let the prompt through.
    await logEvent({
      type: "hostile_detected",
      session_id: input?.session_id,
      cwd: input?.cwd,
      data: { markers: detection.markers, mode: "monitor" },
    });
    process.exit(0);
  }

  // Reframe with haiku; regex suggestion is the safety net if haiku is down.
  const result = await reframeWithHaiku(prompt, detection.suggestion);
  const reframe = result.reframed;

  // Write to clipboard so user's next paste is the clean version.
  const clipboardTool = await copyToClipboard(reframe);

  await logEvent({
    type: "hostile_detected",
    session_id: input?.session_id,
    cwd: input?.cwd,
    data: {
      markers: detection.markers,
      reframe_source: result.source,
      reframe_ms: result.ms,
      reframe_length: reframe.length,
      clipboard: clipboardTool ?? "unavailable",
    },
  });

  const clipboardLine = clipboardTool
    ? `⌘V + ⏎ to use the reframe. Or edit your original and resubmit.`
    : `(couldn't reach clipboard — copy the reframe manually.)`;

  const reason =
    `[claude-care2] tension detected (${detection.markers.join(", ")}) — ` +
    `reframe ready${clipboardTool ? " on your clipboard" : ""}:\n\n` +
    `  ${reframe}\n\n` +
    `${clipboardLine}\n` +
    `Disable this check: CLAUDE_CARE2_MODE=monitor    Uninstall: claude-care2 uninstall`;
  const output = { decision: "block", reason };
  process.stdout.write(JSON.stringify(output));
}

async function hookStop(): Promise<void> {
  if (process.env.CLAUDE_CARE2_INTERNAL === "1") {
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
        await recordTurn(input.session_id, "assistant", signals, input.cwd);
      }
      // Keep legacy apology-spiral event on the events.jsonl log so older dashboards still work.
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
      const hooks = entry.hooks.filter((h) => !h.claudeCare && !String(h.command).includes(".claude-care2/"));
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
  // Copy dist/ to ~/.claude-care2/dist/
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
  await logEvent({ type: "install" });
  console.log(`claude-care2 installed.`);
  console.log(``);
  console.log(`  hooks registered in:  ${SETTINGS_PATH}`);
  console.log(`  framing text:         ${join(CARE_DIR, "framing.md")}`);
  console.log(`  event log:            ${EVENTS_PATH}`);
  console.log(``);
  console.log(`Start a new Claude Code session and the framing takes effect on turn 1.`);
  console.log(`Hostile phrasing in prompts will be flagged with a suggested rewrite.`);
  console.log(`Run  claude-care2 status  to see what's been caught.`);
  console.log(`Run  claude-care2 uninstall  to remove.`);
}

async function uninstall(): Promise<void> {
  const settings = await readSettings();
  stripOurHooks(settings);
  await writeSettings(settings);
  await logEvent({ type: "uninstall" });
  console.log(`claude-care2 hooks removed from ${SETTINGS_PATH}.`);
  console.log(`Event log and cached files in ${CARE_DIR} preserved.`);
  console.log(`To delete them: rm -rf ${CARE_DIR}`);
}

async function update(): Promise<void> {
  await vendorPackageFiles();
  await logEvent({ type: "update" });
  console.log(`claude-care2 files refreshed in ${CARE_DIR}.`);
  console.log(`If hooks were already registered, they'll pick up the new code on next session.`);
}

async function status(): Promise<void> {
  const sessions = await listSessions();
  if (sessions.length === 0) {
    console.log(`No sessions tracked yet. Either claude-care2 isn't installed, or you haven't started a session.`);
    console.log(`  sessions dir: ${SESSIONS_DIR}`);
    return;
  }
  console.log(`claude-care2 — emotion-state dashboard`);
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
  console.log(`claude-care2 — keep Claude calm so it does its best work`);
  console.log(``);
  console.log(`usage:  claude-care2 <command>`);
  console.log(``);
  console.log(`commands:`);
  console.log(`  install       register hooks in ~/.claude/settings.json`);
  console.log(`  uninstall     remove hooks (preserves event log)`);
  console.log(`  update        refresh vendored code (after npm update)`);
  console.log(`  status        show what's been caught`);
  console.log(`  help          this message`);
  console.log(``);
  console.log(`env vars:`);
  console.log(`  CLAUDE_CARE2_MODE=monitor   don't block hostile prompts, just log them`);
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
    console.error(`claude-care2: ${msg}`);
    process.exit(1);
  }
}

main();
