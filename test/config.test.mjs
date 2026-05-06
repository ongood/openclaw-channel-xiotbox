import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildConfig,
  buildSessionKey,
  getChannelConfig,
  normalizeAccountId,
  normalizeAgentId,
  normalizeContextEpoch,
  normalizeStrList,
  normalizeThreadId,
  resolveAccount,
  resolveDefaultAccountId,
  resolveEffectiveConfig,
  resolveThreadAgentId,
} from '../dist/src/config.js';
import { setXiotboxRuntime } from '../dist/src/runtime.js';

test('getChannelConfig returns xiotbox channel config', () => {
  const cfg = { channels: { xiotbox: { DEVICE_ID: 'dev1' } } };
  assert.deepEqual(getChannelConfig(cfg), { DEVICE_ID: 'dev1' });
  assert.deepEqual(getChannelConfig({}), {});
});

test('buildConfig applies defaults and normalized booleans/lists', () => {
  const built = buildConfig({
    DEVICE_ID: 'dev1',
    DEVICE_TOKEN: 'tok',
    STREAMING: 'false',
    BLOCK_STREAMING: 'true',
    PROGRESS_THROTTLE_MS: '250',
    PROGRESS_MAX_UPDATES: '5',
    SCOPES: 'chat, control',
    CONTROL_ACTIONS: ['tap', 'swipe'],
  });
  assert.equal(built.GATEWAY_WSS_URL, 'ws://localhost:9002/ws/bot');
  assert.equal(built.STREAMING, false);
  assert.equal(built.BLOCK_STREAMING, true);
  assert.equal(built.PROGRESS_THROTTLE_MS, 250);
  assert.equal(built.PROGRESS_MAX_UPDATES, 5);
  assert.deepEqual(built.SCOPES, ['chat', 'control']);
  assert.deepEqual(built.CONTROL_ACTIONS, ['tap', 'swipe']);
});

test('normalize helpers handle defaults and safe agent ids', () => {
  assert.equal(normalizeAccountId('  acc  '), 'acc');
  assert.equal(normalizeAccountId(''), 'default');
  assert.equal(normalizeThreadId('  thread  '), 'thread');
  assert.equal(normalizeThreadId(null), 'main');
  assert.equal(normalizeContextEpoch('7.8'), 7);
  assert.equal(normalizeContextEpoch('-1'), 0);
  assert.equal(normalizeAgentId(' Main Agent! '), 'main-agent');
  assert.deepEqual(normalizeStrList('a, b, ,c', []), ['a', 'b', 'c']);
});

test('buildSessionKey includes context epoch only when positive', () => {
  assert.equal(buildSessionKey('Main Agent!', 'dev1', 'thread1'), 'agent:main-agent:xiotbox:dev1:thread1');
  assert.equal(buildSessionKey('main', 'dev1', 'thread1', 2), 'agent:main:xiotbox:dev1:thread1:ctx2');
});

test('resolveThreadAgentId uses thread map before defaults', () => {
  const cfg = {
    agents: { defaults: { id: 'main-default' } },
    channels: {
      xiotbox: {
        SESSION_AGENT_ID: 'channel-default',
        SESSION_AGENT_MAP: {
          support: 'Support Agent',
          '*': 'Fallback Agent',
        },
      },
    },
  };
  assert.equal(resolveThreadAgentId(cfg, 'support'), 'support-agent');
  assert.equal(resolveThreadAgentId(cfg, 'sales'), 'fallback-agent');
});

test('resolveAccount and default account require device credentials', () => {
  assert.deepEqual(resolveAccount({ channels: { xiotbox: { DEVICE_ID: 'd', DEVICE_TOKEN: 't' } } }, ' custom '), {
    accountId: 'custom',
    config: { DEVICE_ID: 'd', DEVICE_TOKEN: 't' },
    enabled: true,
  });
  assert.equal(resolveDefaultAccountId({ channels: { xiotbox: { DEVICE_ID: 'd', DEVICE_TOKEN: 't' } } }), 'default');
  assert.equal(resolveDefaultAccountId({}), 'default');
});

test('resolveEffectiveConfig prefers ctx.cfg over runtime fallback', () => {
  setXiotboxRuntime({
    config: {
      loadConfig: () => ({ source: 'runtime' }),
    },
  });
  assert.deepEqual(resolveEffectiveConfig({ cfg: { source: 'ctx' } }, { source: 'startup' }), { source: 'ctx' });
});

test('resolveEffectiveConfig falls back from runtime to startup config', () => {
  setXiotboxRuntime({
    config: {
      loadConfig: () => ({ source: 'runtime' }),
    },
  });
  assert.deepEqual(resolveEffectiveConfig({}, { source: 'startup' }), { source: 'runtime' });

  setXiotboxRuntime({});
  assert.deepEqual(resolveEffectiveConfig({}, { source: 'startup' }), { source: 'startup' });
});
