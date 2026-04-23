import { spawn } from "node:child_process";

// Compressed principle set. Longer instructions make haiku noticeably slower —
// 400 chars is ~3s, 1400 chars is ~15s. Haiku's smart enough to apply these
// principles from terse cues.
//
// Principles compressed here: Nonviolent Communication (observation+need+
// request, drop blame), positive framing (what to DO), permission to disagree,
// cognitive reframing (no catastrophizing). Plus a hard rule to preserve
// technical details and match length.
const REFRAMER_INSTRUCTION = `Rewrite the prompt below for a coding AI: drop threats, catastrophizing, blame, and "don't X" phrasing; use positive framing ("do X"); preserve ALL technical details (file paths, names, commands, errors); match the original length; add a brief "push back if there's a better angle" only if the original demands one specific approach. Return ONLY the rewrite, no preamble, no quotes, no commentary.

Prompt:
{prompt}`;

const REFRAMER_TIMEOUT_MS = 20_000;

export type ReframeResult = {
  reframed: string;
  source: "haiku" | "fallback";
  ms: number;
};

// Reframe a hostile/stressed prompt via a haiku subagent. Falls back to the
// regex-based suggestion if haiku is unreachable (no `claude` binary, auth
// issue, timeout, etc.) — the caller is expected to pass `fallback` ready.
export async function reframeWithHaiku(
  prompt: string,
  fallback: string,
): Promise<ReframeResult> {
  const start = Date.now();
  try {
    const rewritten = await callHaiku(prompt);
    const cleaned = sanitizeReframe(rewritten, prompt);
    if (!cleaned) throw new Error("empty reframe");
    return { reframed: cleaned, source: "haiku", ms: Date.now() - start };
  } catch {
    return { reframed: fallback, source: "fallback", ms: Date.now() - start };
  }
}

function callHaiku(prompt: string): Promise<string> {
  const fullPrompt = REFRAMER_INSTRUCTION.replace("{prompt}", prompt);
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "claude",
      ["-p", fullPrompt, "--model", "haiku", "--output-format", "text"],
      {
        stdio: ["ignore", "pipe", "pipe"],
        // Mark this call as internal so our own hooks no-op on the subprocess
        // (prevents recursion when the reframer's prompt mentions hostile text).
        env: { ...process.env, CLAUDE_CARE_INTERNAL: "1" },
      },
    );
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    proc.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error("reframer timeout"));
    }, REFRAMER_TIMEOUT_MS);
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0 && stdout.trim()) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`claude exited ${code}: ${stderr.slice(0, 200)}`));
      }
    });
  });
}

// Guard against haiku misbehaving — strip wrappers it sometimes adds, reject
// output that clearly isn't a reframe of the original.
function sanitizeReframe(raw: string, original: string): string {
  let text = raw.trim();
  // Strip surrounding quotes haiku sometimes adds
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'")) ||
    (text.startsWith("`") && text.endsWith("`"))
  ) {
    text = text.slice(1, -1).trim();
  }
  // Strip "Here's the rewrite:" style preambles
  text = text.replace(/^(here('?s|\s+is)\s+the\s+(rewrite|rewritten\s+prompt|reframe(d\s+prompt)?)[:.]?\s*)/i, "");
  text = text.replace(/^(rewritten\s+prompt:|reframed:)\s*/i, "");
  text = text.trim();
  // Reject obviously degenerate output
  if (text.length < 3) return "";
  // If haiku returned something much longer than the original, something's off
  if (text.length > original.length * 6 + 200) return "";
  return text;
}
