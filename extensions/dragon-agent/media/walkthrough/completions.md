# Tab completions

As you type, Dragon suggests the rest of the line or the next few lines in grey. Press **Tab** to accept, or keep typing to ignore it.

- Suggestions come from a small fill-in-the-middle model that runs locally through Ollama (default `qwen2.5-coder:1.5b`, about 1 GB).
- It sees the code before and after the cursor, and nothing leaves your machine.
- For better suggestions on a fast machine, set `dragon.completions.model` to a larger coder model, such as `qwen2.5-coder:7b`.

Run **Dragon: Set Up Tab Completions** to download the model.
