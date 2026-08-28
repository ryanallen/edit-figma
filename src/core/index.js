#!/usr/bin/env node

/**
 * 🦞 ClawDaddy CLI
 *
 * Claude Code to Figma bridge
 * Plugin Mode - Safe, token-authenticated connection
 */

import { Command } from 'commander';
import { spawn } from 'child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { ClawDaddyClient } from './client.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const program = new Command();
const client = new ClawDaddyClient();

// PID file for daemon process management
const PID_FILE = join(homedir(), '.clawdaddy', '.daemon.pid');

// ============ DAEMON MANAGEMENT ============

/**
 * Check if daemon is running
 * @returns {boolean} True if daemon process is running
 */
function isDaemonRunning() {
  if (!existsSync(PID_FILE)) {
    return false;
  }

  try {
    const pid = parseInt(readFileSync(PID_FILE, 'utf8').trim());
    // Check if process exists (doesn't kill it)
    process.kill(pid, 0);
    return true;
  } catch {
    // PID file exists but process doesn't
    unlinkSync(PID_FILE);
    return false;
  }
}

/**
 * Start the daemon in background
 * @returns {Promise<void>}
 */
async function startDaemon() {
  if (isDaemonRunning()) {
    return; // Already running
  }

  // Generate new session token
  client.generateToken();

  // Get daemon script path
  const daemonScript = join(__dirname, 'daemon.js');

  // Spawn daemon as detached background process
  const daemonProcess = spawn('node', [daemonScript], {
    detached: true,
    stdio: 'ignore'
  });

  // Save PID
  const configDir = client.getConfigDir();
  if (!existsSync(configDir)) {
    const { mkdirSync } = await import('fs');
    mkdirSync(configDir, { recursive: true });
  }
  writeFileSync(PID_FILE, daemonProcess.pid.toString());

  // Detach from parent
  daemonProcess.unref();

  // Wait a moment for daemon to start
  await new Promise(r => setTimeout(r, 500));
}

/**
 * Stop the daemon
 */
function stopDaemon() {
  if (!existsSync(PID_FILE)) {
    console.log('🦞 Daemon not running');
    return;
  }

  try {
    const pid = parseInt(readFileSync(PID_FILE, 'utf8').trim());
    process.kill(pid, 'SIGTERM');
    unlinkSync(PID_FILE);
    console.log(chalk.green('🦞 Daemon stopped'));
  } catch (error) {
    console.error(`⚠️  Error stopping daemon: ${error.message}`);
    // Clean up stale PID file
    if (existsSync(PID_FILE)) {
      unlinkSync(PID_FILE);
    }
  }
}

/**
 * Restart the daemon
 */
async function restartDaemon() {
  console.log('🦞 Restarting daemon...');
  stopDaemon();
  await new Promise(r => setTimeout(r, 1000));
  await startDaemon();
  console.log('✅ Daemon restarted');
}

/**
 * Ensure daemon is running, start if needed
 * @returns {Promise<void>}
 */
async function ensureDaemon() {
  if (!isDaemonRunning()) {
    await startDaemon();
  }
}

/**
 * Wait for plugin to connect
 * @param {number} timeoutMs - Timeout in milliseconds
 * @returns {Promise<boolean>} True if plugin connected
 */
async function waitForPlugin(timeoutMs = 30000) {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const status = await client.checkDaemon();
    if (status.plugin) {
      return true;
    }
    await new Promise(r => setTimeout(r, 500));
  }

  return false;
}

// ============ CLI COMMANDS ============

program
  .name('clawdaddy')
  .description('🦞 ClawDaddy - Claude Code to Figma bridge (Plugin mode - Safe & Secure)')
  .version('1.0.0');

// ---- connect command ----
program
  .command('connect')
  .description('Setup ClawDaddy connection to Figma')
  .action(async () => {
    try {
      console.log('🦞 ClawDaddy Connection Setup\n');

      // Start daemon
      console.log('📦 Starting ClawDaddy daemon...');
      await startDaemon();
      console.log('✅ Daemon started\n');

      // Check daemon
      const status = await client.checkDaemon();
      if (!status.running) {
        console.error('⚠️  Daemon failed to start');
        process.exit(1);
      }

      console.log('📊 Daemon Status:');
      console.log(`   Mode: ${status.mode || 'safe'}`);
      console.log(`   Port: ${client.port}`);
      console.log(`   Token: ${client.hasToken() ? 'Generated' : 'Missing'}\n`);

      // Wait for plugin
      console.log('⏳ Waiting for Figma plugin to connect...');
      console.log('   Please start the ClawDaddy plugin in Figma:');
      console.log('   Plugins → Development → ClawDaddy\n');

      const connected = await waitForPlugin();

      if (connected) {
        console.log('✅ Plugin connected!');
        console.log('\n🦞 ClawDaddy is ready to use');
        console.log('\nTry: clawdaddy eval "figma.currentPage.name"');
      } else {
        console.log('⚠️  Timeout waiting for plugin');
        console.log('\nMake sure to:');
        console.log('   1. Open Figma Desktop');
        console.log('   2. Open a design file');
        console.log('   3. Run: Plugins → Development → ClawDaddy');
        process.exit(1);
      }
    } catch (error) {
      console.error(`⚠️  Error: ${error.message}`);
      process.exit(1);
    }
  });

