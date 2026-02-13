import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';
import os from 'os';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { loadRuntimeConfig } from './dist/src/runtime_config.js';

const require = createRequire(import.meta.url);
const pkg = require('./package.json');

/**
 * 加载配置（统一从 OPENCLAW_HOME/xiotbox/config.json + secret.json）
 */
function load() {
    const runtime = loadRuntimeConfig();
    const { xiotbox } = runtime;

    const config = {
        GATEWAY_WSS_URL: xiotbox.GATEWAY_WSS_URL || '',
        GATEWAY_API_URL: xiotbox.GATEWAY_API_URL || '',
        PAIR_CODE: '',
        DEVICE_ID: xiotbox.DEVICE_ID || '',
        DEVICE_TOKEN: xiotbox.DEVICE_TOKEN || '',
        TENANT_ID: xiotbox.TENANT_ID || '',
        USE_QUERY_AUTH: !!xiotbox.USE_QUERY_AUTH,
        COMMAND_TIMEOUT: xiotbox.COMMAND_TIMEOUT || 300000
    };

    if (!config.GATEWAY_API_URL && config.GATEWAY_WSS_URL) {
        config.GATEWAY_API_URL = config.GATEWAY_WSS_URL
            .replace('wss://', 'https://')
            .replace('ws://', 'http://')
            .replace('/ws/openclaw', '');
    }

    return config;
}

/**
 * 保存配置到文件（只保存设备凭证）
 */
function save(config) {
    const runtime = loadRuntimeConfig();

    const nextConfig = {
        xiotbox: {
            ...runtime.xiotbox,
            GATEWAY_WSS_URL: config.GATEWAY_WSS_URL,
            GATEWAY_API_URL: config.GATEWAY_API_URL,
            TENANT_ID: config.TENANT_ID,
            USE_QUERY_AUTH: !!config.USE_QUERY_AUTH,
            COMMAND_TIMEOUT: config.COMMAND_TIMEOUT || runtime.xiotbox.COMMAND_TIMEOUT
        },
        bridge: {
            ...runtime.bridge
        }
    };

    const nextSecrets = {
        xiotbox: {
            DEVICE_ID: config.DEVICE_ID,
            DEVICE_TOKEN: config.DEVICE_TOKEN,
            LOCAL_CONTROL_TOKEN: runtime.xiotbox.LOCAL_CONTROL_TOKEN
        },
        bridge: {
            GATEWAY_TOKEN: runtime.bridge.GATEWAY_TOKEN
        }
    };

    try {
        fs.writeFileSync(runtime.configPath, JSON.stringify(nextConfig, null, 2), 'utf8');
        fs.writeFileSync(runtime.secretPath, JSON.stringify(nextSecrets, null, 2), 'utf8');
        console.log('[Config] Saved to', runtime.configPath);
    } catch (err) {
        console.error('[Config] Failed to save config:', err.message);
    }
}

/**
 * 执行配对流程（使用 pair_code 换取 device_token）
 */
async function pair(config) {
    if (!config.PAIR_CODE) {
        throw new Error('PAIR_CODE not provided (set in config.PAIR_CODE before calling pair)');
    }

    const apiUrl = config.GATEWAY_API_URL;
    if (!apiUrl) {
        throw new Error('GATEWAY_API_URL not configured');
    }

    const pairUrl = `${apiUrl}/openclaw/pair/exchange`;

    console.log('[Pairing] Exchanging pair_code for device_token...');
    console.log('[Pairing] Gateway:', apiUrl);

    // 准备设备信息
    const deviceInfo = {
        hostname: os.hostname(),
        version: pkg.version,
        capabilities: {
            commands: ['help', 'status', 'ping', 'version'],
            streaming: false
        },
        platform: process.platform,
        arch: process.arch,
        node_version: process.version
    };

    try {
        const resp = await httpPost(pairUrl, {
            pair_code: config.PAIR_CODE,
            device_info: deviceInfo
        });

        // 更新配置
        config.DEVICE_ID = resp.device_id;
        config.DEVICE_TOKEN = resp.device_token;

        // 保存到文件
        save(config);

        console.log('[Pairing] ✓ Success!');
        console.log('[Pairing] Device ID:', config.DEVICE_ID);

    } catch (err) {
        throw new Error(`Pairing failed: ${err.message}`);
    }
}

/**
 * HTTP POST 请求
 */
function httpPost(url, data) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify(data);
        const urlObj = new URL(url);

        const options = {
            hostname: urlObj.hostname,
            port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
            path: urlObj.pathname + urlObj.search,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body)
            }
        };

        const protocol = urlObj.protocol === 'https:' ? https : http;

        const req = protocol.request(options, (res) => {
            let responseBody = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => responseBody += chunk);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    try {
                        resolve(JSON.parse(responseBody));
                    } catch (err) {
                        reject(new Error(`Invalid JSON response: ${responseBody}`));
                    }
                } else {
                    reject(new Error(`HTTP ${res.statusCode}: ${responseBody}`));
                }
            });
        });

        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

export { load, save, pair };
export default { load, save, pair };
