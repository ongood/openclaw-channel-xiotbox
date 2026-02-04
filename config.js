require('dotenv').config();
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const CONFIG_FILE = path.join(__dirname, 'config.json');

/**
 * 加载配置（优先级：环境变量 > 配置文件）
 */
function load() {
    let config = {
        GATEWAY_WSS_URL: process.env.GATEWAY_WSS_URL || '',
        GATEWAY_API_URL: process.env.GATEWAY_API_URL || '',
        PAIR_CODE: process.env.PAIR_CODE || '',
        DEVICE_ID: process.env.DEVICE_ID || '',
        DEVICE_TOKEN: process.env.DEVICE_TOKEN || '',
        TENANT_ID: process.env.TENANT_ID || '',
        COMMAND_TIMEOUT: parseInt(process.env.COMMAND_TIMEOUT || '300000', 10)
    };

    // 从文件加载持久化配置（设备凭证）
    if (fs.existsSync(CONFIG_FILE)) {
        try {
            const fileConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
            // 文件中的配置优先级低于环境变量
            config = { ...fileConfig, ...config };
            console.log('[Config] Loaded from file:', CONFIG_FILE);
        } catch (err) {
            console.warn('[Config] Failed to load config file:', err.message);
        }
    }

    // 自动推断 GATEWAY_API_URL（如果未设置）
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
    const toSave = {
        DEVICE_ID: config.DEVICE_ID,
        DEVICE_TOKEN: config.DEVICE_TOKEN,
        GATEWAY_WSS_URL: config.GATEWAY_WSS_URL,
        GATEWAY_API_URL: config.GATEWAY_API_URL,
        TENANT_ID: config.TENANT_ID
    };

    try {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(toSave, null, 2), 'utf8');
        console.log('[Config] Saved to', CONFIG_FILE);
    } catch (err) {
        console.error('[Config] Failed to save config:', err.message);
    }
}

/**
 * 执行配对流程（使用 pair_code 换取 device_token）
 */
async function pair(config) {
    if (!config.PAIR_CODE) {
        throw new Error('PAIR_CODE not provided (set via environment variable or .env)');
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
        hostname: require('os').hostname(),
        version: require('./package.json').version,
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

module.exports = { load, save, pair };
