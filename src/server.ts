#!/usr/bin/env node
/**
 * UI Creator MCP Server
 *
 * Enables anyone with Claude Code to build full SaaS apps through chat.
 * Supports multiple apps — each gets its own isolated namespace in KV
 * and its own Cloudflare Worker deployment.
 *
 * Install: git clone https://github.com/vgpprasad91/ui-creator-mcp.git
 * Configure: Add to ~/.claude.json under mcpServers
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
  accountId?: string;
  apiToken?: string;
  kvNamespaceId?: string;
  appId: string;
  runtimeUrl?: string;
  localDir?: string;
}

// Mutable — changes when switching apps
let config: ServerConfig = {
  accountId: process.env.CF_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID,
  apiToken: process.env.CF_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN,
  kvNamespaceId: process.env.CF_KV_NAMESPACE_ID,
  appId: process.env.UI_CREATOR_APP_ID || "my-app",
  runtimeUrl: process.env.UI_CREATOR_RUNTIME_URL,
  localDir: process.env.UI_CREATOR_LOCAL_DIR || "./ui-creator-app",
};

// Track the app registry in memory (loaded from KV on first use)
let appRegistryCache: Record<string, { name: string; runtimeUrl?: string; createdAt: string }> | null = null;

// ─── Component Manifest ──────────────────────────────────────────

function loadManifest(): Record<string, unknown> {
  const bundledPath = resolve(__dirname, "../manifest/components.schema.json");
  if (existsSync(bundledPath)) {
    return JSON.parse(readFileSync(bundledPath, "utf-8"));
  }
  return { error: "Component manifest not found." };
}

// ─── KV Client ───────────────────────────────────────────────────

async function kvPut(key: string, value: string): Promise<void> {
  if (!config.accountId || !config.apiToken || !config.kvNamespaceId) {
    throw new Error("Missing Cloudflare credentials. Set CF_ACCOUNT_ID, CF_API_TOKEN, and CF_KV_NAMESPACE_ID.");
  }
  const url = `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/storage/kv/namespaces/${config.kvNamespaceId}/values/${encodeURIComponent(key)}`;
  const res = await fetch(url, {
    method: "PUT",
    headers: { Authorization: `Bearer ${config.apiToken}`, "Content-Type": "text/plain" },
    body: value,
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`KV PUT failed (${res.status}): ${body}`);
  }
}

async function kvGet(key: string): Promise<string | null> {
  if (!config.accountId || !config.apiToken || !config.kvNamespaceId) return null;
  const url = `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/storage/kv/namespaces/${config.kvNamespaceId}/values/${encodeURIComponent(key)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${config.apiToken}` } });
  if (res.status === 404 || !res.ok) return null;
  return res.text();
}

async function kvList(prefix: string): Promise<string[]> {
  if (!config.accountId || !config.apiToken || !config.kvNamespaceId) return [];
  const url = `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/storage/kv/namespaces/${config.kvNamespaceId}/keys?prefix=${encodeURIComponent(prefix)}&limit=1000`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${config.apiToken}` } });
  if (!res.ok) return [];
  const data = await res.json() as any;
  return (data.result || []).map((k: any) => k.name);
}

// ─── App Registry ────────────────────────────────────────────────

const REGISTRY_KEY = "__ui_creator_apps__";

async function loadAppRegistry(): Promise<Record<string, { name: string; runtimeUrl?: string; createdAt: string }>> {
  if (appRegistryCache) return appRegistryCache;
  const raw = await kvGet(REGISTRY_KEY);
  appRegistryCache = raw ? JSON.parse(raw) : {};
  return appRegistryCache!;
}

async function saveAppRegistry(registry: Record<string, { name: string; runtimeUrl?: string; createdAt: string }>): Promise<void> {
  appRegistryCache = registry;
  await kvPut(REGISTRY_KEY, JSON.stringify(registry));
}

// ─── Validation ──────────────────────────────────────────────────

function validatePageConfig(pageConfig: unknown): string[] {
  const errors: string[] = [];
  if (!pageConfig || typeof pageConfig !== "object") {
    errors.push("Config must be a JSON object");
    return errors;
  }
  const c = pageConfig as Record<string, unknown>;
  if (!c.page && !c.template) {
    errors.push('Config must have a "page" object or a "template" reference');
  }
  if (c.page && typeof c.page === "object") {
    const page = c.page as Record<string, unknown>;
    if (!page.title) errors.push("page.title is required");
    if (!page.body && !page.aside) errors.push("page.body or page.aside is required");
    if (Array.isArray(page.body)) {
      const manifest = loadManifest();
      const knownComponents = new Set<string>();
      if (Array.isArray((manifest as any).components)) {
        for (const comp of (manifest as any).components) {
          knownComponents.add(comp.name);
          if (comp.aliases) comp.aliases.forEach((a: string) => knownComponents.add(a));
        }
      }
      const checkNodes = (nodes: unknown[]) => {
        for (const node of nodes) {
          if (node && typeof node === "object") {
            const n = node as Record<string, unknown>;
            if (typeof n.type === "string" && !isHtmlElement(n.type) && knownComponents.size > 0 && !knownComponents.has(n.type)) {
              errors.push(`Unknown component type: "${n.type}".`);
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
function isHtmlElement(type: string): boolean { return HTML_ELEMENTS.has(type); }

// ─── Wrangler Deploy Helper ──────────────────────────────────────

function generateWranglerToml(appId: string): string {
  return `name = "${appId}"
main = "src/index.ts"
compatibility_date = "2024-12-01"
compatibility_flags = ["nodejs_compat"]

[assets]
directory = "./public"

[vars]
APP_ID = "${appId}"
APP_ENV = "production"

[[kv_namespaces]]
binding = "CF_KV_SESSIONS"
id = "${config.kvNamespaceId}"

[[kv_namespaces]]
binding = "CF_KV_CONFIG"
id = "${config.kvNamespaceId}"

[[kv_namespaces]]
binding = "CF_KV_CACHE"
id = "${config.kvNamespaceId}"

[ai]
binding = "AI"
`;
}

// ─── MCP Server ──────────────────────────────────────────────────

const server = new Server(
  { name: "ui-creator", version: "2.0.0" },
  { capabilities: { tools: {}, resources: {} } },
);

// ─── Resources ───────────────────────────────────────────────────

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [{
    uri: "ui-creator://manifest/components.schema.json",
    name: "Component Manifest",
    description: "Registry of 99 components, props, plugins, and 16 page templates.",
    mimeType: "application/json",
  }],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  if (request.params.uri === "ui-creator://manifest/components.schema.json") {
    const manifest = loadManifest();
    return { contents: [{ uri: request.params.uri, mimeType: "application/json", text: JSON.stringify(manifest, null, 2) }] };
  }
  throw new Error(`Unknown resource: ${request.params.uri}`);
});

// ─── Tools ───────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    // ── App Management ──
    {
      name: "create_app",
      description:
        "Create a new app with its own isolated namespace. Each app gets separate configs in KV and can be deployed as its own Worker. " +
        "ALWAYS call this first when the user wants to build a new app. This sets the active app context so all subsequent publish calls go to the right place.",
      inputSchema: {
        type: "object" as const,
        properties: {
          appId: { type: "string", description: 'Unique app identifier, lowercase with hyphens (e.g., "spice-garden", "invoice-tracker", "gym-scheduler")' },
          name: { type: "string", description: 'Human-readable app name (e.g., "Your Spice Garden", "Invoice Tracker")' },
          description: { type: "string", description: "Short description of the app" },
          public: { type: "boolean", description: "If true, all pages default to public (no auth). Default: true for new apps." },
        },
        required: ["appId", "name"],
      },
    },
    {
      name: "list_apps",
      description: "List all apps that have been created. Shows app IDs, names, and which configs are published.",
      inputSchema: { type: "object" as const, properties: {} },
    },
    {
      name: "switch_app",
      description: "Switch the active app context. All subsequent publish/read calls will target this app's namespace.",
      inputSchema: {
        type: "object" as const,
        properties: {
          appId: { type: "string", description: "The app ID to switch to" },
        },
        required: ["appId"],
      },
    },
    {
      name: "deploy_app",
      description:
        "Deploy the current app as a new Cloudflare Worker. Creates a Worker with the app's APP_ID, sharing the same KV namespace. " +
        "After deployment, the app is live at https://{appId}.{subdomain}.workers.dev",
      inputSchema: {
        type: "object" as const,
        properties: {
          appId: { type: "string", description: "App ID to deploy (defaults to current active app)" },
        },
      },
    },
    // ── Component Discovery ──
    {
      name: "get_component_manifest",
      description:
        "Get the component manifest. Without a category, returns a compact index. " +
        "With a category, returns full details including all props. Call this first to see what's available.",
      inputSchema: {
        type: "object" as const,
        properties: {
          category: { type: "string", description: 'Filter: "layout", "data", "forms", "charts", "ai", "magic", "advanced", "media"' },
          component: { type: "string", description: 'Single component by name (e.g., "stat_card", "BarChart")' },
        },
      },
    },
    {
      name: "get_templates",
      description: "List available page templates. Use as starting points for pages.",
      inputSchema: {
        type: "object" as const,
        properties: {
          category: { type: "string", description: "Filter by category" },
        },
      },
    },
    // ── Validation ──
    {
      name: "validate_page_config",
      description: "Validate a page config JSON before publishing.",
      inputSchema: {
        type: "object" as const,
        properties: { config: { type: "object", description: "The page config JSON" } },
        required: ["config"],
      },
    },
    // ── Publishing ──
    {
      name: "save_page_config",
      description: "Save a page config to local directory for preview.",
      inputSchema: {
        type: "object" as const,
        properties: {
          pageName: { type: "string", description: 'Page name (e.g., "dashboard")' },
          config: { type: "object", description: "The page config JSON" },
        },
        required: ["pageName", "config"],
      },
    },
    {
      name: "publish_page_config",
      description: "Publish a page config to KV. Also adds the route to the manifest automatically.",
      inputSchema: {
        type: "object" as const,
        properties: {
          pageName: { type: "string", description: 'Page name (e.g., "pages/dashboard", "pages/menu")' },
          config: { type: "object", description: "The page config JSON" },
          path: { type: "string", description: 'URL path for the route (e.g., "/dashboard"). If omitted, derived from pageName.' },
          public: { type: "boolean", description: "If true, page is accessible without auth. Default: uses app default." },
        },
        required: ["pageName", "config"],
      },
    },
    {
      name: "publish_manifest",
      description: "Publish the full app manifest to KV. Defines routes, loading strategies.",
      inputSchema: {
        type: "object" as const,
        properties: { manifest: { type: "object", description: "The manifest.json config" } },
        required: ["manifest"],
      },
    },
    {
      name: "publish_theme",
      description: "Publish a theme config. Controls colors, fonts, radius.",
      inputSchema: {
        type: "object" as const,
        properties: { theme: { type: "object", description: "Theme config with HSL colors, fonts, radius" } },
        required: ["theme"],
      },
    },
    {
      name: "publish_datasources",
      description: "Publish datasource definitions.",
      inputSchema: {
        type: "object" as const,
        properties: { datasources: { type: "object", description: "Datasources config" } },
        required: ["datasources"],
      },
    },
    {
      name: "publish_navigation",
      description: "Publish sidebar navigation config.",
      inputSchema: {
        type: "object" as const,
        properties: { navigation: { type: "object", description: "Navigation config" } },
        required: ["navigation"],
      },
    },
    {
      name: "get_app_status",
      description: "Check current app status — active app ID, published configs, runtime URL.",
      inputSchema: { type: "object" as const, properties: {} },
    },
  ],
}));

// ─── Tool Handlers ───────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name: toolName, arguments: args } = request.params;

  switch (toolName) {

    // ════════════════════════════════════════════════════
    // APP MANAGEMENT
    // ════════════════════════════════════════════════════

    case "create_app": {
      const { appId, name: appName, description: appDesc, public: isPublic } = args as any;

      // Validate app ID
      if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(appId) || appId.length < 3) {
        return { content: [{ type: "text", text: `Invalid app ID "${appId}". Must be lowercase, hyphens only, at least 3 chars (e.g., "spice-garden").` }] };
      }

      // Switch active context to new app
      config.appId = appId;

      // Create initial manifest with base routes
      const defaultPublic = isPublic !== false; // default true for new apps
      const manifest = {
        $schema: "ui-creator-manifest/v1",
        $version: 1,
        app: appId,  // MUST be a string — runtime uses manifest.app as the KV key prefix
        load: { eager: [] as any[], lazy: [] as any[], routes: [] as any[] },
        merge_strategy: {},
      };

      await kvPut(`config:${appId}:manifest`, JSON.stringify(manifest));

      // Register in app registry
      const registry = await loadAppRegistry();
      registry[appId] = {
        name: appName,
        runtimeUrl: config.runtimeUrl ? config.runtimeUrl.replace(/clientforce-portal|[^/]+(?=\.vguruprasad91)/, appId) : undefined,
        createdAt: new Date().toISOString(),
      };
      await saveAppRegistry(registry);

      const runtimeNote = config.runtimeUrl
        ? `\nRuntime: The app will be live at https://${appId}.vguruprasad91.workers.dev once deployed.`
        : "";

      return { content: [{ type: "text", text:
        `App "${appName}" created (ID: ${appId}).\n` +
        `Active app switched to: ${appId}\n` +
        `Default page visibility: ${defaultPublic ? "public" : "authenticated"}\n` +
        `KV namespace: config:${appId}:*${runtimeNote}\n\n` +
        `Next steps:\n` +
        `1. publish_theme — set colors and fonts\n` +
        `2. publish_navigation — set sidebar menu\n` +
        `3. publish_page_config — create pages (routes added automatically)\n` +
        `4. deploy_app — deploy as a Cloudflare Worker`
      }] };
    }

    case "list_apps": {
      const registry = await loadAppRegistry();
      const appIds = Object.keys(registry);

      if (appIds.length === 0) {
        // Check KV for any config keys to find apps
        const keys = await kvList("config:");
        const discovered = new Set<string>();
        for (const key of keys) {
          const match = key.match(/^config:([^:]+):/);
          if (match) discovered.add(match[1]);
        }

        if (discovered.size === 0) {
          return { content: [{ type: "text", text: "No apps found. Use create_app to create your first app." }] };
        }

        return { content: [{ type: "text", text: JSON.stringify({
          active: config.appId,
          apps: Array.from(discovered).map(id => ({
            id,
            active: id === config.appId,
            note: "Discovered from KV keys (no registry entry)",
          })),
        }, null, 2) }] };
      }

      const apps = await Promise.all(appIds.map(async (id) => {
        const info = registry[id];
        const hasManifest = (await kvGet(`config:${id}:manifest`)) !== null;
        const hasTheme = (await kvGet(`config:${id}:theme`)) !== null;
        const pageKeys = await kvList(`config:${id}:pages/`);
        return {
          id,
          name: info.name,
          active: id === config.appId,
          runtimeUrl: info.runtimeUrl,
          createdAt: info.createdAt,
          configs: { manifest: hasManifest, theme: hasTheme, pages: pageKeys.length },
        };
      }));

      return { content: [{ type: "text", text: JSON.stringify({ active: config.appId, apps }, null, 2) }] };
    }

    case "switch_app": {
      const { appId } = args as any;
      const oldId = config.appId;
      config.appId = appId;

      // Check if this app exists in KV
      const hasManifest = (await kvGet(`config:${appId}:manifest`)) !== null;
      const pageKeys = await kvList(`config:${appId}:pages/`);

      return { content: [{ type: "text", text:
        `Switched from "${oldId}" to "${appId}".\n` +
        `Manifest: ${hasManifest ? "exists" : "not found"}\n` +
        `Pages: ${pageKeys.length} published\n` +
        `All publish calls now target: config:${appId}:*`
      }] };
    }

    case "deploy_app": {
      const appId = (args as any)?.appId || config.appId;
      const toml = generateWranglerToml(appId);

      // Save wrangler.toml locally for reference
      const deployDir = resolve(config.localDir || "./ui-creator-app", appId);
      mkdirSync(deployDir, { recursive: true });
      writeFileSync(join(deployDir, "wrangler.toml"), toml);

      // For actual deployment, we need the runtime source + public assets
      // The user's runtime is already built — we just need to deploy with a different name
      const runtimeDir = resolve(__dirname, "../../runtime");
      const hasRuntime = existsSync(join(runtimeDir, "src/index.ts"));

      if (!hasRuntime) {
        return { content: [{ type: "text", text:
          `Generated wrangler.toml for "${appId}" at ${join(deployDir, "wrangler.toml")}.\n\n` +
          `To deploy manually:\n` +
          `1. Copy this wrangler.toml to the runtime directory\n` +
          `2. Run: npx wrangler deploy\n` +
          `3. The app will be live at https://${appId}.vguruprasad91.workers.dev\n\n` +
          `Note: All apps share the same KV namespace, so configs are already published. ` +
          `The Worker just needs the right APP_ID env var to read the correct configs.`
        }] };
      }

      return { content: [{ type: "text", text:
        `Ready to deploy "${appId}".\n\n` +
        `Wrangler config saved to: ${join(deployDir, "wrangler.toml")}\n` +
        `Runtime found at: ${runtimeDir}\n\n` +
        `To deploy, run in terminal:\n` +
        `  cd ${runtimeDir}\n` +
        `  cp ${join(deployDir, "wrangler.toml")} wrangler-${appId}.toml\n` +
        `  npx wrangler deploy -c wrangler-${appId}.toml\n\n` +
        `After deploy: https://${appId}.vguruprasad91.workers.dev\n` +
        `All configs are already in KV under config:${appId}:*`
      }] };
    }

    // ════════════════════════════════════════════════════
    // COMPONENT DISCOVERY
    // ════════════════════════════════════════════════════

    case "get_component_manifest": {
      const manifest = loadManifest();
      const components: any[] = (manifest as any).components || [];
      const templates: any[] = (manifest as any).templates || [];

      if ((args as any)?.component) {
        const cName = (args as any).component;
        const comp = components.find((c: any) => c.name === cName || (c.aliases?.includes(cName)));
        if (comp) return { content: [{ type: "text", text: JSON.stringify(comp, null, 2) }] };
        return { content: [{ type: "text", text: `Component "${cName}" not found.` }] };
      }

      if ((args as any)?.category) {
        const cat = (args as any).category;
        const filtered = components.filter((c: any) => c.category === cat || c.plugin === cat);
        return { content: [{ type: "text", text: JSON.stringify({ components: filtered, total: filtered.length }, null, 2) }] };
      }

      const grouped: Record<string, string[]> = {};
      for (const c of components) {
        const key = c.plugin && c.plugin !== "core" ? c.plugin : (c.category || "core");
        if (!grouped[key]) grouped[key] = [];
        grouped[key].push(c.name);
      }

      return { content: [{ type: "text", text: JSON.stringify({
        total_components: components.length,
        total_templates: templates.length,
        active_app: config.appId,
        categories: grouped,
        templates: templates.map((t: any) => ({ name: t.name, category: t.category })),
        usage: "Call with category or component for full props.",
      }, null, 2) }] };
    }

    case "get_templates": {
      const manifest = loadManifest();
      let templates = (manifest as any).templates || [];
      if ((args as any)?.category) {
        templates = templates.filter((t: any) => t.category === (args as any).category);
      }
      return { content: [{ type: "text", text: JSON.stringify({ templates, total: templates.length }, null, 2) }] };
    }

    // ════════════════════════════════════════════════════
    // VALIDATION
    // ════════════════════════════════════════════════════

    case "validate_page_config": {
      const errors = validatePageConfig((args as any).config);
      if (errors.length === 0) return { content: [{ type: "text", text: "Config is valid. Ready to publish." }] };
      return { content: [{ type: "text", text: `Validation errors:\n${errors.map(e => `  - ${e}`).join("\n")}` }] };
    }

    // ════════════════════════════════════════════════════
    // PUBLISHING
    // ════════════════════════════════════════════════════

    case "save_page_config": {
      const { pageName, config: pageConfig } = args as any;
      const dir = resolve(config.localDir || "./ui-creator-app", config.appId);
      const filePath = join(dir, "pages", `${pageName}.json`);
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, JSON.stringify(pageConfig, null, 2));
      return { content: [{ type: "text", text: `Saved to ${filePath}` }] };
    }

    case "publish_page_config": {
      const { pageName, config: pageConfig, path: routePath, public: isPublic } = args as any;
      const errors = validatePageConfig(pageConfig);
      if (errors.length > 0) {
        return { content: [{ type: "text", text: `Cannot publish:\n${errors.map(e => `  - ${e}`).join("\n")}` }] };
      }

      // Publish the page config
      const key = `config:${config.appId}:${pageName}`;
      await kvPut(key, JSON.stringify(pageConfig));

      // Auto-add route to manifest
      const inferredPath = routePath || "/" + pageName.replace(/^pages\//, "");
      const manifestKey = `config:${config.appId}:manifest`;
      const existingManifest = await kvGet(manifestKey);

      let routeAdded = false;
      if (existingManifest) {
        const manifest = JSON.parse(existingManifest);
        const routes: any[] = manifest.load?.routes ?? manifest.routes ?? [];
        const hasRoute = routes.some((r: any) => r.path === inferredPath);

        if (!hasRoute) {
          const newRoute: Record<string, unknown> = { path: inferredPath, file: pageName };
          if (isPublic !== false) newRoute.public = true; // default public
          routes.push(newRoute);
          if (manifest.load?.routes) manifest.load.routes = routes;
          else manifest.routes = routes;
          await kvPut(manifestKey, JSON.stringify(manifest));
          routeAdded = true;
        }
      }

      const runtimeUrl = config.runtimeUrl
        ? config.runtimeUrl.replace(/clientforce-portal|[^/]+(?=\.vguruprasad91)/, config.appId)
        : null;
      const liveUrl = runtimeUrl ? `${runtimeUrl}${inferredPath}` : inferredPath;

      return { content: [{ type: "text", text:
        `Published ${pageName} to KV (app: ${config.appId}).\n` +
        (routeAdded ? `Route added: ${inferredPath} → ${pageName} (public)\n` : `Route ${inferredPath} already exists.\n`) +
        `Live at: ${liveUrl}\n` +
        `Note: KV propagation ~60 seconds.`
      }] };
    }

    case "publish_manifest": {
      await kvPut(`config:${config.appId}:manifest`, JSON.stringify((args as any).manifest));
      return { content: [{ type: "text", text: `Published manifest for app "${config.appId}".` }] };
    }

    case "publish_theme": {
      await kvPut(`config:${config.appId}:theme`, JSON.stringify((args as any).theme));
      return { content: [{ type: "text", text: `Published theme for app "${config.appId}".` }] };
    }

    case "publish_datasources": {
      await kvPut(`config:${config.appId}:datasources`, JSON.stringify((args as any).datasources));
      return { content: [{ type: "text", text: `Published datasources for app "${config.appId}".` }] };
    }

    case "publish_navigation": {
      await kvPut(`config:${config.appId}:navigation`, JSON.stringify((args as any).navigation));
      return { content: [{ type: "text", text: `Published navigation for app "${config.appId}".` }] };
    }

    // ════════════════════════════════════════════════════
    // STATUS
    // ════════════════════════════════════════════════════

    case "get_app_status": {
      const runtimeUrl = config.runtimeUrl
        ? config.runtimeUrl.replace(/clientforce-portal|[^/]+(?=\.vguruprasad91)/, config.appId)
        : "Not deployed";

      const status: Record<string, unknown> = {
        activeApp: config.appId,
        runtimeUrl,
        cloudflareConnected: !!(config.accountId && config.apiToken && config.kvNamespaceId),
      };

      if (config.accountId && config.apiToken && config.kvNamespaceId) {
        const checks = ["manifest", "theme", "navigation", "datasources"];
        const results: Record<string, boolean> = {};
        for (const check of checks) {
          results[check] = (await kvGet(`config:${config.appId}:${check}`)) !== null;
        }
        const pageKeys = await kvList(`config:${config.appId}:pages/`);
        results[`pages (${pageKeys.length})`] = pageKeys.length > 0;
        status.publishedConfigs = results;

        // Show routes if manifest exists
        const manifestRaw = await kvGet(`config:${config.appId}:manifest`);
        if (manifestRaw) {
          const manifest = JSON.parse(manifestRaw);
          const routes = manifest.load?.routes ?? manifest.routes ?? [];
          status.routes = routes.map((r: any) => `${r.path} → ${r.file || r.redirect || "?"}${r.public ? " (public)" : ""}`);
        }
      }

      return { content: [{ type: "text", text: JSON.stringify(status, null, 2) }] };
    }

    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
});

// ─── Start ───────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`UI Creator MCP server v2.0 running (active app: ${config.appId})`);
}

main().catch(console.error);
