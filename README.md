# llmgui

A simple, minimal desktop GUI for chatting with LLMs using your own API tokens, instead of a subscription or a hosted chat interface.

Built entirely with LLMs as an experiment in LLM-assisted development.

## Features

- Multi-turn chat with OpenAI, Anthropic, and Google models
- Persistent conversation history, stars, renaming, model settings, and reusable system prompts
- Markdown, syntax highlighting, and LaTeX rendering
- Text and code attachments (256 KiB per file, 512 KiB per message)
- Provider-reported token usage and actionable API errors

API keys are sent only from the native Rust process to the selected provider. They are kept in memory for the current app session and are not written to local storage. Conversations and non-secret settings are stored locally in the app's WebView profile.

## Download

Installers for Linux, macOS, and Windows are available from [GitHub Releases](https://github.com/maxr777/llmgui/releases/latest):

| Platform | Downloads |
| --- | --- |
| Linux x64 | AppImage, Debian package, RPM |
| macOS Apple Silicon | DMG |
| macOS Intel | DMG |
| Windows x64 | NSIS installer, MSI |

The installers are currently unsigned. Windows SmartScreen or macOS Gatekeeper may show a warning; review the release and repository before bypassing operating-system protections.

## Requirements

- [Node.js](https://nodejs.org/) 18+
- [pnpm](https://pnpm.io/) 9.15.9 — available through Node's Corepack
- [Rust](https://www.rust-lang.org/tools/install)
- [Tauri system dependencies](https://tauri.app/start/prerequisites/)

## Build & Run

```sh
git clone git@github.com:maxr777/llmgui.git
cd llmgui
corepack pnpm@9.15.9 install

# run in development (hot reload)
corepack pnpm@9.15.9 tauri dev

# build a standalone installer bundle
corepack pnpm@9.15.9 tauri build    # output: src-tauri/target/release/bundle/
```

Open **Settings**, enter the key for your provider, choose a model, and close the modal by clicking outside it. Model lists are editable so newer provider model IDs can be used without an app update.

## Releasing

Version tags build all desktop installers in GitHub Actions and collect them in a draft release:

```sh
# First update the same version in package.json, src-tauri/Cargo.toml,
# and src-tauri/tauri.conf.json, then commit it.
git tag vX.Y.Z
git push origin main vX.Y.Z
```

After every platform job succeeds, verify the attached files and publish the draft release. See [`AGENTS.md`](AGENTS.md) for the release checklist.
