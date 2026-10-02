---
spec_id: dragon-ide
version: 0.9.3
status: active
owners: [VELLORAAI]
last_synced_with_central: 2026-09-30
source_of_truth: repo
related_specs:
  - extensions/dragon-agent/SPEC.md
  - extensions/dragon-agent/src/search/SPEC.md
  - src/vs/workbench/contrib/dragonOnboarding/SPEC.md
related_code:
  - product.json
  - extensions/dragon-agent/
  - src/vs/workbench/contrib/dragonOnboarding/
  - src/vs/workbench/contrib/dragonShared/
  - opencode/
---

# Dragon IDE

## What

Dragon IDE is an open-source AI code editor. It is a fork of VS Code 1.139.1 whose only agent is OpenCode (v2.0.18, vendored in `opencode/`). Its main features:

- **Chat:** a native chat view in which every turn runs inside OpenCode.
- **TUI:** a built-in OpenCode terminal (TUI) that shares sessions with the chat.
- **Local models:** first-class support through Ollama.
- **Search:** Instant Grep, an index-backed code search for the agent, and `codebase_search`, semantic search with local embeddings.
- **Usage readout:** the chat composer shows how full the context window is, the session's cache-hit share and the selected model's input/output price, for every provider OpenCode reports usage and prices for.
- **Design:** the Dragon look, meaning the splash, the onboarding screen, live tool cards and the composer chips.

## Why

We want an editor with the Cursor experience whose agent, model choice and code search are all open source and run locally, with no required account and no telemetry.

## How

```
VS Code workbench (chat view = UI only)
   └─ @dragon participants ── extensions/dragon-agent ── HTTP+SSE ──▶ opencode serve (1 per window, loopback)
                                                                        ├─ Instant Grep plugin (grep/glob/find_files/codebase_search)
OpenCode TUI terminal ── opencode --server <url> ──────────────────────┤
Ollama (127.0.0.1:11434) ◀── OpenCode ollama provider ─────────────────┘
```

- VS Code handles editing, git, the terminal and chat rendering. OpenCode handles the agent loop, tools, edits, permissions, providers and credentials.
- Dragon's OpenCode settings live in a config layer that Dragon owns (`OPENCODE_CONFIG`). It holds the default model, Ollama limits and the Instant Grep plugin, and OpenCode hot-reloads it.

## API/Contract

