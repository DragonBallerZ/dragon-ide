# Dragon IDE queue

Small, self-contained tasks waiting for an owner. `todo.md` holds the multi-agent plan; this file
holds tasks that came out of one review and have no phase of their own. Each entry says what to
build, where it lives and what done looks like. The ground rules in `AGENTS.md` hold: OpenCode is
the only agent harness and stays unmodified, so each of these is an OpenCode plugin or a setting
under `extensions/dragon-agent/`, loaded through the config layer's `plugins` list; every contract
change bumps `extensions/dragon-agent/SPEC.md` and updates `specs/INDEX.md`; nothing phones home.

## From the Aider comparison (2026-10-22)

On 2026-10-22 we compared Aider (github.com/Aider-AI/aider, v0.86.2, Apache-2.0, Python, no agent
loop of its own) with Dragon IDE and Dragon Code. Most Aider-only features are its substitute for
not having an agent loop and were not queued (see "Not queued" at the end). These four earn a try,
in this order. Aider is installed on the M5 Max as a uv tool (`aider` in `~/.local/bin`) for
side-by-side trials.

### 1. Lint after edit (opt-in OpenCode plugin)

**What.** Aider runs the project's linter on every file it edits and feeds the errors back to the
model in the same turn (`--auto-lint`, `--lint-cmd`). In Dragon IDE an edit comes back with nothing
but the diff: the vendored OpenCode formats the file inside the tool, and LSP diagnostics after an
edit are still a TODO there (`opencode/packages/core/src/tool/plugin/edit.ts`), so a broken edit
surfaces when the user runs the build, not while the model still has the edit in front of it.

**Where.** A new plugin under `extensions/dragon-agent/src/lint/` (the pure parts in `lint.ts`, the
plugin in `opencodePlugin.ts`), bundled by `esbuild.mts` as `lintPlugin` beside the search, agents
and sandbox plugins, written next to them by `writeSearchPlugin`, listed in the config layer's
`plugins` (`dragonConfig.ts`) only while enabled, and trusted under confinement. Settings:
`dragon.lint.enabled` (default false), `dragon.lint.command` (a string, or an object from glob to
command; `${file}` or `$FILE` stands for the quoted path, otherwise the path is appended) and
`dragon.lint.timeoutMs` (30000). The extension writes them to `<globalStorage>/opencode/lint.json`
and names the file in `DRAGON_LINT_CONFIG`, re-read on every call as the semantic settings are.

**Rules.** Hook `tool.execute.after`; completed calls only; skip the `plan` agent; the files from the
call's own arguments (`path`, `filePath`, `file_path`; a patch's `*** Add File`, `*** Update File`
and `*** Move to` lines, never a deleted file), never from the model's text; run through
`/bin/sh -c` under `confineSpawn` with `commandEnv`, as patch 0004 runs formatters; output cut at
6 000 characters; a timeout is logged and adds nothing; a passing command adds nothing; the hook
never throws, since a failing hook fails the edit.

**Done.** Unit tests in `src/test/lint.test.ts` (config parsing, globs, command-line quoting,
changed files including patch text, the report, the append; the plugin end to end with `node -e`
commands that fail, pass and time out); `npm run dragon:check` and `npm run compile-check-ts-native`
green; SPEC.md bumped (settings, environment, config layer, failure modes, tests, changelog) and
`specs/INDEX.md` updated; a line in the README's settings. By hand: enable it with `eslint ${file}`
in this repo and watch an edit that leaves an unused variable come back with the report.

A draft of the three files was written on 2026-10-22 and left uncommitted in the working tree of
the Mac that wrote this entry, unwired and never run. If it is gone, start from the design above.

### 2. Repo map as a context plugin (default off, measured first)

**What.** Aider's repo map: a ranked list of the repository's files and the symbols they define
(tree-sitter tags, ranked by references between files, files in the conversation ranked up),
fitted to a token budget and sent with each request. Dragon IDE has nothing between "the whole
file" and a search: the agent learns the structure by reading.

**Where.** A plugin on the `session.hook('context')` hook (as the agents plugin uses) under
`extensions/dragon-agent/src/repomap/`; symbols from Instant Grep's index or a tree-sitter pass
(VS Code ships grammars in `@vscode/tree-sitter-wasm`); ranking by references between files, with
files mentioned in the conversation ranked up; setting `dragon.repoMap.tokens`, 0 (off) by default.

**Measure before any default.** Ten tasks in this repo on one local Ollama model (the default from
`docs/plans/local-models-m5-max.md`) and one cloud model, with and without the map: tool calls per
task, tokens per task, and whether the task finished. Dragon Code's own A/B showed injected
reference context lost (76.9 % against 100 % success, +25.7 % tokens), so the map must earn its
place.

**Done.** Plugin, setting, SPEC bump, and the measurement written up under `docs/plans/`. The
default stays off unless the map wins on both counts.

### 3. Commit per agent turn, with undo (opt-in)

**What.** Aider commits each change it makes, with a generated message, and `/undo` takes the last
one back. Dragon IDE leaves the working tree dirty, and a bad turn is undone by hand.

**Where.** Setting `dragon.commits.perTurn` (default false). When a turn ends (the session goes
idle), the extension commits the files that turn's edit, write and patch calls changed, nothing
else: the files come from the server's tool events, not from `git status`. The subject is asked of
the small model through the OpenCode server, the way OpenCode titles a session, never through a
direct model call, with `Agent: <first line of the prompt>` as the fallback; a trailer names the
agent and the model. Command **Dragon: Undo last agent commit**: when HEAD is such a commit and the
tree is clean, drop it and its changes; otherwise refuse and say why. Skip when the folder is not a
Git repository, HEAD is detached, a rebase or merge is in progress, or the user has staged changes
of their own.

**Done.** Setting, command, tests of the file selection and of every refusal rule, SPEC bump, and a
check by hand that a turn in this repo commits only what it changed.

### 4. A model per chat mode (architect-lite)

**What.** Aider's architect mode has a strong model plan and a cheaper editor model apply the
edits, two requests per change. Dragon IDE's plan then build handoff already separates planning
from editing, on one model: Ask runs the `plan` agent, Agent and Edit run `build` (`MODE_AGENTS` in
`extensions/dragon-agent/src/chat/participant.ts`). The missing piece is that switching mode does
not switch model. No second automatic request.

**Where.** OpenCode's config takes a model per agent (`agents.plan.model`, `agents.build.model`), so
the config layer `buildDragonConfig` writes can carry them. Setting `dragon.model.byMode` (ask, edit
and agent, each a `provider/model`), or the last model picked while in each mode, remembered per
window; the model picker says which mode's model it is setting.

**Done.** Switching mode switches the model and the chat shows it; onboarding unchanged for one
model; SPEC bump; a unit test of the config layer's output and of the remembered choice.

## Not queued

Decided against on 2026-10-22, recorded so nobody re-litigates them by accident:

- Aider's text edit formats (`whole`, `diff`, `udiff`, `editor-*`): OpenCode's models call tools.
- Architect mode as a second automatic model call per edit: entry 4 gets the benefit without it.
- Copy/paste mode, voice input, Aider's browser GUI and the Python API: no fit for an IDE with a
  chat view.
- Conventions files: `AGENTS.md` covers them.
- Analytics (Aider's PostHog): nothing in Dragon IDE phones home.
- An always-on repo map: entry 2 decides it with numbers.
