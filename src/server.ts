#!/usr/bin/env node
/**
 * UI Creator MCP Server
 *
 * Enables anyone with Claude Code to build full SaaS apps through chat.
 * Exposes tools for:
 *   - Reading the component manifest (what's available)
 *   - Generating page configs from natural language
 *   - Validating configs against the schema
 *   - Publishing configs to Cloudflare KV (making apps live)
 *   - Managing templates
 *
 * Install: npx @anthropic/ui-creator-mcp
 * Configure: Add to ~/.claude/settings.json under mcpServers
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "fs";
import { resolve, join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Config ──────────────────────────────────────────────────────

interface ServerConfig {
  /** Cloudflare account ID */
  accountId?: string;
  /** Cloudflare API token with KV write permissions */
  apiToken?: string;
  /** KV namespace ID for the config store */
  kvNamespaceId?: string;
  /** App ID (e.g., "my-app") */
  appId?: string;
  /** URL of the deployed runtime (e.g., "https://my-app.workers.dev") */
  runtimeUrl?: string;
  /** Local directory to write configs (for preview before publish) */
  localDir?: string;
}

function loadConfig(): ServerConfig {
  return {
    accountId: process.env.CF_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID,
    apiToken: process.env.CF_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN,
    kvNamespaceId: process.env.CF_KV_NAMESPACE_ID,
    appId: process.env.UI_CREATOR_APP_ID || "my-app",
    runtimeUrl: process.env.UI_CREATOR_RUNTIME_URL,
    localDir: process.env.UI_CREATOR_LOCAL_DIR || "./ui-creator-app",
  };
}

// ─── Component Manifest ──────────────────────────────────────────

function loadManifest(): Record<string, unknown> {
  // Try bundled manifest first, then check runtime URL
  const bundledPath = resolve(__dirname, "../manifest/components.schema.json");
  if (existsSync(bundledPath)) {
    return JSON.parse(readFileSync(bundledPath, "utf-8"));
  }
  // Fallback: return a minimal manifest with instructions
  return {
    error: "Component manifest not found. Place components.schema.json in manifest/ directory.",
  };
}

// ─── KV Client ───────────────────────────────────────────────────

async function kvPut(config: ServerConfig, key: string, value: string): Promise<void> {
  if (!config.accountId || !config.apiToken || !config.kvNamespaceId) {
    throw new Error(
      "Missing Cloudflare credentials. Set CF_ACCOUNT_ID, CF_API_TOKEN, and CF_KV_NAMESPACE_ID environment variables.",
    );
  }
  const url = `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/storage/kv/namespaces/${config.kvNamespaceId}/values/${encodeURIComponent(key)}`;
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${config.apiToken}`,
      "Content-Type": "text/plain",
    },
    body: value,
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`KV PUT failed (${res.status}): ${body}`);
  }
}

async function kvGet(config: ServerConfig, key: string): Promise<string | null> {
  if (!config.accountId || !config.apiToken || !config.kvNamespaceId) return null;
  const url = `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/storage/kv/namespaces/${config.kvNamespaceId}/values/${encodeURIComponent(key)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${config.apiToken}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) return null;
  return res.text();
}

// ─── Validation ──────────────────────────────────────────────────

function validatePageConfig(config: unknown): string[] {
  const errors: string[] = [];
  if (!config || typeof config !== "object") {
    errors.push("Config must be a JSON object");
    return errors;
  }
  const c = config as Record<string, unknown>;

  if (!c.page && !c.template) {
    errors.push('Config must have a "page" object or a "template" reference');
  }

  if (c.page && typeof c.page === "object") {
    const page = c.page as Record<string, unknown>;
    if (!page.title) errors.push("page.title is required");
    if (!page.body && !page.aside) errors.push("page.body or page.aside is required");

    // Validate component types against manifest
    if (Array.isArray(page.body)) {
      const manifest = loadManifest();
      const knownComponents = new Set<string>();
      if (Array.isArray((manifest as any).components)) {
        for (const comp of (manifest as any).components) {
          knownComponents.add(comp.name);
          if (comp.aliases) comp.aliases.forEach((a: string) => knownComponents.add(a));
        }
      }
      // Walk tree and check types
      const checkNodes = (nodes: unknown[]) => {
        for (const node of nodes) {
          if (node && typeof node === "object") {
            const n = node as Record<string, unknown>;
            if (typeof n.type === "string" && !isHtmlElement(n.type) && knownComponents.size > 0 && !knownComponents.has(n.type)) {
              errors.push(`Unknown component type: "${n.type}". Check the component manifest for available types.`);
            }
            if (Array.isArray(n.children)) checkNodes(n.children);
            if (Array.isArray(n.body)) checkNodes(n.body);
          }
        }
      };
      checkNodes(page.body as unknown[]);
    }
  }

  return errors;
}

