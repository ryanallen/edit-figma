# ClawDaddy - Claude to Figma Bridge

🦞 **Auto-detect Figma requests** - No manual commands needed.

## Architecture - Plugin Mode

**Safe & Secure Plugin Connection:**
- WebSocket bridge via ClawDaddy plugin
- Token-based authentication
- Localhost-only daemon
- Auto-start daemon when needed
- Fast execution (~1-3s)

## First-Time Setup

If user has never setup ClawDaddy:

1. **Install plugin in Figma:**
   - Open Figma Desktop
   - Go to: Plugins → Development → Import plugin from manifest
   - Select: `<clawdaddy-dir>/plugin/manifest.json`

2. **Connect ClawDaddy:**
   ```bash
   npx clawdaddy connect
   # Or if you want to install globally: sudo npm link
   ```

3. **Start plugin in Figma:**
   - Plugins → Development → ClawDaddy
   - Keep it running (or re-run when needed)

**That's it!** ClawDaddy is now ready.

## When User Mentions Figma

**Automatically execute Figma operations:**

1. **Detect Figma Context:**
   - User says "create/update/check in Figma"
   - User provides figma.com URL
   - User asks about Figma files/components
   - User wants to run Figma scripts
   - User asks to "export" designs/assets/images from Figma

2. **Just Execute:**
   ```bash
   # Run JavaScript in Figma (auto-starts daemon)
   npx clawdaddy eval "figma.currentPage.name"

   # Or run a file
   npx clawdaddy run script.js
   ```

## Example Flows

**User:** "Create a red rectangle in Figma"

**You do:**
Execute directly: `npx clawdaddy eval "const rect = figma.createRectangle(); rect.fills = [{type: 'SOLID', color: {r: 1, g: 0, b: 0}}]; figma.currentPage.appendChild(rect);"`

**User:** "Export this as PNG"

**You do:**
Execute directly: `npx clawdaddy export png -o design.png`

(ClawDaddy → daemon auto-starts → plugin executes → returns result → saves to file)

## Commands Available

### Core Commands
```bash
clawdaddy connect              # Initial setup (daemon + plugin)
npx clawdaddy status               # Check connection status
npx clawdaddy eval "<code>"        # Execute JavaScript (auto-starts daemon)
npx clawdaddy run <file>           # Execute file (auto-starts daemon)
npx clawdaddy daemon start/stop    # Manage daemon
```

### FigJam Extension
```bash
npx clawdaddy figjam check         # Check if FigJam board
npx clawdaddy figjam sticky "text" # Create sticky note
npx clawdaddy figjam stickies      # Get all stickies
npx clawdaddy figjam organize      # Organize by color
```

### Export Assets
```bash
# Export selected node as PNG
npx clawdaddy export png -o design.png

# Export with scale factor
npx clawdaddy export png -s 2 -o design@2x.png

# Export specific node by ID
npx clawdaddy export png -n "123:456" -o button.png

# Export as SVG
npx clawdaddy export svg -o icon.svg

# Export specific node as SVG
npx clawdaddy export svg -n "123:456" -o logo.svg
```

## Architecture

- **Plugin Mode** - Safe WebSocket bridge via plugin
- **Token authentication** - Session-based security
- **Auto-start daemon** - Starts automatically when needed
- **Localhost only** - Daemon binds to 127.0.0.1:3456

## Setup (First Time Only)

1. **Import plugin:**
   - Figma → Plugins → Development → Import plugin from manifest
   - Select `plugin/manifest.json`

2. **Connect:**
   ```bash
   clawdaddy connect
   ```

3. **Start plugin in Figma:**
   - Plugins → Development → ClawDaddy

4. **Done!** Daemon auto-starts for future commands.

## Common Patterns

### Basic Operations
**Get page info:**
```bash
npx clawdaddy eval "figma.currentPage.name"
```

**List all nodes:**
```bash
npx clawdaddy eval "figma.currentPage.children.map(n => ({name: n.name, type: n.type}))"
```

**Create shapes:**
```bash
npx clawdaddy eval "const rect = figma.createRectangle(); figma.currentPage.appendChild(rect);"
```

### Export Operations
**When user wants to export designs/assets:**
```bash
# Export current selection as PNG
npx clawdaddy export png -o design.png

# Export at 2x resolution
npx clawdaddy export png -s 2 -o design@2x.png

# Export specific node
npx clawdaddy export png -n "123:456" -o button.png

# Export as SVG
npx clawdaddy export svg -o icon.svg
```

### FigJam Operations
**When user mentions sticky notes, FigJam, brainstorming:**
```bash
# Create sticky notes
npx clawdaddy figjam sticky "Meeting notes"

# Organize stickies by color
npx clawdaddy figjam organize
```

## Web Import (page/component → Figma)

Turn a rendered web page — or one element inside it, like a single Storybook story — into native Figma nodes. ClawDaddy drives a headless Chrome to capture the real geometry and computed styles, then rebuilds it over the eval bridge in short, timeout-safe steps. Images load by URL inside the plugin, so nothing needs to be transported as bytes.

```bash
# Import a Storybook story as a Figma component
npx clawdaddy import "http://localhost:6006/iframe.html?viewMode=story&id=patterns-button--default" \
  --name "Button" --component

# Import just one element from any page, placed on the canvas
npx clawdaddy import "https://example.com" --selector ".pricing-card" -x 0 -y 0
```

Options: `--selector <css>` (target element; omit to auto-pick the story root), `--name`, `--component` (convert to a Figma component), `-x/-y` (page position), `--font <family>` (Figma font to render text in, default Inter — web fonts Figma lacks are substituted), `--width <px>` (Chrome viewport, drives responsive layout), `--batch <n>` (images per eval call), `--page <name>` (build onto a named Figma page, created if missing), `--replace` (clear that page's contents first — use on the first import to a page so re-syncs stay idempotent), `--background <css rgb()|none>` (fill for a transparent root; default white).

Requires a Chrome/Chromium/Edge binary; set `CLAWDADDY_CHROME` to override the path. Same capability is exposed to MCP clients as the `figma_import_url` tool.

### Pages & reverse export (Figma → code)

```bash
# List pages and their top-level children (JSON)
npx clawdaddy list-pages

# Export a Figma node (or a whole page's children) to a JSON tree + PNG assets
npx clawdaddy export-tree --node "12:345" --out out.json --assets ./assets
npx clawdaddy export-tree --page "Button" --out button.json --assets ./assets
```

`export-tree` is the reverse of `import`: it walks a node into a JSON tree of geometry + paint/stroke/effect/text properties, exporting image/vector leaves as PNGs into `--assets`. Feed the tree to a codegen step to regenerate markup. Exposed to MCP as `figma_list_pages` and `figma_export_tree`.

## Troubleshooting

- **"Plugin not connected"** → Start ClawDaddy plugin in Figma (Plugins → Development → ClawDaddy)
- **"No session token"** → Run `clawdaddy connect`
- **"Daemon not running"** → Run `npx clawdaddy daemon start` or just run a command (auto-starts)

---

**Key Rule:** After initial setup, daemon auto-starts when you run commands. User only needs to start the plugin in Figma.
