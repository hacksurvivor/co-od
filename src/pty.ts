import { spawn, type ChildProcess } from "node:child_process";

export interface PtyHandle {
  onData: (cb: (data: string) => void) => void;
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  kill: () => void;
}

/**
 * Creates a local PTY-like shell process.
 * Uses child_process.spawn with a pseudo-TTY via stdio pipes.
 * For a production version, node-pty would give true PTY support,
 * but this works without native compilation.
 */
export function createLocalPty(cwd: string): PtyHandle {
  const shell = process.env.SHELL || "/bin/bash";
  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;

  const child: ChildProcess = spawn(shell, ["-i"], {
    cwd,
    env: {
      ...process.env,
      TERM: "xterm-256color",
      COLUMNS: String(cols),
      LINES: String(rows),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const dataCallbacks: Array<(data: string) => void> = [];

  child.stdout?.setEncoding("utf-8");
  child.stderr?.setEncoding("utf-8");

  child.stdout?.on("data", (chunk: string) => {
    for (const cb of dataCallbacks) cb(chunk);
  });

  child.stderr?.on("data", (chunk: string) => {
    for (const cb of dataCallbacks) cb(chunk);
  });

  child.on("exit", () => {
    for (const cb of dataCallbacks) cb("\r\n[co-ode] Shell process exited\r\n");
  });

  return {
    onData(cb) {
      dataCallbacks.push(cb);
    },
    write(data) {
      child.stdin?.write(data);
    },
    resize(_cols, _rows) {
      // With child_process we can't truly resize without node-pty
      // But we update env for new subprocesses
    },
    kill() {
      child.kill("SIGTERM");
    },
  };
}
