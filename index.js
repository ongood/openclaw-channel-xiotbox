const WSSClient = require('./wss_client');
const Executor = require('./executor');
const config = require('./config');

/**
 * OpenClaw XiotBox 插件主入口
 * 
 * 功能：
 * 1. 加载配置（环境变量或配置文件）
 * 2. 执行配对流程（如果没有 device_token）
 * 3. 连接到 XiotBox Gateway（WSS）
 * 4. 处理命令执行与结果回传
 */
async function main() {
  console.log('[XiotBox] OpenClaw Plugin starting...');
  console.log('[XiotBox] Version:', require('./package.json').version);
  
  // 1. 加载配置
  let cfg;
  try {
    cfg = config.load();
  } catch (err) {
    console.error('[XiotBox] Failed to load config:', err.message);
    process.exit(1);
  }
  
  // 验证必要配置
  if (!cfg.GATEWAY_WSS_URL) {
    console.error('[XiotBox] ERROR: GATEWAY_WSS_URL not configured');
    console.error('[XiotBox] Please set environment variable or add to .env file');
    process.exit(1);
  }
  
  // 2. 如果没有设备凭证，先执行配对
  if (!cfg.DEVICE_ID || !cfg.DEVICE_TOKEN) {
    if (!cfg.PAIR_CODE) {
      console.error('[XiotBox] ERROR: No device credentials found');
      console.error('[XiotBox] Please provide PAIR_CODE to pair this device');
      console.error('[XiotBox] Example: PAIR_CODE=ABC123 npm start');
      process.exit(1);
    }
    
    console.log('[XiotBox] No device credentials found, starting pairing...');
    try {
      await config.pair(cfg);
      console.log('[XiotBox] Pairing successful!');
    } catch (err) {
      console.error('[XiotBox] Pairing failed:', err.message);
      process.exit(1);
    }
  }
  
  console.log('[XiotBox] Device ID:', cfg.DEVICE_ID);
  console.log('[XiotBox] Gateway:', cfg.GATEWAY_WSS_URL);
  
  // 3. 创建 WSS 客户端和执行器
  const wss = new WSSClient(cfg);
  const executor = new Executor(cfg);
  
  // 4. 注册消息处理器
  wss.on('COMMAND', async (payload) => {
    const { command_id, type, payload: cmdPayload, trace_id } = payload;
    
    console.log(`[Command] Received: ${command_id} (type: ${type})`);
    
    // 先发送 ACK（表示收到命令）
    wss.sendMessage('ACK', { 
      command_id, 
      trace_id,
      received_at: Date.now()
    });
    
    // 执行命令
    try {
      console.log(`[Command] Executing: ${cmdPayload.text}`);
      const result = await executor.execute(cmdPayload);
      
      // 发送成功结果
      wss.sendMessage('RESULT', {
        command_id,
        trace_id,
        success: true,
        output_text: result.text,
        output_json: result.json,
        logs_excerpt: result.logs || ''
      });
      
      console.log(`[Command] Success: ${command_id}`);
    } catch (error) {
      // 发送失败结果
      wss.sendMessage('RESULT', {
        command_id,
        trace_id,
        success: false,
        error: error.message,
        output_text: `执行失败: ${error.message}`,
        output_json: {},
        logs_excerpt: error.stack || ''
      });
      
      console.error(`[Command] Failed: ${command_id}`, error.message);
    }
  });
  
  // 处理连接状态变化
  wss.on('connected', () => {
    console.log('[XiotBox] ✓ Connected to gateway');
  });
  
  wss.on('disconnected', () => {
    console.log('[XiotBox] ✗ Disconnected from gateway');
  });
  
  wss.on('error', (err) => {
    console.error('[XiotBox] Error:', err.message);
  });
  
  // 5. 连接到 Gateway
  try {
    await wss.connect();
  } catch (err) {
    console.error('[XiotBox] Failed to connect:', err.message);
    process.exit(1);
  }
  
  console.log('[XiotBox] Plugin running, press Ctrl+C to exit');
  
  // 优雅关闭
  process.on('SIGINT', async () => {
    console.log('\n[XiotBox] Shutting down...');
    await wss.disconnect();
    process.exit(0);
  });
}

// 启动
main().catch(err => {
  console.error('[XiotBox] Fatal error:', err);
  process.exit(1);
});
