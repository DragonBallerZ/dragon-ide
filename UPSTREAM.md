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

## What Dragon IDE changes in OpenCode

Each change is a patch in `opencode-patches/`, so a sync reapplies it.

- `0001-instruction-walk-windows-drive-letter.patch`: the `AGENTS.md` lookup walks up from the workspace and stopped only on an exact string match with home or the project root. On Windows the workspace path can have a lowercase drive letter (`c:\`) while home has `C:\`, so the walk never matched, recursed past the drive root and overflowed the stack, and every chat turn failed with "Instruction initialization blocked by unavailable sources". It now compares paths the way OpenCode's `FSUtil.contains` does and stops at the root. Worth sending upstream.
