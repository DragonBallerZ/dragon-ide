/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vellora AI and Dragon IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const asar = require('asar') as { listPackage(p:string): string[]; extractFile(p:string,f:string): Buffer };
const input = process.argv[2];
if (!input) { throw new Error('Usage: node scripts/dragon/audit-package.mts <app bundle or resources/app>'); }
const root = input.endsWith('.app') ? path.join(input, 'Contents/Resources/app') : input;
const product = JSON.parse(fs.readFileSync(path.join(root, 'product.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const errors: string[] = [];
const release = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../../product.json'), 'utf8')).dragonVersion;
if (product.dragonVersion !== release || pkg.version !== release) { errors.push(`Packaged version ${product.dragonVersion}/${pkg.version} is not the release version ${release} (product.json)`); }
if (product.defaultChatAgent || product.copilotVersions) { errors.push('Proprietary agent metadata present'); }
const archive = path.join(root, 'node_modules.asar');
const entries = asar.listPackage(archive);
for (const entry of entries) {
	if (/^\/(?:@vscode\/copilot-api|@github\/copilot-sdk(?:-[^/]+)?|@anthropic-ai\/claude-agent-sdk)(?:\/|$)/.test(entry)) { errors.push(`Restricted package: ${entry}`); }
}
if (fs.existsSync(path.join(root, 'extensions/copilot'))) { errors.push('Copilot extension is bundled'); }
if (fs.existsSync(path.join(root, 'out/vs/platform/agentHost/node/agentHostMain.js'))) { errors.push('Unused proprietary agent-host entry point is bundled'); }
for (const file of ['LICENSE.txt', 'ThirdPartyNotices.txt', 'licenses/README.txt', 'licenses/DEPENDENCY-NOTICES.txt', 'licenses/dependency-inventory.json', 'licenses/jschardet-source/LICENSE', 'licenses/jschardet-source/src/universaldetector.js']) {
	if (!fs.existsSync(path.join(root, file))) { errors.push(`Missing license/source file: ${file}`); }
}
const splash = path.join(root, 'extensions/dragon-agent/bin/splash');
if (input.endsWith('.app') && process.arch === 'arm64') {
	for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES', 'release.json', 'python/bin/python3', 'engine/splash']) {
		if (!fs.existsSync(path.join(splash, file))) { errors.push(`Missing Splash file: ${file}`); }
	}
}
for (const dir of fs.readdirSync(path.join(root, 'extensions'))) {
	const file = path.join(root, 'extensions', dir, 'package.json');
	if (!fs.existsSync(file)) { continue; }
	const extension = JSON.parse(fs.readFileSync(file, 'utf8'));
	if (!['MIT', 'Apache-2.0'].includes(extension.license)) { errors.push(`Review extension license: ${dir} (${extension.license})`); }
}
if (errors.length) { throw new Error(errors.join('\n')); }
console.log(JSON.stringify({ version: product.dragonVersion, engineVersion: product.version, runtimePackageFiles: entries.length, splash: fs.existsSync(splash), restrictedPackages: 0, licenseFiles: 'present', status: 'passed' }, null, 2));
