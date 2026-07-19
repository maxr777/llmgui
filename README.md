# llmgui

A simple, minimal desktop GUI for chatting with LLMs using your own API tokens, instead of a subscription or a hosted chat interface.

Built entirely with LLMs as an experiment in LLM-assisted development.

## Requirements

You need a few standard tools installed before you can build or run llmgui. These are one-time installs.

1. **Node.js** (version 18 or newer) — runs the JavaScript/TypeScript part. Download it from <https://nodejs.org/> and install it. Check it's installed by running `node --version` in a terminal; you should see a version number.
2. **pnpm** — a package manager that fetches the JavaScript libraries the project uses. Install it by running `npm install -g pnpm` in a terminal (npm comes bundled with Node.js). Verify with `pnpm --version`.
3. **Rust** — the programming language the desktop app itself is written in. Install it from <https://www.rust-lang.org/tools/install> and follow the instructions for your system. Verify with `rustc --version`.
4. **System libraries for Tauri** — Tauri (the framework that turns web code into a desktop app) needs a few OS-level libraries installed. The exact packages depend on your operating system; see the [Tauri prerequisites guide](https://tauri.app/start/prerequisites/). On most Linux distros this means a C compiler, GTK, and WebKit. On macOS you need Xcode Command Line Tools. On Windows you need the Microsoft C++ Build Tools.

## Get the code

If you haven't already, download a copy of this project:

```sh
git clone git@github.com:maxr777/llmgui.git
cd llmgui
```

## Install dependencies

Fetch the JavaScript libraries the project uses (this only needs to be done once, and again only if the dependency list changes):

```sh
pnpm install
```

## Run in development mode

This launches the app live, with automatic reloading when you edit files. Best while working on it:

```sh
pnpm tauri dev
```

The first run will take a while because Rust has to compile the desktop shell from scratch. Subsequent runs are much faster.

## Build a standalone app

This produces a finished, installable desktop app (an `.exe` installer on Windows, a `.dmg` on macOS, or a package on Linux) in `src-tauri/target/release/bundle/`:

```sh
pnpm tauri build
```

Again, the first build is slow; later builds reuse the cached compilation.
