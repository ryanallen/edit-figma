/**
 * 🦞 ClawDaddy Client
 *
 * Wrapper around daemon HTTP API with token management and error handling
 */

import { randomBytes } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const DAEMON_PORT = parseInt(process.env.DAEMON_PORT) || 3456;
const DAEMON_URL = `http://127.0.0.1:${DAEMON_PORT}`;
const CONFIG_DIR = join(homedir(), '.clawdaddy');
const TOKEN_FILE = join(CONFIG_DIR, '.daemon-token');

export class ClawDaddyClient {
  constructor() {
    this.port = DAEMON_PORT;
    this.url = DAEMON_URL;
  }

  /**
   * Generate and save a new session token
   * @returns {string} The generated token
   */
  generateToken() {
    // Ensure config directory exists
    if (!existsSync(CONFIG_DIR)) {
      mkdirSync(CONFIG_DIR, { recursive: true });
    }

    // Generate 256-bit random token (64 hex chars)
    const token = randomBytes(32).toString('hex');

    // Save with restricted permissions (owner read/write only)
    writeFileSync(TOKEN_FILE, token, { mode: 0o600 });

    return token;
  }

  /**
   * Read the current session token
   * @returns {string|null} The token or null if not found
   */
  readToken() {
    try {
      return readFileSync(TOKEN_FILE, 'utf8').trim();
    } catch {
      return null;
    }
  }

  /**
   * Check if daemon is running and plugin is connected
   * @returns {Promise<Object>} Status object with { running, plugin, mode, status }
   */
  async checkDaemon() {
    const token = this.readToken();
    if (!token) {
      return {
        running: false,
        plugin: false,
        mode: 'unknown',
        status: 'no token',
        error: 'No session token found'
      };
    }

    try {
      const response = await fetch(`${this.url}/health`, {
        headers: {
          'X-Daemon-Token': token
        },
        signal: AbortSignal.timeout(2000) // 2 second timeout
      });

      if (!response.ok) {
        return {
          running: false,
          plugin: false,
          mode: 'unknown',
          status: 'error',
          error: `HTTP ${response.status}`
        };
      }

      const data = await response.json();
      return {
        running: true,
        plugin: data.plugin || false,
        mode: data.mode || 'safe',
        status: data.status || 'ok',
        idleTimeout: data.idleTimeoutMs
      };
    } catch (error) {
      return {
        running: false,
        plugin: false,
        mode: 'unknown',
        status: 'disconnected',
        error: error.message
      };
    }
  }

  /**
   * Execute JavaScript code in Figma
   * @param {string} code - JavaScript code to execute
   * @returns {Promise<any>} The result from Figma
   */
  async eval(code) {
    const token = this.readToken();
    if (!token) {
      throw new Error('🦞 No session token found. Run "clawdaddy connect" first.');
    }

    const response = await fetch(`${this.url}/exec`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Daemon-Token': token
      },
      body: JSON.stringify({
        action: 'eval',
        code: code
      }),
      signal: AbortSignal.timeout(30000) // 30 second timeout
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
      throw new Error(errorData.error || `HTTP ${response.status}`);
    }

    const data = await response.json();
    return data.result;
  }

  /**
   * Execute JavaScript code from a file
   * @param {string} filePath - Path to JavaScript file
   * @returns {Promise<any>} The result from Figma
   */
  async execFile(filePath) {
    try {
      const code = readFileSync(filePath, 'utf8');
      return await this.eval(code);
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new Error(`🦞 File not found: ${filePath}`);
      }
      throw error;
    }
  }

  /**
   * Get daemon status with friendly error messages
   * @returns {Promise<string>} Status message
   */
  async getStatusMessage() {
    const status = await this.checkDaemon();

    if (!status.running) {
      if (status.error === 'No session token found') {
        return '🦞 ClawDaddy daemon not started. Run "clawdaddy connect" first.';
      }
      return `🦞 ClawDaddy daemon not running (${status.error || 'unknown error'})`;
    }

    if (!status.plugin) {
      return '🦞 ClawDaddy daemon running, but plugin not connected.\n   Start the ClawDaddy plugin in Figma (Plugins → Development → ClawDaddy)';
    }

    return `🦞 ClawDaddy connected to Figma! (mode: ${status.mode})`;
  }

  /**
   * Ping daemon to check if it responds
   * @returns {Promise<boolean>} True if daemon responds
   */
  async ping() {
    try {
      const status = await this.checkDaemon();
      return status.running && status.plugin;
    } catch {
      return false;
    }
  }

  /**
   * Export a Figma node as an image
   * @param {Object} options - Export options
   * @param {string} options.nodeId - Node ID (optional, uses selection if not provided)
   * @param {string} options.format - 'PNG' or 'SVG'
   * @param {number} options.scale - Scale factor (PNG only, default 1)
   * @param {string} options.output - Output file path
   * @returns {Promise<Object>} Result with {saved: boolean, path: string}
   */
  async exportNode(options) {
    const { nodeId, format = 'PNG', scale = 1, output } = options;

    // Build export code
    const exportCode = `
      const node = ${nodeId ? `await figma.getNodeByIdAsync('${nodeId}')` : 'figma.currentPage.selection[0]'};
      if (!node) {
        throw new Error('No selection. Select a node or provide --node <id>');
      }

      const settings = {
        format: '${format}'
        ${format === 'PNG' ? `, constraint: {type: 'SCALE', value: ${scale}}` : ''}
      };

      const bytes = await node.exportAsync(settings);

      // Convert Uint8Array to base64 for JSON transport. Chunked because
      // String.fromCharCode caps at ~65534 args, which large exports exceed.
      let bin = ''; const CH = 32768;
      for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
      const base64 = btoa(bin);

      return {
        type: 'export',
        format: '${format}',
        data: base64,
        nodeName: node.name
      };
    `;

    const result = await this.eval(exportCode);

    if (result && result.type === 'export') {
      // Decode base64 to binary (Node.js Buffer handles this)
      const bytes = Buffer.from(result.data, 'base64');

      // Write to file
      writeFileSync(output, bytes);

      return {
        saved: true,
        path: output,
        nodeName: result.nodeName
      };
    }

    throw new Error('Export failed: Invalid response from plugin');
  }

  /**
   * Get config directory path
   * @returns {string} Path to config directory
   */
  getConfigDir() {
    return CONFIG_DIR;
  }

  /**
   * Get token file path
   * @returns {string} Path to token file
   */
  getTokenFile() {
    return TOKEN_FILE;
  }

  /**
   * Check if token exists
   * @returns {boolean} True if token file exists
   */
  hasToken() {
    return existsSync(TOKEN_FILE);
  }
}

// Export singleton instance
export const client = new ClawDaddyClient();

// Export class for custom instances
export default ClawDaddyClient;
