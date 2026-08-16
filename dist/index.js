import { xiotboxPlugin } from './src/channel.js';
import { createXiotboxLocalControlTool } from './src/local-control-tool.js';
import { setXiotboxRuntime } from './src/runtime.js';
import { handleMemoryAfterToolCall, handleMemoryAgentEvent } from './src/memory-lifecycle.js';
import { handleSubagentEnded, handleSubagentSpawned } from './src/subagent-lifecycle.js';
import { handleAfterToolCall, handleBeforeToolCall } from './src/tool-lifecycle.js';
import { handleBeforeModelResolve } from './src/session-model.js';
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
        api.on('before_tool_call', handleBeforeToolCall);
        api.on('after_tool_call', handleAfterToolCall);
        api.on('after_tool_call', handleMemoryAfterToolCall);
        api.on('subagent_spawned', handleSubagentSpawned);
        api.on('subagent_ended', handleSubagentEnded);
        api.on('before_model_resolve', handleBeforeModelResolve);
        const memorySubscription = {
            id: 'xiotbox-memory-lifecycle',
            description: 'Project redacted memory tool lifecycle events to XiotBox Gateway.',
            streams: ['tool'],
            handle: (event) => handleMemoryAgentEvent(event),
        };
        const registerMemorySubscription = api.agent?.events?.registerAgentEventSubscription ?? api.registerAgentEventSubscription;
        registerMemorySubscription?.call(api.agent?.events ?? api, memorySubscription);
        registerXiotboxTools(api);
    },
};
