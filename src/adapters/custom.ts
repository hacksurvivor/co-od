import { spawn } from "node:child_process";
import { spawnSync } from "node:child_process";
import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { accessSync, constants, existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  coodeIsolatedBrowser,
  declaredHarnessCapabilityReceipt,
  harnessCapabilities,
  noNativeHarnessIntegrations,
  promptWithHarnessCapabilities,
  providerProcessEnvironment,
  resolveProviderSessionIdFromResult,
  withDeclaredHarnessCapabilityReceipt,
  type AgentAdapter,
  type ExecuteOptions,
  type ExecuteResult,
} from "./base.js";

export interface CustomHarnessConformanceManifest {
  schemaVersion: 1;
  issuedAt: string;
  expiresAt?: string;
  /** Raw 32-byte Ed25519 public key, base64 encoded and pinned by the user. */
  signerPublicKey: string;
  signature: string;
  executableSHA256: string;
  versionOutputSHA256: string;
  capabilities?: {
    sessionResume?: boolean;
    attachments?: boolean;
  };
}

export interface CustomHarnessDefinition {
  id: string;
  name: string;
  executable: string;
  arguments: string[];
  versionArguments?: string[];
  conformanceManifest?: CustomHarnessConformanceManifest;
}

interface CustomHarnessRegistryDocument {
  schemaVersion: number;
  selectedID?: string;
  trustedSignerKeys?: string[];
  definitions: CustomHarnessDefinition[];
}

export interface CustomHarnessAttestation {
  verified: boolean;
  reason: string;
  versionOutput?: string;
}

export const defaultCustomHarnessRegistryPath = join(
  homedir(),
  "Library",
  "Application Support",
  "co·ode",
  "custom-harnesses.json",
);

function registryDocument(value: unknown): CustomHarnessRegistryDocument | undefined {
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
  return {
    schemaVersion: 1,
    ...(typeof document.selectedID === "string" ? { selectedID: document.selectedID } : {}),
    trustedSignerKeys: Array.isArray(document.trustedSignerKeys)
      ? document.trustedSignerKeys.filter((key): key is string => typeof key === "string")
      : [],
    definitions,
  };
}

export function loadSelectedCustomHarness(
  path = process.env.COODE_CUSTOM_HARNESS_REGISTRY || defaultCustomHarnessRegistryPath,
): CustomHarnessDefinition | undefined {
  try {
    const document = registryDocument(JSON.parse(readFileSync(path, "utf8")));
    return document?.definitions.find((candidate) => candidate.id === document.selectedID)
      ?? document?.definitions[0];
  } catch {
    return undefined;
  }
}

