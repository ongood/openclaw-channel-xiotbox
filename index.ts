import { setXiotboxRuntime } from './src/runtime';
import { xiotboxPlugin } from './src/channel';

const plugin = {
  id: 'xiotbox',
  name: 'XiotBox Channel',
  description: 'XiotBox channel plugin — connect XiotBox devices via WSS and dispatch to OpenClaw runtime.',
  register(api: any) {
    setXiotboxRuntime(api.runtime);
    api.registerChannel({ plugin: xiotboxPlugin });
  },
};

export default plugin;
