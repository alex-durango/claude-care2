import { spawn } from "node:child_process";

// Writes text to the system clipboard. Works on macOS (pbcopy), Linux
// (xclip / xsel / wl-copy), and Windows (clip.exe). Returns the name of the
// tool used, or null if nothing worked.
export async function copyToClipboard(text: string): Promise<string | null> {
  const candidates = getClipboardCandidates();
  for (const { cmd, args } of candidates) {
    try {
      await runClipboardCommand(cmd, args, text);
      return cmd;
    } catch {
      // try next
    }
  }
  return null;
}

type ClipboardCandidate = { cmd: string; args: string[] };

function getClipboardCandidates(): ClipboardCandidate[] {
  if (process.platform === "darwin") {
    return [{ cmd: "pbcopy", args: [] }];
  }
  if (process.platform === "win32") {
    return [{ cmd: "clip", args: [] }];
  }
  // Linux/BSD — try X11 tools then Wayland
  return [
    { cmd: "xclip", args: ["-selection", "clipboard"] },
    { cmd: "xsel", args: ["--clipboard", "--input"] },
    { cmd: "wl-copy", args: [] },
  ];
}

function runClipboardCommand(cmd: string, args: string[], text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"] });
    proc.on("error", reject);
    proc.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
    proc.stdin.write(text);
    proc.stdin.end();
  });
}
