import { defineChannelPluginEntry } from 'openclaw/plugin-sdk/core';
import { xiotboxPlugin } from './src/channel.js';
import { createXiotboxLocalControlTool } from './src/local-control-tool.js';
import { setXiotboxRuntime } from './src/runtime.js';
import { createXiotboxControlTool } from './src/xiotbox-control-tool.js';
function registerXiotboxTools(api) {
    api.registerTool(createXiotboxLocalControlTool({
        getConfig: () => api?.runtime?.config?.loadConfig?.() ?? {},
        logger: api?.logger,
    }), { optional: true });
    api.registerTool(createXiotboxControlTool({
        getConfig: () => api?.runtime?.config?.loadConfig?.() ?? {},
        logger: api?.logger,
    }), { optional: true });
}
export default defineChannelPluginEntry({
    id: 'xiotbox',
    name: 'XiotBox Channel',
    description: 'XiotBox channel plugin for WSS device connectivity and OpenClaw runtime dispatch.',
    plugin: xiotboxPlugin,
    setRuntime: setXiotboxRuntime,
    registerFull(api) {
        registerXiotboxTools(api);
    },
});
