# OpenClaw Mirix Plugin

This package connects OpenClaw to the Mirix hosted memory backend and mirrors the core Python SDK flow:

1. `POST /agents/meta/initialize`
2. `POST /users/create_or_get`
3. `POST /memory/retrieve/conversation` before a turn
4. `POST /memory/add` after a turn
5. `GET /memory/search` for explicit search

## What it provides

- Automatic memory recall on `before_agent_start`
- Automatic memory capture on `agent_end`
- A `mirix_memory` agent tool for manual retrieval/search/add
- One dedicated detailed-search tool, configurable as `search_mirix_memory` or `search_memory`
- A `mirix.status` gateway RPC method
- `mirix-status` slash command
- `openclaw mirix status` CLI helper

## Install locally

From this directory:

```bash
openclaw plugins install -l .
openclaw mirix setup
```

Restart the OpenClaw gateway after installation.

## Publish

To make this installable for all OpenClaw users through the normal plugin install flow:

1. Publish the package to npm:

```bash
npm login
npm publish --access public
```

2. Users can then install it with:

```bash
openclaw plugins install @mirix-ai/openclaw-mirix
openclaw mirix setup
```

The `setup` command prompts for the Mirix API key and writes the plugin config into `~/.openclaw/openclaw.json`.

It also supports non-interactive flags:

```bash
openclaw mirix setup --api-key YOUR_MIRIX_API_KEY --search-tool-name search_mirix_memory
```

3. If you want it listed on the OpenClaw community plugins page, add:

- a public GitHub repo for this package
- the npm package link
- install/config docs
- a PR to the OpenClaw community plugins page with the Mirix entry

## OpenClaw config

Add this to your OpenClaw config:

```json
{
  "plugins": {
    "slots": {
      "memory": "openclaw-mirix"
    },
    "entries": {
      "openclaw-mirix": {
        "enabled": true,
        "config": {
          "apiKey": "your_mirix_api_key",
          "baseUrl": "https://api.mirix.io",
          "provider": "openai",
          "autoInitialize": true,
          "autoRecall": true,
          "autoCapture": true,
          "recallLimit": 6,
          "searchMethod": "embedding",
          "searchToolName": "search_mirix_memory",
          "userIdMode": "session",
          "userIdPrefix": "openclaw"
        }
      }
    }
  }
}
```

## User identity mapping

The plugin derives `user_id` for Mirix from OpenClaw runtime state.

- `session` mode: `openclaw:<agentId>:<sessionKey>`
- `agent` mode: `openclaw:<agentId>`
- `fixed` mode: uses `fixedUserId`

`session` is the safest default because it keeps memory scoped per OpenClaw session.

## Manual tool usage

The plugin registers exactly one detailed-search tool name.
Set `searchToolName` to:

- `search_mirix_memory` if you want the system prompt and tool name to stay Mirix-specific
- `search_memory` if you want the shorter generic tool name

Example detailed-search tool call:

```json
{
  "query": "MirixDB indexing",
  "memoryType": "episodic",
  "searchField": "summary",
  "searchMethod": "embedding",
  "limit": 5
}
```

This payload works with whichever tool name you configured.

Example `mirix_memory` tool calls:

```json
{
  "action": "search",
  "query": "MirixDB indexing",
  "memoryType": "episodic",
  "searchField": "summary",
  "searchMethod": "embedding",
  "limit": 5
}
```

```json
{
  "action": "retrieve_conversation",
  "messages": [
    {
      "role": "user",
      "content": [
        {
          "type": "text",
          "text": "What did we decide about retention policies?"
        }
      ]
    }
  ]
}
```

## Notes

- The plugin uses only the Mirix remote REST API and `X-API-Key` authentication.
- It does not depend on the Python SDK at runtime.
- `providerApiKey` and `model` are optional and are passed through to Mirix when initializing the meta agent.
