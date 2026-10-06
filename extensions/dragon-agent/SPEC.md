---
spec_id: dragon-agent
version: 0.9.0
status: active
owners: [VELLORAAI]
last_synced_with_central: 2026-09-30
source_of_truth: repo
related_specs:
  - ../../SPEC.md
  - src/search/SPEC.md
related_code:
  - src/extension.ts
  - src/opencode/
  - src/chat/
  - src/models.ts
  - src/catalog.ts
  - src/onboarding.ts
  - src/tui.ts
  - src/ollama/
  - src/dragonConfig.ts
  - src/semanticSetup.ts
  - src/updates/
  - src/completions/
  - media/walkthrough/
  - src/search/
  - src/usage/
---

# dragon-agent extension

## What

This is the built-in extension that makes OpenCode Dragon IDE's agent:
- It runs one OpenCode server for each window.
- It maps the chat view onto that server.
- It publishes OpenCode's models to the model picker. OpenCode lists models before it has loaded the workspace's providers, so Dragon lists them again on OpenCode's provider, model, catalog and config events, and after the event stream reconnects.
- It provides the OpenCode TUI terminal profile.
- It manages Ollama and Dragon's OpenCode config layer.
- It loads the Instant Grep plugin into OpenCode, which also provides semantic `codebase_search`.
- It checks for new Dragon IDE releases and contributes the **Get Started with Dragon IDE** walkthrough.

## Why

VS Code's chat view is a good UI, but its agent harness is Copilot. This extension keeps the UI and routes every turn into OpenCode, so the agent, tools, credentials and sessions are OpenCode's. That means they match the TUI and stay upgradeable from upstream.

## How

| Module | Responsibility |
| --- | --- |
| `opencode/server.ts` | Resolves the binary, spawns and supervises the server, and checks readiness |
| `opencode/client.ts`, `sse.ts`, `types.ts` | HTTP client and SSE parser for the OpenCode v2 API |
| `chat/participant.ts` | The `@dragon` participants: sessions, model and agent selection, turn streaming, permissions, forms and diffs |
| `chat/turn.ts` | A pure reducer that turns OpenCode events into chat operations, plus `reversePatch` |
| `chat/inline.ts` | Inline edits: the prompt, the short-lived plan session, and code extraction and re-indenting |
| `chat/toolPresentation.ts` | Human-readable labels for tools and permission prompts |
| `models.ts`, `catalog.ts` | The model provider (vendor `dragon`) and the pure catalog helpers |
| `onboarding.ts` | Commands behind the onboarding screen and **Dragon: Choose Model** |
| `ollama/` | Ollama detection, recommendations and downloads |
| `dragonConfig.ts` | Dragon's OpenCode config layer and the plugin entry file |
| `completions/fim.ts`, `completions/tabCompletions.ts` | Tab completions: the fill-in-the-middle request and cleanup, and the inline completion provider |
| `semanticSetup.ts` | **Dragon: Set Up Semantic Search** and the one-time offer to download the embedding model |
| `updates/release.ts`, `updates/updateChecker.ts` | The release check (pure logic, then the VS Code notification) |
| `tui.ts` | The terminal profile and the `dragon.openTui` command |
| `search/` | Instant Grep and semantic search (see [`src/search/SPEC.md`](src/search/SPEC.md)) |
| `usage/usage.ts`, `usage/usageService.ts`, `opencode/sessionBridge.ts` | The composer's usage readout: context occupancy, cache-hit share and model prices from OpenCode (pure formatting; a cached per-session reader invalidated by a shared, reconnecting event stream) |

## Local AI setup

