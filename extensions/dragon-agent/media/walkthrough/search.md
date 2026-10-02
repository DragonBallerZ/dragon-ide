# Search the codebase instantly, and by meaning

**Instant Grep** answers the agent's `grep` and `glob` from a local trigram index. Results are exactly ripgrep's, and they come back in milliseconds instead of a rescan of the tree. `find_files` adds fuzzy file lookup.

**Semantic search** gives the agent `codebase_search`, which finds code by meaning, for example "where are failed uploads retried?".

- It uses a small embedding model that runs locally through Ollama.
- It blends the model's ranking with keyword matches.
- The workspace is embedded on your machine in the background, and nothing is uploaded.

Run **Dragon: Set Up Semantic Search** to download the model (about 640 MB).
