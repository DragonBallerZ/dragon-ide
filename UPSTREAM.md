# Upstreams

Dragon IDE is built from two upstream projects. Both are imported as plain source trees rather than full git histories. The exact revisions are recorded here and in `opencode/PIN.json`.

| Component | Upstream | Revision | Location | License |
| --- | --- | --- | --- | --- |
| Editor | [microsoft/vscode](https://github.com/microsoft/vscode) | `1.139.1` (`04c0d99f4fb0d8afe6ce4f0c58e31e183ac3e4b1`) | repository root | MIT |
| Agent | [sst/opencode](https://github.com/sst/opencode) | `v2.0.18` (`cd9a14a6b688d4021bee381dfd39d2cef9c0f862`) | `opencode/` | MIT |

## Syncing

- **VS Code:** run `scripts/dragon/sync-vscode.sh <next-tag>`. It applies the upstream diff between the pinned tag and `<next-tag>` as a single commit. Conflicts are resolved in favour of upstream except where Dragon-owned files are touched (see `DESIGN.md`).
- **OpenCode:** run `scripts/dragon/sync-opencode.sh <next-tag>`. It replaces `opencode/` with the new tag, reapplies `opencode-patches/*.patch`, prunes the files listed in `PIN.json` and updates the pin.

## What Dragon IDE changes in VS Code

- Copilot is removed. `extensions/copilot` is deleted, and `sync-vscode.sh` leaves it out of every upstream diff. `product.json` has no `defaultChatAgent`, and the core code paths that assumed one are guarded (`// DRAGON`). The built-in agent host (Copilot SDK, Claude and Codex harnesses) is disabled.
- The only chat agent is `@dragon` from `extensions/dragon-agent`, which is a front end for the bundled OpenCode server.
- A terminal in the editor area closes when the terminal is disposed, as one in the panel does, not on `onExit` (`terminalEditorInput.ts`, `// DRAGON`). `TerminalInstance` fires `onExit` before it handles the exit, so closing the editor then disposed the terminal as closed by the user: extensions saw `TerminalExitReason.User` for a process that ended, and a terminal that failed to launch closed without the "failed to launch" notification. Dragon opens OpenCode's terminal UI in the editor area and reads the exit to say why it stopped. Still so in microsoft/vscode `main` (2026-10-07); worth sending upstream.

## What Dragon IDE changes in OpenCode

Each change is a patch in `opencode-patches/`, so a sync reapplies it.

- `0001-instruction-walk-windows-drive-letter.patch`: the `AGENTS.md` lookup walks up from the workspace and stopped only on an exact string match with home or the project root. On Windows the workspace path can have a lowercase drive letter (`c:\`) while home has `C:\`, so the walk never matched, recursed past the drive root and overflowed the stack, and every chat turn failed with "Instruction initialization blocked by unavailable sources". It now compares paths the way OpenCode's `FSUtil.contains` does and stops at the root. Worth sending upstream.
- `0002-bedrock-claude-output-limit.patch`: OpenCode sends no output limit unless a plugin sets one, and Bedrock's Converse API then stops Claude at 4,096 tokens (`finish: "length"`). Any file longer than that was cut off mid-write, and the write failed with "Invalid arguments for tool "write": content: Missing key". Claude on Bedrock now gets its catalog output limit, at most 32,000 (the Anthropic route's default). Other Bedrock models and other providers are unchanged. Worth sending upstream.
- `0003-compaction-threshold.patch`: OpenCode compacts a conversation automatically only near the end of the model's context window (the window less the larger of 20,000 tokens and the output limit), about 88% for a 262K-token model. A new `compaction.threshold` setting, a fraction of the window from 0 to 1, makes it compact sooner; the earlier of the two points wins. Dragon sets it from `dragon.compaction.autoAt` (75% by default, `/autocompact` in the chat). Worth sending upstream.
- `0004-sandbox-spawned-formatters.patch`: a project's `opencode.json` can configure formatter commands, which OpenCode spawns directly (`core/src/formatter.ts`), not through a window's shell, so Dragon's shell sandbox did not reach them and a formatter could read and write anywhere on the disk. When Dragon confines a window (the `DRAGON_SANDBOX_PROFILE`/`DRAGON_SANDBOX_HOME` variables it already sets for shell commands), the formatter command is now run under the same macOS `sandbox-exec` profile, with `HOME` set to the sandbox's home. Full Access, and other platforms, run it unchanged. Dragon-specific; not for upstream.
- `0005-confine-in-process-plugins.patch`: a project's `opencode.json` can load in-process plugins — its own `.opencode/plugin[s]` directories, or packages and paths in its `plugins` array — which OpenCode `import()`s into the server process, where they run with full privileges and cannot be sandboxed as a spawned command can. Under a confined window Dragon passes `DRAGON_TRUSTED_PLUGINS`, the directories of its own plugins, and OpenCode now loads only those, dropping a project's plugins and any plugin-removing entry. The gate stays off when no trusted list is passed (Full Access, and older Dragon builds), so it can never unload the sandbox plugin that confinement itself depends on. Dragon-specific; not for upstream.