`dragon.localAI.setup` and **Choose Model** offer Ollama and Splash after entering the app.
The curated catalog links to the original Hugging Face models and states license, download size,
and estimated working memory. Installation requires weights, a 32k context and runtime buffers
(including Splash's draft) to fit after reserving max(6 GiB, 25% physical RAM) for the system.
Free disk is rechecked before download; staging/preparation and a further 5 GiB reserve are included.
Insufficient or unknown resources never cause the smallest model to be offered anyway.
The estimates are admission limits, not a promise of speed or protection from unrelated processes.

Splash 1.1.0 is bundled only for darwin-arm64, verified by SHA-256 with its Python runtime,
Apache license and third-party notices. It requires Apple M3+ and macOS 26.4+; launch checks both.
The user starts a download explicitly. A visible cancellable terminal runs the packaged launcher,
with `--max-context 32768`, a memory budget and language-only mode. Weights are separate downloads.
Discovery checks `/v1/models` at loopback port 8000 and verifies `owned_by: splash` and context >=32k.
Dragon writes a native OpenCode `providers.splash` entry using the OpenAI-compatible provider.
OpenCode retains all inference, tool use, permissions and session ownership. Ollama still supplies
Tab completions and optional semantic embeddings. Splash does not replace those services.

## API/Contract

**Starting the server.** `opencode serve --stdio` runs with `cwd` set to the working directory and this environment:
- `OPENCODE_PASSWORD`: 24 random bytes, base64url, unique to each window.
- `OPENCODE_DISABLE_AUTOUPDATE=1`, `OPENCODE_CLIENT=dragon-ide`.
- `OPENCODE_CONFIG=<globalStorage>/opencode/dragon.json`.
- `DRAGON_RG_PATH` and `DRAGON_SEARCH_STORAGE`, for Instant Grep.
- `DRAGON_SEMANTIC_CONFIG=<globalStorage>/opencode/semantic.json`, for semantic search.

The first stdout line is `{"url": "..."}`. The server is ready when `GET /api/info` returns 200. It stops when stdin closes, or on SIGTERM 3 s after that.

**Auth.** Every request uses HTTP Basic auth with user `opencode` and the window password. The TUI gets the same password through the environment.

**Stale sockets.** Node's `fetch` keeps connections alive per origin, and a restarted server often gets the same port. A request that fails at the connection level (`ECONNRESET`, `EPIPE`, `UND_ERR_SOCKET`, `UND_ERR_CLOSED`) is therefore sent once more. It never reached a server, so this is safe. A refused connection is not retried.

**Config layer** (`dragon.json`, hot-reloaded by OpenCode):
```jsonc
{
  "model": "<dragon.model>",                                   // when set
  "providers": { "ollama": {
      "settings": { "baseURL": "<origin>/v1" },                // only for a non-default origin
      "models": {
        "<name>": { "limit": { "output": 8192 } },                        // every installed Ollama chat model
        "<name>:<tag>-dragon-32k": { "limit": { "context": 32768, "output": 8192 } } // agent variants
      }
  } },
  "plugins": ["<globalStorage>/opencode/instant-grep"]         // when dragon.instantGrep.enabled
}
```

**Ollama agent variants.** OpenCode reaches Ollama through its OpenAI-compatible endpoint. That endpoint ignores a per-request `num_ctx` and runs at Ollama's default window, which silently cuts off OpenCode's system prompt and tools. OpenCode also keeps max(output, 20000) tokens free, so an agent needs at least 32k.
- When a model is chosen in onboarding, Dragon creates `<name>:<tag>-dragon-<n>k` with `POST /api/create {model, from, parameters: {num_ctx}}`. This is a copy-on-write model, with no extra download or disk.
- `n` is 64 on machines with 48 GB of memory or more, otherwise 32. It never exceeds the model's own `*.context_length` from `/api/show`.
- The config layer gives each variant `limit.context` from its name.
- The model picker shows only the variant of a model that has one.
- If Ollama cannot create the variant, the base model is used and a warning names the fix (`OLLAMA_CONTEXT_LENGTH`).

**Continue in Chat** (`dragon.continueInChat`). It lists the top-level OpenCode sessions in the working directory, newest first (`GET /api/session`), including sessions started in the TUI. The chosen session backs the next new chat for 10 minutes: its first message continues that session, and the reply opens with "Continuing the OpenCode session …".

**Semantic settings** (`semantic.json`, re-read by the plugin on every use):
```jsonc
{ "enabled": true, "model": "qwen3-embedding:0.6b", "origin": "http://127.0.0.1:11434" }
```
- `enabled` is `dragon.semanticSearch.enabled` and `dragon.ollama.enabled`.
- `model` is `dragon.semanticSearch.model`, and `origin` is the loopback Ollama origin.
- Embedding models are recognised by name (`embed`, `minilm`, `bge-`). They are never written into the model config, offered in onboarding or listed in **Choose a local model**. OpenCode itself hides models that lack the `completion` capability.
- **Dragon: Set Up Semantic Search** (`dragon.semanticSearch.setup`) checks that Ollama is running, turns on Instant Grep, pulls the model and enables the setting.
- When Ollama is running without the model, a notification offers the download once, and only after the first completed agent turn, so it never covers onboarding or the chat input. **Not now** asks again after 7 days; **Don't ask again** never asks again.
- Onboarding and **Choose a local model** list chat models only: no embedding models, and a model with an agent variant appears only as that variant (`chatModelNames`).

**Inline edits** (`dragon.inline`, the default participant for the `editor` location; Ctrl/Cmd+I).
- The selection is widened to whole lines. With no selection, the code goes on the cursor's line if it is blank, otherwise on a new line after it.
- The prompt holds the instruction, the file path and language, up to 80 lines before and 40 after, and the target between `<selection>` markers (or `<cursor/>`). It asks for one fenced code block.
- A short-lived OpenCode session runs the read-only `plan` agent with the request's model. It may read and search, and permission requests are rejected. The session is deleted afterwards.
- The first fenced block of the reply (or the whole reply when it has none) is re-indented to the target's indentation and converted to the document's EOL.
- It is sent as `textEdit`, which the editor shows as an inline diff with **Keep** and **Undo**.

**Tab completions** (`dragon.completions.enabled`, on by default; `dragon.completions.model`, default `qwen2.5-coder:1.5b`).
- This is an inline completion provider for `file` and `untitled` documents. It is silent unless Ollama runs, the model is installed, and Ollama is enabled.
- **Request.** After a 120 ms pause in typing (none for an explicit trigger), it sends one `POST /api/generate` with the last 6,000 characters before the cursor as `prompt` and the next 2,000 as `suffix`, so Ollama applies the model's FIM template.
  - Parameters: `temperature` 0.1, `keep_alive` 30m, and a loopback origin only.
  - When the rest of the line has code, the reply is limited to that line (stop at `\n`, 48 tokens); otherwise up to 8 lines (160 tokens).
- **Cleanup.** Trailing whitespace is removed, as is any ending the suffix already has (typically closing brackets). An empty result shows nothing.
- **Dragon: Set Up Tab Completions** (`dragon.completions.setup`) pulls the model and turns the setting on.
- This is the one AI feature that does not run through OpenCode: completions need a fast model call on every pause, not an agent turn. It still never leaves the machine.

**Update check** (`dragon.updates.check`, on by default):
- Once a day (30 s after the first startup), it makes one anonymous `GET` to `product.json#dragonUpdateFeed`, a GitHub "latest release" API URL.
- It compares the result with `product.json#dragonVersion`. The release workflow stamps that field from the tag.
- A newer version shows **Download** (opens the release page) and **Skip This Version**. Nothing is downloaded or installed automatically.
- **Dragon: Check for Updates** (`dragon.checkForUpdates`) checks on demand, and also reports "latest" and any errors.

**Walkthrough.** `dragon.gettingStarted` has six steps: pick a model, chat, Tab completions, permission mode, TUI, and semantic search. Each step has markdown media in `media/walkthrough/`, and each completes on the matching command or setting change.

**One chat turn:**
1. Find or create the OpenCode session for this chat. The key is `request.sessionResource`. A chat with no history gets a new session.
2. Set the model with `POST /session/{id}/model` when the picker changed, and the agent with `POST /session/{id}/agent` when the mode changed.
3. Subscribe to `GET /api/event` and wait for `server.connected`.
4. Send `POST /session/{id}/prompt` with the text and `file://` attachments. A slash command goes to `POST /session/{id}/command` instead.
5. Reduce events until the session reports `session.execution.succeeded`, `session.execution.failed` or `session.execution.interrupted`.

**How events are rendered:**

| OpenCode event | Chat view |
| --- | --- |
| `session.text.delta` | Markdown |
| `session.reasoning.*` | A thinking block |
| `session.tool.input.started`, `tool.called`, `tool.success`, `tool.failed` | A `ChatToolInvocationPart`, which renders as a Dragon tool card. A command gets its terminal block only once it ran; a call the user denied, or that a rule blocked, reads "Skipped …" with the reason and shows as an error |
| `permission.asked` | A question carousel with Allow once, Always allow and Deny, answered according to the permission mode. It takes no typed answer: OpenCode 2.0.18 does not pass a note sent with a denial on to the agent. Requests from subagent sessions the turn started come to the same chat |
| `form.created` | A question carousel |
| `tool.success` with `metadata.files` | A multi-file diff at the end of the turn. The original content is rebuilt from the patch. |
| `session.usage.updated` | `response.usage` |

**Chat modes.** Agent and Edit run OpenCode's `build` agent; Ask runs the `plan` agent, which may write only its plan file under `~/.opencode/plan`. The mode picker offers the built-in Ask mode, since Dragon ships no newer Ask agent to replace it.

**Permission modes** (`dragon.permissionMode`):
- `read-only`: always runs the `plan` agent, gives its session deny rules for edits, commands and subagents other than `explore` (they beat saved "Always allow" rules, and denied tools are not offered to the model), and denies every request.
- `ask`: the config asks before edits and commands (OpenCode's agents allow everything by default) and restates the `plan` agent's edit deny, which those rules would otherwise override. Requests prompt in the chat.
- `full-access`: replies `once` to every request.

**Models.** The vendor `dragon` lists `provider/model` identifiers:
- Only enabled models appear; deprecated ones are hidden.
- Copilot providers (including enterprise variants) are excluded from models, default selection and key/OAuth connection pickers. Existing OpenCode credentials are not modified.
- Ollama is listed first.
- `isDefault` goes to `dragon.model`, or to OpenCode's default.
- Direct `vscode.lm` requests are refused.

**Onboarding commands:**

| Command | Arguments | Returns |
| --- | --- | --- |
| `dragon.onboarding.state` | none | `{serverReady, serverError?, model?, ollama:{running, models}, keyProviders, signInProviders}` |
| `dragon.onboarding.useOllama` | `(model?)` | The model ref, or undefined |

The three commands that set a model resolve only once OpenCode lists it (at most 10 s), so the chat that onboarding opens next can select it.
| `dragon.onboarding.connectKey` | `(integrationID?, key?)` | The model ref, or undefined |
| `dragon.onboarding.signIn` | `(integrationID?, methodID?)` | The model ref, or undefined |

**Usage readout** (`dragon.usage.summary`, used by the chat composer's usage pills).
- Arguments `{sessionResource?, sessionID?, vendor?, model?}`; the chat's session resource maps to its OpenCode session. Returns `{model, context, cache, price}` with display text and tooltips, or undefined. It never starts OpenCode, and ignores models from other vendors.
- **Context**: the newest assistant message's prompt (uncached input + cache reads + cache writes) plus its output and reasoning, over the model's `limit.context` (else `limit.input`), rounded and clamped to 100%. A compaction newer than that message resets it to 0% until the next reply. A model other than the session's shows its window at 0%.
- **Cache hit**: the session's cache reads over its prompt tokens (`tokens.cache.read / (tokens.input + cache.read + cache.write)`), rounded so a partial hit never shows 100% (DeepSeek Harness's `formatCacheHitPercent`). Shown only when the provider caches (cache tokens reported, or a cache-read price listed); the tooltip lists the buckets and the session cost OpenCode recorded.
- **Price**: the model's base `cost` entry in USD per million tokens (`$3 / $15 per 1M`); the tooltip adds cache read/write prices and context tiers. Local providers show **Local · free**; a zero price shows **Free**.
- Works for every provider OpenCode normalizes usage for (Anthropic, OpenAI, Google, OpenRouter, Bedrock, OpenAI-compatible, …) and every model with prices in its catalog or in the config layer (`providers.<id>.models.<id>.cost`).
- Reads are cached per session and refreshed after `session.usage.updated`, `session.execution.*`, `session.compaction.ended` or a model switch for that session (one `GET /api/event` stream, reconnected with backoff); the model catalog is cached for 60 s.
- The extension loads the newest build of the Instant Grep plugin (`dist/` or `tsc` output), so a stale development bundle cannot shadow a fix.

**Agent messaging and teams** (`src/agents/`). Agents are OpenCode sessions shown in chats; they find, message, wait for and spawn each other through four OpenCode tools.
- **Parts.** `opencodePlugin.ts` (plugin `dragon.agents`, loaded from the config layer's `plugins`) adds the tools and forwards every call to the **agent hub** (`hub.ts`), a token-protected HTTP endpoint on `127.0.0.1` inside the extension host. The hub's address and token are in a file readable only by the user, named by `DRAGON_AGENTS_HUB` and read on every call. `agents.ts` connects the hub to the chats. The hub has no VS Code types and is tested directly.
- **Tools.** `list_agents()`; `send_message({to, message})`; `wait_agent({agent, timeoutSeconds?})` (default 120 s, at most 600 s; returns the status and the last reply); `spawn_teammate({name, prompt, agent?})`. The sender is the session OpenCode ran the tool in (`context.sessionID`), never an argument.
- **Opt-in.** Each agent has a messaging mode: `off` (default; the tools are removed from its requests by the plugin's `context` hook, and the hub refuses its calls), `on`, or `muted` (receives, is never woken). The composer's Messages chip cycles it (`dragon.agents.cycleMessaging`, `dragon.agents.messagingState`, both `{sessionResource}` → `{mode, name?, role?, team?}`). Subagent sessions are never registered, so they never have the tools.
- **Delivery.** A message is admitted to the recipient's OpenCode inbox with `POST /api/session/{id}/synthetic` as `<agent-message from="NAME" session="ID">…</agent-message>` with metadata `{source: 'dragon.agent', from, fromName}`; a body containing the wrapper's tag is neutralized. An idle agent whose chat is loaded gets it as a system-initiated chat turn (`_dragon.chat.sendSystemRequest`): the request row shows **From NAME** and the quoted message in place of a typed message. A busy agent gets it at its next step, and its running turn shows it as a quote. An agent with no loaded chat is woken without one.
- **Limits.** 16,000 characters per message; an identical message between the same two agents within 60 s is not delivered again; an agent is woken by other agents at most `dragon.agents.maxWakes` (25) times until a person messages it or its team's lead. Muted, stopped and over-limit agents get the message with `resume: false`, and the sender is told it was not woken.
- **Stop.** Cancelling a turn writes `stopped` to the hub's registry before it calls OpenCode's interrupt. A stopped agent stays stopped until the user's next message to it. **Dragon: Stop All Agents** (`dragon.agents.stopAll`) does this for every working agent.
- **Teams.** **Dragon: New Team** (`dragon.newTeam`) asks for a pane count (2, 3, 4 or 6) and a name, lays the editor area out as the lead on the left and a grid of panes on the right, opens the lead's chat with messaging on, and leaves a note in its inbox saying it leads the team. Only the lead may call `spawn_teammate` (at most `dragon.agents.maxTeammates`, 16). A teammate is a new OpenCode session with the lead's directory and model; it opens in the next pane (panes are shared as tabs after that) and its task arrives as a message from the lead. A read-only lead's teammates run the `plan` agent with the Read-Only rules.
- **Approvals outside a chat turn.** A permission request from an agent no chat turn is showing is answered by the permission mode: Full Access allows once, Read-Only (or a read-only agent) rejects, Ask shows a notification (**Allow Once**, **Deny**, **Show Agent**). Its forms are cancelled.
- **State.** The registry (agents, teams, the deduplication ledger) is `agents.json` in the workspace's storage, written atomically with mode 0600.
- **Workbench commands** (`src/vs/workbench/contrib/chat/browser/actions/dragonAgentActions.ts`): `_dragon.chat.sendSystemRequest({sessionResource, message, label, agentId?})` → whether the chat took it; `_dragon.chat.openAgentEditor({title?, toSide?, group?, preserveFocus?})` → the new chat's session resource; `_dragon.chat.reveal(sessionResource)`.

## Behavior & Invariants

- An agent cannot speak as another: the sender of a message is the session OpenCode ran the tool in.
- A message from an agent never shows as something the user typed.
- An agent the user stopped or muted is not woken by another agent.
- A teammate never has more permissions than its lead had when it was spawned.

- The extension never runs an agent loop, calls a model directly, or executes tools itself.
- One server per window. The chat and the TUI share it, and so share sessions and credentials.
- Credentials are only ever sent to OpenCode's credential endpoints and never persisted by the extension.
- Local models get an output-token cap. OpenCode's default of 32,000 plus a 20,000 buffer would leave a 32k-context model about 768 prompt tokens, so every turn would start with a compaction.
- The extension runs only in trusted workspaces (`capabilities.untrustedWorkspaces.supported: false`).

## Failure Modes & Remediations

| Failure | Behavior |
| --- | --- |
| No `server.connected` frame | The turn fails with the message "the OpenCode event stream closed immediately" |
| The event stream drops mid-turn | The turn ends with an error message; the session stays usable |
| A patch does not reverse cleanly | The file is listed without a diff instead of with a wrong one |
| The user cancels | `POST /session/{id}/interrupt`; open tool cards are marked complete |
| The server crashes | Restart with backoff (1 s, doubling, up to 30 s) |
| The agent hub cannot start, or its address file is missing | The messaging tools are not offered to any agent; chats work as before |
| A message cannot be put in the recipient's inbox | `send_message` fails for the sender, and the message is not counted as delivered, so it can be sent again |
| The recipient's chat does not start the turn within 10 s | The message goes to OpenCode without the chat |

## Tests

- `src/test/unit.test.ts`: Tab completions (mid-line detection, the FIM request, cleanup, and a round trip through the mock's `/api/generate`), the inline-edit prompt, code extraction and re-indenting, the stale-socket retry, agent-variant naming, `/api/create` and context limits, version comparison and the release feed, the SSE parser, the reducer against a recorded live OpenCode trace (`fixtures/turn-edit.json`), `reversePatch`, tool presentation, model refs, server helpers, Ollama config and the catalog helpers.
- `src/test/e2e.test.ts`: the real OpenCode binary against a scripted Ollama. A permission test runs each rule set: the build agent asks before each command and edit and runs them once allowed, a denied command interrupts the turn, the plan agent asks before a command and cannot edit, Read-Only runs nothing and offers no shell or edit tool even after an "Always allow", and a subagent's request reaches the parent chat. A second end-to-end test runs an inline edit in a real plan session: the reply comes back, and the session is gone from the list afterwards. The first test uses an agent-variant model, and checks that OpenCode applies its 32k window over the 131k maximum Ollama reports. It then runs Instant Grep, `codebase_search` and an edit, and checks the answer, the diff metadata, the file on disk, the session list, the saved vectors, and that the embedding model is not offered for chat.
- `src/test/search.test.ts` and `src/test/semantic.test.ts`: see the Instant Grep spec.
- `src/test/usage.test.ts`: the cache-hit rounding cases from DeepSeek Harness, token and money formats, caching, OpenAI-style, uncached, local and free providers, tiered prices, compaction, and the service's per-session cache and invalidation. `src/test/usage.e2e.test.ts` (real OpenCode): an OpenAI-compatible provider with prices in the config layer reports 10,000 prompt tokens with 8,000 cached; the readout shows `80% cache hit`, the context and `$3 / $15 per 1M`, and OpenCode's recorded cost matches the prices. `src/test/sessionBridge.test.ts`: the event stream's fan-out, reconnect and isolation of a failing subscriber.
- `src/test/agents.test.ts`: the hub's rules (sender, opt-in, size, duplicates, the wake limit), muted and stopped agents and that Stop is on disk before it returns, teams (only the lead spawns, the read-only ceiling, the size cap), `wait_agent`, the endpoint's token, a failed delivery, and a forged wrapper. Each rule was checked by removing it and seeing a test fail (16 of 16). `src/test/agents.e2e.test.ts` (real OpenCode): two agents message each other and wait, an agent with messaging off is not offered the tools, a stopped agent is not woken, and a read-only lead spawns a read-only teammate that reports back.
- `npm run dragon:smoke-agents` (repository root): the desktop app: New Team, a stopped teammate that is not woken, a teammate with a closed chat whose command is approved (Full Access, and the Ask notification), and a window reload. Removing the stop-before-interrupt call, the approvals outside a chat turn, or the loading of the registry makes it fail.
- Run with `npm --prefix extensions/dragon-agent test`. Set `DRAGON_OPENCODE_BIN` to point at a binary other than `bin/opencode`.

## Risks

- The OpenCode v2 event schema can change. The recorded fixture and the end-to-end test catch that on upgrade.
- VS Code's proposed chat APIs can change. They are compiled against `src/vscode-dts/vscode.proposed.*` at every upstream sync.

## Changelog

- 0.9.0 (2026-10-05): agents message each other (`list_agents`, `send_message`, `wait_agent`), opt-in per chat with the Messages chip; teams (**Dragon: New Team**, `spawn_teammate`); **Dragon: Stop All Agents**.

- 0.8.2 (2026-10-02): permission modes that hold. Allow in the approval prompt allowed nothing (the answer is a `{selectedValue}` object); Ask permission mode never asked; Ask mode and Read-Only could run commands; subagent requests were dropped. Ask is in the mode picker, and denied calls read as skipped.

- 0.8.1 (2026-10-02): the model picker lists OpenCode's models again when its providers change; an early list could hold only OpenCode's built-in models.

- 0.8.0 (2026-09-30): the usage readout (`dragon.usage.summary`): context occupancy, cache-hit share and model prices for the chat composer.

- 0.7.0 (2026-09-30): Add Splash alongside Ollama, shared hardware-aware local model installer, and dragon.localAI.setup / dragon.onboarding.useSplash commands.

- 0.6.2 (2026-09-30): exclude Copilot providers from user-facing model and connection catalogs.

- 0.6.1 (2026-09-28): onboarding's model commands wait until OpenCode lists the chosen model, so the first chat turn runs on it rather than on the model the chat had selected before.
- 0.6.0 (2026-09-28): Tab completions with a local FIM model (`dragon.completions.*`, **Dragon: Set Up Tab Completions**), and labels for OpenCode's session, model and MCP resource tools.
- 0.5.0 (2026-09-28): inline edits (`dragon.inline`, Ctrl/Cmd+I), and a retry for stale pooled sockets after a server restart.
- 0.4.0 (2026-09-28): Ollama agent variants with a real context window, and **Continue OpenCode Session in Chat**.
- 0.3.0 (2026-09-28): update check (`dragon.updates.check`, **Dragon: Check for Updates**), the Get Started walkthrough, semantic search wiring (`DRAGON_SEMANTIC_CONFIG`, `dragon.semanticSearch.*`, **Dragon: Set Up Semantic Search**), embedding models kept out of the chat model lists, and the `codebase_search` presentation.
- 0.2.0 (2026-09-28): Instant Grep plugin wiring (`plugins`, `DRAGON_RG_PATH`, `DRAGON_SEARCH_STORAGE`, `dragon.instantGrep.enabled`); `find_files` presentation.
- 0.1.0 (2026-09-28): server lifecycle, `@dragon` participants, model provider, TUI profile, Ollama, onboarding commands, permission modes.

Curated local models use a 32k agent context window so the runtime agrees with the admission memory estimates, including on machines with 48 GB or more.