const HTML_ELEMENTS = new Set([
  "div", "span", "p", "h1", "h2", "h3", "h4", "h5", "h6", "a", "ul", "ol", "li",
  "img", "pre", "code", "section", "article", "header", "footer", "nav", "main",
  "table", "thead", "tbody", "tr", "th", "td", "form", "input", "button", "label",
  "select", "textarea", "blockquote", "hr", "br",
]);

function isHtmlElement(type: string): boolean {
  return HTML_ELEMENTS.has(type);
}

// ─── MCP Server ──────────────────────────────────────────────────

const server = new Server(
  {
    name: "ui-creator",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
      resources: {},
    },
  },
);

const config = loadConfig();

// ─── Resources ───────────────────────────────────────────────────

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    {
      uri: "ui-creator://manifest/components.schema.json",
      name: "Component Manifest",
      description:
        "Complete registry of all 99 components, their props, plugins, and 16 page templates. Read this FIRST before generating any config.",
      mimeType: "application/json",
    },
  ],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  if (request.params.uri === "ui-creator://manifest/components.schema.json") {
    const manifest = loadManifest();
    return {
      contents: [
        {
          uri: request.params.uri,
          mimeType: "application/json",
          text: JSON.stringify(manifest, null, 2),
        },
      ],
    };
  }
  throw new Error(`Unknown resource: ${request.params.uri}`);
});

