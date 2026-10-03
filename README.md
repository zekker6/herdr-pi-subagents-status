# herdr-pi-subagents-status

A standalone [Pi extension](https://github.com/earendil-works/pi) that reports the parent session and ordinary `pi-subagents` workers as one [Herdr](https://github.com/herdrdev/herdr) pane status. It replaces Herdr's stock Pi reporter, not `pi-subagents` itself.

- `working` while the parent or any tracked worker is active.
- `blocked` while an explicit `herdr:blocked` request is active, taking priority over working.
- `idle` once the parent has settled and all tracked workers have finished.
- Native Pi restore through reports of the root session file or session ID.

## Install

Requires Pi and Herdr. Use a Bun-based Pi runtime or Node.js 22.20 or newer. Install `pi-subagents` separately if you want worker aggregation.

**Disable the stock reporter first.** Both reporters use `herdr:pi`; running them together can overwrite status and trigger premature idle notifications.

```fish
herdr integration uninstall pi
```

Alternatively, run `pi config` and disable `herdr-agent-state.ts`. To keep Herdr's managed file installed, merge this exclusion into your user Pi settings, normally `~/.pi/agent/settings.json`:

```json
{
  "extensions": ["-extensions/herdr-agent-state.ts"]
}
```

Keep your other settings and extension entries. Reinstalling Herdr's stock integration can recreate the reporter, so retain the exclusion if you use that installer.

Install from this checkout:

```fish
pi install .
```

Pi stores the local path, so keep the checkout in place. No build or dependency installation is needed for use. Once the repository is published, install from GitHub without an npm release:

```fish
pi install git:github.com/zekker6/herdr-pi-subagents-status
```

If you already have another copy of this reporter installed, disable it before loading this package. Restart Pi or run `/reload` after changing installed extensions. This repository does not modify your active Pi settings or remove existing files.

The extension warns in TUI mode if Herdr's conventional `herdr-agent-state.ts` installation appears enabled. This is a best-effort file/settings check, not inspection of all loaded extensions. It recognizes exact and glob exclusions but cannot identify renamed copies, package-provided reporters, or every project/CLI override. The warning does not disable either reporter. Check `pi config` and load only one reporter.

## Behavior and compatibility

The extension activates only when Herdr supplies all of these variables:

| Variable | Required value |
| --- | --- |
| `HERDR_ENV` | `1` |
| `HERDR_SOCKET_PATH` | Herdr's socket path |
| `HERDR_PANE_ID` | The owning pane ID |

Only Pi's TUI session reports status. RPC, JSON, and print sessions stay silent, including headless workers that inherit the parent's Herdr environment.

This extension targets Pi **0.99.2**, `pi-subagents` **0.19.0**, and Herdr **0.9.3**. It uses Pi's `session_start`, `agent_start`, `agent_settled`, and `session_shutdown` events, `ctx.mode`, `ctx.isIdle()`, and `pi.getSettings()`. Older Pi versions are not validated. The peer dependency uses `*` per Pi's package convention, not as a claim that every Pi version works.

Worker aggregation consumes the shared event bus events `subagents:started`, `subagents:completed`, and `subagents:failed`, each with a nonempty string `id`. Workers count by ID, so duplicate terminal events do not clear unrelated workers. `subagents:created` is deliberately ignored: it can arrive after completion, and a queued worker cancelled before starting may never emit a terminal event. A same-turn queue handoff does not briefly report idle.

The reporter preserves **`source: "herdr:pi"`**. Herdr uses this identity for authoritative Pi lifecycle status and native session restore; changing it to a package-specific name breaks that compatibility. Reports retain the root session reference, never a worker's session reference. Native restore also requires the saved session to remain accessible to Herdr's Pi process.

### Limits

- No workflow tracking. `SubagentWorkflow` activity is not aggregated.
- No reconstruction of workers already running at startup or `/reload`. New `subagents:started` events are required; parent activity is recovered with `ctx.isIdle()`.
- No separate Herdr pane or status row for each worker.
- Blocked status requires an integration emitting `herdr:blocked` with `{ active: true, label?: string }` and a matching `{ active: false }`. The extension does not infer every UI prompt.
- Socket delivery is best effort: a 500 ms attempt followed by one 1500 ms retry. Intermediate pending state changes are coalesced. An unavailable socket does not stop Pi.
- Automated checks run on Linux. Windows is unvalidated; the inherited session-path check accepts POSIX absolute paths and otherwise falls back to the session ID.

## Development

### Automated checks

Run these commands from the repository root. Development uses Bun 1.4.2 and Task 3.54.0, pinned in `mise.toml`. Install dependencies from `bun.lock`; Node.js and npm are not required for development.

```fish
mise install
task install
task check
```

`task lint` type-checks the extension with TypeScript under Bun. `task test` runs the lifecycle regressions, duplicate-reporter checks, and an installation smoke test with Bun. The smoke test packs the distributable files with `bun pm pack`, installs them with Pi into a temporary `PI_CODING_AGENT_DIR`, and loads them with Pi's resource loader under Bun. It requires `tar`, makes no model calls, and does not contact a live Herdr instance. It verifies installation and loading, not an end-to-end Herdr UI or restore operation.

For a focused test run while editing:

```fish
bun test test/herdr-status.test.mjs
bun test test/stock-reporter.test.mjs
bun run test:install
```

The first two suites use local fixtures and mocked lifecycle/socket behavior. They do not need Herdr, model credentials, or `pi-subagents`. Run `task check` before submitting changes. If your shell resolves different tool versions, use `mise exec -- task check`.

### Try the extension in Herdr

1. Open a terminal pane in Herdr and change to this repository's root. Use the runtime versions listed under [Behavior and compatibility](#behavior-and-compatibility).
2. Disable Herdr's stock Pi reporter and any other copy of this reporter as described under [Install](#install). Keep `pi-subagents` enabled for worker tests.
3. Load the source for this invocation without adding the package to your Pi settings:

   ```fish
   bun node_modules/@earendil-works/pi-coding-agent/dist/cli.js --extension ./src/herdr-status.ts
   ```

   This uses the development dependency's Pi version with your usual Pi profile. Herdr supplies the socket and pane environment variables; do not invent values for them. Outside Herdr, the reporter stays inactive.

4. Send a short prompt. Confirm the pane changes to `working` during the turn and returns to `idle` after Pi settles. Model-backed checks require your normal Pi provider credentials and may incur usage costs.
5. Ask Pi to launch an ordinary background `pi-subagents` worker with enough work to outlast the parent turn, then return without waiting. Confirm the pane stays `working` after the parent settles and becomes `idle` only after the worker finishes and the parent has settled again. Repeat with two workers and confirm the first completion does not clear the second. Use ordinary workers, not `SubagentWorkflow`.
6. After editing the source, wait for all workers to finish, then run `/reload` in Pi and repeat the checks. Reload does not reconstruct already-running workers. No build step is needed.

If you installed this checkout with `pi install .`, start Pi normally instead of adding another source load. Source edits take effect after `/reload` or a restart.

## CI and dependency updates

GitHub Actions runs `task install` and `task check` on pull requests and pushes to `main` or `master`, using the tools pinned in `mise.toml`.

`renovate.json` extends the public [zekker6/renovate-config](https://github.com/zekker6/renovate-config) presets for dependency, mise tool, and GitHub Actions updates, including their automerge policy. Enable the [Renovate GitHub App](https://github.com/apps/renovate) for this repository to activate updates.

## Attribution

Adapted from Herdr's Pi integration version 8, with subagent status aggregation and regression tests. See [NOTICE](NOTICE) for provenance and [LICENSE](LICENSE) for Apache-2.0 terms.
