---
spec_id: instant-grep
version: 0.4.1
status: active
owners: [VELLORAAI]
last_synced_with_central: 2026-09-28
source_of_truth: repo
related_specs:
  - ../../SPEC.md
related_code:
  - trigrams.ts
  - planner.ts
  - index.ts
  - engine.ts
  - ripgrep.ts
  - fuzzy.ts
  - semantic.ts
  - opencodePlugin.ts
  - ../semanticSetup.ts
  - ../../../../scripts/dragon/bench-instant-grep.mts
---

# Instant Grep and semantic search

## What

Instant Grep is a local, index-backed code search for the OpenCode agent. It replaces OpenCode's `grep` and `glob` tools under the same names and adds `find_files`.

It also adds `codebase_search`: semantic "search by meaning" over a local embedding model served by Ollama, fused with Instant Grep keyword hits.

## Why

OpenCode's `grep` and `glob` start a fresh `rg` process over the whole tree on every call. An agent searches constantly, so on large repositories that costs seconds per call.

In March 2026 Cursor described "Instant Grep": an n-gram index with bloom-filter masks, where most files are never opened and results come back in milliseconds. This is the open equivalent.

## How

1. **Index** (`trigrams.ts`, `index.ts`)
   - Every indexed file contributes its case-folded trigrams to an inverted index.
   - Each posting stores two 8-bit masks:
     - a **next-character bloom mask** of the characters that follow the trigram
     - a **position mask**, the trigram's offsets modulo 8
   - For a literal, trigram *k* must be followed by the literal's character *k+3*, and the trigrams' position masks must line up (rotated by *k*). Files where they don't are rejected without being read.
   - Case folding uses a Unicode table, so characters that are equal under simple case folding (ripgrep's `-i`) always share a key. For example: `Æ`/`æ`, `Σ`/`σ`/`ς`, the Kelvin sign with `k`, and the long s with `s`. A test checks this against the whole Basic Multilingual Plane.
   - **Chunks.** A file over 256K characters is split into chunks that end on line boundaries, so its masks don't saturate. Each chunk is a separate document; a match never spans lines, so a literal always lies inside one chunk.
   - **Bloom documents.** Where a line runs more than 16K characters past a chunk boundary (base64 data, minified code), nearly every trigram occurs. That region is cut into 64K-character pieces that overlap by 256 characters. Each piece is stored as a 64 KiB bloom filter of its trigrams and 4-grams, instead of in the posting lists. A literal longer than the overlap is split into windows, and a file must hold every window.
   - Files over 16 MB are not indexed and are always candidates. Binary files are skipped, as ripgrep does. UTF-16 files with a byte-order mark are decoded and indexed, as ripgrep transcodes them.
   - **Segments.** Postings live in immutable segments in compressed-sparse-row form: sorted trigram keys, a start offset per key, then document ids (ascending per key) and masks. Queries run a literal against each segment on its own, since a literal lies inside one document, and union the files.
     - The **base** segment is the saved file, `<hash>.trigrams` under `DRAGON_SEARCH_STORAGE`, keyed by a hash of the root. Under Bun (how OpenCode runs the plugin) on macOS and Linux it is memory-mapped with a private mapping and read through typed-array views, so its postings stay in the OS page cache instead of the process heap. Elsewhere (Node, Windows) it is read into memory.
     - New and changed files go to an in-memory **delta**, an append-only log of about 10 bytes per posting. A query sorts it into a segment (a stable radix sort) and caches that until the next change. A replaced or deleted file's old postings stay in their segment and point at a tombstone until the next merge.
     - While a large repository is indexed, the delta is **spilled** to a run file (`<hash>.trigrams.run-<pid>-<n>`) every 2M postings, so memory stays flat.
     - **Merging** k-way merges every segment and the delta into a new base, dropping tombstones, in two streaming passes (count, then write) through a temporary file and a rename. It runs at the end of the startup reconciliation when anything changed. After later edits it runs once the delta reaches 1M postings, there is more than one segment, or over a quarter of the files are tombstones; a small index (up to 4M postings) is saved 10 s after edits settle.
     - Edits not merged yet need no saving: at the next start the saved mtimes no longer match, so those files are re-indexed.
     - **File format 7.** A 48-byte header (magic, version, byte-order mark, section sizes), a JSON header with the root and the file table, then the keys, starts, document-to-file and bloom-to-file tables, the ids, the masks and the bloom documents, each section 8-byte aligned. Loading checks the header, the exact length, and that keys ascend and starts are monotonic.
2. **Planner** (`planner.ts`)
   - A regex is parsed into an AND/OR query over the literals that any match must contain. It handles alternation, groups, classes, quantifiers, escapes and inline flags.
   - Anything it cannot reason about plans to "all", which means a full ripgrep scan.
3. **Verification** (`engine.ts`, `ripgrep.ts`)
   - **In-process fast path.** Some literals are verified in-process, with no ripgrep process started. The conditions:
     - the pattern is a fixed string, or a regex with no metacharacters
     - every candidate is indexed and unchanged
     - there are at most 1,000 candidates, together at most 16 MB
     - Case-sensitive searches scan the raw bytes first and decode only files that contain the literal. Case-insensitive searches use a Unicode (`iu`) matcher, which applies the same simple case folding as ripgrep. Smart case is case-sensitive when the pattern has an uppercase letter.
     - Files ripgrep reads differently (a byte-order mark, NUL bytes, or invalid UTF-8) are handed to ripgrep, which then runs only on those.
   - **ripgrep.** Every other search passes its candidates to VS Code's bundled ripgrep (`@vscode/ripgrep-universal`), so matches, case rules and context are exactly ripgrep's.
   - A full scan is used when the plan is "all", when there are more than 20,000 candidates, or while the index is still warming up.
4. **Freshness**
   - A recursive `fs.watch` marks changed paths as dirty. Dirty files are always candidates until they are re-indexed, which happens 300 ms after the last change.
   - New git-ignored files are dropped (`git check-ignore`).
   - At startup the saved index is reconciled against `rg --files` by mtime and size.
   - Indexing and merging are serialized, so a merge never sees files half-added.
5. **Plugin** (`opencodePlugin.ts`)
   - An OpenCode promise-API plugin with `id: dragon.instant-grep`. OpenCode loads it from Dragon's config layer, once per workspace location.
6. **Semantic search** (`semantic.ts`)
   - **Files.** Source, config and docs files, from the Instant Grep file list. Excluded: hidden paths, lockfiles, minified files, `.d.ts`, files over 200 KB (32 KB for JSON and text), and files averaging over 300 characters per line.
   - **Chunks.** About 1,000 characters each. A chunk ends early only where the next line is blank or starts a new top-level construct. It is cut hard at 1,800 characters or 60 lines.
   - **Embedding.** Each chunk is embedded as `path\ncode` with Ollama's `/api/embed`, 16 at a time, in the background.
     - The work order: code before tests, then shallower paths first.
     - Where a model expects instruction prefixes, they are used for queries and documents (Qwen3, Nomic, EmbeddingGemma, mxbai).
   - **Storage.** Vectors are truncated to 512 dimensions (local embedding models are Matryoshka-trained), normalized, and stored as int8 with one scale per vector. They are saved to `<hash>.vectors` under `DRAGON_SEARCH_STORAGE`, keyed by root and model.
   - **Freshness.** The Instant Grep watcher wakes the indexer. Changed files are re-chunked; unchanged chunks keep their vectors (matched by content hash), and only new chunks are embedded.
   - **Ranking.**
     - Every chunk is scored by cosine similarity with the embedded question.
     - Up to 6 keywords are taken from the question: `backticked` text first, then identifiers, then other words. Each is searched with Instant Grep, and files are scored by keyword weight × IDF.
     - The top 150 chunks and the best chunk of each of the top 40 keyword files are fused with reciprocal rank fusion (k = 60).
     - At most 2 chunks are shown per file. Keyword hits in files not embedded yet fill any remaining places while indexing runs.
   - **Settings.** Read on every use from the JSON file named by `DRAGON_SEMANTIC_CONFIG`, `{enabled, model, origin}`, which Dragon writes, so changes apply without restarting OpenCode.

## Index admission limits

The canonical workspace root must not be the home directory, one of its ancestors, or a filesystem
root. At most 500,000 files and 512 MiB of index data are admitted. Before spill or merge, available
disk minus twice the estimated index size must remain above max(2 GiB, half the initial free space).
Budget or I/O failures close the watcher, discard this instance's spill files, preserve the last
complete base, and leave `ready=false` with a diagnostic reason. Searches continue through ripgrep;
semantic indexing sees an empty source list. No cache pruning or deletion of user files occurs.

## API/Contract

The tools are native OpenCode tools (`codemode: false`).

**`grep`** (permission action `grep`). Parameters:

| Parameter | Type | Required |
| --- | --- | --- |
| `pattern` | string | yes |
| `path` | string | no |
| `include` | glob | no |
| `exclude` | glob | no |
| `literal` | boolean | no |
| `caseSensitive` | boolean, default true | no |
| `context` | integer, 0 to 10 | no |
| `multiline` | boolean | no |
| `filesOnly` | boolean | no |
| `limit` | integer, 1 to 1000, default 100 | no |

It returns text: a header with the match and file counts, the mode (`instant index: N candidate file(s) of M` or `full scan`) and the elapsed time. Matches follow as `path` lines, each followed by `line: text` rows, with context rows written `line- text`. The metadata is `{matches, files, truncated, mode, candidates, elapsedMs}`.

**`glob`** (permission action `glob`). Parameters:

| Parameter | Type | Required |
| --- | --- | --- |
| `pattern` | glob | yes |
| `path` | string | no |
| `hidden` | boolean | no |
| `limit` | integer | no |

It returns one path per line, or `No files found`.

**`find_files`** (permission action `glob`). Parameters:

| Parameter | Type | Required |
| --- | --- | --- |
| `query` | string | yes |
| `limit` | integer, default 20 | no |

Matching is fuzzy, prefers word starts and camelCase humps, and returns the best matches first.

**`codebase_search`** (permission action `grep`). Parameters:

| Parameter | Type | Required |
| --- | --- | --- |
| `query` | string, at least 3 characters | yes |
| `path` | directory | no |
| `limit` | integer, 1 to 50, default 10 | no |

It returns a header with the result count, the mode and the elapsed time. The mode is `semantic + keyword; N chunks from M files`, or `keyword only: <keywords>`. A note follows when embeddings are unavailable or indexing is still running. Each hit is then written as `path:start-end (similarity 0.83[, keyword match])` or `path:start-end (keyword match)`, followed by up to 40 numbered lines. The metadata is `{mode, results, keywords, indexedFiles, candidateFiles, chunks, elapsedMs}`.

## Behavior & Invariants

- **Results equal ripgrep's.** For the same pattern, flags and globs, `grep` returns exactly the files that `rg --hidden` returns, honoring `.gitignore` and skipping `.git`.
- **Edits are never missed.** A file written after indexing is found as soon as the OS delivers its change event, which usually takes milliseconds. Until it is re-indexed it is searched directly as a dirty candidate.
- **Stopping early is labeled.** When the limit is reached, ripgrep is stopped and the result says `More than N`.
- **Nothing leaves the machine.** No paths or content are uploaded. Embeddings use only a loopback Ollama origin; any other origin is refused.
- **Semantic search never blocks the agent.** Without Ollama or the embedding model, `codebase_search` still answers from Instant Grep keyword matches and says why. A search waits at most 2 s for a starting index.
- **Edits are re-embedded incrementally.** Only chunks whose content changed are embedded again, and a restart reuses the saved vectors.

## Failure Modes & Remediations

| Failure | Behavior |
| --- | --- |
| ripgrep is not found | The plugin is not registered, and OpenCode's built-in grep and glob remain |
| The file watcher is unavailable | The index is marked not ready, and every search runs as a full scan (correct, slower) |
| The saved index is corrupt, truncated, from another format version, or from a machine with the other byte order | It is rebuilt from scratch |
| A process exited while spilling or saving | Its run and temporary files are deleted at the next load (their pid is no longer alive) |
| Spilling or merging fails (for example, the disk is full) | A spilled run stays in memory; a failed merge is logged and retried at the next save. Either way the index keeps answering from its segments and delta |
| The regex does not parse | The plan is "all", and ripgrep reports the error |
| A changed file is deleted before ripgrep opens it | ripgrep's error for it is suppressed and the search returns every other file's matches |
| Ollama is not running, or the embedding model is missing | `codebase_search` answers from keywords with a note naming the fix (**Dragon: Set Up Semantic Search** or `ollama pull <model>`); the indexer re-checks every 30 s |
| `/api/embed` fails mid-indexing | The indexer pauses for 30 s and resumes where it stopped; vectors already computed are kept |
| The embedding model changes | The vectors for that model are loaded if saved, otherwise the workspace is embedded again |

## Tests

`src/test/search.test.ts` covers:
- the planner, including its refusal to guess
- mask rejection of non-adjacent trigrams
- the dirty and oversized-file candidate rules
- save and load
- a randomized check that an index built with tiny spill runs, then edited, merged, reloaded, edited again and merged again, returns exactly the candidates of an index built in one go, never misses a file that contains the literal, and leaves no run files behind
- rejection of truncated, older-format (6 and the JSON-headed layout) and missing files, and removal of runs and temporary files left by dead processes
- under Bun, that the loaded index is memory-mapped with nothing held in the heap
- globs and fuzzy scoring
- **equivalence with ripgrep** on a generated repository across 21 file-list patterns and 7 line-level probes with context. The repository includes hidden, ignored, binary, 17 MB, UTF-16, UTF-8-BOM, CRLF, invalid UTF-8 and case-folding (`Æ`, Kelvin sign, long s) files, plus a 2.4 MB single-line blob.
- that an indexed literal is answered without starting ripgrep
- freshness after an edit, context lines, truncation and `find_files`
- that a dirty candidate deleted before ripgrep runs does not fail the search

`src/test/semantic.test.ts` covers:
- chunk boundaries and line numbers
- keyword extraction
- which files are embedded
- embedding-model detection
- against a mock embedder (hashed bag of words): ranking by meaning, hybrid keyword fusion, `path` scoping, incremental re-embedding after an edit, reuse of saved vectors after a restart, the keyword fallback without the model, and refusal of a remote origin

`src/test/e2e.test.ts` checks that the real OpenCode agent's `grep` call is answered by the index. It also checks that its `codebase_search` call is answered from the semantic index built inside OpenCode's process, and that the embedding model is not offered as a chat model.

`node scripts/dragon/bench-instant-grep.mts <repo>` benchmarks against plain ripgrep and fails on any mismatch. It reports whether each query was verified in-process or by ripgrep. On this repository (22.7k files, warm cache) it measured 4.6× faster overall with 0 mismatches. Indexed literal lookups took 8–16 ms, against about 210 ms for ripgrep. The gap grows with repository size and on cold caches.

## Risks

- Very broad regexes (such as `a.c` or `\d+`) have no required literal and fall back to a full scan.
- Regex verification still starts an `rg` process (about 30 ms), which puts a floor on regex latency.
- Postings take 6 bytes each on disk. On this repository (22.1k indexed files, 26.8M postings, 244 bloom documents) the saved file is 173 MB. Measured on an Apple M4 Pro Mac with 24 GB and Bun 1.4.2, loading it took 11 ms and raised RSS by 33 MB, against 114–199 ms and 516 MB for format 6. Under Node, which reads rather than maps it, it took 37–181 ms and 153–199 MB, against 476–557 ms and 421–427 MB. Indexing from scratch peaked at 400 MB RSS, against 678 MB.
- Mapped pages count toward the process's resident size while they are cached, but the OS can drop them under memory pressure without swapping.
- A merge rewrites the whole base. That is about 0.5 s for this repository and grows linearly, which is why edits wait in the delta until one is worth it.
- A future OpenCode release could rename `grep` or `glob`, or change the plugin API. The end-to-end test catches that.
- Embedding a large repository on a CPU-only machine takes a long time (the VS Code tree is on the order of 100k chunks). Keyword results cover files that are not embedded yet, and progress is saved every 30 s.
- Scoring is brute force: about 512 multiply-adds per chunk, roughly 50 ms per 100k chunks. An approximate index (HNSW) would be needed well beyond that.

## Changelog

- 0.4.1 (2026-09-30): Skip home/ancestor/root indexes, enforce file/memory/disk budgets, clean temporary runs and use exact ripgrep fallback.

- 0.4.0 (2026-09-28): disk-backed index: memory-mapped base segment under Bun, in-memory delta, spilled runs while indexing, streaming k-way merges; index format 7; new `postings`, `segments`, `deltaPostings`, `mappedBytes` and `memoryBytes` stats. A dirty candidate deleted before ripgrep runs no longer fails the search.
- 0.3.0 (2026-09-28): `codebase_search`, semantic search with local Ollama embeddings (int8 vectors, incremental and persisted), fused with Instant Grep keywords.
- 0.2.0 (2026-09-28): in-process verification for literals; Unicode case-fold table; line-aligned chunks and overlapping bloom documents for large files; a 16 MB index cap; UTF-16 files indexed; a `ripgrepRuns` stat; index format 6.
- 0.1.0 (2026-09-28): trigram index with next and position masks, regex planner, ripgrep verification, watcher freshness, persistence, `grep`/`glob`/`find_files` OpenCode plugin, and the benchmark.