// ─── Tools ───────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "get_component_manifest",
      description:
        "Get the full component manifest — all available components, their props, plugin assignments, and page templates. " +
        "ALWAYS call this first before generating any page config so you know what components exist and what props they accept.",
      inputSchema: {
        type: "object" as const,
        properties: {
          category: {
            type: "string",
            description: 'Optional: filter by category (e.g., "layout", "data", "charts", "ai", "magic", "media")',
          },
        },
      },
    },
    {
      name: "get_templates",
      description:
        "List all 16 available page templates. Templates are pre-built page configs you can use as-is or customize with overrides. " +
        "Categories: dashboard, auth, settings, productivity, marketing, onboarding, ai, developer, crm.",
      inputSchema: {
        type: "object" as const,
        properties: {
          category: {
            type: "string",
            description: "Optional: filter templates by category",
          },
        },
      },
    },
    {
      name: "validate_page_config",
      description:
        "Validate a page config JSON before publishing. Checks structure, required fields, and verifies component types exist in the manifest.",
      inputSchema: {
        type: "object" as const,
        properties: {
          config: {
            type: "object",
            description: "The page config JSON to validate",
          },
        },
        required: ["config"],
      },
    },
    {
      name: "save_page_config",
      description:
        "Save a page config to the local app directory. Use this to preview configs before publishing. " +
        "Creates the JSON file at {localDir}/pages/{pageName}.json",
      inputSchema: {
        type: "object" as const,
        properties: {
          pageName: {
            type: "string",
            description: 'Page name/path (e.g., "dashboard", "settings", "clients")',
          },
          config: {
            type: "object",
            description: "The full page config JSON",
          },
        },
        required: ["pageName", "config"],
      },
    },
    {
      name: "publish_page_config",
      description:
        "Publish a page config directly to Cloudflare KV, making it live immediately. " +
        "Requires CF_ACCOUNT_ID, CF_API_TOKEN, and CF_KV_NAMESPACE_ID to be set. " +
        "The page will be accessible at the runtime URL immediately after publishing.",
      inputSchema: {
        type: "object" as const,
        properties: {
          pageName: {
            type: "string",
            description: 'Page name/path (e.g., "pages/dashboard", "pages/settings")',
          },
          config: {
            type: "object",
            description: "The full page config JSON",
          },
        },
        required: ["pageName", "config"],
      },
    },
    {
      name: "publish_manifest",
      description:
        "Publish the app manifest.json to KV. The manifest defines routes, eager/lazy loading, and merge strategies. " +
        "You need this for the runtime to know which pages exist and how to route to them.",
      inputSchema: {
        type: "object" as const,
        properties: {
          manifest: {
            type: "object",
            description: "The manifest.json config",
          },
        },
        required: ["manifest"],
      },
    },
    {
      name: "publish_theme",
      description:
        "Publish a theme config to KV. Controls colors, fonts, radius, and dark mode for the entire app.",
      inputSchema: {
        type: "object" as const,
        properties: {
          theme: {
            type: "object",
            description: "The theme.json config with colors (HSL values), fonts, and radius",
          },
        },
        required: ["theme"],
      },
    },
    {
      name: "publish_datasources",
      description:
        "Publish datasource definitions to KV. Datasources define how pages fetch data from D1, KV, HTTP APIs, or tRPC.",
      inputSchema: {
        type: "object" as const,
        properties: {
          datasources: {
            type: "object",
            description: "The datasources.json config",
          },
        },
        required: ["datasources"],
      },
    },
    {
      name: "publish_navigation",
      description:
        "Publish navigation config to KV. Defines the sidebar menu items, their icons, paths, and grouping.",
      inputSchema: {
        type: "object" as const,
        properties: {
          navigation: {
            type: "object",
            description: "The navigation.json config",
          },
        },
        required: ["navigation"],
      },
    },
    {
      name: "add_page_route",
      description:
        "Add a new route to the app manifest. This fetches the current manifest from KV, adds the route, and re-publishes. " +
        "Use this after publish_page_config to make the page accessible at a URL path.",
      inputSchema: {
        type: "object" as const,
        properties: {
          path: {
            type: "string",
            description: 'URL path (e.g., "/about", "/invoices", "/clients/:id")',
          },
          file: {
            type: "string",
            description: 'Config file reference (e.g., "pages/about", "pages/invoices")',
          },
          public: {
            type: "boolean",
            description: "If true, the page is accessible without authentication (default: false)",
          },
          guard: {
            type: "string",
            description: 'Optional guard name (e.g., "owner", "admin", "team")',
          },
        },
        required: ["path", "file"],
      },
    },
    {
      name: "get_app_status",
      description:
        "Check the current status of the app — what configs are published, what pages exist, and the runtime URL.",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case "get_component_manifest": {
      const manifest = loadManifest();
      if ((args as any)?.category && Array.isArray((manifest as any).components)) {
        const filtered = (manifest as any).components.filter(
          (c: any) => c.category === (args as any).category || c.plugin === (args as any).category,
        );
        return { content: [{ type: "text", text: JSON.stringify({ components: filtered, total: filtered.length }, null, 2) }] };
      }
      return { content: [{ type: "text", text: JSON.stringify(manifest, null, 2) }] };
    }

    case "get_templates": {
      const manifest = loadManifest();
      let templates = (manifest as any).templates || [];
      if ((args as any)?.category) {
        templates = templates.filter((t: any) => t.category === (args as any).category);
      }
      return { content: [{ type: "text", text: JSON.stringify({ templates, total: templates.length }, null, 2) }] };
    }

    case "validate_page_config": {
      const errors = validatePageConfig((args as any).config);
      if (errors.length === 0) {
        return { content: [{ type: "text", text: "Config is valid. Ready to publish." }] };
      }
      return { content: [{ type: "text", text: `Validation errors:\n${errors.map((e) => `  - ${e}`).join("\n")}` }] };
    }

    case "save_page_config": {
      const { pageName, config: pageConfig } = args as any;
      const dir = resolve(config.localDir || "./ui-creator-app");
      const filePath = join(dir, "pages", `${pageName}.json`);
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, JSON.stringify(pageConfig, null, 2));
      return { content: [{ type: "text", text: `Saved to ${filePath}` }] };
    }

    case "publish_page_config": {
      const { pageName, config: pageConfig } = args as any;
      const errors = validatePageConfig(pageConfig);
      if (errors.length > 0) {
        return { content: [{ type: "text", text: `Cannot publish — validation errors:\n${errors.map((e) => `  - ${e}`).join("\n")}` }] };
      }
      const key = `config:${config.appId}:${pageName}`;
      await kvPut(config, key, JSON.stringify(pageConfig));
      const url = config.runtimeUrl ? `${config.runtimeUrl}/${pageName.replace("pages/", "")}` : pageName;
      return { content: [{ type: "text", text: `Published ${pageName} to KV (key: ${key}). Live at: ${url}` }] };
    }

    case "publish_manifest": {
      const key = `config:${config.appId}:manifest`;
      await kvPut(config, key, JSON.stringify((args as any).manifest));
      return { content: [{ type: "text", text: `Published manifest to KV (key: ${key}).` }] };
    }

    case "publish_theme": {
      const key = `config:${config.appId}:theme`;
      await kvPut(config, key, JSON.stringify((args as any).theme));
      return { content: [{ type: "text", text: `Published theme to KV. Colors and fonts will update on next page load.` }] };
    }

    case "publish_datasources": {
      const key = `config:${config.appId}:datasources`;
      await kvPut(config, key, JSON.stringify((args as any).datasources));
      return { content: [{ type: "text", text: `Published datasources config to KV.` }] };
    }

    case "publish_navigation": {
      const key = `config:${config.appId}:navigation`;
      await kvPut(config, key, JSON.stringify((args as any).navigation));
      return { content: [{ type: "text", text: `Published navigation config to KV.` }] };
    }

    case "add_page_route": {
      const { path: routePath, file: routeFile, public: isPublic, guard } = args as any;
      const manifestKey = `config:${config.appId}:manifest`;
      const existing = await kvGet(config, manifestKey);
      if (!existing) {
        return { content: [{ type: "text", text: "No manifest found in KV. Use publish_manifest first to create the initial manifest." }] };
      }
      const manifest = JSON.parse(existing);
      const routes: any[] = manifest.load?.routes ?? manifest.routes ?? [];

      // Remove existing route with same path if present
      const filtered = routes.filter((r: any) => r.path !== routePath);
      const newRoute: Record<string, unknown> = { path: routePath, file: routeFile };
      if (isPublic) newRoute.public = true;
      if (guard) newRoute.guard = guard;
      filtered.push(newRoute);

      if (manifest.load?.routes) {
        manifest.load.routes = filtered;
      } else {
        manifest.routes = filtered;
      }

      await kvPut(config, manifestKey, JSON.stringify(manifest));
      const url = config.runtimeUrl ? `${config.runtimeUrl}${routePath}` : routePath;
      return { content: [{ type: "text", text: `Route added: ${routePath} → ${routeFile}${isPublic ? " (public)" : ""}. Live at: ${url}\nNote: KV propagation may take up to 60 seconds.` }] };
    }

    case "get_app_status": {
      const status: Record<string, unknown> = {
        appId: config.appId,
        runtimeUrl: config.runtimeUrl || "Not configured",
        cloudflareConnected: !!(config.accountId && config.apiToken && config.kvNamespaceId),
        localDir: config.localDir,
      };

      // Check which configs exist in KV
      if (config.accountId && config.apiToken && config.kvNamespaceId) {
        const checks = ["manifest", "theme", "navigation", "datasources", "pages/dashboard"];
        const results: Record<string, boolean> = {};
        for (const check of checks) {
          const val = await kvGet(config, `config:${config.appId}:${check}`);
          results[check] = val !== null;
        }
        status.publishedConfigs = results;
      }

      return { content: [{ type: "text", text: JSON.stringify(status, null, 2) }] };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

// ─── Start ───────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("UI Creator MCP server running on stdio");
}

main().catch(console.error);
