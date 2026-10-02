/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vellora AI and Dragon IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Builds the vendored OpenCode (opencode/, pinned in opencode/PIN.json) into a standalone
// binary and places it where the dragon-agent extension looks for it:
//   extensions/dragon-agent/bin/opencode[.exe]
//
// Usage: node scripts/dragon/build-opencode.mts [--target=<os>-<arch>] [--skip-install]
//   --target  cross-compile, e.g. darwin-arm64, linux-x64, windows-x64 (default: this machine)
// Requires bun >= 1.4.2.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', '..');
const opencode = path.join(root, 'opencode');
const pin = JSON.parse(readFileSync(path.join(opencode, 'PIN.json'), 'utf8'));
const args: Record<string, string | true> = Object.fromEntries(process.argv.slice(2).map(a => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, v ?? true]));
const version = pin.tag.replace(/^v/, '');
const env = { ...process.env, OPENCODE_CHANNEL: 'local', OPENCODE_VERSION: version };

const run = (cmd: string, argv: string[], cwd: string) => {
	console.log(`$ ${cmd} ${argv.join(' ')}  (in ${path.relative(root, cwd) || '.'})`);
	execFileSync(cmd, argv, { cwd, env, stdio: 'inherit' });
};

if (!args['skip-install']) {
	// Only the CLI's workspace dependencies: the binary does not use the web app or enterprise
	// packages, whose git and pkg.pr.new dependencies make a full install slower and more fragile.
	// bun installs native optional packages (the pty) for this machine unless told the target's.
	const [targetOs, targetCpu] = args.target ? String(args.target).split('-') : [];
	const targetArgs = targetOs ? [`--os=${targetOs === 'windows' ? 'win32' : targetOs}`, `--cpu=${targetCpu}`] : [];
	run('bun', ['install', '--filter', '@opencode/cli', ...targetArgs], opencode);
}

const cli = path.join(opencode, 'packages', 'cli');
// Start from an empty dist so only this build's binary is picked up.
rmSync(path.join(cli, 'dist'), { recursive: true, force: true });
const buildArgs = ['run', 'script/build.ts', '--skip-install', '--skip-web-ui'];
if (args.target) {
	const [os, arch] = String(args.target).split('-');
	buildArgs.push(`--target=opencode-${os}-${arch}`);
} else {
	buildArgs.push('--single');
}
run('bun', buildArgs, cli);

// Find the produced binary: packages/cli/dist/<name>/bin/opencode[.exe]
const dist = path.join(cli, 'dist');
const wantWindows = args.target ? String(args.target).startsWith('windows') : process.platform === 'win32';
const exe = wantWindows ? 'opencode.exe' : 'opencode';
const produced = readdirSync(dist)
	.map(dir => path.join(dist, dir, 'bin', exe))
	.filter(existsSync);
if (!produced.length) {
	throw new Error(`No ${exe} found under ${dist}`);
}
const source = produced[0];
const destDir = path.join(root, 'extensions', 'dragon-agent', 'bin');
mkdirSync(destDir, { recursive: true });
const dest = path.join(destDir, exe);
copyFileSync(source, dest);
if (!wantWindows) {
	chmodSync(dest, 0o755);
}
const sha256 = createHash('sha256').update(readFileSync(dest)).digest('hex');
writeFileSync(path.join(destDir, 'opencode.json'), JSON.stringify({ version, commit: pin.commit, target: args.target ?? `${process.platform}-${process.arch}`, sha256 }, null, '\t') + '\n');
console.log(`OpenCode ${version} -> ${path.relative(root, dest)} (sha256 ${sha256.slice(0, 16)}…)`);
