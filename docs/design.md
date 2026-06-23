# AI Model Router Design

## Goal

Provide one terminal entrypoint that can work with multiple CLI model providers while keeping track of per-model token usage and automatically failing over when a provider gets too close to its configured budget.

This is a standalone CLI router with a native menubar app, a browser/debug dashboard, and a small background daemon, not an IDE plugin.

## Requirements

### 1. Token visibility

Each provider needs a `limit`, `used`, and `remaining` value.

The primary visualization is the native menubar app backed by an embedded WebKit view. The router still serves the same dashboard HTML over HTTP for debugging and manual browser access, and the terminal status command prints a compact text summary for quick checks. If the daemon is not reachable, the status command falls back to the locally persisted project ledger instead of failing.

The router now keeps the active project state in a daemon-backed control plane so usage and auth snapshots continue updating after the terminal that started the session exits.

For Codex specifically, the router reconciles usage from Codex's local SQLite state in `~/.codex`. The router ledger is scoped to the current repo cwd, and the dashboard shows the account-wide Codex total separately as observed usage.

Providers can optionally expose an explicit `status` probe so the router can cache:

- authentication state
- account identity or workspace label
- provider-reported usage or quota snapshots

If a provider does not expose a probe, the router falls back to command availability plus turn-by-turn usage tracking.

### 2. Automatic switching

Before dispatching a new turn, the router checks the active provider's local ledger.

If the current provider is at or beyond the threshold, or if the projected prompt would push it beyond the threshold, the router selects the healthiest alternative provider with the most headroom.

The router does not interrupt an in-flight CLI response. It switches at the next turn boundary.

### 3. Context preservation

The router keeps a shared project ledger:

- recent user and assistant turns
- a rolling summary of older turns
- provider session handles when a CLI exposes them
- handoff notes explaining why a switch happened

When the router moves from one provider to another, it flattens the shared ledger into a prompt envelope so the new provider receives the same task context.

### 4. Workspace actions

The router also supports an agent-style task mode.

In task mode, the model is asked to return a strict JSON action plan. The router executes the plan against the current workspace using local tools such as:

- read file
- write file
- append file
- replace text
- create directories
- list files
- run shell commands

This makes the CLI behave more like a coding IDE than a plain chat relay.

## Runtime layout

State lives outside the repo by default:

- `~/.ai-model-router/config.json`
- `~/.ai-model-router/projects/<project-key>.json`

The runtime still accepts legacy state environment variables for migration.

The project key is a stable hash of the current working directory, which lets the same terminal controller keep independent histories for multiple projects.

The daemon state is stored separately from project state:

- `~/.ai-model-router/daemon.json`
- `~/.ai-model-router/shims/manifest.json`
- `~/.ai-model-router/shims/env.sh`

## Provider model

Each provider config contains:

- `id`
- `label`
- `transport` (`command` or `http`)
- `command` or `commandCandidates`
- optional `shimName` for direct wrapper installation
- `args`
- `budgetTokens`
- optional `model`
- optional `http` settings for local or remote servers
- optional `status` settings for provider auth and usage probes

Provider adapters are responsible for:

- building the CLI command
- parsing provider usage output
- extracting a session reference, if available

HTTP providers are responsible for:

- building the request body for the target server
- parsing the JSON response from OpenAI-compatible or Ollama-compatible endpoints
- handling local server availability through a `baseUrl`

## Usage normalization

Usage reporting is normalized into a conservative local total:

- Claude: input, output, and cache-creation tokens are tracked separately
- Codex: prompt, output, reasoning, and cached input are tracked separately
- Gemini: a provider report is used when available, otherwise the router estimates from text length
- Local HTTP models: the router reads provider usage if the server reports it, otherwise it estimates from the final text

The dashboard shows the router ledger as the switching budget and also surfaces observed provider/account usage separately. That keeps the per-project routing budget stable while still showing direct CLI activity from a sibling terminal or a provider status probe.

## Commands

- `init` writes the starter config
- `status` prints the local ledger
- `daemon run` starts the background server in the foreground
- `daemon start` starts the background server detached from the shell
- `daemon status` prints daemon metadata
- `daemon stop` stops the background server
- `serve` ensures the daemon is running and prints the graphical dashboard URL
- `app` launches the native menubar status app and attempts to start or reconnect the daemon
- `panel` is an alias for `app`
- `ask` sends a single prompt
- `chat` opens an interactive agent loop and prints the provider/account roster before the first prompt
- `task` opens the agent-style workspace executor
- `switch` forces the active provider for the next turn
- `shims install` installs optional command wrappers for direct provider CLIs
- `shims status` prints the shim manifest

## Local model integration

The router can mix CLI providers with local servers in the same project ledger.

Recommended patterns:

- `transport: "http"` plus `http.mode: "openai-chat"` for OpenAI-compatible local servers such as LM Studio, LocalAI, or vLLM
- `transport: "http"` plus `http.mode: "ollama-chat"` for Ollama-compatible servers
- `commandCandidates` for CLI tools with more than one possible binary name, such as `gemini` and a fallback alias

## Shim mode

Some provider usage happens outside the router, especially when users run Claude/Codex/Gemini directly in other terminals.

The shim layer addresses that by generating wrappers in `~/.ai-model-router/shims`. Each wrapper:

- calls the real provider binary
- parses its output for session and usage metadata
- posts the usage snapshot back to the daemon

Users then prepend the shims directory to `PATH` by sourcing `~/.ai-model-router/shims/env.sh`.

## Verification

Tests cover:

- provider parsing
- provider selection and failover
- prompt envelope construction
- command fallback resolution
- HTTP provider execution
- daemon client state refresh
- shim installation and usage reporting
- dashboard rendering and API responses
