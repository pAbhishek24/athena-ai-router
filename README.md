# Athena AI Router

Athena AI Router is a standalone single-terminal controller for Claude, Codex, Gemini, and local HTTP-hosted LLMs.

It is an independent CLI, not an IDE plugin. You can launch it from any terminal, and an IDE can wrap it through its terminal or task runner if you want tighter workflow integration.

It does three things:

1. Tracks token usage per model with a limit/used breakdown.
2. Switches to another model automatically when a provider crosses the configured threshold.
3. Preserves task context across providers through a shared project ledger.

## Commands

- Install globally:

```bash
npm install -g athena-ai-router
```

- `athena-router status` prints the current usage table.
- `athena-router serve` launches a local dashboard with pie charts.
- `athena-router ask "prompt"` sends one prompt through the active model.
- `athena-router chat` starts an interactive terminal loop.
- `athena-router init` creates a starter config in `~/.athena-router/config.json`.
- If you prefer not to install globally, use `npx athena-router status` or `npm start -- status`.

## Configuration

The sample config lives at [`config/router.config.example.json`](./config/router.config.example.json).

By default the runtime state is stored in `~/.athena-router`, or in the path pointed to by `ATHENA_ROUTER_HOME`.

Local models are configured with `transport: "http"` and a `http.baseUrl`. The router currently understands:

- OpenAI-compatible chat endpoints such as `http://127.0.0.1:1234/v1/chat/completions`
- Ollama-compatible chat endpoints such as `http://127.0.0.1:11434/api/chat`

The sample config includes disabled local examples; set `enabled: true` after your local server is up.

Gemini can be configured with fallback command names, so the router will try the first binary it finds on `PATH`.

## Notes

- Claude and Codex are probed from the current `PATH`.
- Gemini is supported as a configurable adapter with command fallbacks such as `gemini` and `gemni`.
- Local hosted models are supported through the HTTP transport adapter, so you can mix remote CLI tools and local servers in the same terminal session.
- Token numbers are normalized from provider output when available and fall back to a conservative estimate when a provider does not report them.
