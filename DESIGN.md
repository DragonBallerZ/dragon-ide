# Dragon IDE design

This file lists everything Dragon IDE adds on top of VS Code: its look, and how its agent is wired in. Each item says where it lives in the repo. Keep it up to date. The upstream sync scripts use it to see which files are ours.

## The Dragon look

| Element | Where | Notes |
| --- | --- | --- |
| Doom-dragon splash (molten mark, embers, heat shimmer, dragon sway, 10 keyframes) | `src/vs/code/electron-browser/workbench/workbench.ts` (`showDragonSplash`, `appendDragonDoomLoader`) | Draws on top of the parts splash, including on first launch. `PartsSplash` keeps it on screen for 1.2 s and then fades it out (`src/vs/workbench/contrib/splash/browser/partsSplash.ts`). Respects reduced motion and high-contrast themes. |
| FREEDOM AI entrance and in-app setup | `src/vs/workbench/contrib/dragonOnboarding/` | Orange dragon, a **Dragon IDE** heading, restrained ember backdrop, one tactile **Enter FREEDOM AI** button. No setup fields. **Connect AI** is available in the home screen, status bar and command palette, with normal workspace trust and OpenCode provider setup. |
| Warm orange workspace theme | `extensions/theme-defaults/themes/dragon_orange.json` | **Freedom Orange** is the default dark theme: warm charcoal surfaces, orange buttons, focus rings, links, selections and progress. Errors, warnings, diffs and terminal ANSI semantics retain their distinct colors. Custom/light/high-contrast themes stay selectable. |
| Live tool-call cards (the "agent is working" activity) | `src/vs/workbench/contrib/dragonShared/browser/toolCallCard.ts`, `agentTurnActivityModel.ts`, `liveActivityScheduler.ts`, and `chatDragonToolCardSubPart.ts` in the chat tool parts | Every non-terminal tool call from `@dragon` uses one, from the moment its arguments start streaming until it finishes. |
| Usage readout (context ring, cache hit, price) | `src/vs/workbench/contrib/dragonShared/browser/usageChips.ts`, mounted in `chatInputPart.ts`; data from `extensions/dragon-agent/src/usage/` | Ring geometry, pill layout and cache-hit rounding adapted from DeepSeek Harness (MIT, see Asset licenses). Theme colors; warning color at 90% context. |
| Composer chips | `src/vs/workbench/contrib/dragonShared/browser/composerChips.ts`, mounted in `chatInputPart.ts` | **Permission mode** (Read-Only / Ask / Full Access, stored in `dragon.permissionMode`) and **working directory** (`dragon.workingDirectory`). |
| Dragon mark (app icon, watermark, splash, onboarding) | `src/vs/workbench/browser/parts/editor/media/dragon-mark.png`, `resources/**` | The user-selected orange profile dragon generated with OpenAI image generation on 2026-09-29. The master has a continuous charcoal background with no white matte. Rounded transparency is applied during icon packaging, preventing a white fringe on dark surfaces. macOS uses an 824 px tile on a 1024 px transparent canvas; Windows and web include small icon sizes. The same artwork appears on the entrance, splash and home. |
| Chat avatar | `extensions/dragon-agent/media/dragon.png` | The same orange profile dragon, resized to 256 px. |
| Heading font (Almendra Bold, OFL 1.1) and brand variables | `src/vs/workbench/browser/media/dragon-heading.woff2` (CSS family `Dragon Heading`), `style.css` (`--dragon-*`) | Used for workbench headings, the onboarding screen and the sign-in callback pages. |
| Sign-in callback pages | `src/vs/code/browser/workbench/callback.html`, `extensions/{github,microsoft}-authentication/media/` | Restyled with the heading font. |

The "thinking" shimmer comes from VS Code itself (`chat-thinking-shimmer`). OpenCode's reasoning stream is sent into it through `thinkingProgress`.

## The agent: OpenCode only

```
chat view (VS Code UI) ──@dragon──▶ extensions/dragon-agent ──HTTP + SSE──▶ opencode serve (one per window)
OpenCode terminal (TUI) ──────────── opencode --server <url> ───────────────▲
Ollama (localhost:11434) ◀── OpenCode's ollama provider ────────────────────┘
```

