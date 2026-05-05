export type RuntimeReplySurface = {
  dispatchReplyWithBufferedBlockDispatcher?: (args: Record<string, unknown>) => Promise<any>;
  createReplyDispatcherWithTyping?: (args: Record<string, unknown>) => any;
  finalizeInboundContext?: (ctx: unknown) => any;
  dispatchReplyFromConfig?: (args: Record<string, unknown>) => Promise<any>;
  [key: string]: unknown;
};

export type PluginRuntime = {
  config?: {
    loadConfig?: () => unknown;
  };
  channel?: {
    reply?: RuntimeReplySurface;
  };
};

let runtime: PluginRuntime | null = null;

export function setXiotboxRuntime(next: PluginRuntime): void {
  runtime = next;
}

export function getXiotboxRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("XiotBox runtime not initialized");
  }
  return runtime;
}

export function getXiotboxRuntimeOrNull(): PluginRuntime | null {
  return runtime;
}
