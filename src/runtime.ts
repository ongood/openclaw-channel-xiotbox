export type PluginRuntime = {
  config?: {
    loadConfig?: () => unknown;
  };
  channel?: {
    reply?: Record<string, any>;
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
