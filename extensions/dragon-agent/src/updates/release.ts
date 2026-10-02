/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vellora AI and Dragon IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { readFileSync } from 'node:fs';
import * as path from 'node:path';

/** The Dragon IDE build this is, and where its releases are published (from product.json). */
export interface DragonProduct {
	readonly version?: string;
	/** A GitHub "latest release" API URL, e.g. https://api.github.com/repos/<owner>/<repo>/releases/latest. */
	readonly updateFeed?: string;
}

export interface ReleaseInfo {
	readonly version: string;
	readonly name: string;
	readonly url: string;
}

export function readDragonProduct(appRoot: string): DragonProduct {
	try {
		const product = JSON.parse(readFileSync(path.join(appRoot, 'product.json'), 'utf8')) as { dragonVersion?: unknown; dragonUpdateFeed?: unknown };
		return {
			version: typeof product.dragonVersion === 'string' ? product.dragonVersion : undefined,
			updateFeed: typeof product.dragonUpdateFeed === 'string' ? product.dragonUpdateFeed : undefined,
		};
	} catch {
		return {};
	}
}

/**
 * Compares two versions like `1.2.3` or `v1.2.3-beta.1`: numeric parts first, and a release
 * sorts after its own pre-releases. Returns a negative number, zero or a positive number.
 */
export function compareVersions(a: string, b: string): number {
	const parse = (v: string) => {
		const [core, pre] = v.trim().replace(/^v/i, '').split('-', 2);
		return { parts: core.split('.').map(n => parseInt(n, 10) || 0), pre };
	};
	const x = parse(a);
	const y = parse(b);
	for (let i = 0; i < Math.max(x.parts.length, y.parts.length); i++) {
		const diff = (x.parts[i] ?? 0) - (y.parts[i] ?? 0);
		if (diff) {
			return diff;
		}
	}
	if (x.pre === y.pre) {
		return 0;
	}
	if (x.pre === undefined) {
		return 1;
	}
	if (y.pre === undefined) {
		return -1;
	}
	return x.pre.localeCompare(y.pre, undefined, { numeric: true });
}

/** The latest published release from a GitHub "latest release" feed. Drafts and pre-releases are never returned by it. */
export async function latestRelease(feed: string, fetchImpl: typeof fetch = fetch, signal?: AbortSignal): Promise<ReleaseInfo> {
	const res = await fetchImpl(feed, {
		headers: { accept: 'application/vnd.github+json', 'user-agent': 'Dragon-IDE-update-check' },
		signal: signal ?? AbortSignal.timeout(10_000),
	});
	if (!res.ok) {
		throw new Error(res.status === 404 ? 'no published release was found (HTTP 404)' : `the release feed answered HTTP ${res.status}`);
	}
	const body = await res.json() as { tag_name?: unknown; name?: unknown; html_url?: unknown; draft?: unknown; prerelease?: unknown };
	if (typeof body.tag_name !== 'string' || typeof body.html_url !== 'string' || body.draft === true || body.prerelease === true) {
		throw new Error('the release feed returned no usable release');
	}
	return { version: body.tag_name.replace(/^v/i, ''), name: typeof body.name === 'string' && body.name ? body.name : body.tag_name, url: body.html_url };
}

/** A newer release than `current`, if there is one. */
export async function availableUpdate(product: DragonProduct, fetchImpl: typeof fetch = fetch): Promise<ReleaseInfo | undefined> {
	if (!product.version || !product.updateFeed) {
		return undefined;
	}
	const latest = await latestRelease(product.updateFeed, fetchImpl);
	return compareVersions(latest.version, product.version) > 0 ? latest : undefined;
}
