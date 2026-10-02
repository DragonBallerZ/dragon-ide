/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vellora AI and Dragon IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Collect local license evidence without network access or private credentials.
import fs from 'node:fs';
import path from 'node:path';
import { getProductionDependencies } from '../../build/lib/dependencies.ts';
const root = path.resolve(import.meta.dirname, '../..');
const output = path.join(root, 'licenses');
fs.mkdirSync(output, { recursive: true });
const excluded = /[\/]node_modules[\/](?:@vscode[\/]copilot-api|@github[\/]copilot-sdk(?:-[^\/]*)?|@anthropic-ai[\/]claude-agent-sdk)(?:[\/]|$)/;
const packages = new Map<string, { name: string; version: string; license: unknown; source: unknown; group: string; notices: string[] }>();
const notices: string[] = [];
function collect(dir: string, group: string): void {
	if (excluded.test(dir.split(path.sep).join('/')) || !fs.existsSync(path.join(dir, 'package.json'))) { return; }
	const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
	const key = `${pkg.name}@${pkg.version}`;
	if (packages.has(key)) { return; }
	const files = fs.readdirSync(dir).filter(f => /^(license|licence|copying|notice|third.?party.?notices)(\.|$)/i.test(f) && fs.statSync(path.join(dir, f)).isFile());
	const license = pkg.license ?? pkg.licenses ?? (['@opencode/latex', '@opencode/merman'].includes(pkg.name) ? 'MIT (OpenCode repository LICENSE)' : 'UNKNOWN');
	packages.set(key, { name: pkg.name, version: pkg.version, license, source: pkg.repository ?? pkg.homepage, group, notices: files });
	notices.push(`\n${'='.repeat(80)}\n${key} (${group})\nDeclared license: ${JSON.stringify(license)}\nSource: ${JSON.stringify(pkg.repository ?? pkg.homepage ?? '')}\n`);
	for (const file of files) { notices.push(`\n--- ${file} ---\n${fs.readFileSync(path.join(dir, file), 'utf8')}\n`); }
}
for (const dir of getProductionDependencies(root)) { collect(dir, 'Code-OSS runtime'); }
// Follow only production dependencies from the OpenCode CLI, resolving Bun workspace links.
const visited = new Set<string>();
function visit(dir: string): void {
	if (!fs.existsSync(path.join(dir, 'package.json'))) { return; }
	dir = fs.realpathSync(dir);
	if (visited.has(dir)) { return; } visited.add(dir);
	collect(dir, 'OpenCode CLI dependency graph');
	const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
	for (const name of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })) {
		let search = dir;
		for (;;) {
			const candidate = path.join(search, 'node_modules', name);
			if (fs.existsSync(path.join(candidate, 'package.json'))) { visit(candidate); break; }
			const parent = path.dirname(search); if (parent === search) { break; } search = parent;
		}
	}
}
visit(path.join(root, 'opencode/packages/cli'));
const inventory = [...packages.values()].sort((a,b) => a.name.localeCompare(b.name));
fs.writeFileSync(path.join(output, 'dependency-inventory.json'), JSON.stringify(inventory, null, 2) + '\n');
const version = JSON.parse(fs.readFileSync(path.join(root, 'product.json'), 'utf8')).dragonVersion;
fs.writeFileSync(path.join(output, 'DEPENDENCY-NOTICES.txt'), (`Dragon IDE V${version} dependency notices. Copyright and license notices remain with their respective owners.\n` + notices.join('')).replace(/[ \t]+$/gm, '').trimEnd() + '\n');
// LGPL library source is distributed in editable form, independently replaceable in node_modules.asar.
fs.cpSync(path.join(root, 'node_modules/jschardet'), path.join(output, 'jschardet-source'), { recursive: true, filter: file => !file.includes('/node_modules/jschardet/node_modules') });
fs.copyFileSync(path.join(root, 'opencode/LICENSE'), path.join(output, 'OpenCode-LICENSE.txt'));
console.log(`Collected ${inventory.length} package records and original notices.`);
console.log('Manual review:', JSON.stringify(inventory.filter(p => /UNKNOWN|SEE LICENSE|UNLICENSED/i.test(JSON.stringify(p.license))).map(p => ({ name:p.name, license:p.license }))));
