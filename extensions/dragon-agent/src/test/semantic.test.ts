/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vellora AI and Dragon IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { hasOllamaModel, isEmbeddingModel, ollamaConfig } from '../ollama/ollama';
import { SearchEngine } from '../search/engine';
import { findRipgrep } from '../search/ripgrep';
import { chunkCode, extractKeywords, formatSemantic, isSemanticCandidate, queryInput, SemanticIndex, SemanticSettings } from '../search/semantic';
import { startMockOllama } from './mockOllama';

const rg = findRipgrep({ appRoot: path.resolve(__dirname, '..', '..', '..', '..') });

test('code is chunked at natural boundaries with exact line numbers', () => {
	const fn = (name: string) => [`export function ${name}(value: number): number {`, ...Array.from({ length: 12 }, (_, i) => `\tconst step${i} = value * ${i} + ${name.length}; // arithmetic for ${name}`), '\treturn value;', '}'];
	const text = [...fn('first'), '', ...fn('second'), '', ...fn('third')].join('\n') + '\n';
	const chunks = chunkCode(text);
	assert.ok(chunks.length >= 2, `several chunks (${chunks.length})`);
	const lines = text.split('\n');
	for (const chunk of chunks) {
		assert.equal(chunk.text, lines.slice(chunk.start - 1, chunk.end).join('\n'));
		assert.ok(chunk.text.length <= 1800 + 200);
	}
	assert.equal(chunks[0].start, 1);
	assert.equal(chunks[chunks.length - 1].end, lines.length - 1);
	// Every chunk ends where the next line is blank or starts a new top-level construct.
	for (const chunk of chunks.slice(0, -1)) {
		const next = lines[chunk.end];
		assert.ok(next === '' || /^\S/.test(next), `chunk ends at a boundary (next: ${JSON.stringify(next)})`);
	}
	assert.deepEqual(chunkCode('\n\n  \n'), []);
});

test('keywords prefer backticks and identifiers over words', () => {
	assert.deepEqual(extractKeywords('where is `retry_upload` called when the uploadQueue fails?').map(k => k.text), ['retry_upload', 'uploadQueue', 'fails']);
	assert.deepEqual(extractKeywords('how does it work'), []);
	assert.equal(extractKeywords('a b c d e f g h i j k l m n o p q r s t u v w x y z alpha beta gamma delta epsilon zeta eta theta').length, 6);
});

test('which files are embedded', () => {
	assert.ok(isSemanticCandidate('src/app.ts', 1000));
	assert.ok(isSemanticCandidate('docs/guide.md', 1000));
	assert.ok(!isSemanticCandidate('src/app.min.js', 1000));
	assert.ok(!isSemanticCandidate('package-lock.json', 1000));
	assert.ok(!isSemanticCandidate('.github/workflows/ci.yml', 1000));
	assert.ok(!isSemanticCandidate('data/big.json', 64 * 1024));
	assert.ok(!isSemanticCandidate('assets/logo.png', 1000));
	assert.ok(!isSemanticCandidate('types/index.d.ts', 1000));
});

test('embedding models are recognised and kept out of the agent model config', () => {
	for (const name of ['qwen3-embedding:0.6b', 'nomic-embed-text:latest', 'embeddinggemma', 'mxbai-embed-large', 'all-minilm:l6-v2', 'bge-m3']) {
		assert.ok(isEmbeddingModel(name), name);
	}
	for (const name of ['qwen2.5-coder:7b', 'gpt-oss:20b', 'qwen3:14b']) {
		assert.ok(!isEmbeddingModel(name), name);
	}
	const config = JSON.stringify(ollamaConfig('http://127.0.0.1:11434', [{ name: 'qwen2.5-coder:7b', size: 1 }, { name: 'qwen3-embedding:0.6b', size: 1 }]));
	assert.ok(config.includes('qwen2.5-coder:7b') && !config.includes('qwen3-embedding'));
	assert.ok(hasOllamaModel(['nomic-embed-text:latest'], 'nomic-embed-text'));
	assert.ok(!hasOllamaModel(['nomic-embed-text:v1.5'], 'nomic-embed-text'));
	assert.match(queryInput('qwen3-embedding:0.6b', 'q'), /^Instruct: .*\nQuery: q$/);
	assert.equal(queryInput('nomic-embed-text', 'q'), 'search_query: q');
});

