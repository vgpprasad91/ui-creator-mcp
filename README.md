# UI Creator MCP Server

> Build full SaaS apps through chat — zero code, zero deploy.

Chat with Claude to create complete web applications. Describe what you want in plain English, and it becomes a live app instantly.

## Quick Start

### 1. Install globally

```bash
npm install -g @anthropic/ui-creator-mcp
```

### 2. Get your Cloudflare credentials

You need three things from your Cloudflare account:

| Credential | Where to find it |
|-----------|-----------------|
| **Account ID** | Cloudflare Dashboard → Overview → right sidebar |
| **API Token** | Cloudflare Dashboard → My Profile → API Tokens → Create Token (needs "Workers KV Storage:Edit") |
| **KV Namespace ID** | Workers & Pages → KV → your namespace → ID column |

Don't have a KV namespace yet? Create one:
```bash
npx wrangler kv:namespace create UI_CREATOR_CONFIG
```

### 3. Add to Claude Code

Edit `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "ui-creator": {
      "command": "ui-creator-mcp",
      "env": {
        "CF_ACCOUNT_ID": "your-cloudflare-account-id",
        "CF_API_TOKEN": "your-cloudflare-api-token",
        "CF_KV_NAMESPACE_ID": "your-kv-namespace-id",
        "UI_CREATOR_APP_ID": "my-app",
        "UI_CREATOR_RUNTIME_URL": "https://ui-creator-runtime.your-domain.workers.dev"
      }
    }
  }
}
```

### 4. Start chatting

Open Claude Code and describe your app:

```
Human: Build me an invoice tracking app with a dashboard showing total
outstanding, total paid this month, and overdue count. Add a data table
of all invoices with client name, amount, due date, and status. Use a
clean purple theme.
```

Claude will:
1. Read the component manifest (99 components, 16 templates)
2. Generate JSON page configs matching your description
3. Validate the configs against the schema
4. Publish directly to Cloudflare KV
5. Your app is live at your runtime URL

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `CF_ACCOUNT_ID` | Yes | Cloudflare account ID |
| `CF_API_TOKEN` | Yes | API token with KV write permissions |
| `CF_KV_NAMESPACE_ID` | Yes | KV namespace ID for config storage |
| `UI_CREATOR_APP_ID` | No | App identifier (default: "my-app") |
| `UI_CREATOR_RUNTIME_URL` | No | URL of deployed runtime for live preview links |
| `UI_CREATOR_LOCAL_DIR` | No | Local directory for saving configs before publishing |

## Available Tools

| Tool | Description |
|------|-------------|
| `get_component_manifest` | Browse all 99 components and their props |
| `get_templates` | List 16 pre-built page templates |
| `validate_page_config` | Check a config for errors before publishing |
| `save_page_config` | Save config to local files for review |
| `publish_page_config` | Publish a page config to KV (live instantly) |
| `publish_manifest` | Publish the app route manifest |
| `publish_theme` | Publish theme (colors, fonts, radius) |
| `publish_datasources` | Publish data source definitions |
| `publish_navigation` | Publish sidebar navigation config |
| `get_app_status` | Check what's currently published |

## How It Works

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  You Chat    │────▶│  MCP Server  │────▶│ Cloudflare   │
│  in Claude   │     │  Generates   │     │ KV Store     │
│              │     │  JSON Config │     │              │
└──────────────┘     └──────────────┘     └──────┬───────┘
                                                  │
                                                  ▼
                                          ┌──────────────┐
                                          │   Runtime    │
                                          │   (Workers)  │
                                          │   Renders UI │
                                          └──────────────┘
```

1. **You describe** what you want in natural language
2. **Claude reads the manifest** — knows all available components and props
3. **Claude generates JSON configs** — pages, theme, navigation, data sources
4. **MCP server publishes to KV** — via Cloudflare REST API
5. **Runtime renders your app** — reads configs from KV, renders real UI components

The runtime is deployed once. After that, everything is config-driven. New apps, new pages, new features — all through chat.

## Prerequisites

The runtime must be deployed to Cloudflare Workers before using this MCP server. See the main repository for deployment instructions.

## License

MIT
