# Security policy

Please **do not** report security vulnerabilities in public issues.

Report them privately with [GitHub's private vulnerability reporting](https://github.com/VELLORAAI/dragon-ide/security/advisories/new). We will acknowledge your report within three working days and keep you updated until a fix ships.

Where to report:
- **Dragon IDE:** the editor, the dragon-agent extension, onboarding and packaging. Report here.
- **OpenCode:** the agent, its tools and its server. Report to [sst/opencode](https://github.com/sst/opencode/security) as well; we will pull the fix into `opencode/`.
- **VS Code:** anything in unmodified upstream code. Report to [Microsoft](https://github.com/microsoft/vscode/blob/main/SECURITY.md), and let us know so we can merge the fix.

How Dragon IDE handles your data:
- The OpenCode server listens on loopback only and requires a random password generated for each window.
- API keys are stored by OpenCode on your machine. Dragon IDE never sends them anywhere except to the provider you chose.
- Dragon IDE collects no telemetry.
