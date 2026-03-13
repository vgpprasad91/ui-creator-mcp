# UI Creator — Build Apps Through Chat

You have access to the **UI Creator MCP server**, which lets you build full SaaS app UIs through conversation. No code, no deploys — just describe what you want and it becomes a live app.

## How It Works

1. **You read the component manifest** to know what's available (99 components, 16 templates)
2. **You generate JSON page configs** based on what the user describes
3. **You publish configs to Cloudflare KV** — the app is live instantly

The runtime is already deployed. You only need to publish JSON configs.

## Workflow

### Step 1: Read the manifest FIRST

Before generating any config, ALWAYS call `get_component_manifest` to see what's available. This returns a compact index grouped by category. Then drill into specific categories to get full props.

```
get_component_manifest()                        → compact index of all 99 components grouped by category
get_component_manifest(category="charts")        → full props for chart components
get_component_manifest(category="magic")         → full props for magic/animation components
get_component_manifest(component="stat_card")    → full props for a single component
get_templates()                                  → all 16 page templates
```

**Important**: The full manifest is ~110K chars — too large for a single response. Always start with the no-arg call to get the index, then query specific categories or components you need.

### Step 2: Generate page configs

Page configs are JSON objects with this structure:

```json
{
  "page": {
    "title": "Dashboard",
    "layout": "sidebar",
    "body": [
      {
        "type": "grid",
        "props": { "columns": 4, "gap": 4 },
        "children": [
          {
            "type": "stat_card",
            "props": {
              "title": "Total Revenue",
              "value": "$48,250",
              "change": "+12.5%",
              "trend": "up"
            }
          }
        ]
      }
    ]
  }
}
```

Key rules:
- Every node has `type` (component name from manifest) and `props` (component props)
- Use `children` for nested components
- Use `text` for plain text content
- Reference datasources with `"datasource": "my_datasource_name"`
- Reference context variables with `$ctx.user.name`, `$ctx.workspace.id`
- Use template references with `"template": "saas-dashboard"` + optional `"overrides"` for deep-merge

### Step 3: Validate before publishing

Always call `validate_page_config` before publishing to catch errors early.

### Step 4: Publish to make it live

```
publish_page_config("pages/dashboard", config)  → publishes a page
publish_manifest(manifest)                       → publishes route map
publish_theme(theme)                             → publishes colors/fonts
publish_datasources(datasources)                 → publishes data definitions
publish_navigation(navigation)                   → publishes sidebar menu
```

## Component Categories

| Category | Examples | Plugin |
|----------|---------|--------|
| **Layout** | grid, flex, card, tabs, accordion, sidebar | core |
| **Data** | data_table, stat_card, list, badge, avatar | core |
| **Forms** | form, input, select, checkbox, textarea, date_picker, color_picker | core |
| **Charts** | BarChart, LineChart, AreaChart, PieChart, DonutChart, SparkChart, Tracker | charts |
| **AI** | AIChat, AISummary, AISearch | ai |
| **Magic** | GradientText, Marquee, AnimatedNumber, Confetti, Globe | magic |
| **Advanced** | Kanban, Calendar, RichTextEditor, FileUpload, Stepper | advanced |
| **Media** | VideoPlayer, AudioPlayer, ImageGallery, PDFViewer | media |

## Templates

Templates are pre-built page configs. Use them as starting points:

- `saas-dashboard` — KPI cards + charts + activity feed
- `crm-contacts` — data table with filters + detail panel
- `settings-general` — tabbed settings with form sections
- `auth-login` / `auth-signup` — authentication pages
- `pricing-three-tier` — pricing comparison page
- `kanban-board` — drag-and-drop task board
- `analytics-overview` — charts + metrics dashboard
- `onboarding-wizard` — multi-step onboarding flow

Use like: `{ "template": "saas-dashboard", "overrides": { "page": { "title": "My Dashboard" } } }`

## Building a Complete App

A complete app needs these configs published to KV:

1. **manifest.json** — Routes and page registry
2. **theme.json** — Colors, fonts, radius
3. **navigation.json** — Sidebar menu items
4. **datasources.json** — Data source definitions
5. **pages/*.json** — Individual page configs (one per route)
6. **forms/*.json** — Form definitions (optional)

### Example: Publishing a complete app

```
1. get_component_manifest()  → read what's available
2. publish_manifest({
     "appId": "invoice-tracker",
     "name": "Invoice Tracker",
     "routes": {
       "/": { "config": "pages/dashboard", "eager": true },
       "/invoices": { "config": "pages/invoices" },
       "/clients": { "config": "pages/clients" },
       "/settings": { "config": "pages/settings" }
     }
   })
3. publish_theme({ "colors": { "primary": "262 83% 58%", ... } })
4. publish_navigation({ "items": [ { "label": "Dashboard", "path": "/", "icon": "LayoutDashboard" }, ... ] })
5. publish_datasources({ "invoices": { "type": "d1", "table": "invoices" }, ... })
6. publish_page_config("pages/dashboard", { ... })
7. publish_page_config("pages/invoices", { ... })
   ... etc for each page
```

## Tips

- **Iterate**: Users will refine their requests. Just publish updated configs — changes are instant.
- **Use templates**: For standard pages (dashboards, settings, auth), start from a template and customize.
- **Check props**: Don't guess prop names. Always verify against the manifest.
- **Plugin components**: Charts, AI, Magic, Advanced, and Media components auto-load their plugin bundles. No extra setup needed.
- **HSL colors**: Theme colors use HSL format without `hsl()` wrapper: `"262 83% 58%"` not `"hsl(262, 83%, 58%)"`.
- **Datasource binding**: Components bind to data via `"datasource": "name"` prop. The runtime resolves this at render time.
