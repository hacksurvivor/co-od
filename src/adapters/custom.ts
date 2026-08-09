import { spawn } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  coodeIsolatedBrowser,
  harnessCapabilities,
  noNativeHarnessIntegrations,
  promptWithHarnessCapabilities,
  providerProcessEnvironment,
  type AgentAdapter,
  type ExecuteOptions,
  type ExecuteResult,
} from "./base.js";

export interface CustomHarnessDefinition {
  id: string;
  name: string;
  executable: string;
  arguments: string[];
  versionArguments?: string[];
}

interface CustomHarnessRegistryDocument {
  schemaVersion: number;
  selectedID?: string;
  definitions: CustomHarnessDefinition[];
}

export const defaultCustomHarnessRegistryPath = join(
  homedir(),
  "Library",
  "Application Support",
  "co·ode",
  "custom-harnesses.json",
);

function selectedDefinitionFromDocument(value: unknown): CustomHarnessDefinition | undefined {
  if (!value || typeof value !== "object") return undefined;
  const document = value as Partial<CustomHarnessRegistryDocument>;
  if (document.schemaVersion !== 1 || !Array.isArray(document.definitions)) return undefined;
  const definitions = document.definitions.filter((candidate): candidate is CustomHarnessDefinition =>
    Boolean(
      candidate
      && typeof candidate.id === "string"
      && typeof candidate.name === "string"
      && typeof candidate.executable === "string"
      && Array.isArray(candidate.arguments)
      && candidate.arguments.every((argument) => typeof argument === "string"),
    ));
  return definitions.find((candidate) => candidate.id === document.selectedID) ?? definitions[0];
}

export function loadSelectedCustomHarness(
  path = process.env.COODE_CUSTOM_HARNESS_REGISTRY || defaultCustomHarnessRegistryPath,
): CustomHarnessDefinition | undefined {
  try {
    return selectedDefinitionFromDocument(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return undefined;
  }
}

export function buildCustomHarnessArgs(
  definition: CustomHarnessDefinition,
  prompt: string,
  options: Pick<ExecuteOptions, "activeGoal" | "effort" | "model"> = {},
): string[] {
  const replacements: Record<string, string> = {
    "{prompt}": prompt,
    "{model}": options.model || "",
    "{effort}": options.effort || "",
    "{goal}": options.activeGoal || "",
  };
  const hasPromptPlaceholder = definition.arguments.some((argument) => argument.includes("{prompt}"));
  const argumentsWithValues = definition.arguments
    .map((argument) => Object.entries(replacements).reduce(
      (value, [placeholder, replacement]) => value.replaceAll(placeholder, replacement),
      argument,
    ))
    .filter((argument) => argument.length > 0);
  if (!hasPromptPlaceholder) argumentsWithValues.push(prompt);
  return argumentsWithValues;
}

function executableAvailable(executable: string): boolean {
  if (isAbsolute(executable)) {
    try {
      accessSync(executable, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  if (!/^[A-Za-z0-9._+-]+$/.test(executable)) return false;
  return (process.env.PATH || "")
    .split(":")
    .some((directory) => existsSync(join(directory, executable)));
}

export class CustomAdapter implements AgentAdapter {
  name = "custom";
  private readonly definition = loadSelectedCustomHarness();
  capabilities = harnessCapabilities({
    modelSelection: this.definition?.arguments.some((argument) => argument.includes("{model}")) ?? false,
    effortSelection: this.definition?.arguments.some((argument) => argument.includes("{effort}")) ?? false,
    nativeIntegrations: noNativeHarnessIntegrations(),
    browser: coodeIsolatedBrowser(),
  });

  async available(): Promise<boolean> {
    return Boolean(this.definition && executableAvailable(this.definition.executable));
  }

  async execute(goal: string, options: ExecuteOptions): Promise<ExecuteResult> {
    const definition = this.definition;
    if (!definition) {
      return {
        exitCode: 78,
        stdout: "",
        stderr: "No custom harness is selected in co·ode Settings.",
      };
    }

    const prompt = promptWithHarnessCapabilities(goal, options, this.name);
    const args = buildCustomHarnessArgs(definition, prompt, options);

    return new Promise<ExecuteResult>((resolve) => {
      const child = spawn(definition.executable, args, {
        cwd: options.workDir,
        env: providerProcessEnvironment({ ...options, provider: this.name }),
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
        options.onTextDelta?.(chunk);
        options.onOutput?.(chunk);
      });
      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
        options.onOutput?.(chunk);
      });
      child.on("error", (error) => {
        resolve({ exitCode: 127, stdout, stderr: stderr || error.message });
      });
      child.on("close", (code) => {
        resolve({ exitCode: code ?? 1, stdout, stderr });
      });
      options.signal?.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });
    });
  }
}