- `extensions/dragon-agent/src/opencode/`: server lifecycle and HTTP client. The server authenticates with a random per-window password, and auto-update is off.
- `extensions/dragon-agent/src/chat/`: the `@dragon` participants (Agent and Edit run OpenCode's `build` agent; Ask runs `plan`). `turn.ts` is a pure function that turns OpenCode's v2 events into chat operations: text, reasoning, tool calls, permission prompts, question forms, and multi-file diffs.
- `extensions/dragon-agent/src/ollama/`: finds a running Ollama, recommends models that fit this machine and that call tools reliably (7B and up), and downloads them with a progress display. It also gives each chosen model an agent variant (`<model>-dragon-32k`, copy-on-write) with a context window OpenCode can work in, because Ollama's OpenAI-compatible endpoint ignores per-request context sizes.
- `extensions/dragon-agent/src/dragonConfig.ts`: writes a config layer that Dragon owns and passes it to OpenCode through `OPENCODE_CONFIG`. OpenCode watches the file, so the default model and the Ollama limits change without a restart. Local models get an output cap so a 32k-context window does not start compacting on every turn.
- **Instant Grep** (`extensions/dragon-agent/src/search/`, spec in `src/search/SPEC.md`) is an OpenCode plugin that replaces `grep` and `glob` with an index-backed version and adds `find_files`.
  - It keeps a local trigram index with next-character and position masks.
  - Every result is verified by ripgrep, so answers are identical to ripgrep's.
  - A file watcher keeps it fresh.
  - It is loaded through `plugins` in Dragon's config layer.
- **Semantic search** (`src/search/semantic.ts`) adds `codebase_search` to the same plugin. It embeds the workspace with a local Ollama model, stores the vectors as int8, and blends them with Instant Grep keyword hits. **Dragon: Set Up Semantic Search** downloads the model.
- **Updates** (`src/updates/`) check the GitHub release feed in `product.json` once a day and offer the download. **Get Started with Dragon IDE** is a walkthrough contributed by the same extension (`media/walkthrough/`).
- VS Code's own agents are switched off. `extensions/copilot` is deleted, `product.json` has no `defaultChatAgent` (the code paths that used to assume one are guarded), and the built-in agent host (Copilot SDK, Claude and Codex harnesses) is disabled in `agentHostEnablementService.ts` and `webAgentHostEnablementService.ts`.

## Upstream patch points (`// DRAGON` markers)

Search for `DRAGON` to find every change we made to an upstream VS Code file. Keep each one to a few lines, so monthly upstream merges stay mechanical.

The UI names Dragon IDE, never VS Code. Rather than edit hundreds of upstream strings, `rebrand()` in `src/vs/nls.ts` replaces "Visual Studio Code" and "VS Code" at the points where text becomes UI:
- every localized message template, before its arguments are filled in, so user data is untouched
- built-in extension manifests, both package.nls.json values and plain-text names, descriptions and labels
- extensions' runtime `l10n.t` strings
- walkthrough pages
- built-in extension READMEs

The About dialog shows Dragon's own version and no Copilot runtime. Identifiers such as `vscode.*`, `.vscode/` and `vscode://` stay, because extensions and workspaces depend on them. So do accurate references to other software, such as the `code` CLI completions. `scripts/dragon/check-branding.mts` fails if a rebrand hook is lost in an upstream merge, and `npm run dragon:check-ui` checks the running app.

The Linux package metadata has no room for markers. `resources/linux/debian/control.template`, `resources/linux/rpm/code.spec.template` and `resources/linux/code.appdata.xml` carry Dragon's name, homepage and description. The deb scripts register no package repository (upstream adds Microsoft's apt repository and key), and the debconf question is gone. `scripts/dragon/check-branding.mts` fails the build if VS Code's identity or Microsoft's repository returns to any of them.

## Asset licenses

Every design asset that ships is original or openly licensed, so the repository can go public. Record the license of any new asset here and in `ThirdPartyNotices.txt`.

| Asset | Origin | License |
| --- | --- | --- |
| Heading font (`dragon-heading.woff2`, three copies: workbench media and both sign-in extensions) | Almendra Bold by Ana Sanfelippo, the unmodified Latin subset from Fontsource | SIL Open Font License 1.1, reproduced in `ThirdPartyNotices.txt`. |
| Usage readout (`usageChips.ts`, `composerChips.css`, `extensions/dragon-agent/src/usage/usage.ts`) | ContextMeter ring, StatsPills layout and `formatCacheHitPercent` adapted from DeepSeek Harness (commit `639ed015`) | MIT, Copyright (c) 2026 DeepSeek; notice kept in `extensions/dragon-agent/NOTICE-deepseek-harness.txt` and `ThirdPartyNotices.txt`. No endorsement implied. |
| Onboarding dragon (`dragonPaths.ts`, `dragonAnimation.ts`) | Original artwork and motion code, drawn and written for Dragon IDE on 2026-09-28 | MIT, with the rest of the repository. |
| Orange dragon (`dragon-mark.png`, platform icons, web icons and chat avatar) | Generated with OpenAI image generation on 2026-09-29 and selected by the repository owner for this app | Distributed as the project’s branding at the owner’s request; the existing product-name/logo reuse restriction in README applies. No third-party artwork was supplied as a reference. |

Authentication callback pages and their favicons also use the orange dragon and warm palette. The shared workbench `code-icon.svg` embeds the approved orange dragon, so the title bar, Welcome tab, updates, banners and walkthroughs match the native app icon. Presentation localization names FREEDOM AI while retaining technical identifiers and URLs. Subscription-only chat controls are absent without a bundled provider; Dragon model and connection catalogs omit Copilot providers.
