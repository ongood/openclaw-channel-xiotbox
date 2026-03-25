import { defineSetupPluginEntry } from 'openclaw/plugin-sdk/core';
import { xiotboxPlugin } from './src/channel.js';

export default defineSetupPluginEntry(xiotboxPlugin);
