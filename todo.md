# Dragon IDE to-do (later)

Planned work. Nothing here is started yet. Each agent should be its own chat, side by side, not a separate
webview surface.

## Multiple agents

### Goal

Every agent is a full Dragon chat: the same composer, model picker, folder and permission chips, and usage readout.
The user opens as many as they want side by side, runs them in parallel, sees at a glance which ones are running,
waiting or done, and answers approvals without hunting. Agents can delegate to and message each other. Later phases
let a lead agent run a team whose members open as their own panes.

### What DeepSeek Harness does

- One main chat per window, plus a right dock that holds up to **2 panes side by side** (tabs within each) and
  floating panels. Subagent and teammate chats open there as full chats with a composer. Other top-level sessions
  keep running in the background and are listed on the left with status dots.
- One backend agent per session, each with its own event stream. Agents keep running when nothing is watching
  them. A client "reference" per pane, with no global current session.
- Status language: amber = waiting (approval, question), spinner = running (+ "N subagents running"),
  green = finished while unseen, grey = idle.
- Limits: 8 active subagents per tree; 16 teammates.
- Approvals: children never prompt (policy pinned to never). A background top-level session shows only an
  amber dot; there is no approval inbox and no notification.
- Pane layout, tabs and splits are restored per session after a restart. Shortcuts: new session Mod+N,
  split Mod+\, pane fullscreen Mod+Alt+Enter.
- **Where Dragon should go further:** top-level chats side by side (DSH cannot); child panes that can open
  automatically (DSH never does); approvals from background agents that reach the user.

### Approach

Build on VS Code's native **chat editors**, not a webview. Upstream already has "New Chat Editor" and "New Chat
Editor to the Side". Dragon's chat participant already maps each chat session to its own OpenCode session
(`workspaceState['dragon.sessions']`). So N chat editors give N independent OpenCode agents, each with its own
model and usage readout. The editor grid gives splits, tabs, drag, maximize and layout restore for free.

What chat editors cannot do on their own is render a turn the widget did not start: a child agent, or a message
that wakes an idle agent. That needs the `chatSessionsProvider` API (Phase 2). The first attempt at it failed
because the model picker listed 0 models and showed "Auto". The likely cause, from the code:
`chatInputModelUtils.filterModelsForSession` and `requiresCustomModelsForSessionType` give a contributed
session type its own model pool. Dragon's models must be published targeting that session type
(`targetChatSessionType`), or the type must be contributed without a custom pool. Prove the fix in a
test before building on it.

### Phase 0: spike (half a day). Prove parallel chat editors work.

- [ ] Desktop smoke: open two Dragon chat editors side by side and start turns in both at once against the mock
  provider. Both must stream, cancelling one must leave the other running, each usage readout must show its own
  session, and a reload must restore both conversations.
- [ ] Audit the participant for state shared across turns: the `originals` map for reverse patches,
  `dragon.lastSession`, per-turn permission prompts. Also confirm that OpenCode runs two sessions' turns
  concurrently.
- Exit: a list of blockers with a fix for each, or "works as is".

### Phase 1: "New Agent" side by side (target V1.2.0, 2–3 days)

- [ ] **Dragon: New Agent** (Mod+Alt+N) opens a Dragon chat editor to the side, focused and with the composer
  ready. **Dragon: Agent Layout** offers presets: 2 side by side, 3 columns, 2×2 grid.
- [ ] Agent identity in the tab: the OpenCode session title (editable) and a status icon using DSH's language
  (running, waiting for approval, finished unseen, idle, error). This needs a small hook in the chat editor
  input's label and icon, marked `DRAGON`.
- [ ] Agents list: reuse the upstream Sessions list in the chat view, with Dragon status dots and a running
  count. Clicking an agent reveals its editor, or opens it if closed.
- [ ] Approvals from a hidden agent: a notification with **Show Agent**, plus a status bar count ("2 agents
  waiting"). Never auto-approve.
- [ ] Concurrency: `dragon.agents.maxConcurrent` (default 4 for cloud models). Local Ollama/Splash defaults to
  1 active generation, and the others show "Queued" in their composer. Unknown capacity is treated as local.
- [ ] Writers in parallel: an optional per-agent **Git worktree** chip next to the folder chip. Changed files
  and diffs stay per agent.
- [ ] Restore: editors come back through normal editor restore and reattach to their OpenCode sessions. A
  running agent keeps running when its editor closes; reopening it from the list shows progress.
- [ ] Tests: `dragon:smoke-agents` (two and four agents, concurrent turns, cancel one, approval from a hidden
  agent, reload), plus unit tests for the queue and the status mapping.

### Phase 2: delegated agents open as panes (3–5 days, API risk)

- [ ] Register Dragon as a chat session provider (`chatSessionsProvider`) so an editor can show an OpenCode
  session's history and attach to a turn already running, whoever started it. Fix the model pool first (see
  Approach).
- [ ] When an agent spawns a subagent (OpenCode `task`/subagent tool), its tool card gets **Open in Pane**. Setting
  `dragon.agents.openChildren`: `never` | `ask` | `always` (default `ask`). Keep at most 2 auto-opened panes
  and list the rest.
- [ ] The child pane has a working composer: follow-ups go to the child, and Stop interrupts it.
- [ ] Tests: end to end against real OpenCode, where the parent spawns a child and the pane streams the child
  live; a desktop smoke for Open in Pane.

### Phase 3: agents message each other; teams (3–4 days)

Built on 2026-10-05, ahead of Phases 0–2, on plain chat editors (see `extensions/dragon-agent/SPEC.md`,
"Agent messaging and teams").

- [x] Plugin tools: `list_agents`, `send_message` (durable, deduplicated, size and wake limits),
  `wait_agent`. Messaging is opt-in per agent (the Messages chip in the composer).
- [x] Incoming messages render as a distinct "From <agent>" turn in the recipient's editor, never as user input.
  Stopped or muted agents do not wake.
- [x] **Dragon: New Team**: a lead chat plus N teammate panes in a grid preset. The lead delegates through
  `spawn_teammate`, and teammates open as panes. The permission ceiling is inherited and loop limits are
  enforced.
- [x] Safety rules: host-validated sender identity, persisted
  stop-before-interrupt, and read-only agents stay read-only.

Left for later:

- [ ] An agent whose chat is not loaded works without a transcript in the chat view (it is in OpenCode and
  the TUI). Phase 2's session provider would show it.
- [ ] An automated test of the Ask-mode notification for an agent working outside a chat turn (Full Access
  is covered by the desktop smoke test).
- [ ] A test of a window reload in the middle of a team's work.

### Decisions for the owner

1. Top-level agents side by side (beyond DSH): **yes** (recommended).
2. Delegated children auto-open as panes: `ask` (recommended), `always`, or `never` (the DSH behavior).
3. Concurrency defaults: 4 cloud, 1 local (recommended).
4. Ship Phase 1 alone as V1.2.0 before starting the API work in Phase 2: **yes** (recommended).
