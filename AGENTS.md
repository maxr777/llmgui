# llmgui

A minimal, fast, standalone desktop GUI for chatting with LLMs via your own API tokens.

## Principles

This project is deliberately small and self-contained. The goal is a tight, no-bloat codebase with as few external dependencies as practical. When making changes, favor:

- **Minimalism.** Don't add code, files, or features unless they serve the core goal. Prefer removing over adding.
- **Few external dependencies.** Implement things directly rather than pulling in a library when a modest amount of code will do. Every new dependency needs a real justification.
- **Speed.** Keep the app fast to build, fast to launch, and fast to run. Avoid abstractions that add overhead without earning it.
- **Self-contained.** Prefer implementing the thing yourself over relying on a framework feature or third-party helper. Understand and own the code that runs.
- **Direct code.** Write straightforward, readable code over clever indirection. No speculative generality, no unused config, no dead weight.
- **Tauri + Vanilla TS.** The frontend stays plain TypeScript and HTML/CSS. No UI framework, no state library, no build-time magic beyond what's already here.

When in doubt, leave it out.
