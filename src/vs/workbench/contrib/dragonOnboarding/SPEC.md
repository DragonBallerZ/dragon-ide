---
spec_id: dragon-workbench-ui
version: 0.6.1
status: active
owners: [VELLORAAI]
last_synced_with_central: 2026-09-28
source_of_truth: repo
related_specs:
  - ../../../../../SPEC.md
  - ../../../../../extensions/dragon-agent/SPEC.md
related_code:
  - browser/
  - ../dragonShared/browser/
  - ../chat/browser/widget/chatContentParts/toolInvocationParts/chatDragonToolCardSubPart.ts
  - ../../../code/electron-browser/workbench/workbench.ts
  - ../splash/browser/partsSplash.ts
  - ../../../../../scripts/dragon/smoke-onboarding.mts
---

# Dragon workbench UI: onboarding, splash, tool cards and composer chips

## What

These are the workbench-side pieces of the Dragon look:
- the first-run onboarding screen
- the doom-dragon splash
- the live tool-call cards in the chat
- the chips in the chat composer for permission mode and working directory, and the usage readout (context, cache hit, price)

## Why

Dragon IDE asks for no account. The onboarding drives OpenCode through the dragon-agent commands, so there is no backend of its own.

## How

- **Entrance** (`browser/dragonOnboarding.ts`)
  - Registered as `IOnboardingService`. The existing first-run rules and `dragon.onboarding.completed` application storage remain compatible.
  - Shows the orange dragon, the **Dragon IDE** heading, and one **Enter FREEDOM AI** button. There are no credential fields, provider cards, model discovery calls or trust prompts on this screen.
  - Enter (click, Enter or Space) and Escape persist completion and reveal the workbench without waiting for OpenCode, a provider or workspace trust. Tab stays on the single button. Focus returns to the workbench on dismissal.
  - Hover/press feedback and a short exit transition respect reduced motion. Repeated entry clicks cannot dismiss a newly opened overlay.
- **Connect AI** (`browser/dragonOnboarding.contribution.ts`, `browser/dragonHome.ts`)
  - Always accessible from the status bar and command palette; also a button on the branded Welcome page, independent of shortcut tips. The empty editor displays the orange dragon watermark; the status bar action is still available there. Changes to **Manage AI** after `dragon.model` is configured.
  - `dragon.connectAI` first requests workspace trust through the existing trust service. Cancel leaves the editor usable and does not activate model setup.
  - After trust, calls `dragon.chooseModel`: local Ollama, API key and provider OAuth remain owned by the dragon-agent extension and OpenCode's credential store.
  - A returned model opens chat with `{modelSelector: {vendor: 'dragon', id: model}}`, so the first turn uses the chosen model. Cancel leaves the current model unchanged; failures show a workbench notification and the action can be retried.
  - The status bar action remains available while editing files. No automatic setup dialog appears after entry.
- **Splash**
  - `showDragonSplash` draws the molten loader over the parts splash, creating the splash element on first launch.
  - `PartsSplash` keeps it on screen for at least 1.2 s and then fades it out over 280 ms.
- **Tool cards**
  - `chatToolInvocationPart.ts` sends tool invocations from `dragon.*` participants to `ChatDragonToolCardSubPart`, from streaming onward. Terminal commands, confirmations, extension installs and result lists keep their specialised renderers, and other participants keep all the upstream renderers.
  - The exceptions keep their upstream renderers: `terminal`, `extensions`, `modifiedFilesConfirmation` and `resources`.
- **Composer chips** (`dragonShared/browser/composerChips.ts`)
  - `DragonPermissionToggle` cycles `dragon.permissionMode` at workspace scope.
  - `DragonDirectoryToggle` shows `dragon.workingDirectory` (or the first workspace folder) and runs `dragon.moveSession`.
  - Both are mounted in the chat input's secondary toolbar, except in compact style.
- **Usage readout** (`dragonShared/browser/usageChips.ts`, `DragonUsageChips`, at the end of the composer's secondary toolbar, where the workbench's own context meter goes; in a composer too narrow for one row it moves to a row of its own and never covers the chips or pickers): a 14px context ring with the percentage used, the session's cache-hit share, and the selected model's price per million input/output tokens. Each pill has a tooltip with the detail (token buckets, session cost, cache and tiered prices) and an accessible label. It asks the extension (`dragon.usage.summary` with the chat's session resource and the picker's vendor and model id) every 2.5 s while visible and when the model changes; it asks nothing for other vendors' models and hides what a provider does not report. The ring turns to the warning color at 90%. Ring geometry and pill layout are adapted from DeepSeek Harness (MIT).

- **Agents window.** VS Code's separate Agents window runs the agent host harnesses, which Dragon disables.
  - Its commands are switched off through `OPEN_AGENTS_WINDOW_PRECONDITION` (`ContextKeyExpr.false()`), which also hides its menus and title-bar entry.
  - The "Try out the new Agents window" banner is shown only when that precondition holds (`gettingStarted.ts`, `agentSessionsWelcome.ts`), so it is never shown.

## API/Contract

| Item | Contract |
| --- | --- |
| Commands | `dragon.showOnboarding`, `dragon.connectAI` |
| Storage | `dragon.onboarding.completed` (application, user) |
| Settings read | `dragon.model`, `dragon.permissionMode`, `dragon.workingDirectory` |
| CSS variables | `--dragon-heading-font-family`, `--dragon-heading-letter-spacing`, `--dragon-label-letter-spacing`, `--dragon-accent-hot-ember`, `--dragon-accent-hot-ember-rgb`, `--dragon-accent-molten-orange`, `--dragon-accent-warm-gold` (all registered in `vscode-known-variables.json`) |

