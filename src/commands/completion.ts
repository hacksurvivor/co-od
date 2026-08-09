import { CLI_COMMAND_NAMES, CLI_COMMANDS, GLOBAL_FLAGS, PROVIDER_NAMES } from "../commands-registry.js";

export type CompletionShell = "bash" | "zsh" | "fish";

export const COMPLETION_SHELLS: CompletionShell[] = ["bash", "zsh", "fish"];

const COMMAND_ALIASES = ["co-od", "co-ode"];

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function shellWords(values: string[]): string {
  return unique(values).join(" ");
}

function zshSingleQuoted(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function fishSingleQuoted(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

function commandFlags(command: string): string[] {
  return CLI_COMMANDS[command]?.flags || [];
}

function buildBashCompletionScript(): string {
  const commands = shellWords(CLI_COMMAND_NAMES);
  const globalFlags = shellWords(GLOBAL_FLAGS);
  const providers = shellWords(PROVIDER_NAMES);
  const commandCases = CLI_COMMAND_NAMES.map((command) => {
    const flags = shellWords(commandFlags(command));
    return `    ${command}) COMPREPLY=( $(compgen -W "${flags}" -- "$cur") ) ;;`;
  }).join("\n");

  return `# co-od bash completion
_co_od_completion() {
  local cur prev
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"

  case "$prev" in
    --renderer)
      COMPREPLY=( $(compgen -W "node opentui" -- "$cur") )
      return
      ;;
    --provider)
      COMPREPLY=( $(compgen -W "${providers}" -- "$cur") )
      return
      ;;
    --dir)
      COMPREPLY=( $(compgen -d -- "$cur") )
      return
      ;;
    --server)
      return
      ;;
    --bridge-url|--bridge)
      return
      ;;
  esac

  if [[ \${COMP_CWORD} -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "${commands} ${globalFlags}" -- "$cur") )
    return
  fi

  case "\${COMP_WORDS[1]}" in
${commandCases}
    *) COMPREPLY=( $(compgen -W "${globalFlags}" -- "$cur") ) ;;
  esac
}

complete -F _co_od_completion co-od co-ode
`;
}

function buildZshCompletionScript(): string {
  const commands = CLI_COMMAND_NAMES
    .map((command) => `    ${zshSingleQuoted(`${command}:${CLI_COMMANDS[command].desc}`)}`)
    .join("\n");
  const commandNames = shellWords(CLI_COMMAND_NAMES);
  const globalFlags = shellWords(GLOBAL_FLAGS);
  const providers = shellWords(PROVIDER_NAMES);
  const commandCases = CLI_COMMAND_NAMES.map((command) => {
    const flags = shellWords(commandFlags(command));
    return `    ${command}) compadd -- ${flags} ;;`;
  }).join("\n");

  return `#compdef co-od co-ode
# co-od zsh completion
_co_od() {
  local -a commands
  commands=(
${commands}
  )

  if (( CURRENT == 2 )); then
    _describe 'co-od command' commands
    compadd -- ${globalFlags}
    return
  fi

  case "\${words[CURRENT-1]}" in
    --renderer) compadd -- node opentui; return ;;
    --provider) compadd -- ${providers}; return ;;
    --dir) _files -/; return ;;
    --server|--bridge-url|--bridge) return ;;
  esac

  case "\${words[2]}" in
${commandCases}
    *) compadd -- ${commandNames} ${globalFlags} ;;
  esac
}

_co_od "$@"
`;
}

function buildFishCompletionScript(): string {
  const lines = [
    "# co-od fish completion",
    "function __co_od_using_command",
    "  set -l cmd (commandline -opc)[2]",
    "  test \"$cmd\" = \"$argv[1]\"",
    "end",
  ];

  for (const alias of COMMAND_ALIASES) {
    lines.push(`complete -c ${alias} -f`);
    for (const command of CLI_COMMAND_NAMES) {
      lines.push(`complete -c ${alias} -f -n "__fish_use_subcommand" -a ${fishSingleQuoted(command)} -d ${fishSingleQuoted(CLI_COMMANDS[command].desc)}`);
    }
    for (const flag of GLOBAL_FLAGS) {
      lines.push(`complete -c ${alias} -f -n "__fish_use_subcommand" -a ${fishSingleQuoted(flag)}`);
    }
    for (const command of CLI_COMMAND_NAMES) {
      for (const flag of commandFlags(command)) {
        lines.push(`complete -c ${alias} -f -n "__co_od_using_command ${command}" -a ${fishSingleQuoted(flag)}`);
      }
    }
    lines.push(`complete -c ${alias} -f -n "__fish_seen_argument --renderer" -a "node opentui"`);
    lines.push(`complete -c ${alias} -f -n "__fish_seen_argument --provider" -a ${fishSingleQuoted(shellWords(PROVIDER_NAMES))}`);
  }

  return `${lines.join("\n")}\n`;
}

export function buildCompletionScript(shell: CompletionShell): string {
  switch (shell) {
    case "bash":
      return buildBashCompletionScript();
    case "zsh":
      return buildZshCompletionScript();
    case "fish":
      return buildFishCompletionScript();
  }
}

export function isCompletionShell(value: string): value is CompletionShell {
  return (COMPLETION_SHELLS as string[]).includes(value);
}

export function formatCompletionHelp(): string {
  return [
    "Generate shell completions for co-od.",
    "",
    "Usage: co-od completion <bash|zsh|fish>",
    "",
    "Examples:",
    "  co-od completion zsh > ~/.zfunc/_co-od",
    "  co-od completion bash > ~/.local/share/bash-completion/completions/co-od",
    "  co-od completion fish > ~/.config/fish/completions/co-od.fish",
  ].join("\n");
}

export async function run(args: string[]): Promise<void> {
  const shell = args[0];

  if (!shell || shell === "--help" || shell === "-h") {
    console.log(formatCompletionHelp());
    return;
  }

  if (!isCompletionShell(shell)) {
    console.error(`Unsupported completion shell: ${shell}`);
    console.error(formatCompletionHelp());
    process.exit(1);
  }

  process.stdout.write(buildCompletionScript(shell));
}
