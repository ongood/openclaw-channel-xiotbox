import { exec } from 'child_process';
import util from 'util';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const pkg = require('./package.json');
const execAsync = util.promisify(exec);

/**
 * 命令执行器
 * 负责执行用户发送的命令并返回结果
 */
class Executor {
    constructor(config) {
        this.config = config;
        this.timeout = config.COMMAND_TIMEOUT || 300000;  // 默认 300 秒超时
    }

    /**
     * 执行命令
     * @param {Object} cmdPayload - 命令内容 {text, mode, context}
     * @returns {Object} - 执行结果 {text, json, logs}
     */
    async execute(cmdPayload) {
        const { text, mode } = cmdPayload;

        // 内置命令（以 / 开头）
        if (text.startsWith('/')) {
            return this.executeBuiltin(text);
        }

        // 自定义命令执行逻辑
        // TODO: 根据实际 OpenClaw API 调整
        // 目前使用 shell 执行作为示例
        try {
            const result = await this.executeShell(text);
            return result;
        } catch (error) {
            throw new Error(`执行失败: ${error.message}`);
        }
    }

    /**
     * 执行内置命令
     */
    async executeBuiltin(cmd) {
        const cmdLower = cmd.toLowerCase();

        switch (cmdLower) {
            case '/help':
                return {
                    text: this.getHelpText(),
                    json: { commands: ['help', 'status', 'ping', 'version'] },
                    logs: ''
                };

            case '/status':
                const status = this.getStatus();
                return {
                    text: status.text,
                    json: status.data,
                    logs: ''
                };

            case '/ping':
                return {
                    text: 'pong',
                    json: {
                        timestamp: Date.now(),
                        uptime: process.uptime()
                    },
                    logs: ''
                };

            case '/version':
                return {
                    text: `openclaw-channel-xiotbox v${pkg.version}`,
                    json: {
                        version: pkg.version,
                        node: process.version,
                        platform: process.platform
                    },
                    logs: ''
                };

            default:
                throw new Error(`未知的内置命令: ${cmd}\n输入 /help 查看可用命令`);
        }
    }

    /**
     * 获取帮助文本
     */
    getHelpText() {
        return `OpenClaw XiotBox 插件 - 可用命令：

内置命令：
  /help     - 显示此帮助信息
  /status   - 显示插件运行状态
  /ping     - 测试连接（返回 pong）
  /version  - 显示插件版本信息

自定义命令：
  其他文本将作为自定义命令执行
  
示例：
  echo Hello World
  ls -la
  node --version`;
    }

    /**
     * 获取状态信息
     */
    getStatus() {
        const mem = process.memoryUsage();
        const cpu = process.cpuUsage();

        const statusText = `插件运行状态：
━━━━━━━━━━━━━━━━━━━━
✓ 状态：运行中
⏱ 运行时间：${this.formatUptime(process.uptime())}
💾 内存使用：${this.formatBytes(mem.heapUsed)} / ${this.formatBytes(mem.heapTotal)}
🖥 主机：${os.hostname()}
📍 平台：${process.platform} (${process.arch})
🔧 Node.js：${process.version}`;

        return {
            text: statusText,
            data: {
                status: 'running',
                uptime: process.uptime(),
                memory: {
                    heapUsed: mem.heapUsed,
                    heapTotal: mem.heapTotal,
                    rss: mem.rss
                },
                cpu: {
                    user: cpu.user,
                    system: cpu.system
                },
                hostname: os.hostname(),
                platform: process.platform,
                arch: process.arch,
                nodeVersion: process.version
            }
        };
    }

    /**
     * 执行 Shell 命令（示例实现）
     * TODO: 替换为实际 OpenClaw API 调用
     */
    async executeShell(command) {
        try {
            const { stdout, stderr } = await execAsync(command, {
                timeout: this.timeout,
                maxBuffer: 10 * 1024 * 1024  // 10MB 缓冲区
            });

            const output = stdout || stderr;

            return {
                text: output || '命令执行成功（无输出）',
                json: {
                    stdout: stdout || '',
                    stderr: stderr || '',
                    exitCode: 0
                },
                logs: stderr || ''
            };
        } catch (error) {
            // 超时或执行失败
            if (error.killed) {
                throw new Error(`命令超时（超过 ${this.timeout / 1000} 秒）`);
            }

            throw new Error(`执行错误: ${error.message}\n${error.stderr || ''}`);
        }
    }

    /**
     * 格式化运行时间
     */
    formatUptime(seconds) {
        const days = Math.floor(seconds / 86400);
        const hours = Math.floor((seconds % 86400) / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const secs = Math.floor(seconds % 60);

        const parts = [];
        if (days > 0) parts.push(`${days}天`);
        if (hours > 0) parts.push(`${hours}小时`);
        if (minutes > 0) parts.push(`${minutes}分钟`);
        parts.push(`${secs}秒`);

        return parts.join(' ');
    }

    /**
     * 格式化字节数
     */
    formatBytes(bytes) {
        const units = ['B', 'KB', 'MB', 'GB'];
        let size = bytes;
        let unitIndex = 0;

        while (size >= 1024 && unitIndex < units.length - 1) {
            size /= 1024;
            unitIndex++;
        }

        return `${size.toFixed(2)} ${units[unitIndex]}`;
    }
}

export default Executor;
