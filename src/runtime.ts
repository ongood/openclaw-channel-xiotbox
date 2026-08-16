export type RuntimeReplySurface = {
  dispatchReplyWithBufferedBlockDispatcher?: (args: Record<string, unknown>) => Promise<any>;
  createReplyDispatcherWithTyping?: (args: Record<string, unknown>) => any;
  finalizeInboundContext?: (ctx: unknown) => any;
  dispatchReplyFromConfig?: (args: Record<string, unknown>) => Promise<any>;
  [key: string]: unknown;
};

export type PluginRuntimeSystem = {
  /**
   * Queues a heartbeat wake for a specific agent/session. Exposed by the host
   * runtime (`api.runtime.system`); absent on hosts older than the seam.
   */
  requestHeartbeat?: (opts: {
    source?: string;
    intent?: string;
    reason?: string;
    agentId?: string;
    sessionKey?: string;
  }) => void;
  enqueueSystemEvent?: (text: string, options?: Record<string, unknown>) => boolean;
};

export type PluginRuntime = {
  config?: {
    loadConfig?: () => unknown;
  };
  channel?: {
    reply?: RuntimeReplySurface;
  };
  system?: PluginRuntimeSystem;
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
