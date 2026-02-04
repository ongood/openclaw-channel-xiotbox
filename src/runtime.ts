export type PluginRuntime = any;

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
