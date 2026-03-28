import { exec } from 'child_process';
import util from 'util';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const pkg = require('./package.json');
const execAsync = util.promisify(exec);

/**
 * Command executor.
 * Responsible for executing user-submitted commands and returning results.
 */
class Executor {
    constructor(config) {
        this.config = config;
        this.timeout = config.COMMAND_TIMEOUT || 300000; // Default: 300 seconds
    }

    /**
     * Execute a command.
     * @param {Object} cmdPayload - Command payload {text, mode, context}
     * @returns {Object} - Execution result {text, json, logs}
     */
    async execute(cmdPayload) {
        const { text } = cmdPayload;

        // Built-in commands start with "/".
        if (text.startsWith('/')) {
            return this.executeBuiltin(text);
        }

        // Custom command execution path.
        // TODO: replace this with the real OpenClaw API integration.
        // For now, shell execution is used as an example implementation.
        try {
            return await this.executeShell(text);
        } catch (error) {
            throw new Error(`Execution failed: ${error.message}`);
        }
    }

    /**
     * Execute a built-in command.
     */
    async executeBuiltin(cmd) {
        const cmdLower = cmd.toLowerCase();

        switch (cmdLower) {
            case '/help':
                return {
                    text: this.getHelpText(),
                    json: { commands: ['help', 'status', 'ping', 'version'] },
                    logs: '',
                };

            case '/status': {
                const status = this.getStatus();
                return {
                    text: status.text,
                    json: status.data,
                    logs: '',
                };
            }

            case '/ping':
                return {
                    text: 'pong',
                    json: {
                        timestamp: Date.now(),
                        uptime: process.uptime(),
                    },
                    logs: '',
                };

            case '/version':
                return {
                    text: `xiotbox v${pkg.version}`,
                    json: {
                        version: pkg.version,
                        node: process.version,
                        platform: process.platform,
                    },
                    logs: '',
                };

            default:
                throw new Error(`Unknown built-in command: ${cmd}\nUse /help to view available commands.`);
        }
    }

    /**
     * Return the built-in help text.
     */
    getHelpText() {
        return `OpenClaw XiotBox Plugin - Available commands

Built-in commands:
  /help     - Show this help message
  /status   - Show plugin runtime status
  /ping     - Test connectivity (returns pong)
  /version  - Show plugin version information

Custom commands:
  Any other text will be executed as a custom command.

Examples:
  echo Hello World
  ls -la
  node --version`;
    }

    /**
     * Return runtime status information.
     */
    getStatus() {
        const mem = process.memoryUsage();
        const cpu = process.cpuUsage();

        const statusText = `Plugin runtime status:
==============================
Status: running
Uptime: ${this.formatUptime(process.uptime())}
Memory: ${this.formatBytes(mem.heapUsed)} / ${this.formatBytes(mem.heapTotal)}
Host: ${os.hostname()}
Platform: ${process.platform} (${process.arch})
Node.js: ${process.version}`;

        return {
            text: statusText,
            data: {
                status: 'running',
                uptime: process.uptime(),
                memory: {
                    heapUsed: mem.heapUsed,
                    heapTotal: mem.heapTotal,
                    rss: mem.rss,
                },
                cpu: {
                    user: cpu.user,
                    system: cpu.system,
                },
                hostname: os.hostname(),
                platform: process.platform,
                arch: process.arch,
                nodeVersion: process.version,
            },
        };
    }

    /**
     * Execute a shell command (example implementation).
     * TODO: replace this with the actual OpenClaw API integration.
     */
    async executeShell(command) {
        try {
            const { stdout, stderr } = await execAsync(command, {
                timeout: this.timeout,
                maxBuffer: 10 * 1024 * 1024, // 10 MB buffer
            });

            const output = stdout || stderr;

            return {
                text: output || 'Command completed successfully (no output).',
                json: {
                    stdout: stdout || '',
                    stderr: stderr || '',
                    exitCode: 0,
                },
                logs: stderr || '',
            };
        } catch (error) {
            // Timeout or execution failure
            if (error.killed) {
                throw new Error(`Command timed out after ${this.timeout / 1000} seconds.`);
            }

            throw new Error(`Execution error: ${error.message}\n${error.stderr || ''}`);
        }
    }

    /**
     * Format process uptime.
     */
    formatUptime(seconds) {
        const days = Math.floor(seconds / 86400);
        const hours = Math.floor((seconds % 86400) / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const secs = Math.floor(seconds % 60);

        const parts = [];
        if (days > 0) parts.push(`${days}d`);
        if (hours > 0) parts.push(`${hours}h`);
        if (minutes > 0) parts.push(`${minutes}m`);
        parts.push(`${secs}s`);

        return parts.join(' ');
    }

    /**
     * Format a byte count.
     */
    formatBytes(bytes) {
        const units = ['B', 'KB', 'MB', 'GB'];
        let size = bytes;
        let unitIndex = 0;

        while (size >= 1024 && unitIndex < units.length - 1) {
            size /= 1024;
            unitIndex += 1;
        }

        return `${size.toFixed(2)} ${units[unitIndex]}`;
    }
}

export default Executor;
