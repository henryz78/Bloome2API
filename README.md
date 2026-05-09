# Bloome LLM Gateway

A portable OpenAI-compatible API gateway that proxies **Bloome's built-in LLM provider** to standard clients.

## What It Does

Turns `https://stream.bloome.im/api/llm/proxy/reson` into a clean, standard-compatible endpoint:

| Route | Description |
|-------|-------------|
| `GET /v1/models` | List available models |
| `POST /v1/chat/completions` | OpenAI-format chat completions (stream + non-stream) |

## Supported Models

| Model | Notes |
|-------|-------|
| `kimi-k2.6` | Works via OpenAI format |
| `kimi-k2.5` | Aliases to kimi-k2.6 |
| `gpt-5.4` | `max_tokens` auto-rewritten to `max_completion_tokens` |
| `claude-opus-4-7` | Automatically translated to/from Anthropic Messages format |

## Key Features

- **Claude auto-translation**: Send OpenAI-format requests with `claude-opus-4-7`, the gateway translates to Anthropic Messages and back (streaming supported)
- **Non-standard field cleanup**: Strips `system_fingerprint`, drops trailing `choices: []` SSE chunks, hoists nested `usage` to top-level
- **`reasoning_content` preserved**: Thinking chains kept in their own field, never mapped to `content`

## Quick Start

```bash
# Install
bun install

# Set your Bloome agent key
export BLOOME_API_KEY="your-key-here"

# Run (defaults to port 3000)
bun start
```

## Client Configuration

| Field | Value |
|-------|-------|
| Base URL | `http://localhost:3000` |
| API Key | Any value (or leave empty) |
| Model | `kimi-k2.6` / `kimi-k2.5` / `gpt-5.4` / `claude-opus-4-7` |

## Model Availability

The Bloome LLM proxy only recognizes models that have been **selected at least once** in the Bloome runtime config. If a model returns `Model alias not found`, go to Bloome settings and switch to that model temporarily — the alias will then be available through the proxy.

## Deployment

This is a standard Hono app. Deploy anywhere that runs Bun/Node:

- **Cloudflare Workers**: wrap with `hono/cloudflare-workers`
- **EdgeSpark**: add `bloome-bridge.ts` (see `prompts/llm-gateway-deploy.md`)
- **Vercel / Railway / Fly.io**: standard Node.js deployment
