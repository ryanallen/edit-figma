#!/bin/bash
#
# 🦞 ClawDaddy setup — installs deps, starts the daemon, and registers ClawDaddy
# as an MCP server in BOTH Claude Code and Codex. Run by "Setup ClawDaddy.app"
# or directly. Self-locating & portable.
#
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
cd "$REPO"
MCP_SERVER="$REPO/src/mcp/server.js"

printf '\n  🦞 ClawDaddy setup\n  %s\n\n' "$REPO"

# --- Node required ---
if ! command -v node >/dev/null 2>&1; then
  printf 'ERROR: Node.js not found. Install the LTS from https://nodejs.org/ and run again.\n'
  command -v osascript >/dev/null 2>&1 && osascript \
    -e 'set r to button returned of (display alert "Node.js not found" message "ClawDaddy needs Node.js. Install the LTS from nodejs.org, then run Setup ClawDaddy again." buttons {"Open nodejs.org","OK"} default button "Open nodejs.org")' \
    -e 'if r is "Open nodejs.org" then do shell script "open https://nodejs.org/"' >/dev/null 2>&1 || true
  exit 1
fi
printf 'node %s, npm %s\n\n' "$(node -v)" "$(npm -v)"

# --- Dependencies ---
printf 'Installing dependencies...\n'
npm install || { printf '\nnpm install failed.\n'; exit 1; }

# --- Register in Claude Code (user scope = every folder) ---
printf '\nClaude Code:\n'
if command -v claude >/dev/null 2>&1; then
  claude mcp remove -s user clawdaddy >/dev/null 2>&1 || true
  if claude mcp add -s user clawdaddy -- node "$MCP_SERVER"; then
    printf '  ✅ registered clawdaddy (user scope)\n'
  else
    printf '  ⚠️  could not register clawdaddy in Claude Code\n'
  fi
else
  printf '  ⚠️  "claude" CLI not on PATH — skipped. Install Claude Code, then re-run.\n'
fi

# --- Register in Codex ---
printf '\nCodex:\n'
if node "$HERE/register-codex.mjs" "$MCP_SERVER"; then
  printf '  ✅ registered clawdaddy (~/.codex/config.toml)\n'
else
  printf '  ⚠️  Codex registration had an issue\n'
fi

# --- Start the daemon ---
printf '\nStarting ClawDaddy daemon...\n'
node src/core/index.js daemon start >/dev/null 2>&1 || true

cat <<'DONE'

──────────────────────────────────────────────
🦞 Almost there. Two things:

1. In Figma Desktop, keep the ClawDaddy plugin open:
   Plugins → Development → ClawDaddy
   (First time? Plugins → Development → Import plugin from manifest →
    pick this repo's  plugin/manifest.json )

2. Restart Claude Code and/or Codex so they load the new MCP server.
   Then the figma_eval / figma_status / figma_export tools appear.
──────────────────────────────────────────────

DONE