function loadCustomHarnessRegistry(
  path = process.env.COODE_CUSTOM_HARNESS_REGISTRY || defaultCustomHarnessRegistryPath,
): CustomHarnessRegistryDocument | undefined {
  try {
    return registryDocument(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return undefined;
  }
}

const stableJSON = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJSON).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJSON(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

export function customHarnessManifestPayload(
  definition: CustomHarnessDefinition,
  manifest: CustomHarnessConformanceManifest,
): string {
  return stableJSON({
    definition: {
      arguments: definition.arguments,
      executable: definition.executable,
      id: definition.id,
      name: definition.name,
      versionArguments: definition.versionArguments ?? ["--version"],
    },
    executableSHA256: manifest.executableSHA256,
    expiresAt: manifest.expiresAt,
    issuedAt: manifest.issuedAt,
    schemaVersion: manifest.schemaVersion,
    signerPublicKey: manifest.signerPublicKey,
    versionOutputSHA256: manifest.versionOutputSHA256,
    capabilities: manifest.capabilities ?? {},
  });
}

const resolvedExecutablePath = (executable: string): string | undefined => {
  if (isAbsolute(executable)) {
    try { return realpathSync(executable); } catch { return undefined; }
  }
  if (!/^[A-Za-z0-9._+-]+$/.test(executable)) return undefined;
  for (const directory of (process.env.PATH || "").split(":")) {
    const candidate = join(directory, executable);
    try {
      accessSync(candidate, constants.X_OK);
      return realpathSync(candidate);
    } catch {
      // Keep searching the exact PATH entries without invoking a shell.
    }
  }
  return undefined;
};

const sha256 = (value: Uint8Array | string): string => createHash("sha256")
  .update(value)
  .digest("hex");

export function verifyCustomHarnessAttestation(
  definition: CustomHarnessDefinition,
  trustedSignerKeys: string[],
  now = new Date(),
): CustomHarnessAttestation {
  const manifest = definition.conformanceManifest;
  if (!manifest) return { verified: false, reason: "No signed conformance manifest." };
  if (manifest.schemaVersion !== 1) return { verified: false, reason: "Unsupported conformance manifest version." };
  if (!trustedSignerKeys.includes(manifest.signerPublicKey)) {
    return { verified: false, reason: "The manifest signer is not pinned in co·ode Settings." };
  }
  const issuedAt = Date.parse(manifest.issuedAt);
  const expiresAt = manifest.expiresAt ? Date.parse(manifest.expiresAt) : undefined;
  if (!Number.isFinite(issuedAt) || issuedAt > now.getTime() + 5 * 60_000) {
    return { verified: false, reason: "The manifest issue time is invalid." };
  }
  if (expiresAt !== undefined && (!Number.isFinite(expiresAt) || expiresAt <= now.getTime())) {
    return { verified: false, reason: "The conformance manifest has expired." };
  }
  const executable = resolvedExecutablePath(definition.executable);
  if (!executable) return { verified: false, reason: "The attested executable is unavailable." };
  if (sha256(readFileSync(executable)) !== manifest.executableSHA256.toLowerCase()) {
    return { verified: false, reason: "The executable no longer matches its signed manifest." };
  }
  const version = spawnSync(executable, definition.versionArguments ?? ["--version"], {
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 64 * 1_024,
  });
  if (version.error || version.status !== 0) {
    return { verified: false, reason: "The attested version probe failed." };
  }
  const versionOutput = `${version.stdout || ""}${version.stderr || ""}`.trim();
  if (sha256(versionOutput) !== manifest.versionOutputSHA256.toLowerCase()) {
    return { verified: false, reason: "The version output no longer matches its signed manifest." };
  }
  try {
    const rawKey = Buffer.from(manifest.signerPublicKey, "base64");
    if (rawKey.length !== 32) throw new Error("invalid Ed25519 key");
    const spki = Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      rawKey,
    ]);
    const publicKey = createPublicKey({ key: spki, format: "der", type: "spki" });
    const valid = verifySignature(
      null,
      Buffer.from(customHarnessManifestPayload(definition, manifest)),
      publicKey,
      Buffer.from(manifest.signature, "base64"),
    );
    return valid
      ? { verified: true, reason: "Signed conformance manifest verified.", versionOutput }
      : { verified: false, reason: "The conformance signature is invalid." };
  } catch {
    return { verified: false, reason: "The conformance signer key or signature is malformed." };
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
  private readonly registry = loadCustomHarnessRegistry();
  private readonly definition = this.registry?.definitions.find((candidate) =>
    candidate.id === this.registry?.selectedID
  ) ?? this.registry?.definitions[0];
  private attestation?: CustomHarnessAttestation;
  capabilities = harnessCapabilities({
    transport: {
      kind: "custom",
      capabilityNegotiation: false,
      structuredEvents: false,
    },
    modelSelection: this.definition?.arguments.some((argument) => argument.includes("{model}")) ?? false,
    effortSelection: this.definition?.arguments.some((argument) => argument.includes("{effort}")) ?? false,
    nativeIntegrations: noNativeHarnessIntegrations(),
    browser: coodeIsolatedBrowser(),
  });

  async available(): Promise<boolean> {
    if (!this.definition || !executableAvailable(this.definition.executable)) return false;
    if (!this.definition.conformanceManifest) return true;
    this.attestation = verifyCustomHarnessAttestation(
      this.definition,
      this.registry?.trustedSignerKeys ?? [],
    );
    return this.attestation.verified;
  }

  async execute(goal: string, options: ExecuteOptions): Promise<ExecuteResult> {
    const definition = this.definition;
    if (!definition) {
      return withDeclaredHarnessCapabilityReceipt({
        exitCode: 78,
        stdout: "",
        stderr: "No custom harness is selected in co·ode Settings.",
      }, this.name, this.capabilities, options);
    }
    if (definition.conformanceManifest) {
      this.attestation = verifyCustomHarnessAttestation(
        definition,
        this.registry?.trustedSignerKeys ?? [],
      );
      if (!this.attestation.verified) {
        return withDeclaredHarnessCapabilityReceipt({
          exitCode: 78,
          stdout: "",
          stderr: this.attestation.reason,
        }, this.name, this.capabilities, options);
      }
    }

    const prompt = promptWithHarnessCapabilities(goal, options, this.name);
    const args = buildCustomHarnessArgs(definition, prompt, options);

    const result = await new Promise<ExecuteResult>((resolve) => {
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
        void options.onRawEvent?.({
          observedAt: new Date().toISOString(),
          direction: "providerToCoode",
          channel: "stdout",
          payload: chunk,
        });
        stdout += chunk;
        options.onTextDelta?.(chunk);
        options.onOutput?.(chunk);
      });
      child.stderr?.on("data", (chunk: string) => {
        void options.onRawEvent?.({
          observedAt: new Date().toISOString(),
          direction: "providerToCoode",
          channel: "stderr",
          payload: chunk,
        });
        stderr += chunk;
        options.onOutput?.(chunk);
      });
      child.on("error", (error) => {
        resolve({ exitCode: 127, stdout, stderr: stderr || error.message });
      });
      child.on("close", (code) => {
        resolve({
          exitCode: code ?? 1,
          stdout,
          stderr,
          providerSessionId: resolveProviderSessionIdFromResult(
            `${stdout}\n${stderr}`,
            options.providerSession,
          ),
        });
      });
      options.signal?.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });
    });
    if (!this.attestation?.verified || !definition.conformanceManifest) {
      return withDeclaredHarnessCapabilityReceipt(result, this.name, this.capabilities, options);
    }
    const attestedCapabilities = harnessCapabilities({
      ...this.capabilities,
      sessionResume: definition.conformanceManifest.capabilities?.sessionResume === true,
      attachments: definition.conformanceManifest.capabilities?.attachments === true,
    });
    const capabilityReceipt = declaredHarnessCapabilityReceipt(this.name, attestedCapabilities);
    capabilityReceipt.source = "attested";
    capabilityReceipt.agentName = definition.name;
    capabilityReceipt.agentVersion = this.attestation.versionOutput?.slice(0, 512);
    options.onCapabilityReceipt?.(capabilityReceipt);
    return { ...result, capabilityReceipt };
  }
}
