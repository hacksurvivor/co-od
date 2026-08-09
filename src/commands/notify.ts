// `co-od notify` — configure and test attention routing (desktop + Telegram).
// The TUI picks the config up on next launch; nothing here touches the server.
import {
  loadNotifyConfig,
  notifyConfigPath,
  RoomNotifier,
  saveNotifyConfig,
} from "../notify.js";

const HELP = `co-od notify — route room events to your desktop and Telegram

usage:
  co-od notify                            show what's configured
  co-od notify set telegram <bot-token> <chat-id>
  co-od notify set desktop on|off
  co-od notify off                        disable telegram delivery
  co-od notify test                       send a test notification

Telegram setup: message @BotFather, /newbot, copy the token. Then message
your new bot once and grab your chat id from
https://api.telegram.org/bot<token>/getUpdates — or use @userinfobot.

While a bridge approval is pending, the TUI long-polls your bot so the
✓ Allow / ✗ Deny buttons under the Telegram message answer it directly.`;

export async function run(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(HELP);
    return;
  }

  const [command, ...rest] = args;
  const config = loadNotifyConfig() ?? { desktop: true };

  if (!command || command === "status") {
    console.log(`config: ${notifyConfigPath()}`);
    console.log(`desktop: ${config.desktop ? "on" : "off"}`);
    console.log(
      config.telegram
        ? `telegram: configured (chat ${config.telegram.chatId})`
        : "telegram: not configured — co-od notify set telegram <bot-token> <chat-id>",
    );
    return;
  }

  if (command === "set" && rest[0] === "telegram") {
    const [, botToken, chatId] = rest;
    if (!botToken || !chatId) {
      console.error("usage: co-od notify set telegram <bot-token> <chat-id>");
      process.exitCode = 1;
      return;
    }
    saveNotifyConfig({ ...config, telegram: { botToken, chatId } });
    console.log("telegram delivery configured — co-od notify test sends a test message");
    return;
  }

  if (command === "set" && rest[0] === "desktop") {
    const value = rest[1];
    if (value !== "on" && value !== "off") {
      console.error("usage: co-od notify set desktop on|off");
      process.exitCode = 1;
      return;
    }
    saveNotifyConfig({ ...config, desktop: value === "on" });
    console.log(`desktop notifications ${value}`);
    return;
  }

  if (command === "off") {
    saveNotifyConfig({ desktop: config.desktop, telegram: undefined });
    console.log("telegram delivery disabled");
    return;
  }

  if (command === "test") {
    if (!config.desktop && !config.telegram) {
      console.log("nothing configured to deliver — desktop is off and telegram is not set up");
      return;
    }
    // One deliver() call exercises exactly the configured sinks — no
    // unconditional desktop send, no double notification.
    const notifier = new RoomNotifier(config);
    notifier.deliver("co-od", "Notifications are working — approvals will show ✓ Allow / ✗ Deny buttons in Telegram.");
    if (config.telegram) {
      // Give the fire-and-forget send a moment before the process exits.
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    notifier.close();
    const sinks = [config.desktop ? "desktop" : "", config.telegram ? "Telegram" : ""].filter(Boolean).join(" and ");
    console.log(`sent — check your ${sinks}`);
    return;
  }

  console.error(`Unknown notify command: ${command}`);
  console.log(HELP);
  process.exitCode = 1;
}
