# Contributing to Dragon IDE

Thanks for helping. Dragon IDE is VS Code with OpenCode as its only agent, so most changes land in one of three places:

| Change | Where it goes |
| --- | --- |
| Chat, agent, models, Ollama, TUI | `extensions/dragon-agent/` |
| The Dragon look (splash, onboarding, tool cards, composer chips) | `src/vs/workbench/contrib/dragon*`, plus the few upstream files listed in [`DESIGN.md`](DESIGN.md) |
| The agent's own behavior (tools, prompts, providers) | Upstream, in [sst/opencode](https://github.com/sst/opencode). `opencode/` is a vendored copy; see [`UPSTREAM.md`](UPSTREAM.md). |

## Building

```bash
npm ci
npm run compile
npm run dragon:build-opencode   # needs bun >= 1.4.2
./scripts/code.sh
```

`./scripts/code-web.sh` runs Dragon IDE in a browser, which helps when you are working on the UI.

## Before you open a pull request

```bash
npm run dragon:check                  # branding gate and dragon-agent tests
npm run typecheck-client              # type check src/
node build/hygiene.ts <changed files>
```

To run the whole CI workflow on your machine, use `npm run ci:local` (or `npm run ci:local -- dragon-agent` for one job). It runs every job in `.github/workflows/ci.yml` against the current commit. Add `-- --node-headers` when your network blocks electronjs.org, and `-- --reuse-deps` when a clean `npm ci` cannot reach GitHub (both are reported as deviations). Each job gets a fresh git worktree, the Node version pinned in `.nvmrc` (downloaded if needed) and the pinned Bun. The `run:` steps execute exactly as written. Logs and artifacts, including the packaged Linux app and its launch screenshots, go to `../.dragon-ci/`. Failed jobs keep their worktree for debugging. The Linux packaging job takes about an hour and needs roughly 10 GB of free disk. Uncommitted changes are not tested.

- Put new workbench code under `contrib/dragon*`. When you have to change an upstream VS Code file, keep the change to a few lines and mark it with `// DRAGON`.
- Don't edit `opencode/` directly. Send the change upstream to OpenCode, or, as a last resort, add a patch to `opencode-patches/`.
- New files start with the Dragon IDE header:

  ```
  /*---------------------------------------------------------------------------------------------
   *  Copyright (c) Vellora AI and Dragon IDE contributors. All rights reserved.
   *  Licensed under the MIT License. See License.txt in the project root for license information.
   *--------------------------------------------------------------------------------------------*/
  ```

## Reporting issues

Open an issue at https://github.com/VELLORAAI/dragon-ide/issues. Please include:
- your Dragon IDE version (Help > About)
- the model provider (for example Ollama with `qwen2.5-coder:7b`, or Anthropic)
- the output of **Dragon: Show OpenCode Log**

By contributing you agree that your contributions are licensed under the MIT License.
