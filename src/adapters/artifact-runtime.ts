import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { HarnessArtifactUpdate } from "./base.js";

export interface ArtifactRuntimeBinding {
  version: 1;
  id: string;
  artifactID: string;
  contentSHA256: string;
  threadId: string;
  originCallId: string;
  server: string;
  tool: string;
  uri: string;
  connectorId?: string;
  createdAt: string;
}

export function artifactRuntimeRoot(environment: NodeJS.ProcessEnv = process.env): string | undefined {
  // This path belongs to the selected native application channel. Never fall
  // back to a provider home or share bindings between stable and development.
  const library = environment.COODE_MANAGED_INTEGRATIONS_PATH;
  return library ? join(dirname(library), "artifact-runtime") : undefined;
}

export async function registerArtifactRuntime(
  artifact: HarnessArtifactUpdate,
  origin: Pick<ArtifactRuntimeBinding, "threadId" | "originCallId" | "server" | "tool" | "uri" | "connectorId">,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  const root = artifactRuntimeRoot(environment);
  if (!root || !artifact.content || artifact.kind !== "mcpApp") return undefined;
  const id = randomUUID();
  const binding: ArtifactRuntimeBinding = {
    version: 1, id, artifactID: artifact.id,
    contentSHA256: createHash("sha256").update(Buffer.from(artifact.content,
      artifact.encoding === "base64" ? "base64" : "utf8")).digest("hex"),
    ...origin, createdAt: new Date().toISOString(),
  };
  await mkdir(root, { recursive: true, mode: 0o700 });
  const file = await open(join(root, `${id}.json`), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(JSON.stringify(binding)); } finally { await file.close(); }
  return id;
}

export async function readArtifactRuntime(
  id: string,
  artifactID: string,
  contentSHA256: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ArtifactRuntimeBinding> {
  const root = artifactRuntimeRoot(environment);
  if (!root || !/^[a-f0-9-]{36}$/i.test(id)) throw new Error("Reconnect this artifact on the Mac that produced it.");
  const file = await open(join(root, `${id}.json`), constants.O_RDONLY | constants.O_NOFOLLOW)
    .catch(() => { throw new Error("This saved preview has no local connection. Reopen it with the agent on the Mac that produced it."); });
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 16_384 || (stat.mode & 0o077) || stat.uid !== process.getuid?.()) {
      throw new Error("The local artifact binding could not be verified.");
    }
    const binding = JSON.parse(await file.readFile("utf8")) as ArtifactRuntimeBinding;
    if (binding.version !== 1 || binding.id !== id || binding.artifactID !== artifactID
        || binding.contentSHA256 !== contentSHA256) throw new Error("This artifact revision does not match its producing session.");
    return binding;
  } finally { await file.close(); }
}
