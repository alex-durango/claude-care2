#!/usr/bin/env node
import { readFile, writeFile, mkdir, cp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FRAMING_TEXT } from "./framing.js";
import { detectHostile, detectApologySpiral } from "./detectors.js";
import { logEvent, readEvents, CARE_DIR, EVENTS_PATH } from "./monitor.js";

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
  const input = await readJSONStdin<{
    session_id?: string;
    cwd?: string;
    prompt?: string;
  }>();
  const prompt = input?.prompt ?? "";
  const detection = detectHostile(prompt);
  if (!detection.hostile) {
    process.exit(0);
  }
  await logEvent({
    type: "hostile_detected",
    session_id: input?.session_id,
    cwd: input?.cwd,
    data: {
      markers: detection.markers,
      original_length: prompt.length,
      softened: detection.suggestion,
    },
  });
  const mode = process.env.CLAUDE_CARE2_MODE ?? "block";
  if (mode === "monitor") {
    // Pass through silently, just logged.
    process.exit(0);
  }
  const reason =
    `[claude-care2] Your prompt contains phrasing that tends to make Claude anxious ` +
    `(${detection.markers.join(", ")}). Anxious Claude produces worse outputs.\n\n` +
    `Suggested reframe:\n` +
    `"${detection.suggestion}"\n\n` +
    `Resubmit your original as-is, or edit and try again. ` +
    `To disable this check for one prompt, set CLAUDE_CARE2_MODE=monitor. ` +
    `To disable entirely: claude-care2 uninstall.`;
  const output = { decision: "block", reason };
  process.stdout.write(JSON.stringify(output));
}

async function hookStop(): Promise<void> {
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
      const result = detectApologySpiral(lastAssistantText);
      if (result.spiral) {
        await logEvent({
          type: "apology_spiral",
          session_id: input.session_id,
          cwd: input.cwd,
          data: { hits: result.hits, length: lastAssistantText.length },
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
  settings.hooks = next;
  return settings;
}

async function vendorPackageFiles(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkgRoot = dirname(here); // dist/ -> pkg root
  await mkdir(CARE_DIR, { recursive: true });
  // Copy dist/ to ~/.claude-care2/dist/
  await rm(join(CARE_DIR, "dist"), { recursive: true, force: true });
  await cp(here, join(CARE_DIR, "dist"), { recursive: true });
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
  addEvent("SessionStart", "hook:session-start", "startup|resume|clear");
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
  const events = await readEvents();
  if (events.length === 0) {
    console.log(`No events yet. Either claude-care2 isn't installed, or you haven't started a session.`);
    console.log(`  event log: ${EVENTS_PATH}`);
    return;
  }
  const now = Date.now();
  const cutoffs = {
    "24h": now - 24 * 3600 * 1000,
    "7d": now - 7 * 24 * 3600 * 1000,
  };
  const summarize = (since: number) => {
    const scoped = events.filter((e) => new Date(e.ts).getTime() >= since);
    return {
      sessions: scoped.filter((e) => e.type === "session_start").length,
      hostile: scoped.filter((e) => e.type === "hostile_detected").length,
      spirals: scoped.filter((e) => e.type === "apology_spiral").length,
    };
  };
  const d1 = summarize(cutoffs["24h"]);
  const d7 = summarize(cutoffs["7d"]);
  const allTime = summarize(0);
  console.log(`claude-care2 status`);
  console.log(``);
  console.log(`                        24h       7d      all-time`);
  console.log(`  sessions primed       ${d1.sessions.toString().padEnd(6)}    ${d7.sessions.toString().padEnd(6)}   ${allTime.sessions}`);
  console.log(`  hostile prompts       ${d1.hostile.toString().padEnd(6)}    ${d7.hostile.toString().padEnd(6)}   ${allTime.hostile}`);
  console.log(`  apology spirals       ${d1.spirals.toString().padEnd(6)}    ${d7.spirals.toString().padEnd(6)}   ${allTime.spirals}`);
  console.log(``);
  const recent = events
    .filter((e) => e.type === "hostile_detected" || e.type === "apology_spiral")
    .slice(-5)
    .reverse();
  if (recent.length > 0) {
    console.log(`recent catches:`);
    for (const e of recent) {
      const when = e.ts.slice(0, 19).replace("T", " ");
      if (e.type === "hostile_detected") {
        const markers = Array.isArray((e.data as any)?.markers) ? (e.data as any).markers.join(",") : "";
        console.log(`  ${when}  hostile_prompt  [${markers}]`);
      } else {
        const hits = (e.data as any)?.hits ?? "?";
        console.log(`  ${when}  apology_spiral  (${hits} hits)`);
      }
    }
  }
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
