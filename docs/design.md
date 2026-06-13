# AI Model Router Design

## Goal

Provide one terminal entrypoint that can work with multiple CLI model providers while keeping track of per-model token usage and automatically failing over when a provider gets too close to its configured budget.

This is a standalone CLI router with a browser dashboard, not an IDE plugin.

## Requirements

### 1. Token visibility

Each provider needs a `limit`, `used`, and `remaining` value.

The primary visualization is a browser dashboard served from the router process, rendered with SVG/CSS donut charts. The terminal status command also prints a compact text summary for quick checks.

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

## Runtime layout

State lives outside the repo by default:

- `~/.ai-model-router/config.json`
- `~/.ai-model-router/projects/<project-key>.json`

The runtime still accepts legacy state environment variables for migration.

The project key is a stable hash of the current working directory, which lets the same terminal controller keep independent histories for multiple projects.

## Provider model

Each provider config contains:

- `id`
- `label`
- `transport` (`command` or `http`)
- `command` or `commandCandidates`
- `args`
- `budgetTokens`
- optional `model`
- optional `http` settings for local or remote servers

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

The dashboard shows the normalized local total so switching works consistently across providers.

## Commands

- `init` writes the starter config
- `status` prints the local ledger
- `serve` starts the graphical dashboard
- `ask` sends a single prompt
- `chat` opens an interactive loop
- `switch` forces the active provider for the next turn

## Local model integration

The router can mix CLI providers with local servers in the same project ledger.

Recommended patterns:

- `transport: "http"` plus `http.mode: "openai-chat"` for OpenAI-compatible local servers such as LM Studio, LocalAI, or vLLM
- `transport: "http"` plus `http.mode: "ollama-chat"` for Ollama-compatible servers
- `commandCandidates` for CLI tools with more than one possible binary name, such as `gemini` and a fallback alias

## Verification

Tests cover:

- provider parsing
- provider selection and failover
- prompt envelope construction
- command fallback resolution
- HTTP provider execution
- dashboard rendering and API responses