// ---- eval command ----
program
  .command('eval')
  .description('Execute JavaScript in Figma')
  .argument('[code]', 'JavaScript code to execute')
  .option('-f, --file <path>', 'Execute code from file')
  .action(async (code, options) => {
    try {
      // Read from file if specified
      let codeToExecute = code;
      if (options.file) {
        try {
          codeToExecute = readFileSync(options.file, 'utf8');
        } catch (error) {
          if (error.code === 'ENOENT') {
            console.error(`⚠️  File not found: ${options.file}`);
          } else {
            console.error(`⚠️  Error reading file: ${error.message}`);
          }
          process.exit(1);
        }
      }

      if (!codeToExecute) {
        console.error('⚠️  No code provided');
        console.error('   Usage: clawdaddy eval "<code>" or clawdaddy eval --file <path>');
        process.exit(1);
      }

      // Ensure daemon is running
      await ensureDaemon();

      // Execute code
      const result = await client.eval(codeToExecute);

      // Output result
      if (result !== undefined) {
        if (typeof result === 'object') {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(result);
        }
      }
    } catch (error) {
      // Provide helpful error messages
      if (error.message.includes('Plugin not connected')) {
        console.error('⚠️  Plugin not connected');
        console.error('   Start the ClawDaddy plugin in Figma:');
        console.error('   Plugins → Development → ClawDaddy\n');
        console.error('   First time? Run: clawdaddy connect');
      } else if (error.message.includes('No session token')) {
        console.error('⚠️  Not connected');
        console.error('   Run: clawdaddy connect');
      } else {
        console.error(`⚠️  Execution error: ${error.message}`);
      }
      process.exit(1);
    }
  });

// ---- run command (alias for eval --file) ----
program
  .command('run <file>')
  .description('Execute JavaScript file in Figma')
  .action(async (file) => {
    try {
      // Ensure daemon is running
      await ensureDaemon();

      // Execute file
      const result = await client.execFile(file);

      // Output result
      if (result !== undefined) {
        if (typeof result === 'object') {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(result);
        }
      }
    } catch (error) {
      if (error.message.includes('File not found')) {
        console.error(`⚠️  File not found: ${file}`);
      } else if (error.message.includes('Plugin not connected')) {
        console.error('⚠️  Plugin not connected');
        console.error('   Start the ClawDaddy plugin in Figma');
      } else {
        console.error(`⚠️  Execution error: ${error.message}`);
      }
      process.exit(1);
    }
  });

// ---- export command ----
const exportCmd = program
  .command('export')
  .description('Export Figma nodes as images');

exportCmd
  .command('png')
  .description('Export as PNG')
  .option('-n, --node <id>', 'Node ID to export (or uses selection)')
  .option('-s, --scale <scale>', 'Scale factor (1x, 2x, 3x)', '1')
  .option('-o, --output <path>', 'Output file path', 'export.png')
  .action(async (options) => {
    try {
      await ensureDaemon();

      const scale = parseFloat(options.scale.replace('x', ''));
      const result = await client.exportNode({
        nodeId: options.node,
        format: 'PNG',
        scale: scale,
        output: options.output
      });

      if (result.saved) {
        console.log(`✅ Exported to: ${result.path}`);
      } else {
        console.error('⚠️  Export failed');
        process.exit(1);
      }
    } catch (error) {
      if (error.message.includes('Plugin not connected')) {
        console.error('⚠️  Plugin not connected');
        console.error('   Start the ClawDaddy plugin in Figma');
      } else if (error.message.includes('No selection')) {
        console.error('⚠️  No selection. Select a node in Figma or use --node <id>');
      } else {
        console.error(`⚠️  Export error: ${error.message}`);
      }
      process.exit(1);
    }
  });

