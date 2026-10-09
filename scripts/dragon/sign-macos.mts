/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vellora AI and Dragon IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { sign } from '@electron/osx-sign';
const root = path.resolve(import.meta.dirname, '../..');
const app = process.argv[2];
const identity = process.env.DRAGON_SIGNING_IDENTITY;
const profile = process.env.DRAGON_NOTARY_PROFILE;
if (process.platform !== 'darwin' || !app?.endsWith('.app') || !identity || !profile) {
	throw new Error('Usage: DRAGON_SIGNING_IDENTITY="Developer ID Application: …" DRAGON_NOTARY_PROFILE=<keychain profile> node scripts/dragon/sign-macos.mts <app>');
}
const identities = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' });
if (!identity.startsWith('Developer ID Application:') || !identities.includes(`"${identity}"`)) { throw new Error('A valid Developer ID Application certificate and private key are required.'); }
const entitlements = path.join(root, 'build/azure-pipelines/darwin');
// OpenCode's terminal UI and file watcher load native libraries that Bun unpacks at run time, which
// carry no Team ID, so only OpenCode may load libraries signed by others.
const opencode = path.join(app, 'Contents/Resources/app/extensions/dragon-agent/bin/opencode');
function entitlementsFor(file: string): string {
	return path.join(entitlements, file === opencode ? 'opencode-entitlements.plist' : file.includes(' Helper (GPU).app') ? 'helper-gpu-entitlements.plist' : file.includes(' Helper (Renderer).app') ? 'helper-renderer-entitlements.plist' : file.includes(' Helper (Plugin).app') ? 'helper-plugin-entitlements.plist' : file.includes(' Helper.app') ? 'helper-entitlements.plist' : 'app-entitlements.plist');
}
// Nested native libraries and executables include the bundled Bun and Python runtimes.
const native: string[] = [];
function walk(dir: string): void {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const file = path.join(dir, entry.name);
		if (entry.isDirectory()) { walk(file); }
		else if (entry.isFile()) {
			const fd = fs.openSync(file, 'r'); const magic = Buffer.alloc(4);
			try { fs.readSync(fd, magic, 0, 4, 0); } finally { fs.closeSync(fd); }
			if (['cffaedfe', 'cefaedfe', 'cafebabe', 'bebafeca'].includes(magic.toString('hex'))) { native.push(file); }
		}
	}
}
walk(path.join(app, 'Contents/Resources/app'));
for (const file of native) { execFileSync('codesign', ['--force', '--timestamp', '--options', 'runtime', '--entitlements', entitlementsFor(file), '--sign', identity, file], { stdio: 'inherit' }); }
await sign({ app, identity, platform: 'darwin', preAutoEntitlements: false, preEmbedProvisioningProfile: false, optionsForFile: file => ({ hardenedRuntime: true, entitlements: entitlementsFor(file) }) });
execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], { stdio: 'inherit' });
execFileSync(process.execPath, [path.join(root, 'scripts/dragon/check-opencode-tui.mts'), opencode], { stdio: 'inherit' });
const archive = app + '.notarization.zip';
execFileSync('ditto', ['-c', '-k', '--keepParent', app, archive]);
try {
	const response = JSON.parse(execFileSync('xcrun', ['notarytool', 'submit', archive, '--keychain-profile', profile, '--wait', '--output-format', 'json'], { encoding: 'utf8' }));
	if (response.status !== 'Accepted') { throw new Error(`Notarization ${response.status}; submission ${response.id}`); }
	execFileSync('xcrun', ['stapler', 'staple', app], { stdio: 'inherit' });
	execFileSync('xcrun', ['stapler', 'validate', app], { stdio: 'inherit' });
	execFileSync('spctl', ['--assess', '--type', 'execute', '--verbose=2', app], { stdio: 'inherit' });
	console.log('Developer ID signature and notarization verified. Re-archive this stapled app for release.');
} finally { fs.rmSync(archive, { force: true }); }