test('codebase_search ranks by meaning, fuses keywords, stays fresh and persists', { skip: !rg && 'ripgrep not found', timeout: 120_000 }, async t => {
	const root = mkdtempSync(path.join(tmpdir(), 'dragon-semantic-'));
	const storage = mkdtempSync(path.join(tmpdir(), 'dragon-semantic-store-'));
	const files: Record<string, string> = {
		'src/auth/session.ts': 'export function validateSessionToken(token: string): boolean {\n\t// Check the signature and the expiry of the login token before trusting the session.\n\treturn verifySignature(token) && !isExpired(token);\n}\n',
		'src/images/resize.ts': 'export function resizeImage(buffer: Uint8Array, width: number): Uint8Array {\n\t// Scale pictures down to thumbnails, keeping the aspect ratio.\n\treturn scale(buffer, width);\n}\n',
		'src/db/migrate.ts': 'export async function runMigrations(db: Database): Promise<void> {\n\t// Apply the database schema migrations in order, each inside a transaction.\n\tfor (const step of steps) { await db.apply(step); }\n}\n',
		'docs/uploads.md': '# Uploads\n\nUploads are retried three times with exponential backoff when the network connection fails.\n',
		'test/session.test.ts': 'import { validateSessionToken } from "../src/auth/session";\n// ensures expired tokens are rejected by the validator in every case\n',
		'.hidden/secret.ts': 'export const hiddenThing = "the login token signature expiry";\n',
	};
	for (const [rel, text] of Object.entries(files)) {
		mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
		writeFileSync(path.join(root, rel), text);
	}
	const mock = await startMockOllama([{ kind: 'text', chunks: ['unused'] }], 'qwen2.5-coder:7b', 0, { embedModel: 'mock-embed' });
	const settings = async (): Promise<SemanticSettings> => ({ enabled: true, model: 'mock-embed', origin: mock.origin });
	// Documents are embedded as "path\ncode"; questions are embedded on their own, without a newline.
	const embedInputs = () => mock.requests.filter(r => r.path === '/api/embed').reduce((n, r) => n + (r.body as { input: string[] }).input.filter(i => i.includes('\n')).length, 0);
	const engine = new SearchEngine(root, rg!, storage);
	let semantic = new SemanticIndex(root, engine, storage, line => t.diagnostic(line), settings);
	try {
		semantic.start();
		assert.equal((await semantic.whenIdle()).kind, 'ready');
		assert.equal(semantic.stats.files, 5, 'the hidden file is not embedded');

		const top = async (query: string, under?: string) => (await semantic.search(query, { under, limit: 3 })).hits.map(h => h.path);
		assert.equal((await top('where do we check the login token signature and expiry'))[0], 'src/auth/session.ts');
		assert.equal((await top('scale pictures down to thumbnails'))[0], 'src/images/resize.ts');
		assert.equal((await top('what happens when network uploads fail, are they retried with backoff'))[0], 'docs/uploads.md');
		assert.deepEqual(await top('login token signature expiry', 'src/images'), ['src/images/resize.ts']);

		const hybrid = await semantic.search('in what order does runMigrations apply steps', { limit: 3 });
		assert.equal(hybrid.mode, 'hybrid');
		assert.equal(hybrid.hits[0].path, 'src/db/migrate.ts');
		assert.ok(hybrid.hits[0].keyword, 'the identifier also matched as a keyword');
		const text = await formatSemantic(root, hybrid, 'in what order does runMigrations apply steps');
		assert.match(text, /src\/db\/migrate\.ts:1-4 \(similarity/);
		assert.match(text, /^2: \t\/\/ Apply the database schema migrations/m);

		// An edit re-embeds only the changed file.
		const before = embedInputs();
		const embedded = semantic.stats.embedded;
		writeFileSync(path.join(root, 'src/images/resize.ts'), files['src/images/resize.ts'] + '\n// Rotating photos by ninety degrees happens here as well, for sideways pictures.\n');
		const deadline = Date.now() + 10_000;
		while (Date.now() < deadline && (semantic.stats.embedded === embedded || semantic.status.kind !== 'ready')) {
			await new Promise(resolve => setTimeout(resolve, 25));
		}
		const rotated = await semantic.search('rotating sideways photos by ninety degrees', { limit: 3 });
		assert.equal(rotated.hits[0].path, 'src/images/resize.ts');
		assert.ok((rotated.hits[0].similarity ?? 0) > 0.3, `the new text is embedded (similarity ${rotated.hits[0].similarity})`);
		assert.ok(embedInputs() - before >= 1 && embedInputs() - before <= 2, `only the changed file was re-embedded (${embedInputs() - before} inputs)`);

		// A restart loads the saved vectors instead of embedding again.
		semantic.dispose();
		await new Promise(resolve => setTimeout(resolve, 200));
		const saved = embedInputs();
		semantic = new SemanticIndex(root, engine, storage, line => t.diagnostic(line), settings);
		semantic.start();
		assert.equal((await semantic.whenIdle()).kind, 'ready');
		assert.equal(embedInputs(), saved, 'nothing re-embedded after a restart');
		assert.equal((await top('scale pictures down to thumbnails'))[0], 'src/images/resize.ts');
		semantic.dispose();

		// Without the embedding model, search falls back to keywords and says why.
		const missing = new SemanticIndex(root, engine, undefined, () => { }, async () => ({ enabled: true, model: 'not-pulled-embed', origin: mock.origin }));
		missing.start();
		assert.equal((await missing.whenIdle()).kind, 'unavailable');
		const fallback = await missing.search('where is resizeImage defined');
		assert.equal(fallback.mode, 'keyword');
		assert.match(fallback.note ?? '', /not-pulled-embed is not installed/);
		assert.equal(fallback.hits[0].path, 'src/images/resize.ts');
		missing.dispose();

		// Remote origins are refused outright.
		const remote = new SemanticIndex(root, engine, undefined, () => { }, async () => ({ enabled: true, model: 'mock-embed', origin: 'http://10.1.2.3:11434' }));
		remote.start();
		const state = await remote.whenIdle();
		assert.equal(state.kind, 'unavailable');
		assert.match(state.kind === 'unavailable' ? state.reason : '', /only uses a local Ollama/);
		remote.dispose();
	} finally {
		semantic.dispose();
		engine.dispose();
		await mock.close();
		rmSync(root, { recursive: true, force: true });
		rmSync(storage, { recursive: true, force: true });
	}
});
