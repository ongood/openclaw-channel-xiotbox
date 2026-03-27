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
export default {
    id: 'xiotbox',
    name: 'XiotBox Channel',
    description: 'XiotBox channel plugin for WSS device connectivity and OpenClaw runtime dispatch.',
    plugin: xiotboxPlugin,
    register(api) {
        setXiotboxRuntime(api.runtime);
        api.registerChannel({ plugin: xiotboxPlugin });
        if (api.registrationMode !== 'full') {
            return;
        }
        registerXiotboxTools(api);
    },
};
