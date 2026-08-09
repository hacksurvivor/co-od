export const TUI_PROVIDERS = ["opencode", "codex", "claude", "hermes", "openclaw"];

export interface ProviderState {
  provider: string;
  model?: string;
}

export function providerStatus(provider: string, availability: Record<string, boolean>): "available" | "not found" | "checking" {
  if (Object.keys(availability).length === 0) return "checking";
  return availability[provider] ? "available" : "not found";
}

export function resolveLocalProviderForAgent(agent: {
  provider?: string;
  execution_mode?: string;
}): string | undefined {
  const mode = agent.execution_mode || "";
  const provider = agent.provider || "";
  if (mode === "local_opencode" || provider === "opencode") return "opencode";
  if (mode === "local_codex" || (mode.startsWith("local_") && provider === "openai")) return "codex";
  if (mode === "local_claude_code" || (mode.startsWith("local_") && provider === "anthropic")) return "claude";
  if (mode === "local_hermes" || (mode.startsWith("local_") && provider === "hermes")) return "hermes";
  if (mode === "local_openclaw" || (mode.startsWith("local_") && provider === "openclaw")) return "openclaw";
  return undefined;
}

export function resolveInitialProvider(input: {
  argProvider?: string;
  configProvider?: string;
  providerAvailability: Record<string, boolean>;
  previousProvider?: string;
  providers?: string[];
}): string {
  const providers = input.providers || TUI_PROVIDERS;
  const configuredProvider = input.argProvider || input.configProvider;
  if (configuredProvider) return configuredProvider;
  return providers.find((name) => input.providerAvailability[name]) || input.previousProvider || providers[0];
}

export function cycleProvider(current: string, providers = TUI_PROVIDERS): string {
  const index = providers.indexOf(current);
  return providers[(index + 1) % providers.length] || providers[0];
}

export function resolveProviderCommand(input: {
  current: string;
  requested?: string;
  availability: Record<string, boolean>;
  providers?: string[];
}): { ok: true; provider: string; message: string } | { ok: false; provider: string; message: string } {
  const providers = input.providers || TUI_PROVIDERS;
  const provider = input.requested ? input.requested : cycleProvider(input.current, providers);
  if (!providers.includes(provider)) {
    return {
      ok: false,
      provider: input.current,
      message: `Unknown provider: ${provider}. Available: ${providers.join(", ")}.`,
    };
  }

  return {
    ok: true,
    provider,
    message: `Provider set to ${provider} (${providerStatus(provider, input.availability)}).`,
  };
}

export function resolveModelCommand(input: {
  current: ProviderState;
  requested?: string;
}): { ok: true; state: ProviderState; message: string } | { ok: false; state: ProviderState; message: string } {
  const requested = input.requested?.trim();
  if (!requested) {
    return {
      ok: false,
      state: input.current,
      message: "Model selection needs a model name, for example /model gpt-5.",
    };
  }

  return {
    ok: true,
    state: { ...input.current, model: requested },
    message: `Model set to ${requested}.`,
  };
}
