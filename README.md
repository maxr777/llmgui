# llmgui

A simple, minimal desktop GUI for chatting with LLMs using your own API tokens, instead of a subscription or a hosted chat interface.

Built entirely with LLMs as an experiment in LLM-assisted development.

## Requirements

- [Node.js](https://nodejs.org/) 18+
- [pnpm](https://pnpm.io/) — `npm install -g pnpm`
- [Rust](https://www.rust-lang.org/tools/install)
- [Tauri system dependencies](https://tauri.app/start/prerequisites/)

## Build & Run

```sh
git clone git@github.com:maxr777/llmgui.git
cd llmgui
pnpm install

# run in development (hot reload)
pnpm tauri dev

# build a standalone installer bundle
pnpm tauri build    # output: src-tauri/target/release/bundle/
```