## Behavior & Invariants

- User-facing AI copy names FREEDOM AI. Provider catalogs omit Copilot connections, and subscription-specific commands, status and sign-in actions are unavailable without `product.defaultChatAgent`. Compatibility IDs, link targets, inline code and user-supplied message arguments are preserved.
- The native app icon and shared workbench icon use the same clean orange dragon, including title bars, update panels, walkthroughs and the Welcome tab.

- The entrance displays the approved static orange dragon mark without breathing deformation, fire animation or a WebGL renderer.
- Entry works without credentials, a configured model, workspace trust or a running OpenCode server.
- Trust remains required for AI setup and agent execution, never for entering the editor.
- **Freedom Orange** is the default dark theme; its warm charcoal surfaces and orange accents replace decorative red branding without recoloring error/diff/terminal semantics. Explicit user theme choices and high-contrast/light themes remain available.
- The orange profile dragon is shared by desktop/web icons, splash, entry, empty-editor home and chat avatar.
- Reduced motion removes entry hover/exit transforms; high-contrast themes use theme colors for the entry and button.
- Existing workbench headings retain Almendra; the FREEDOM AI entrance uses the workbench UI font.

## Failure Modes & Remediations

| Failure | Behavior |
| --- | --- |
| The folder is in Restricted Mode | Entry works. **Connect AI** requests workspace trust before setup |
| The agent extension or server is unavailable | Entry works; setup reports the command/server error through notifications |
| A setup command is cancelled | Stay in the app with the existing model unchanged |

## Tests

- Covered by the workbench type check and hygiene in CI.
- The onboarding, chat and tool-card flow was verified in Chromium against the web build during development (`docs/images/`).
- **Onboarding smoke test** (`scripts/dragon/smoke-onboarding.mts`, `npm run dragon:smoke-onboarding`). It drives the Electron desktop app with Playwright `_electron` on a fresh profile and an untrusted folder, against a scripted fake Ollama (`extensions/dragon-agent/src/test/mockOllama.ts`), and checks, in order:
  1. the splash
  2. one-button entry with no setup controls, including keyboard focus containment
  3. **Connect AI** inside the app and the workspace trust dialog
  4. local/API-key/sign-in choices, then choosing the mock local model and creating its agent variant
  5. the chat's model picker naming the variant before anything is typed (the side bar's chat is maximized first: at its default width the picker is in More Actions), then an `@dragon` turn that reads and edits a file on the selected variant, with successful tool cards and an on-disk assertion, and its whole answer outside its reasoning and the folded steps. The answer's last chunk comes 500 ms after the rest, so OpenCode reports the reasoning ended after the answer started, as it does for Nemotron on OpenCode Zen
  - The test folder's `opencode.json` enables only the `ollama` provider, so the turn cannot go to a hosted model.
  - CI runs it in the `package-linux` job against the packaged app under Xvfb (`--app ../VSCode-linux-x64`). Screenshots and the app's logs, OpenCode's included, are uploaded with the job's screenshots.
  - Locally it runs the development build by default (after `npm run compile` and `npm run electron`).

## Risks

- VS Code's chat widget internals (`chatInputPart.ts`, `chatToolInvocationPart.ts`) change monthly. The `// DRAGON` hunks must be checked at every upstream sync.
- New artwork or fonts need a license recorded in `DESIGN.md` and `ThirdPartyNotices.txt` before they ship.

## Changelog

- 0.6.3 (2026-10-08): the onboarding smoke test waits until the chat's model picker names the agent variant before it types, instead of up to 90 s for a picker name the narrow chat did not show. With the base model still listed and chosen, it fails there. Typing as soon as the chat shows ran the turn on the base model; that race in the product is not fixed yet.
- 0.6.2 (2026-10-07): the onboarding smoke test checks that the answer shows in full outside its reasoning, from a model that reports the reasoning ended after the answer started. Before the turn reducer's fix it showed only the answer's last chunk.
- 0.6.1 (2026-10-02): the entrance and the Welcome page are headed **Dragon IDE** instead of FREEDOM AI (the Welcome page shows the product name again, as upstream does, so development builds read "Dragon IDE Dev"). The onboarding smoke test checks both headings.
- 0.6.0 (2026-09-30): the composer's usage readout (context ring, cache hit, price per 1M tokens) for Dragon models; unit test `dragonShared/test/browser/usageChips.test.ts`.
- 0.5.1 (2026-09-30): Restore the static welcome dragon; remove the breathing/fire renderer and associated animation styles.
- 0.5.0 (2026-09-30): Living orange welcome dragon, procedural fire with sparks and reflected light, reduced-motion/static fallback and visibility/disposal resource management.

- 0.4.0 (2026-09-29): orange dragon branding and credential-free FREEDOM AI entrance; provider setup moved into the workspace via `dragon.connectAI`, with Welcome/home/status-bar actions, a default Freedom Orange theme and the first-turn model selection preserved.

- 0.3.2 (2026-09-28): the onboarding flow is an automated smoke test, run in CI against the packaged Linux app. Completing onboarding selects the chosen model in the chat; the smoke test caught the first turn running on the base model instead of its agent variant.
- 0.3.1 (2026-09-28): tool cards apply only to `@dragon` responses.
- 0.3.0 (2026-09-28): original dragon artwork and motion (a damped-spring head, fixed-length body, beating wings, an idle figure-eight), and the Almendra heading font.
- 0.2.0 (2026-09-28): a trust flow in onboarding; the overlay sits below modal dialogs; the Agents window and its banner are disabled.
- 0.1.0 (2026-09-28): onboarding, splash, tool cards and composer chips ported and rewired to OpenCode.
