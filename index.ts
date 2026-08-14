import { xiotboxPlugin } from './src/channel.js';
import { createXiotboxLocalControlTool } from './src/local-control-tool.js';
import { setXiotboxRuntime } from './src/runtime.js';
import { handleMemoryAgentEvent } from './src/memory-lifecycle.js';
import { handleSubagentEnded, handleSubagentSpawned } from './src/subagent-lifecycle.js';
import { handleAfterToolCall, handleBeforeToolCall } from './src/tool-lifecycle.js';
import { createXiotboxControlTool } from './src/xiotbox-control-tool.js';

type XiotboxPluginApi = {
  logger?: unknown;
  runtime: {
    config?: {
      loadConfig?: () => unknown;
    };
  };
  registrationMode?: string;
  registerChannel: (params: { plugin: unknown }) => void;
  registerTool: (tool: unknown, options?: { optional?: boolean }) => void;
  on: (hookName: string, handler: (event: any, ctx: any) => void | Promise<void>) => void;
  agent?: {
    events?: {
      registerAgentEventSubscription?: (subscription: {
        id: string;
        description?: string;
        streams?: string[];
        handle: (event: any, ctx: any) => void | Promise<void>;
      }) => void;
    };
  };
};

function registerXiotboxTools(api: XiotboxPluginApi): void {
  api.registerTool(
    createXiotboxLocalControlTool({
      getConfig: () => api?.runtime?.config?.loadConfig?.() ?? {},
      logger: api?.logger,
    }),
    { optional: true },
  );
  api.registerTool(
    createXiotboxControlTool({
      getConfig: () => api?.runtime?.config?.loadConfig?.() ?? {},
      logger: api?.logger,
    }),
    { optional: true },
  );
}

export default {
  id: 'xiotbox',
  name: 'XiotBox Channel',
  description: 'XiotBox channel plugin for WSS device connectivity and OpenClaw runtime dispatch.',
  plugin: xiotboxPlugin,
  register(api: XiotboxPluginApi) {
    setXiotboxRuntime(api.runtime);
    api.registerChannel({ plugin: xiotboxPlugin });
    if (api.registrationMode !== 'full') {
      return;
    }
    api.on('before_tool_call', handleBeforeToolCall);
    api.on('after_tool_call', handleAfterToolCall);
    api.on('subagent_spawned', handleSubagentSpawned);
    api.on('subagent_ended', handleSubagentEnded);
    api.agent?.events?.registerAgentEventSubscription?.({
      id: 'xiotbox-memory-lifecycle',
      description: 'Project redacted memory tool lifecycle events to XiotBox Gateway.',
      streams: ['tool'],
      handle: (event) => handleMemoryAgentEvent(event),
    });
    registerXiotboxTools(api);
  },
};