| Surface | Contract |
| --- | --- |
| Chat participants | `dragon.agent` (Agent mode, OpenCode `build`), `dragon.edit` (Edit mode, `build`), `dragon.ask` (Ask mode, `plan`), and `dragon.inline` (inline edits in the editor, Ctrl/Cmd+I, `plan`). Slash commands: `/new`, `/compact`, `/tui`; any other command is forwarded to OpenCode. |
| Language models | The vendor `dragon` lists OpenCode's enabled models as `provider/model`. The picker only selects a model; requests run through OpenCode. |
| Settings | `dragon.model`, `dragon.permissionMode` (`read-only`, `ask`, `full-access`), `dragon.workingDirectory`, `dragon.opencode.path`, `dragon.ollama.enabled`, `dragon.ollama.origin`, `dragon.instantGrep.enabled`, `dragon.semanticSearch.enabled`, `dragon.semanticSearch.model`, `dragon.completions.enabled`, `dragon.completions.model`, `dragon.updates.check` |
| Commands | `dragon.chooseModel`, `dragon.openTui`, `dragon.continueInTui`, `dragon.continueInChat`, `dragon.ollama.pull`, `dragon.semanticSearch.setup`, `dragon.completions.setup`, `dragon.checkForUpdates`, `dragon.moveSession`, `dragon.restartServer`, `dragon.showLog`, `dragon.showOnboarding`, `dragon.connectAI`, the `dragon.onboarding.*` commands used by the onboarding screen, and `dragon.usage.summary` (the composer's usage readout) |
| Terminal profile | `dragon.opencode` ("OpenCode"): the TUI attached to the window's server |
| Walkthrough | `vscode.dragon-agent#dragon.gettingStarted` ("Get Started with Dragon IDE") |
| Product fields | `dragonVersion` (stamped from the release tag) and `dragonUpdateFeed` (GitHub "latest release" API URL; forks point it at their own repository) |
| Build | `npm run dragon:build-opencode` (bundles the binary), `npm run dragon:check` (branding gate plus tests), `npm run dragon:smoke-usage` |

The full contracts are in [`extensions/dragon-agent/SPEC.md`](extensions/dragon-agent/SPEC.md) and [`extensions/dragon-agent/src/search/SPEC.md`](extensions/dragon-agent/src/search/SPEC.md).

## Behavior & Invariants

1. **OpenCode is the only agent harness.** The one AI feature outside it is Tab completion, a direct fill-in-the-middle call to the local Ollama. VS Code's own harnesses do not run:
   - `extensions/copilot` does not exist.
   - `product.json` has no `defaultChatAgent`.
   - The built-in agent host (Copilot SDK, Claude and Codex) is disabled on desktop and remote web, and so is the Agents window that runs it, along with its commands and banner.
2. **Core code works without a Copilot default agent.** Every place that assumed one is guarded and marked `// DRAGON`.
3. **Local by default.**
   - The OpenCode server binds to loopback with a random per-window password.
   - Ollama is used only on loopback.
   - The Instant Grep index and the semantic vectors stay on the machine; embeddings come from a loopback Ollama.
   - There is no telemetry.
   - Dragon's own code makes one background request: the daily update check, an anonymous GET to the release feed. `dragon.updates.check` turns it off.
   - OpenCode refreshes its public model catalog from `models.opencode.ai`, with a bundled snapshot as the fallback.
   - VS Code's extension update checks go to Open VSX.
4. **No proprietary endpoints.** `scripts/dragon/check-branding.mts` fails the build when a name or endpoint matching the `DRAGON_FORBIDDEN_NAMES` pattern appears.
5. **Small upstream diffs.**
   - New workbench code lives in `contrib/dragon*`.
   - Every edit to an upstream VS Code file is marked `// DRAGON`.
   - `opencode/` is unmodified; `opencode-patches/` is empty.
6. **Extensions come from Open VSX**, never the Microsoft Marketplace (enforced by the hygiene gallery rule). The exception is the pinned built-in extensions (js-debug and its companions), which the build downloads from their GitHub releases and checks against their pinned checksums.
7. **The package holds no Copilot code.** The Copilot SDK runtime is neither re-added nor packaged. Source maps are stripped and not pointed at Microsoft's CDN. The agent extension ships only `dist/`, `bin/` (OpenCode), `media/` and `package.json`.
8. **The UI names Dragon IDE, never VS Code.** `rebrand()` (`src/vs/nls.ts`) is applied wherever text becomes UI: localized messages, extension manifests, extension `l10n` strings, walkthroughs and built-in READMEs. Identifiers (`vscode.*`, `.vscode/`, `vscode://`) and accurate references to other software are kept. The branding gate guards the hooks, and `npm run dragon:check-ui` checks the running app.

## Failure Modes & Remediations

| Failure | Behavior | Remediation |
| --- | --- | --- |
| The OpenCode binary is missing | The status bar shows an error; chat explains how to fix it | `npm run dragon:build-opencode`, `opencode` on PATH, or `dragon.opencode.path` |
| The OpenCode server crashes | It restarts automatically with backoff (1 s, doubling, up to 30 s) | **Dragon: Show OpenCode Log** |
| A provider rejects a request (auth, quota, network) | The turn ends with the provider's message and a pointer to **Dragon: Choose Model** | Connect a provider or pick a local model |
| The workspace is untrusted | Entry works; Connect AI requests trust before provider setup | Trust the folder only if its contents are trusted |
| No Ollama is running | In-app model setup and **Download a Local Model** offer the Ollama download | Install or start Ollama |
| ripgrep is missing | Instant Grep is disabled and OpenCode's own grep is used | Ships with VS Code; check the OpenCode log |

## Tests

- `npm run dragon:check`: the branding gate and all dragon-agent tests, which include:
  - unit tests, including the release-feed and version checks
  - the ripgrep equivalence test: file lists and lines, including the in-process path and Unicode case folding
  - the semantic search suite against a mock embedder
  - an end-to-end test in which the real OpenCode binary, with the Instant Grep plugin, runs a turn against a scripted Ollama: `grep`, then `codebase_search`, then an edit
  - the usage readout: DeepSeek Harness's cache-hit rounding cases, every provider shape, and an end-to-end test on the real OpenCode binary with a priced provider that reports cached tokens
- `npm run dragon:smoke-usage` (`scripts/dragon/smoke-usage.mts`): drives the desktop app with a scripted OpenAI-compatible provider that has prices and reports cached prompt tokens, runs a chat turn, and checks the composer's readout (context ring, `80% cache hit`, `$3 / $15 per 1M`, the tooltip). It also checks that no pill is covered in the default narrow chat and that the readout shares the chips' row in a wide one. `--app <dir>` runs it against a packaged app on macOS, Linux or Windows. It strips provider credentials from the app's environment so no real provider is enabled.
- `node scripts/dragon/bench-instant-grep.mts <repo>`: speed against ripgrep, failing on any mismatch.
- `npm run dragon:smoke-onboarding` (`scripts/dragon/smoke-onboarding.mts`): drives the desktop app through first-run onboarding against a scripted Ollama: splash, Restricted Mode, the trust dialog, picking a local model (which creates its agent variant), and a Dragon turn that reads and edits a file. It checks the file on disk and that every model request went to the new variant. On the macOS development build (Apple M4 Pro, 2026-09-28) it passed six runs in a row, 26–41 s each, after the fix it prompted (onboarding now selects the chosen model in the chat; before that, 1 of 3 runs caught the turn on the base model).
- `npm run dragon:check-ui` (`scripts/dragon/check-ui-branding.cjs`): launches the desktop app and fails if VS Code is named in the default settings JSON (every setting description, case-sensitive), the settings editor, the command palette, the Editor Playground, the built-in extensions and their details, the welcome page, About or the issue reporter.
- **Packaging**, run locally with the CI job's commands:
  - `CI=1 npm run gulp vscode-linux-x64-min` builds in about 4.4 minutes, and the result is 805 MB.
  - The job's checks all pass: binary, bundled `opencode`, agent `dist/`, no `extensions/copilot`, and the product identity.
  - Launched under Xvfb, it shows the Dragon onboarding, and its OpenCode log reports `ready at http://127.0.0.1…`, with Instant Grep using the packaged ripgrep.
- CI (`.github/workflows/ci.yml`) has five jobs:
  - the dragon-agent job
  - **secret-scan**: gitleaks (pinned and checksum-verified) on the commits in the change
  - the workbench type check, layer check, hygiene on changed files and full compile
  - **unit-tests**: the upstream Node and Electron unit suites (about 18k and 28k tests) under Xvfb. Upstream tests see upstream's Copilot `defaultChatAgent` through `test/unit/upstreamProductFixture.json`, so they exercise that disabled code as upstream configures it. The shipped `product.json` has no default chat agent.
  - **package-linux**, which builds the Linux desktop app with the bundled OpenCode, checks the packaged product, launches it under Xvfb, requires the OpenCode server to start, and runs the onboarding smoke test against the packaged app
- `npm run ci:local` (`scripts/dragon/ci-local.mts`) runs those jobs on any machine against HEAD: each job in a fresh git worktree, with the `run:` steps verbatim. All jobs passed on 2026-09-28. `--node-headers` and `--reuse-deps` are reported deviations for networks that block electronjs.org or the GitHub API.
- **Release packages** (`.github/workflows/release.yml`): Linux `.deb` and `.rpm` are built with the upstream gulp tasks. Locally, the deb was installed with apt, launched with OpenCode ready and purged, and the rpm was extracted and launched. Neither touched apt's sources or keyrings. The deb's dependency list comes from Microsoft-hosted sysroots, which the local test network blocked, so the first real deb dependency computation happens on the release runner.
- **Release gates:** `scripts/dragon/audit-package.mts` checks the packaged app's version against `product.json`'s `dragonVersion`, the license files and the absence of restricted packages. `scripts/dragon/collect-licenses.mts` writes the notices for the version in `product.json`; it needs OpenCode's dependencies installed in `opencode/` (as `build-opencode.mts` leaves them), or the OpenCode half of the notices is missing. V1.1.0, Linux x64 (2026-09-30): the packaged app passed the audit (744 packages in the notices) and both desktop smoke tests (`smoke-onboarding`, `smoke-usage`) run with `--app`.
- **Secret scan of the full history** (gitleaks 8.28.0, 2026-09-28): no findings in Dragon's own commits. The 74 findings in the imported upstream trees (VS Code 1.139.1 and OpenCode 2.0.18) are public test fixtures, translated UI strings, and Microsoft's public telemetry keys already in upstream VS Code.
- Manual and UI, verified with Playwright during development:
  - the **Electron desktop app** under Xvfb:
    - onboarding in Restricted Mode, **Trust this folder**, a local model with its agent variant, then an `@dragon` turn that edits a file
    - an inline edit (Ctrl+I, the inline diff, **Keep**, saved to disk)
    - a Tab completion (ghost text from the FIM model, accepted with Tab)
  - the browser flow: onboarding, a local model, then an `@dragon` turn with tool cards and a diff
  - the Get Started walkthrough

## Risks

- **The OpenCode v2 HTTP API changes between minor versions.** Mitigations: `PIN.json`, the recorded event fixture (`src/test/fixtures/turn-edit.json`), and the end-to-end test.
- **Proposed VS Code chat APIs** (`chatParticipantAdditions`, `chatProvider`) change monthly. The upstream sync must re-run the dragon-agent tests.
- **Asset licensing** (details in `DESIGN.md`). Every shipped design asset is original or openly licensed: the heading font is Almendra (OFL 1.1), and the onboarding dragon is original artwork and motion code. New assets need a license recorded in `DESIGN.md` and `ThirdPartyNotices.txt`.

## Changelog

- 0.9.3 (2026-10-02): V1.1.2; the entrance and the Welcome page are headed Dragon IDE instead of FREEDOM AI; permission modes that hold (Allow allows, Ask asks, Ask mode and Read-Only change nothing; dragon-agent 0.8.2) and a desktop smoke test of them; notarized Mac apps.
- 0.9.2 (2026-10-02): V1.1.1; Linux and Windows downloads; the chat lists models again when OpenCode loads the workspace's providers; OpenCode's `AGENTS.md` lookup on Windows (`opencode-patches/0001`); Developer ID-signed Mac apps.
- 0.9.1 (2026-10-01): release gates read the version from `product.json`; the usage smoke test covers narrow and wide chats and packaged apps on every platform.
- 0.9.0 (2026-09-30): V1.1.0; the usage readout (context ring, cache hit, price per 1M tokens) in the chat composer.

- 0.8.0 (2026-09-30): V1.0.0 packaging; bundled Splash and hardware-gated local model setup; bounded search indexes and distribution license gate.

- 0.7.3 (2026-09-29): selected orange dragon artwork for app icons and home; FREEDOM AI entry needs no model or account, with provider setup available through Connect AI inside the workbench.

- 0.7.2 (2026-09-28): the onboarding flow is an automated smoke test in the package-linux job; the Instant Grep index is disk-backed and memory-mapped (instant-grep 0.4.0).

- 0.7.1 (2026-09-28): the Dragon tool card renders only tool calls from `@dragon` participants; other participants keep the upstream renderers. The full Node and Electron unit suites pass and run in CI (a new unit-tests job).
- 0.7.0 (2026-09-28): the UI no longer names VS Code. Localized strings, extension manifests, extension `l10n` strings, walkthroughs and built-in READMEs say Dragon IDE, and the About dialog shows Dragon's version without Copilot. Guarded by the branding gate and by `npm run dragon:check-ui`, which checks every setting description and the main surfaces in the running app.
- 0.6.0 (2026-09-28): Linux `.deb` and `.rpm` release packages, built and tested locally. The deb was installed with apt, its app started OpenCode, and it purged cleanly; the rpm was extracted and launched. The packages carry Dragon's metadata and no longer register Microsoft's apt repository or key, or remove them on uninstall. node-pty's prebuilt binaries for other platforms no longer ship. The Linux dependency check reports differences instead of failing, because Dragon builds native modules with the runner's compiler. A gitleaks secret-scan CI job, and a full-history scan. `npm run ci:local`.
- 0.5.1 (2026-09-28): the heading font is Almendra (OFL), and the onboarding dragon is original artwork and motion.
- 0.5.0 (2026-09-28): Tab completions (ghost text) from a small local model through Ollama, verified in the desktop app.
- 0.4.0 (2026-09-28): inline edits powered by OpenCode (Ctrl/Cmd+I in the editor, shown as an inline diff), verified in the desktop app.
- 0.3.0 (2026-09-28): Ollama agent variants (a real 32k/64k context window for local agents), and Continue in Chat for OpenCode sessions started in the TUI.
- 0.2.0 (2026-09-28): semantic `codebase_search` with local Ollama embeddings; Instant Grep verifies literals in-process; release update check and the Get Started walkthrough; asset licensing findings.
- 0.1.0 (2026-09-28): first spec. Covers VS Code 1.139.1 plus OpenCode v2.0.18, the Dragon design port, the dragon-agent extension, Ollama and Instant Grep.
