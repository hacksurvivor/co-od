import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";

export interface ManagedIntegrationRecord {
  id: string;
  name: string;
  harness: string;
  kind: "skill" | "plugin";
  enabled: boolean;
  removedAt?: string | null;
  sourcePluginID?: string | null;
  sourceSkillPaths: string[];
  sourceSkillNames: string[];
  payloadRelativePath: string;
  skillRootRelativePaths: string[];
  claudePluginRelativePath?: string | null;
}

export interface ManagedIntegrationRuntime {
  signature: string;
  skillRoots: string[];
  disabledSkillPaths: string[];
  disabledPluginIDs: string[];
  claudeArguments: string[];
  entryCount: number;
}

export class ManagedIntegrationRuntimeError extends Error {
  constructor(message = "The co·od integration library could not be loaded. Refresh Skills & plugins before starting this agent.") {
    super(message); this.name = "ManagedIntegrationRuntimeError";
  }
}

/** Read only the explicit local runtime path; never scan or modify personal provider configuration. */
export function managedIntegrationRuntime(
  harness: "codex" | "claude",
  environment: NodeJS.ProcessEnv = process.env,
): ManagedIntegrationRuntime | undefined {
  const manifestPath = environment.COODE_MANAGED_INTEGRATIONS_PATH;
  if (!manifestPath) return undefined;
  if (!isAbsolute(manifestPath)) throw new ManagedIntegrationRuntimeError();
  if (!existsSync(manifestPath)) return undefined;
  try {
    if (statSync(manifestPath).size > 8_000_000) throw new Error("oversized library");
    const root = realpathSync(dirname(manifestPath));
    const snapshot = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      version?: number; revision?: string; entries?: ManagedIntegrationRecord[];
    };
    if (snapshot.version !== 1 || typeof snapshot.revision !== "string" || !Array.isArray(snapshot.entries)) {
      throw new Error("invalid library");
    }
    const records = snapshot.entries.filter((entry) => typeof entry.harness === "string" && entry.harness.toLowerCase() === harness);
    if (records.length === 0) return undefined;
    const owned = (path: string): string => {
      if (typeof path !== "string" || !path.startsWith("packages/") || isAbsolute(path) || path.split("/").includes("..")) throw new Error("invalid owned path");
      const target = realpathSync(resolve(root, path));
      if (!target.startsWith(root + sep)) throw new Error("owned path escaped library");
      return target;
    };
    const active = records.filter((entry) => entry.enabled && !entry.removedAt);
    const skillRoots: string[] = [];
    const disabledSkillPaths = new Set<string>();
    const disabledPluginIDs = new Set<string>();
    const skillOverrides: Record<string, "off"> = {};
    const pluginDirectories: string[] = [];
    const ids = new Set<string>();
    for (const entry of records) {
      if (typeof entry.id !== "string" || ids.has(entry.id) || typeof entry.enabled !== "boolean"
        || !["skill", "plugin"].includes(entry.kind) || !Array.isArray(entry.sourceSkillPaths)
        || !Array.isArray(entry.sourceSkillNames) || !Array.isArray(entry.skillRootRelativePaths)) throw new Error("invalid entry");
      ids.add(entry.id);
      for (const path of entry.sourceSkillPaths) {
        if (typeof path !== "string" || !isAbsolute(path) || !path.endsWith("/SKILL.md")) throw new Error("invalid source skill path");
        disabledSkillPaths.add(existsSync(path) ? realpathSync(path) : path);
      }
      if (entry.sourcePluginID) {
        if (typeof entry.sourcePluginID !== "string" || entry.sourcePluginID.length > 300) throw new Error("invalid source plugin");
        disabledPluginIDs.add(entry.sourcePluginID);
      }
      for (const name of entry.sourceSkillNames) {
        if (typeof name !== "string" || !name || name.length > 200) throw new Error("invalid skill name");
        // Plugin skills are already excluded by their original plugin selector.
        if (entry.kind === "skill") skillOverrides[name] = "off";
      }
    }
    for (const entry of active) {
      owned(entry.payloadRelativePath);
      if (harness === "codex") skillRoots.push(...entry.skillRootRelativePaths.map(owned));
      if (harness === "claude") {
        if (!entry.claudePluginRelativePath) throw new Error("missing plugin runtime");
        pluginDirectories.push(owned(entry.claudePluginRelativePath));
      }
    }
    const enabledPlugins = Object.fromEntries([...disabledPluginIDs].map((id) => [id, false]));
    const settings = {
      ...(Object.keys(enabledPlugins).length ? { enabledPlugins } : {}),
      ...(Object.keys(skillOverrides).length ? { skillOverrides } : {}),
    };
    const claudeArguments = pluginDirectories.flatMap((path) => ["--plugin-dir", path]);
    if (Object.keys(settings).length) claudeArguments.push("--settings", JSON.stringify(settings));
    return {
      signature: `${root}:${snapshot.revision}`,
      skillRoots: [...new Set(skillRoots)].sort(),
      disabledSkillPaths: [...disabledSkillPaths].sort(),
      disabledPluginIDs: [...disabledPluginIDs].sort(),
      claudeArguments,
      entryCount: records.length,
    };
  } catch (error) {
    if (error instanceof ManagedIntegrationRuntimeError) throw error;
    throw new ManagedIntegrationRuntimeError();
  }
}

/** Preserve every existing user skill rule, then apply only owned import bindings. */
export function codexManagedIntegrationConfig(
  runtime: ManagedIntegrationRuntime | undefined,
  existingConfig: Record<string, unknown> = {},
): Record<string, unknown> | undefined {
  if (!runtime) return undefined;
  const skills = existingConfig.skills && typeof existingConfig.skills === "object"
    ? existingConfig.skills as Record<string, unknown> : {};
  const currentRules = Array.isArray(skills.config) ? skills.config : [];
  return {
    ...(runtime.disabledSkillPaths.length ? {
      skills: { ...skills, config: [...currentRules, ...runtime.disabledSkillPaths.map((path) => ({ path, enabled: false }))] },
    } : {}),
    ...(runtime.disabledPluginIDs.length ? {
      plugins: { ...(existingConfig.plugins && typeof existingConfig.plugins === "object" ? existingConfig.plugins : {}), ...Object.fromEntries(runtime.disabledPluginIDs.map((id) => [id, { enabled: false }])) },
    } : {}),
  };
}
