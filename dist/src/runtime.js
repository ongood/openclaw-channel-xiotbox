let runtime = null;

export function setXiotboxRuntime(next) {
  runtime = next;
}

export function getXiotboxRuntime() {
  if (!runtime) {
    throw new Error('XiotBox runtime not initialized');
  }
  return runtime;
}
