import test from "node:test";
import assert from "node:assert/strict";

import {
  buildCompletionScript,
  COMPLETION_SHELLS,
  formatCompletionHelp,
  isCompletionShell,
} from "../dist/commands/completion.js";

test("completion command supports the expected shells", () => {
  assert.deepEqual(COMPLETION_SHELLS, ["bash", "zsh", "fish"]);
  assert.equal(isCompletionShell("bash"), true);
  assert.equal(isCompletionShell("zsh"), true);
  assert.equal(isCompletionShell("fish"), true);
  assert.equal(isCompletionShell("powershell"), false);
});

test("bash completion includes command aliases, commands, and key TUI flags", () => {
  const script = buildCompletionScript("bash");

  assert.match(script, /complete -F _co_od_completion co-od co-ode/);
  assert.match(script, /tui opentui web start init login auth rooms run join daemon share connect status doctor notify tui-qa completion/);
  assert.match(script, /--renderer/);
  assert.match(script, /--provider/);
  assert.match(script, /--bridge-url/);
  assert.match(script, /antigravity claude codex custom gemini grok hermes opencode openclaw pi zeroclaw/);
});

test("zsh completion includes command descriptions and command-specific flags", () => {
  const script = buildCompletionScript("zsh");

  assert.match(script, /#compdef co-od co-ode/);
  assert.match(script, /'completion:Generate a shell completion script'/);
  assert.match(script, /tui\) compadd -- .*--renderer.*--provider/);
  assert.match(script, /tui-qa\) compadd -- .*--live.*--bridge-url.*--mutate/);
});

test("fish completion includes both binary names and command-specific flags", () => {
  const script = buildCompletionScript("fish");

  assert.match(script, /complete -c co-od -f/);
  assert.match(script, /complete -c co-ode -f/);
  assert.match(script, /-a 'completion' -d 'Generate a shell completion script'/);
  assert.match(script, /__co_od_using_command tui.*-a '--renderer'/s);
  assert.match(script, /__co_od_using_command run.*-a '--continue'/s);
  assert.match(script, /__co_od_using_command tui-qa.*-a '--bridge-url'/s);
});

test("completion help shows install destinations", () => {
  const help = formatCompletionHelp();

  assert.match(help, /Usage: co-od completion <bash\|zsh\|fish>/);
  assert.match(help, /~\/\.zfunc\/_co-od/);
  assert.match(help, /bash-completion\/completions\/co-od/);
  assert.match(help, /fish\/completions\/co-od\.fish/);
});
