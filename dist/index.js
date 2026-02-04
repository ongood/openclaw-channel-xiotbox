import { setXiotboxRuntime } from './src/runtime.js';
import { xiotboxPlugin } from './src/channel.js';

const plugin = {
  id: 'xiotbox',
  name: 'XiotBox Channel',
  description: 'XiotBox channel plugin — connect XiotBox devices via WSS and dispatch to OpenClaw runtime.',
  register(api) {
    setXiotboxRuntime(api.runtime);
    api.registerChannel({ plugin: xiotboxPlugin });
  },
};

export default plugin;
