import { setXiotboxRuntime } from './src/runtime.js';
import { xiotboxPlugin } from './src/channel.js';
import { createXiotboxLocalControlTool } from './src/local-control-tool.js';
const plugin = {
    id: 'xiotbox',
    name: 'XiotBox Channel',
    description: 'XiotBox channel plugin — connect XiotBox devices via WSS and dispatch to OpenClaw runtime.',
    register(api) {
        setXiotboxRuntime(api.runtime);
        api.registerChannel({ plugin: xiotboxPlugin });
        if (typeof api.registerTool === 'function') {
            api.registerTool(createXiotboxLocalControlTool({
                getConfig: () => api?.runtime?.config?.loadConfig?.() ?? {},
                logger: api?.logger,
            }), { optional: true });
        }
        else {
            api?.logger?.warn?.('[XiotBox] registerTool API not available, skip local control tool');
        }
    },
};
export default plugin;
