import { appendFile, readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";
import { join } from "node:path";

export const CARE_DIR = join(homedir(), ".claude-care");
export const EVENTS_PATH = join(CARE_DIR, "events.jsonl");

export type EventType =
  | "session_start"
  | "hostile_detected"
  | "prompt_review_fallback"
  | "apology_spiral"
  | "compact_done"
  | "therapy_auto_triggered"
  | "score_turn_spawned"
  | "score_turn_started"
  | "score_turn_done"
  | "score_turn_failed"
  | "anxiety_score_spawned"
  | "anxiety_score_done"
  | "anxiety_score_failed"
  | "anxiety_intervention"
  | "install"
  | "uninstall"
  | "update";

export type Event = {
  ts: string;
  type: EventType;
  session_id?: string;
  cwd?: string;
  data?: Record<string, unknown>;
};

export async function logEvent(event: Omit<Event, "ts">): Promise<void> {
  const record: Event = { ts: new Date().toISOString(), ...event };
  try {
    if (!existsSync(dirname(EVENTS_PATH))) {
      await mkdir(dirname(EVENTS_PATH), { recursive: true });
    }
    await appendFile(EVENTS_PATH, JSON.stringify(record) + "\n", "utf8");
  } catch {
    // Never let logging break a hook
  }
}

export async function readEvents(): Promise<Event[]> {
  if (!existsSync(EVENTS_PATH)) return [];
  const raw = await readFile(EVENTS_PATH, "utf8");
  const events: Event[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // skip malformed lines
    }
  }
  return events;
}
