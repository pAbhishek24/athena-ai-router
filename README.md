# AI Model Router

AI Model Router is a standalone single-terminal controller for Claude, Codex, Gemini, and local HTTP-hosted LLMs.

It is an independent CLI, not an IDE plugin. You can launch it from any terminal, and an IDE can wrap it through its terminal or task runner if you want tighter workflow integration.

It does three things:

1. Tracks token usage per model with a limit/used breakdown.
2. Switches to another model automatically when a provider crosses the configured threshold.
3. Preserves task context across providers through a shared project ledger.

## Commands

- Install globally:

```bash
npm install -g ai-model-router
```

- `model-router status` prints the current usage table.
- `model-router serve` launches a local dashboard with pie charts.
- `model-router panel` launches the same dashboard and opens it in your browser.
- `model-router ask "prompt"` sends one prompt through the active model.
- `model-router chat` starts an interactive prompt for the active model.
- `model-router task "prompt"` runs an agent-style workspace task that can read, write, and execute local commands.
- `model-router init` creates a starter config in `~/.ai-model-router/config.json`.
- If you prefer not to install globally, use `npx model-router status` or `npm start -- status`.

## Configuration

The sample config lives at [`config/router.config.example.json`](./config/router.config.example.json).

By default the runtime state is stored in `~/.ai-model-router`, or in the path pointed to by `AI_MODEL_ROUTER_HOME`.

For migration, the legacy state environment variables are still recognized.

Local models are configured with `transport: "http"` and a `http.baseUrl`. The router currently understands:

- OpenAI-compatible chat endpoints such as `http://127.0.0.1:1234/v1/chat/completions`
- Ollama-compatible chat endpoints such as `http://127.0.0.1:11434/api/chat`

The sample config includes disabled local examples; set `enabled: true` after your local server is up.

Gemini can be configured with fallback command names, so the router will try the first binary it finds on `PATH`.

Provider auth/status can be probed explicitly with an optional `status` block per provider. Use it when the CLI or server can return account metadata, login state, or quota data. If you do not configure a status probe, the router still tracks turn usage and command availability, but it cannot invent account details.

Example shape:

```json
{
  "status": {
    "command": "your-cli",
    "args": ["status", "--json"],
    "accountPath": "account.email",
    "authPath": "authState",
    "usagePath": "usage"
  }
}
```

## Notes

- Claude and Codex are probed from the current `PATH`.
- Gemini is supported as a configurable adapter with command fallbacks such as `gemini` and `gemni`.
- Local hosted models are supported through the HTTP transport adapter, so you can mix remote CLI tools and local servers in the same terminal session.
- Token numbers are normalized from provider output when available and fall back to a conservative estimate when a provider does not report them.
- `model-router task` is the closest mode to a CLI IDE. It asks the model for a JSON action plan and executes workspace tools locally, so file edits and shell commands happen from the router instead of only being described in text.
- `model-router serve --open` or `model-router panel` gives you the live pie-chart view in a browser window. Native system notification centers do not support rich pie charts, so the browser dashboard is the practical panel.

## Release

GitHub Actions runs tests and package validation on every push and pull request to `main`.

This project uses npm trusted publishing, so the GitHub Actions release job does not need an `NPM_TOKEN`.

To enable trusted publishing in npm:

1. Open the package page on npmjs.com for `ai-model-router`.
2. Go to `Settings` -> `Trusted publishing`.
3. Add a trusted publisher for GitHub Actions with these values:
   - Organization or user: `pAbhishek24`
   - Repository: `athena-ai-router`
   - Workflow filename: `publish.yml`
   - Allowed action: `npm publish`
4. Save the trusted publisher configuration.

Then publish a release from GitHub:

1. Bump the version with `npm version patch`, `npm version minor`, or `npm version major`.
2. Create the version tag with `git tag v1.0.1`.
3. Push the commit and tag with `git push --follow-tags`.
4. GitHub Actions will rerun the test suite, verify the package tarball, and publish to npm using OIDC.

Trusted publishing automatically generates provenance for public packages published from GitHub Actions, so no `--provenance` flag or registry token is needed.

If the package settings page is not available yet because the package has never been published, do one bootstrap publish first, then add the trusted publisher. For that bootstrap publish, npm may require a granular access token with package `Read and write` access and `Bypass two-factor authentication` enabled. npm's CLI cannot create that granular token; it must be created on npmjs.com in `Access Tokens`.
