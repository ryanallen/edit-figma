#!/usr/bin/env node
/**
 * 🦞 ClawDaddy MCP server (stdio)
 *
 * Exposes ClawDaddy's Figma bridge as Model Context Protocol tools so Claude
 * Code and Codex can read and drive the live Figma file. Everything runs over
 * ClawDaddy's existing eval bridge (HTTP → localhost daemon → Figma plugin), so
 * no plugin changes are needed. The daemon auto-starts on demand; the only
 * manual step is keeping the ClawDaddy plugin open in Figma Desktop.
 *
 * Tool set is inspired by southleft/figma-console-mcp, pared to the high-value
 * reads/actions that map cleanly onto a single eval bridge.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { spawn } from "child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";
import ClawDaddyClient from "../core/client.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const client = new ClawDaddyClient();
const PID_FILE = join(homedir(), ".clawdaddy", ".daemon.pid");

function isDaemonRunning() {
  if (!existsSync(PID_FILE)) return false;
  try {
    process.kill(parseInt(readFileSync(PID_FILE, "utf8").trim(), 10), 0);
    return true;
  } catch {
    try { unlinkSync(PID_FILE); } catch {}
    return false;
  }
}

// Start the daemon if it isn't already up (mirrors the CLI's startDaemon).
async function ensureDaemon() {
  const status = await client.checkDaemon();
  if (status.running) return;
  if (!client.hasToken()) client.generateToken();
  const dir = client.getConfigDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const proc = spawn("node", [join(__dirname, "..", "core", "daemon.js")], {
    detached: true,
    stdio: "ignore"
  });
  writeFileSync(PID_FILE, String(proc.pid));
  proc.unref();
  await new Promise((r) => setTimeout(r, 600));
}

const text = (data) => ({
  content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }]
});
const fail = (message) => ({ content: [{ type: "text", text: `🦞 ${message}` }], isError: true });

// Run an eval snippet through the bridge, starting the daemon first.
async function run(code) {
  await ensureDaemon();
  return client.eval(code);
}

const server = new McpServer({ name: "clawdaddy", version: "1.0.0" });

server.tool(
  "figma_eval",
  "Execute JavaScript in the live Figma file via ClawDaddy and return the result. Use the Figma Plugin API (figma.*). Return a value to read data back; async/await is supported.",
  { code: z.string().describe("JavaScript to run in the Figma plugin context") },
  async ({ code }) => {
    try {
      const r = await run(code);
      return text(r === undefined ? "(no return value)" : r);
    } catch (e) { return fail(e.message); }
  }
);

server.tool(
  "figma_status",
  "Check the ClawDaddy connection: daemon running + Figma plugin connected, plus the open file/page.",
  {},
  async () => {
    try {
      const status = await client.checkDaemon();
      if (!status.running || !status.plugin) return text(status);
      const ctx = await run("({file: figma.root.name, page: figma.currentPage.name, selection: figma.currentPage.selection.length})");
      return text({ ...status, ...ctx });
    } catch (e) { return fail(e.message); }
  }
);

server.tool(
  "figma_get_selection",
  "Get the currently selected nodes on the page (id, name, type, position, size).",
  {},
  async () => {
    try {
      return text(await run(
        "figma.currentPage.selection.map(n => ({ id:n.id, name:n.name, type:n.type, x:Math.round(n.x||0), y:Math.round(n.y||0), width:Math.round(n.width||0), height:Math.round(n.height||0) }))"
      ));
    } catch (e) { return fail(e.message); }
  }
);

server.tool(
  "figma_get_page",
  "Read the current page's node tree (top-level by default). id, name, type, position, size.",
  { depth: z.number().int().min(1).max(4).optional().describe("How many levels deep to walk (default 1)") },
  async ({ depth }) => {
    const d = depth ?? 1;
    try {
      return text(await run(`
        (function(){
          function walk(node, level){
            const base = { id:node.id, name:node.name, type:node.type,
              x:Math.round(node.x||0), y:Math.round(node.y||0),
              width:Math.round(node.width||0), height:Math.round(node.height||0) };
            if (level < ${d} && 'children' in node) base.children = node.children.map(c => walk(c, level+1));
            return base;
          }
          return { file: figma.root.name, page: figma.currentPage.name,
            nodes: figma.currentPage.children.map(n => walk(n, 1)) };
        })()
      `));
    } catch (e) { return fail(e.message); }
  }
);

server.tool(
  "figma_get_variables",
  "List local variable collections and variables (design tokens): id, name, type, modes.",
  {},
  async () => {
    try {
      return text(await run(`
        (function(){
          const collections = figma.variables.getLocalVariableCollections().map(c => ({
            id:c.id, name:c.name, modes:c.modes.map(m => m.name) }));
          const variables = figma.variables.getLocalVariables().map(v => ({
            id:v.id, name:v.name, type:v.resolvedType, collectionId:v.variableCollectionId }));
          return { collections, variables };
        })()
      `));
    } catch (e) { return fail(e.message); }
  }
);

server.tool(
  "figma_get_styles",
  "List local paint, text, and effect styles (id + name).",
  {},
  async () => {
    try {
      return text(await run(`
        ({
          paint: figma.getLocalPaintStyles().map(s => ({ id:s.id, name:s.name })),
          text: figma.getLocalTextStyles().map(s => ({ id:s.id, name:s.name })),
          effect: figma.getLocalEffectStyles().map(s => ({ id:s.id, name:s.name }))
        })
      `));
    } catch (e) { return fail(e.message); }
  }
);

server.tool(
  "figma_screenshot",
  "Render a Figma node to a PNG and return it inline so you can see the design. Uses the current selection when nodeId is omitted.",
  {
    nodeId: z.string().optional().describe("Node id to capture; omit to use the current selection"),
    scale: z.number().optional().describe("Scale factor (default 2)")
  },
  async ({ nodeId, scale }) => {
    try {
      const s = scale ?? 2;
      const nodeExpr = nodeId ? `await figma.getNodeByIdAsync(${JSON.stringify(nodeId)})` : "figma.currentPage.selection[0]";
      const b64 = await run(`
        (async function(){
          const node = ${nodeExpr};
          if (!node) throw new Error('Nothing to capture — select a node in Figma or pass nodeId.');
          if (!node.exportAsync) throw new Error('That node type cannot be exported.');
          const bytes = await node.exportAsync({ format:'PNG', constraint:{ type:'SCALE', value:${s} } });
          // Chunked base64 — String.fromCharCode.apply caps at ~65534 args, so
          // large exports must be encoded in slices.
          let bin = ''; const CH = 32768;
          for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
          return btoa(bin);
        })()
      `);
      return { content: [{ type: "image", data: b64, mimeType: "image/png" }] };
    } catch (e) { return fail(e.message); }
  }
);

server.tool(
  "figma_export",
  "Export a Figma node (or the current selection) to a PNG or SVG file on disk.",
  {
    output: z.string().describe("Absolute output file path"),
    format: z.enum(["PNG", "SVG"]).default("PNG"),
    nodeId: z.string().optional().describe("Node id to export; omit to use the current selection"),
    scale: z.number().optional().describe("PNG scale factor (default 1)")
  },
  async ({ output, format, nodeId, scale }) => {
    try {
      await ensureDaemon();
      return text(await client.exportNode({ nodeId, format, scale: scale ?? 1, output }));
    } catch (e) { return fail(e.message); }
  }
);

server.tool(
  "figma_import_url",
  "Import a rendered web page (or a single element inside it) into Figma as native nodes — turn a live Storybook story, component, or any URL into a Figma frame or component. Drives a headless Chrome to capture real geometry + computed styles, then rebuilds it over the eval bridge in short, timeout-safe steps (images load by URL inside the plugin).",
  {
    url: z.string().describe("Page URL to render (e.g. a Storybook iframe.html?id=... URL)"),
    selector: z.string().optional().describe("CSS selector of the element to import; omit to auto-pick the story root"),
    name: z.string().optional().describe("Name for the created frame/component"),
    asComponent: z.boolean().optional().describe("Convert the result into a Figma component"),
    x: z.number().optional().describe("Page X position (default 0)"),
    y: z.number().optional().describe("Page Y position (default 0)"),
    font: z.string().optional().describe("Target Figma font family to render text with (default Inter)"),
    width: z.number().optional().describe("Chrome viewport width; drives responsive layout (default 1440)"),
    batch: z.number().optional().describe("Images loaded per eval call (default 4)"),
    background: z.string().optional().describe("Fill for a transparent root as a CSS rgb() string (default white); pass 'none' to leave transparent"),
    page: z.string().optional().describe("Target Figma page name (created if missing)"),
    replace: z.boolean().optional().describe("Clear the target page's contents before building")
  },
  async ({ url, selector, name, asComponent, x, y, font, width, batch, background, page, replace }) => {
    try {
      await ensureDaemon();
      const { importWeb } = await import("../modules/webimport.js");
      const result = await importWeb({
        run,
        url,
        selector: selector ?? null,
        name: name ?? "Imported",
        asComponent: asComponent ?? false,
        x: x ?? 0,
        y: y ?? 0,
        font: font ?? "Inter",
        width: width ?? 1440,
        batch: batch ?? 4,
        background: background === "none" ? null : (background ?? "rgb(255,255,255)"),
        page: page ?? null,
        replace: replace ?? false
      });
      return text(result);
    } catch (e) { return fail(e.message); }
  }
);

server.tool(
  "figma_list_pages",
  "List the Figma file's pages and each page's top-level children (id, name, type).",
  {},
  async () => {
    try {
      const { listPages } = await import("../modules/webexport.js");
      return text(await listPages({ run }));
    } catch (e) { return fail(e.message); }
  }
);

server.tool(
  "figma_export_tree",
  "Export a Figma node (by id) into a JSON tree of geometry + paint/stroke/effect/text properties — the reverse of figma_import_url. Image/vector leaves are exported as PNGs into assetsDir. Feed the tree to a codegen step to regenerate markup (e.g. Storybook stories).",
  {
    nodeId: z.string().describe("Figma node id to export"),
    assetsDir: z.string().optional().describe("Directory to write exported PNG assets into"),
    scale: z.number().optional().describe("PNG export scale for image/vector leaves (default 2)")
  },
  async ({ nodeId, assetsDir, scale }) => {
    try {
      await ensureDaemon();
      const { exportNodeTree } = await import("../modules/webexport.js");
      const result = await exportNodeTree({ run, nodeId, assetsDir: assetsDir ?? null, scale: scale ?? 2 });
      return text(result);
    } catch (e) { return fail(e.message); }
  }
);

await server.connect(new StdioServerTransport());
