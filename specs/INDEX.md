# Spec index

| spec_id | Version | Status | Spec | Covers |
| --- | --- | --- | --- | --- |
| `dragon-ide` | 0.9.1 | active | [`SPEC.md`](../SPEC.md) | Product scope, architecture, invariants, release gates |
| `dragon-agent` | 0.8.0 | active | [`extensions/dragon-agent/SPEC.md`](../extensions/dragon-agent/SPEC.md) | OpenCode server contract, chat-turn mapping, permissions, models, Ollama config layer, semantic-search setup, TUI, onboarding commands, usage readout |
| `instant-grep` | 0.4.1 | active | [`extensions/dragon-agent/src/search/SPEC.md`](../extensions/dragon-agent/src/search/SPEC.md) | Indexed grep, glob and find_files, and semantic `codebase_search`, for the agent |
| `dragon-workbench-ui` | 0.6.0 | active | [`src/vs/workbench/contrib/dragonOnboarding/SPEC.md`](../src/vs/workbench/contrib/dragonOnboarding/SPEC.md) | Onboarding, splash, tool cards, composer chips, usage readout |

## Related documents

- [`DESIGN.md`](../DESIGN.md): everything Dragon adds, the upstream patch points, and asset licensing status
- [`UPSTREAM.md`](../UPSTREAM.md): the pinned VS Code and OpenCode versions, and how to sync them

When a contract changes (settings, commands, tool schemas, the server contract, events), update the spec in the same commit: bump its `version`, add a changelog line, and update this index.
