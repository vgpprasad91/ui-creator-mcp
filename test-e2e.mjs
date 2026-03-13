#!/usr/bin/env node
/**
 * End-to-end test for the UI Creator MCP server.
 * SDK v1.27.1 uses newline-delimited JSON (not Content-Length framing).
 */
import { spawn } from "child_process";
import { createInterface } from "readline";

const TIMEOUT = 10000;
let passed = 0;
let failed = 0;

function assert(label, condition) {
  if (condition) { passed++; console.log(`  ✅ ${label}`); }
  else { failed++; console.log(`  ❌ ${label}`); }
}

const proc = spawn("node", ["dist/server.js"], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env },
});

const rl = createInterface({ input: proc.stdout });
const pending = new Map();
let nextId = 1;

rl.on("line", (line) => {
  if (!line.trim()) return;
  try {
    const msg = JSON.parse(line);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  } catch {}
});

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    pending.set(id, resolve);
    proc.stdin.write(msg);
    setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: ${method}`)); }, TIMEOUT);
  });
}

function notify(method, params = {}) {
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

async function run() {
  console.log("\n🧪 UI Creator MCP Server — End-to-End Test\n");

  // Wait for server to start
  await new Promise(r => setTimeout(r, 500));

  // 1. Initialize
  console.log("--- Protocol ---");
  const init = await send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "e2e-test", version: "1.0.0" },
  });
  assert("Initialize handshake", init.result?.serverInfo?.name === "ui-creator");
  notify("notifications/initialized");

  // 2. List tools
  console.log("\n--- Tools ---");
  const toolsResp = await send("tools/list");
  const tools = toolsResp.result?.tools?.map(t => t.name) ?? [];
  assert(`Lists 14 tools (got ${tools.length})`, tools.length === 14);
  assert("Has create_app", tools.includes("create_app"));
  assert("Has list_apps", tools.includes("list_apps"));
  assert("Has switch_app", tools.includes("switch_app"));
  assert("Has deploy_app", tools.includes("deploy_app"));
  assert("Has get_component_manifest", tools.includes("get_component_manifest"));
  assert("Has publish_page_config", tools.includes("publish_page_config"));
  assert("Has validate_page_config", tools.includes("validate_page_config"));

  // 3. List resources
  console.log("\n--- Resources ---");
  const resResp = await send("resources/list");
  const resources = resResp.result?.resources ?? [];
  assert("Has 1 resource", resources.length === 1);
  assert("Resource is component manifest", resources[0]?.uri?.includes("components.schema.json"));

  // 4. Get full manifest
  console.log("\n--- Component Manifest ---");
  const manifestResp = await send("tools/call", {
    name: "get_component_manifest", arguments: {},
  });
  const manifest = JSON.parse(manifestResp.result?.content?.[0]?.text ?? "{}");
  assert(`99 components (got ${manifest.total_components ?? manifest.components?.length})`, (manifest.total_components ?? manifest.components?.length) === 99);
  assert(`16 templates (got ${manifest.total_templates ?? manifest.templates?.length})`, (manifest.total_templates ?? manifest.templates?.length) === 16);

  // 5. Filtered manifest
  const chartsResp = await send("tools/call", {
    name: "get_component_manifest", arguments: { category: "charts" },
  });
  const charts = JSON.parse(chartsResp.result?.content?.[0]?.text ?? "{}");
  assert(`Chart filter → 9 (got ${charts.total})`, charts.total === 9);

  // 6. Templates
  console.log("\n--- Templates ---");
  const templatesResp = await send("tools/call", {
    name: "get_templates", arguments: {},
  });
  const templates = JSON.parse(templatesResp.result?.content?.[0]?.text ?? "{}");
  assert(`16 templates (got ${templates.total})`, templates.total === 16);

  // 7. Validate valid config
  console.log("\n--- Validation ---");
  const validResp = await send("tools/call", {
    name: "validate_page_config",
    arguments: { config: { page: { title: "Test", body: [{ type: "stat_card", props: { title: "Rev" } }] } } },
  });
  assert("Valid config passes", validResp.result?.content?.[0]?.text?.includes("valid"));

  // 8. Validate invalid config
  const invalidResp = await send("tools/call", {
    name: "validate_page_config",
    arguments: { config: { page: { title: "Test", body: [{ type: "BogusWidget", props: {} }] } } },
  });
  assert("Catches unknown component", invalidResp.result?.content?.[0]?.text?.includes("BogusWidget"));

  // 9. Missing page object
  const missingResp = await send("tools/call", {
    name: "validate_page_config",
    arguments: { config: {} },
  });
  assert("Catches missing page", missingResp.result?.content?.[0]?.text?.includes("page"));

  // 10. Save locally
  console.log("\n--- Local Save ---");
  const saveResp = await send("tools/call", {
    name: "save_page_config",
    arguments: {
      pageName: "e2e-test",
      config: { page: { title: "E2E Test", body: [{ type: "stat_card", props: { title: "Test" } }] } },
    },
  });
  assert("Returns file path", saveResp.result?.content?.[0]?.text?.includes("e2e-test.json"));

  // 11. Publish to KV + add route + verify live
  console.log("\n--- KV Publish (Live) ---");
  const hasCredentials = !!(process.env.CF_ACCOUNT_ID && process.env.CF_API_TOKEN && process.env.CF_KV_NAMESPACE_ID);
  if (hasCredentials) {
    const pubResp = await send("tools/call", {
      name: "publish_page_config",
      arguments: {
        pageName: "pages/e2e-test",
        config: {
          page: {
            title: "E2E Test — Built Through Chat",
            layout: "full",
            body: [{
              type: "div", props: { className: "flex items-center justify-center min-h-screen" },
              children: [{
                type: "h1", props: { className: "text-4xl font-bold" }, text: "E2E Test Passed!"
              }]
            }]
          }
        },
      },
    });
    assert("Publish to KV succeeds", pubResp.result?.content?.[0]?.text?.includes("Published"));

    // publish_page_config now auto-adds routes
    assert("Route auto-added", pubResp.result?.content?.[0]?.text?.includes("Route"));

    const statusResp = await send("tools/call", {
      name: "get_app_status", arguments: {},
    });
    const status = JSON.parse(statusResp.result?.content?.[0]?.text ?? "{}");
    assert("Cloudflare connected", status.cloudflareConnected === true);
    assert("Active app set", !!status.activeApp);

    // Verify live page (wait for KV propagation)
    console.log("\n--- Live Verification ---");
    console.log("  ⏳ Waiting 15s for KV propagation...");
    await new Promise(r => setTimeout(r, 15000));
    const resp = await fetch(process.env.UI_CREATOR_RUNTIME_URL + "/e2e-test", {
      headers: { Accept: "text/html" },
    });
    assert(`Live page returns ${resp.status}`, resp.status === 200);
    const html = await resp.text();
    assert("Page contains test content", html.includes("E2E Test Passed!"));
  } else {
    console.log("  ⏭️  Skipping KV tests (no credentials set)");
  }

  // Done
  console.log(`\n${"═".repeat(50)}`);
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log(`${"═".repeat(50)}\n`);

  proc.kill();
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((e) => {
  console.error("Test error:", e.message);
  proc.kill();
  process.exit(1);
});
