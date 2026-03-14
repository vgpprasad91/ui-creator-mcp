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

### Step 2: Generate page configs (json-render native spec format)

Page configs use json-render's **flat spec format**. This is a flat map of elements with string ID references — NOT a nested tree. The Renderer consumes this directly with zero conversion.

```json
{
  "page": {
    "title": "Dashboard",
    "layout": "full",
    "spec": {
      "root": "main-stack",
      "elements": {
        "main-stack": {
          "type": "Stack",
          "props": { "direction": "column", "gap": "lg" },
          "children": ["header-1", "stats-grid", "content-card"]
        },
        "header-1": {
          "type": "Heading",
          "props": { "level": 1, "text": "Dashboard" },
          "children": []
        },
        "stats-grid": {
          "type": "Grid",
          "props": { "columns": 4, "gap": "md" },
          "children": ["stat-1", "stat-2", "stat-3", "stat-4"]
        },
        "stat-1": {
          "type": "Card",
          "props": { "title": "Revenue", "description": "$48,250" },
          "children": []
        },
        "stat-2": {
          "type": "Card",
          "props": { "title": "Users", "description": "2,847" },
          "children": []
        },
        "stat-3": {
          "type": "Card",
          "props": { "title": "Completion", "description": "73%" },
          "children": []
        },
        "stat-4": {
          "type": "Card",
          "props": { "title": "Rating", "description": "4.8/5" },
          "children": []
        },
        "content-card": {
          "type": "Card",
          "props": { "title": "Recent Activity" },
          "children": ["activity-text"]
        },
        "activity-text": {
          "type": "Text",
          "props": { "text": "No recent activity" },
          "children": []
        }
      }
    }
  }
}
```

**Key rules for the spec format:**
- Every element MUST have a **unique string ID** as its key in `elements`
- `children` is an array of **string IDs** (NOT inline objects)
- `props` contains all the component's properties
- `root` is the ID of the top-level element — it MUST exist in `elements`
- Every child ID referenced in `children` MUST exist in `elements`
- Leaf elements MUST have `"children": []` (empty array, not omitted)

**Available component types (41 total):**

*shadcn/json-render (36):* Card, Stack, Grid, Separator, Tabs, Accordion, Collapsible, Dialog, Drawer, Carousel, Table, Heading, Text, Image, Avatar, Badge, Alert, Progress, Skeleton, Spinner, Tooltip, Popover, Input, Textarea, Select, Checkbox, Radio, Switch, Slider, Button, Link, DropdownMenu, Toggle, ToggleGroup, ButtonGroup, Pagination

*Custom (5):* StatCard, PageHeader, DataTable, ActivityFeed, Icon

**Layout patterns:**
- Use `Stack` for vertical/horizontal layouts: `{ "direction": "column", "gap": "lg" }` or `{ "direction": "row", "gap": "md" }`
- Use `Grid` for multi-column layouts: `{ "columns": 4, "gap": "md" }`
- Gap values: `"xs"`, `"sm"`, `"md"`, `"lg"`, `"xl"`
- Stack alignment: `"align": "center"`, `"justify": "space-between"`

**Tabs pattern:**
```json
"my-tabs": {
  "type": "Tabs",
  "props": { "tabs": [{ "value": "t1", "label": "Tab 1" }, { "value": "t2", "label": "Tab 2" }] },
  "children": ["panel-1", "panel-2"]
}
```
Each child corresponds to a tab panel in order.

**Legacy tree format** (still supported as fallback):
- Uses `body` array with nested `{ type, props, children }` objects
- Rendered via ConfigRenderer, not json-render
- New pages should always use the `spec` format

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

## Component Schema

Call `get_ui_schema` to get the complete component schema with all available types, their exact props, and generation rules. This schema is auto-generated from the component catalog and is always up-to-date.

**Key differences from legacy format:**
- `Grid.columns` (not `cols`) — number of columns
- `Grid.gap` — `"sm"` | `"md"` | `"lg"` (not a number)
- `Stack.direction` — `"horizontal"` | `"vertical"` (not `"row"` | `"column"`)
- `Heading.level` — `"h1"` | `"h2"` | `"h3"` | `"h4"` (not a number)
- `Badge.text` (not `label`)
- All text content uses `text` prop (not children text nodes)

The spec format uses JSONL patches (RFC 6902). Each element has a unique ID, children are ID references.

### Always Validate Before Publishing

ALWAYS call `validate_page_config` before `publish_page_config` and fix ALL errors. The validator checks structural rules that, if violated, cause broken or empty pages at runtime. Warnings are informational but errors are blocking.

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
