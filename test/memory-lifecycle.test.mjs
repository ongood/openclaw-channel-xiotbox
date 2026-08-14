import assert from 'node:assert/strict';
import test from 'node:test';

import {
  handleMemoryAgentEvent,
  registerActiveMemoryBinding,
  registerMemoryLifecycleAccount,
  resetMemoryLifecycleForTest,
} from '../dist/src/memory-lifecycle.js';

test.beforeEach(() => resetMemoryLifecycleForTest());

function setup() {
  const emitted = [];
  const unregisterAccount = registerMemoryLifecycleAccount({
    accountId: 'default',
    deviceId: 'device-1',
    emit: (event) => emitted.push(event),
  });
  const unregisterBinding = registerActiveMemoryBinding({
    accountId: 'default',
    deviceId: 'device-1',
    sessionKey: 'agent:main:xiotbox:device-1:conversation-1',
    bindingId: 'binding-1',
    conversationId: 'conversation-1',
    agentId: 'main',
    runId: 'command-1',
    traceId: 'trace-1',
  });
  return { emitted, unregisterAccount, unregisterBinding };
}

function event(overrides = {}) {
  return {
    stream: 'tool',
    runId: 'runtime-run-1',
    sessionKey: 'agent:main:xiotbox:device-1:conversation-1',
    agentId: 'main',
    data: {
      phase: 'result',
      name: 'memory_search',
      toolCallId: 'call-1',
      result: {
        hits: [
          {
            id: 'memory/private-note.md',
            source: 'memory',
            score: 0.8,
            text: 'super-secret memory text',
            content: 'private content',
          },
        ],
      },
      ...overrides,
    },
  };
}

test('projects redacted memory hits and drops sensitive content', () => {
  const harness = setup();
  handleMemoryAgentEvent(event());
  assert.equal(harness.emitted.length, 1);
  assert.equal(harness.emitted[0].kind, 'memory.hit');
  assert.equal(harness.emitted[0].payload.tool_name, 'memory_search');
  assert.equal(harness.emitted[0].payload.count, 1);
  assert.equal(harness.emitted[0].payload.refs[0].id, 'memory/private-note.md');
  assert.equal(harness.emitted[0].payload.refs[0].source, 'memory');
  assert.equal(harness.emitted[0].payload.refs[0].score, 0.8);
  assert.equal(JSON.stringify(harness.emitted).includes('super-secret'), false);
  assert.equal(JSON.stringify(harness.emitted).includes('private content'), false);
  harness.unregisterBinding();
  harness.unregisterAccount();
});

test('projects saved and deleted actions for recognized memory tools', () => {
  const harness = setup();
  handleMemoryAgentEvent(event({ name: 'memory_save', result: { ok: true } }));
  assert.equal(harness.emitted[0].kind, 'memory.saved');
  assert.equal(harness.emitted[0].payload.count, undefined);

  handleMemoryAgentEvent(event({ name: 'memory_delete', result: { ok: true } }));
  assert.equal(harness.emitted[1].kind, 'memory.deleted');
  harness.unregisterBinding();
  harness.unregisterAccount();
});

test('fails closed for missing or ambiguous session bindings', () => {
  const harness = setup();
  const unknown = event();
  unknown.sessionKey = 'unknown';
  handleMemoryAgentEvent(unknown);
  assert.equal(harness.emitted.length, 0);

  const unregisterSecond = registerActiveMemoryBinding({
    accountId: 'default',
    deviceId: 'device-1',
    sessionKey: 'agent:main:xiotbox:device-1:conversation-1',
    bindingId: 'binding-1',
    conversationId: 'conversation-1',
    agentId: 'main',
    runId: 'command-2',
    traceId: 'trace-2',
  });
  handleMemoryAgentEvent(event());
  assert.equal(harness.emitted.length, 0);
  unregisterSecond();
  harness.unregisterBinding();
  harness.unregisterAccount();
});

test('ignores failed tool results and unknown tools', () => {
  const harness = setup();
  handleMemoryAgentEvent(event({ isError: true }));
  assert.equal(harness.emitted.length, 0);
  handleMemoryAgentEvent(event({ name: 'exec' }));
  assert.equal(harness.emitted.length, 0);
  harness.unregisterBinding();
  harness.unregisterAccount();
});