exportCmd
  .command('svg')
  .description('Export as SVG')
  .option('-n, --node <id>', 'Node ID to export (or uses selection)')
  .option('-o, --output <path>', 'Output file path', 'export.svg')
  .action(async (options) => {
    try {
      await ensureDaemon();

      const result = await client.exportNode({
        nodeId: options.node,
        format: 'SVG',
        output: options.output
      });

      if (result.saved) {
        console.log(`✅ Exported to: ${result.path}`);
      } else {
        console.error('⚠️  Export failed');
        process.exit(1);
      }
    } catch (error) {
      if (error.message.includes('Plugin not connected')) {
        console.error('⚠️  Plugin not connected');
        console.error('   Start the ClawDaddy plugin in Figma');
      } else if (error.message.includes('No selection')) {
        console.error('⚠️  No selection. Select a node in Figma or use --node <id>');
      } else {
        console.error(`⚠️  Export error: ${error.message}`);
      }
      process.exit(1);
    }
  });

// ---- status command ----
program
  .command('status')
  .description('Check ClawDaddy connection status')
  .action(async () => {
    try {
      console.log('🦞 ClawDaddy Status\n');

      // Check daemon
      const daemonRunning = isDaemonRunning();
      console.log(`Daemon: ${daemonRunning ? '✅ Running' : '❌ Not running'}`);

      if (!daemonRunning) {
        console.log('\nTo start: clawdaddy connect');
        process.exit(1);
      }

      // Check connection
      const status = await client.checkDaemon();

      console.log(`Plugin: ${status.plugin ? '✅ Connected' : '❌ Not connected'}`);
      console.log(`Mode: ${status.mode || 'unknown'}`);
      console.log(`Port: ${client.port}`);

      if (!status.plugin) {
        console.log('\n⚠️  Plugin not connected');
        console.log('   Start the ClawDaddy plugin in Figma:');
        console.log('   Plugins → Development → ClawDaddy');
        process.exit(1);
      } else {
        console.log('\n✅ ClawDaddy is ready');
      }
    } catch (error) {
      console.error(`⚠️  Error: ${error.message}`);
      process.exit(1);
    }
  });

// ---- daemon command ----
const daemonCmd = program
  .command('daemon')
  .description('Manage ClawDaddy daemon');

daemonCmd
  .command('start')
  .description('Start the daemon')
  .action(async () => {
    if (isDaemonRunning()) {
      console.log('🦞 Daemon already running');
      return;
    }

    console.log('🦞 Starting daemon...');
    await startDaemon();
    console.log('✅ Daemon started');
  });

daemonCmd
  .command('stop')
  .description('Stop the daemon')
  .action(() => {
    stopDaemon();
  });

daemonCmd
  .command('restart')
  .description('Restart the daemon')
  .action(async () => {
    await restartDaemon();
  });

daemonCmd
  .command('status')
  .description('Check daemon status')
  .action(async () => {
    const running = isDaemonRunning();
    console.log(`🦞 Daemon: ${running ? '✅ Running' : '❌ Not running'}`);

    if (running) {
      const status = await client.checkDaemon();
      console.log(`Plugin: ${status.plugin ? '✅ Connected' : '❌ Not connected'}`);
    }
  });

// ---- figjam command (FigJam extension) ----
const figjamCmd = program
  .command('figjam')
  .description('FigJam board operations');

figjamCmd
  .command('check')
  .description('Check if current file is FigJam')
  .action(async () => {
    try {
      await ensureDaemon();
      const { FigJam } = await import('../modules/figjam.js');
      const fj = new FigJam(client);
      const isFigJam = await fj.isFigJam();
      console.log(`Is FigJam: ${isFigJam ? '✅ Yes' : '❌ No'}`);
    } catch (error) {
      console.error(`⚠️  Error: ${error.message}`);
      process.exit(1);
    }
  });

figjamCmd
  .command('sticky <text>')
  .description('Create a sticky note')
  .option('-x <x>', 'X position', '0')
  .option('-y <y>', 'Y position', '0')
  .action(async (text, options) => {
    try {
      await ensureDaemon();
      const { FigJam } = await import('../modules/figjam.js');
      const fj = new FigJam(client);
      const result = await fj.createSticky(text, {
        x: parseInt(options.x),
        y: parseInt(options.y)
      });
      console.log('✅ Sticky note created:', result.text);
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      console.error(`⚠️  Error: ${error.message}`);
      process.exit(1);
    }
  });

figjamCmd
  .command('stickies')
  .description('Get all sticky notes')
  .action(async () => {
    try {
      await ensureDaemon();
      const { FigJam } = await import('../modules/figjam.js');
      const fj = new FigJam(client);
      const result = await fj.getAllStickies();
      console.log(`Found ${result.length} sticky notes`);
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      console.error(`⚠️  Error: ${error.message}`);
      process.exit(1);
    }
  });

figjamCmd
  .command('organize')
  .description('Organize stickies by color into sections')
  .action(async () => {
    try {
      await ensureDaemon();
      const { FigJam } = await import('../modules/figjam.js');
      const fj = new FigJam(client);
      const result = await fj.organizeByColor();
      console.log('✅ Stickies organized by color');
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      console.error(`⚠️  Error: ${error.message}`);
      process.exit(1);
    }
  });

