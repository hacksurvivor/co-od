import {
  checkAllProviderAuth,
  checkProviderAuth,
  loginProvider,
  logoutProvider,
  providerAuthProviders,
  PROVIDER_AUTH_FILE,
  type ProviderAuthCheck,
} from "../provider-auth.js";

interface ParsedAuthArgs {
  command: "status" | "login" | "logout" | "list";
  provider?: string;
  json?: boolean;
}

function parseArgs(args: string[]): ParsedAuthArgs {
  const command = (args[0] || "status").toLowerCase();
  const parsed: ParsedAuthArgs = {
    command: command === "add" ? "login"
      : command === "remove" ? "logout"
      : command === "list" ? "list"
      : command === "login" || command === "logout" || command === "status" ? command
      : "status",
  };
  for (let index = 1; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--json") {
      parsed.json = true;
    } else if (!arg.startsWith("-") && !parsed.provider) {
      parsed.provider = arg.toLowerCase();
    }
  }
  if (command && !["add", "remove", "list", "login", "logout", "status"].includes(command) && !parsed.provider) {
    parsed.provider = command;
  }
  return parsed;
}

function statusGlyph(status: ProviderAuthCheck["status"]): string {
  if (status === "connected") return "connected";
  if (status === "cli_missing") return "missing";
  return "needs login";
}

function printChecks(checks: ProviderAuthCheck[]): void {
  console.log(`Provider auth store: ${PROVIDER_AUTH_FILE}`);
  for (const check of checks) {
    const source = check.source ? ` · ${check.source}` : "";
    console.log(`${check.provider.padEnd(8)} ${statusGlyph(check.status).padEnd(11)} ${check.label}${source}`);
    if (check.status !== "connected") {
      console.log(`           ${check.detail}`);
    }
  }
}

function printProviderList(): void {
  for (const provider of providerAuthProviders()) {
    console.log(`${provider.provider.padEnd(8)} ${provider.label} (${provider.command})`);
  }
}

export async function run(args: string[]): Promise<void> {
  const parsed = parseArgs(args);
  if (parsed.command === "list") {
    printProviderList();
    return;
  }

  if (parsed.command === "status") {
    const checks = parsed.provider ? [checkProviderAuth(parsed.provider)] : checkAllProviderAuth();
    if (parsed.json) {
      console.log(JSON.stringify({ authFile: PROVIDER_AUTH_FILE, providers: checks }, null, 2));
    } else {
      printChecks(checks);
    }
    return;
  }

  if (parsed.command === "logout") {
    const provider = parsed.provider || "all";
    logoutProvider(provider);
    console.log(provider === "all"
      ? "Cleared co-od provider auth records."
      : `Cleared co-od provider auth record for ${provider}.`);
    console.log("Provider CLI credentials are left in their official stores; run that CLI's logout command to revoke them.");
    return;
  }

  const provider = parsed.provider;
  if (!provider) {
    throw new Error("Choose a provider: codex, claude, or gemini. Example: co-od auth login codex");
  }
  console.log(`Starting ${provider} login using the official provider CLI...`);
  const check = await loginProvider(provider);
  printChecks([check]);
}
