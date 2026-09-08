import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

type ExecutableCheck = (path: string) => boolean;

const isExecutable: ExecutableCheck = (path) => {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const unique = (values: string[]): string[] => [...new Set(values.filter(Boolean))];

/**
 * Finder-launched macOS apps inherit a deliberately small PATH. Resolve the
 * same well-known Codex installations that the native discovery UI accepts so
 * a harness shown as installed can also be started by the bundled relay.
 */
export function codexExecutableCandidates(
  environment: NodeJS.ProcessEnv = process.env,
): string[] {
  const home = environment.HOME || homedir();
  const pathCandidates = (environment.PATH || "")
    .split(delimiter)
    .filter(Boolean)
    .map((directory) => join(directory, "codex"));
  const applicationRoots = ["/Applications", join(home, "Applications")];
  const bundledCandidates = applicationRoots.flatMap((root) => [
    join(root, "ChatGPT.app", "Contents", "Resources", "codex"),
    join(root, "Codex.app", "Contents", "Resources", "codex"),
  ]);

  return unique([
    environment.COODE_CODEX_EXECUTABLE_PATH || "",
    ...pathCandidates,
    join(home, ".local", "bin", "codex"),
    join(home, ".npm-global", "bin", "codex"),
    join(home, ".bun", "bin", "codex"),
    join(home, ".cargo", "bin", "codex"),
    join(home, ".volta", "bin", "codex"),
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
    ...bundledCandidates,
  ]);
}

export function resolveCodexExecutable(
  environment: NodeJS.ProcessEnv = process.env,
  executableCheck: ExecutableCheck = isExecutable,
): string | undefined {
  return codexExecutableCandidates(environment).find(executableCheck);
}
