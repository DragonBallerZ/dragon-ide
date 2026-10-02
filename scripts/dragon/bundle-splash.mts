/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vellora AI and Dragon IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Pin and verify the official runtime. No model weights or credentials are included.
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
const root = path.resolve(import.meta.dirname, '../..');
const target = process.argv.find(a => a.startsWith('--target='))?.split('=')[1] ?? `${process.platform}-${process.arch}`;
if (target !== 'darwin-arm64') { console.log(`Splash is not supported on ${target}; Ollama remains available.`); process.exit(0); }
const version = '1.1.0';
const sha256 = '255be83f404b1e31e4d98a863ccce05004d348fb6662c68afced4ff992402437';
const archiveName = `splash-${version}-arm64-macos26`;
const supplied = process.argv.find(a => a.startsWith('--archive='))?.slice('--archive='.length);
const temp = mkdtempSync(path.join(tmpdir(), 'dragon-splash-'));
try {
	const archive = supplied ?? path.join(temp, `${archiveName}.tar.gz`);
	if (!supplied) {
		const response = await fetch(`https://github.com/incoai/splash/releases/download/${version}/${archiveName}.tar.gz`);
		if (!response.ok) { throw new Error(`Splash download failed: ${response.status}`); }
		writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
	}
	if (createHash('sha256').update(readFileSync(archive)).digest('hex') !== sha256) { throw new Error('Splash archive checksum mismatch'); }
	execFileSync('tar', ['-xzf', archive, '-C', temp]);
	const source = path.join(temp, archiveName);
	for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES', 'release.json', 'engine/splash', 'python/bin/python3']) {
		if (!existsSync(path.join(source, file))) { throw new Error(`Splash archive is missing ${file}`); }
	}
	const destination = path.join(root, 'extensions/dragon-agent/bin/splash');
	rmSync(destination, { recursive: true, force: true });
	mkdirSync(path.dirname(destination), { recursive: true });
	cpSync(source, destination, { recursive: true, verbatimSymlinks: true });
	console.log(`Bundled Splash ${version}; verified ${sha256}`);
} finally { rmSync(temp, { recursive: true, force: true }); }