// ---- import command (web → Figma) ----
program
  .command('import <url>')
  .description('Import a rendered web page/element into Figma as a frame or component')
  .option('-s, --selector <css>', 'CSS selector of the element to import')
  .option('-n, --name <name>', 'Name for the created frame/component', 'Imported')
  .option('-c, --component', 'Convert the result into a Figma component')
  .option('-x, --x <n>', 'Page X position', '0')
  .option('-y, --y <n>', 'Page Y position', '0')
  .option('--font <family>', 'Target Figma font family', 'Inter')
  .option('--width <px>', 'Chrome viewport width (drives responsive layout)', '1440')
  .option('--batch <n>', 'Images loaded per eval call', '4')
  .option('--background <color>', 'Fill for a transparent root (CSS rgb()/none)', 'rgb(255,255,255)')
  .option('--page <name>', 'Target Figma page (created if missing)')
  .option('--replace', 'Clear the target page before building')
  .action(async (url, options) => {
    try {
      await ensureDaemon();
      const status = await client.checkDaemon();
      if (!status.plugin) {
        console.error('⚠️  Plugin not connected. Start the ClawDaddy plugin in Figma.');
        process.exit(1);
      }
      const { importWeb } = await import('../modules/webimport.js');
      const result = await importWeb({
        run: (code) => client.eval(code),
        url,
        selector: options.selector || null,
        name: options.name,
        asComponent: !!options.component,
        x: parseFloat(options.x) || 0,
        y: parseFloat(options.y) || 0,
        font: options.font,
        width: parseInt(options.width, 10) || 1440,
        batch: parseInt(options.batch, 10) || 4,
        background: options.background === 'none' ? null : options.background,
        page: options.page || null,
        replace: !!options.replace,
        onProgress: (m) => console.error('  … ' + m)
      });
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      console.error(`⚠️  Import error: ${error.message}`);
      process.exit(1);
    }
  });

// ---- list-pages command ----
program
  .command('list-pages')
  .description('List Figma pages and their top-level children (JSON)')
  .action(async () => {
    try {
      await ensureDaemon();
      const { listPages } = await import('../modules/webexport.js');
      const pages = await listPages({ run: (code) => client.eval(code) });
      console.log(JSON.stringify(pages, null, 2));
    } catch (error) {
      console.error(`⚠️  ${error.message}`);
      process.exit(1);
    }
  });

// ---- export-tree command (Figma node → tree JSON + PNG assets) ----
program
  .command('export-tree')
  .description('Export a Figma node (or a page\'s children) to a JSON tree + PNG assets')
  .option('-n, --node <id>', 'Node id to export')
  .option('-p, --page <name>', 'Export every top-level child of this page')
  .requiredOption('-o, --out <file>', 'Output JSON file')
  .option('--assets <dir>', 'Directory for exported PNG assets', '')
  .option('--scale <n>', 'PNG export scale for image/vector leaves', '2')
  .action(async (options) => {
    try {
      await ensureDaemon();
      const status = await client.checkDaemon();
      if (!status.plugin) { console.error('⚠️  Plugin not connected.'); process.exit(1); }
      const { exportNodeTree, listPages } = await import('../modules/webexport.js');
      const { writeFileSync, mkdirSync } = await import('fs');
      const { dirname } = await import('path');
      const run = (code) => client.eval(code);
      const assetsDir = options.assets || null;
      const scale = parseFloat(options.scale) || 2;

      let nodeIds = [];
      if (options.node) nodeIds = [options.node];
      else if (options.page) {
        const pages = await listPages({ run });
        const pg = pages.find((p) => p.name === options.page);
        if (!pg) { console.error(`⚠️  Page not found: ${options.page}`); process.exit(1); }
        nodeIds = pg.children.map((c) => c.id);
      } else { console.error('⚠️  Pass --node <id> or --page <name>'); process.exit(1); }

      const roots = [];
      for (const id of nodeIds) {
        const { tree, assets } = await exportNodeTree({ run, nodeId: id, assetsDir, scale, onProgress: (m) => console.error('  … ' + m) });
        roots.push({ tree, assets });
      }
      mkdirSync(dirname(options.out), { recursive: true });
      writeFileSync(options.out, JSON.stringify(roots.length === 1 ? roots[0] : roots, null, 2));
      console.log(JSON.stringify({ out: options.out, roots: roots.length }, null, 2));
    } catch (error) {
      console.error(`⚠️  Export error: ${error.message}`);
      process.exit(1);
    }
  });

// ============ RUN CLI ============

program.parse();
