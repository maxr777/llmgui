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

## Architecture and Security

- `src/main.ts` owns UI state, local conversation persistence, prompt management, and attachment handling.
- `src-tauri/src/lib.rs` owns provider HTTP requests. Keep provider endpoints fixed in Rust; never accept arbitrary endpoint URLs from the WebView.
- API keys are session-only. Never write them to local storage, logs, errors, or conversation history.
- Treat model output as untrusted. Keep Markdown sanitization and the restrictive Tauri CSP intact.
- Keep provider request formats explicit rather than forcing OpenAI, Anthropic, and Google through a misleading shared wire format.

## Verification

Run the narrow checks relevant to the change. Before a release, run all of:

```sh
pnpm install --frozen-lockfile
pnpm build
cargo fmt --check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
```

## Releases

- Use calendar versions in the SemVer-compatible form `YYYY.M.D-N`, based on the current UTC date. `N` starts at `1` each day and increments for additional releases that day; for example, the first two releases on July 19, 2026 are `2026.7.19-1` and `2026.7.19-2`. Always include `N` so same-day versions remain correctly ordered.
- Keep versions synchronized in `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json`. Regenerate `src-tauri/Cargo.lock` after changing the Cargo package version.
- Tags use `vYYYY.M.D-N` and must match the application version exactly (with only the leading `v` added).
- Pushing a version tag triggers `.github/workflows/release.yml`, which builds a draft GitHub release for Linux x64, Windows x64, and both macOS architectures.
- Publish the draft only after every matrix job succeeds and all installers are attached.
- Release installers are currently unsigned. Do not imply they are signed or notarized unless signing credentials and configuration are added.

When shipping a release to `main`:

1. Choose the next version for the current UTC date and update every version file above.
2. Run the full release verification commands from the Verification section and commit the version changes.
3. Merge or push that commit to `main`. Create the release tag from that exact commit only after it is on `main`.
4. Push the tag, for example: `git tag -a v2026.7.19-1 -m "llmgui v2026.7.19-1" && git push origin v2026.7.19-1`.
5. Wait for the Release workflow to finish, verify all four platform installers are attached to the draft release, then publish the draft.
