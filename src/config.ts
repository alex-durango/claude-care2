import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { CARE_DIR } from "./monitor.js";

// Data-driven configuration in the spirit of Claude Code's permission policy
// (rules-as-data, not rules-as-code). Users can edit this file directly to
// tune thresholds, modes, and detector severity without changing code.
//
// Modes loosely mirror claw-code's permission modes:
//   strict  — block on any hostile detection, lower thresholds for "distressed"
//   normal  — default; block hostile prompts, show reframe on clipboard
//   monitor — observe only, never block, just log events

export type Mode = "strict" | "normal" | "monitor";

export type Config = {
  mode: Mode;
  thresholds: {
    drifting: number;
    distressed: number;
  };
  reframer: {
    enabled: boolean;
    timeout_ms: number;
    model: string;
  };
  therapy: {
    auto_summary: boolean;
  };
};

export const CONFIG_PATH = join(CARE_DIR, "config.json");

export const DEFAULT_CONFIG: Config = {
  // Default is monitor: zero interruption to the user. Hostile prompts are
  // detected and logged, but pass through unchanged. The SessionStart framing
  // + /therapy slash command are the primary interventions. For blocking +
  // haiku reframe on hostile prompts, opt into normal or strict mode.
  mode: "monitor",
  thresholds: {
    drifting: 5,
    distressed: 10,
  },
  reframer: {
    enabled: true,
    timeout_ms: 25_000,
    model: "haiku",
  },
  therapy: {
    auto_summary: true,
  },
};

export async function loadConfig(): Promise<Config> {
  if (!existsSync(CONFIG_PATH)) return DEFAULT_CONFIG;
  try {
    const raw = await readFile(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw);
    // Shallow merge with defaults so missing fields don't crash older configs
    return {
      ...DEFAULT_CONFIG,
      ...parsed,
      thresholds: { ...DEFAULT_CONFIG.thresholds, ...(parsed.thresholds ?? {}) },
      reframer: { ...DEFAULT_CONFIG.reframer, ...(parsed.reframer ?? {}) },
      therapy: { ...DEFAULT_CONFIG.therapy, ...(parsed.therapy ?? {}) },
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export async function writeDefaultConfigIfMissing(): Promise<boolean> {
  if (existsSync(CONFIG_PATH)) return false;
  if (!existsSync(dirname(CONFIG_PATH))) {
    await mkdir(dirname(CONFIG_PATH), { recursive: true });
  }
  await writeFile(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n", "utf8");
  return true;
}

// Env-var overrides take precedence over config file (explicit user intent).
export function effectiveMode(config: Config): Mode {
  const envMode = process.env.CLAUDE_CARE_MODE;
  if (envMode === "strict" || envMode === "normal" || envMode === "monitor") {
    return envMode;
  }
  return config.mode;
}
