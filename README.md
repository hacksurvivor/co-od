# co-od CLI

The open-source command-line workspace for running coding agents together.
Use Claude Code, Codex, Gemini, Grok, OpenCode, OpenClaw, ZeroClaw,
Antigravity, Hermes, Pi, or a custom harness from one terminal UI.

The native Mac app and the co-od website are separate products with private
source. This repository contains the CLI tool, its tests, public documentation,
and downloadable Mac release binaries.

## Native Mac app

[Download co·od for Mac](https://github.com/hacksurvivor/co-od/releases/download/macos-0.3.1.0-20260908071837/co-od-0.3.1.0-20260908071837-macOS-26-arm64.dmg) · [Release notes](https://github.com/hacksurvivor/co-od/releases/tag/macos-0.3.1.0-20260908071837)

The current alpha is version **0.3.1.0**, build **20260908071837**, for Apple
silicon Macs running macOS 26.5 or later. The installer is Developer ID signed,
notarized, and stapled. The native app remains a separate product; its source
is not included under this repository’s CLI license.

## Install

```bash
npm install --global @codegrammer/co-od
```

Then sign in and open the terminal workspace:

```bash
co-od login
co-od
```

You can also try it without a global install:

```bash
npx @codegrammer/co-od doctor
```

## Useful commands

```bash
co-od rooms
co-od run <room> "Fix the failing tests"
co-od join <room>
co-od share
co-od doctor
```

Run `co-od --help` for the full command list. The default service is
[co-od.dev](https://co-od.dev); use `CO_ODE_SERVER` to point the CLI at another
compatible server.

## Develop

Requirements: Node.js 18+ and Corepack.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm test
pnpm build
```

The complete deterministic terminal verification is available with:

```bash
pnpm verify:tui
```

## Privacy boundary

This public repository intentionally excludes:

- the native macOS application source;
- the co-od website source and media;
- hosted backend and deployment configuration;
- private room data, credentials, local runtime state, and personal files.

Authentication tokens are read at runtime and must never be committed. See
[SECURITY.md](SECURITY.md) for private vulnerability reporting.

## License

The CLI source in this repository is available under the [MIT License](LICENSE).
