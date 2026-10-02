# Dragon IDE: instructions for agents

Dragon IDE is VS Code 1.139.1 with OpenCode v2.0.18 as its only agent. Read [`README.md`](README.md), [`SPEC.md`](SPEC.md), [`UPSTREAM.md`](UPSTREAM.md) and [`DESIGN.md`](DESIGN.md) first. Before you change a component, read its spec. They are listed in [`specs/INDEX.md`](specs/INDEX.md).

## Ground rules

- **OpenCode is the only agent harness.** The chat view is used purely as a user interface. Model calls, tools, edits and permissions go through the OpenCode server. Do not add an agent loop, tool implementations or model routing in `src/` or in `extensions/dragon-agent/`.
- **Keep the diff against VS Code small.** Put new workbench code under `src/vs/workbench/contrib/dragon*`. When an upstream file has to change, keep the change to a few lines and mark it with `// DRAGON:` so upstream syncs can find it.
- **Keep the diff against OpenCode at zero.** Do not edit `opencode/` directly. When a change is unavoidable, add a patch to `opencode-patches/`.
- **Do not add proprietary endpoints.** Nothing should phone home. `scripts/dragon/check-branding.mts` fails the build if a name or endpoint matching the `DRAGON_FORBIDDEN_NAMES` pattern appears (CI reads the pattern from a repository secret).
- **Update specs together with contracts.** A change to settings, commands, tool schemas, the OpenCode server contract or event mapping must update the nearest `SPEC.md` in the same commit: bump its `version`, add a changelog line, and update `specs/INDEX.md`.
- **Search goes through Instant Grep.** Improve search in `extensions/dragon-agent/src/search/`. Its results must stay identical to ripgrep's, which the equivalence test enforces.
- **Bundle no Copilot pieces.** `extensions/copilot` is deleted and must stay deleted. Core code must work with no `defaultChatAgent` in `product.json`.

## Validation

- `npm run compile-check-ts-native`: type-checks the workbench.
- `npm run dragon:check`: runs the branding gate and the dragon-agent unit tests.
- `cd extensions/dragon-agent && npm test`: runs the agent bridge tests on their own.

For VS Code's own coding guidelines, see `.github/copilot-instructions.md` and `.github/instructions/`.
