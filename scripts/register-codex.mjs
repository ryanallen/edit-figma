#!/usr/bin/env node
/**
 * Register ClawDaddy as an MCP server in Codex (~/.codex/config.toml).
 * Line-based block editing — no TOML lib needed.
 *
 * Usage: node register-codex.mjs /abs/path/to/src/mcp/server.js
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const server = process.argv[2];
if (!server) {
  console.error("register-codex: missing MCP server path");
  process.exit(1);
}

const dir = join(homedir(), ".codex");
const file = join(dir, "config.toml");
if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
let toml = existsSync(file) ? readFileSync(file, "utf8") : "";

// Remove an existing [header] table block (up to the next [table] or EOF).
function stripBlock(text, header) {
  const lines = text.split("\n");
  const out = [];
  let skip = false;
  for (const line of lines) {
    if (line.trim() === header) { skip = true; continue; }
    if (skip && /^\s*\[/.test(line)) skip = false;
    if (!skip) out.push(line);
  }
  return out.join("\n");
}

toml = stripBlock(toml, "[mcp_servers.clawdaddy]");
toml = toml.replace(/\n{3,}/g, "\n\n").trimEnd();
if (toml.length) toml += "\n";

toml += `\n[mcp_servers.clawdaddy]\ncommand = "node"\nargs = ["${server}"]\n`;

writeFileSync(file, toml);
console.log(`  Codex config: ${file}`);
