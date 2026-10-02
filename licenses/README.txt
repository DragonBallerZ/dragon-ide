Dragon IDE V1.0.0 — third-party materials

Code-OSS and Dragon changes are MIT licensed. Microsoft copyright and attribution
are retained. This is not Microsoft's Visual Studio Code distribution and is not
endorsed by Microsoft, GitHub, Anthropic, Qwen, Ollama or IncoAI.

The orange Dragon artwork was generated for this project. Codicons retain their
CC-BY-4.0 attribution and license in DEPENDENCY-NOTICES.txt. Other font licenses and
Electron/Chromium notices accompany their assets and application bundle.

DEPENDENCY-NOTICES.txt and dependency-inventory.json record installed runtime
packages and the OpenCode CLI production dependency graph. Some optional packages
listed may not be present on every platform. Original package notices are retained.

jschardet 3.1.4 is LGPL-2.1-or-later. Complete supplied library source is included in
jschardet-source/. The library remains an external JavaScript module in
node_modules.asar, not linked into an opaque native application. You may modify,
replace and reverse engineer the library and the application for debugging those
modifications as the LGPL permits. Use the open-source asar tool to extract/repack
the archive, or build Dragon IDE from source with the modified dependency. Modified
macOS bundles need to be re-signed for your own use. No extra product EULA restricts
these rights. Upstream source: https://github.com/aadsm/jschardet/tree/v3.1.4

The macOS arm64 build additionally includes unmodified Splash 1.1.0 (Apache-2.0),
its MIT notices and packaged Python distribution under extensions/dragon-agent/bin/splash.
That folder retains Python's license and each distribution's *.dist-info license files.
Splash source and release: https://github.com/incoai/splash/releases/tag/1.1.0
Python source: https://www.python.org/downloads/source/
certifi (MPL-2.0): https://github.com/certifi/python-certifi
The corresponding certifi certificate data and Python sources are included in the
Splash package. tqdm (MPL-2.0 and MIT) sources and notices are also retained there.

No model weights are redistributed with Dragon. Model downloads are separate,
explicit user actions. The curated Qwen models identify their Hugging Face source
and Apache-2.0 license in the setup flow. Model cards and downstream service terms
remain applicable to those downloads and provider connections.

The proprietary @vscode/copilot-api, @github/copilot-sdk and Claude agent SDK are
excluded from the packaged runtime. MIT-licensed upstream compatibility identifiers
are not a grant or requirement to distribute those proprietary implementations.

This inventory and packaging check record technical compliance work. They do not
constitute an independent legal opinion or a guarantee covering every use case.
