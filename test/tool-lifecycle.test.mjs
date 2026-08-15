import assert from 'node:assert/strict';
import test from 'node:test';

import {
  handleAfterToolCall,
  handleBeforeToolCall,
  registerActiveToolRun,
  resetActiveToolRunsForTest,
  resetSessionPermissionsForTest,
  setSessionPermission,
} from '../dist/src/tool-lifecycle.js';

test.beforeEach(() => {
  resetActiveToolRunsForTest();
  resetSessionPermissionsForTest();
});

test('projects redacted tool lifecycle for an authorized active session', () => {
  const emitted = [];
  const unregister = registerActiveToolRun({
    sessionKey: 'agent:supervisor:xiotbox:thread-1',
    agentId: 'supervisor',
    emit: (kind, payload, occurrenceId) => emitted.push({ kind, payload, occurrenceId }),
  });
  const ctx = {
    sessionKey: 'agent:supervisor:xiotbox:thread-1',
    agentId: 'supervisor',
    runId: 'openclaw-run-1',
    toolCallId: 'call-1',
    toolName: 'exec',
  };

  handleBeforeToolCall({
    toolName: 'exec',
    toolCallId: 'call-1',
    params: { command: 'echo hello', api_key: 'sk-SECRET_TOKEN_1234567890' },
  }, ctx);
  handleAfterToolCall({
    toolName: 'exec',
    toolCallId: 'call-1',
    result: { stdout: 'hello\n', exitCode: 0 },
    durationMs: 42,
  }, ctx);

  assert.equal(emitted.length, 2);
  assert.equal(emitted[0].kind, 'tool.call');
  assert.equal(emitted[0].payload.tool_name, 'exec');
  assert.equal(emitted[0].payload.status, 'running');
  // Command is projectable; the API key value must be redacted.
  assert.ok(emitted[0].payload.params.includes('echo hello'));
  assert.equal(emitted[0].payload.params.includes('sk-SECRET_TOKEN'), false);
  assert.equal(emitted[0].payload.params.includes('sk-SECRET_TOKEN_1234567890'), false);

  assert.equal(emitted[1].kind, 'tool.result');
  assert.equal(emitted[1].payload.status, 'completed');
  assert.equal(emitted[1].payload.duration_ms, 42);
  assert.ok(emitted[1].payload.result.includes('hello'));
  assert.equal(JSON.stringify(emitted).includes('sk-SECRET_TOKEN'), false);

  unregister();
  handleBeforeToolCall({ toolName: 'exec', toolCallId: 'call-2' }, ctx);
  assert.equal(emitted.length, 2);
});

test('redacts secret-form values inside strings and key=value credentials', () => {
  const emitted = [];
  registerActiveToolRun({
    sessionKey: 'session-1',
    agentId: 'agent-1',
    emit: (kind, payload) => emitted.push({ kind, payload }),
  });
  handleBeforeToolCall({
    toolName: 'exec',
    toolCallId: 'call-a',
    params: { command: 'curl -H "Authorization: Bearer abcdefgh12345678" https://x' },
  }, { sessionKey: 'session-1', agentId: 'agent-1' });

  const text = JSON.stringify(emitted);
  assert.equal(text.includes('abcdefgh12345678'), false);
  assert.ok(emitted[0].payload.params.includes('[redacted]'));
});

test('fails closed for missing correlation or ambiguous active sessions', () => {
  const emitted = [];
  const options = {
    sessionKey: 'agent:supervisor:xiotbox:thread-1',
    agentId: 'supervisor',
    emit: (...args) => emitted.push(args),
  };
  const unregisterFirst = registerActiveToolRun(options);
  handleBeforeToolCall(
    { toolName: 'exec', toolCallId: 'call-1' },
    { sessionKey: options.sessionKey, agentId: options.agentId },
  );
  handleBeforeToolCall(
    { toolName: 'exec' },
    { sessionKey: options.sessionKey, agentId: options.agentId },
  );
  handleBeforeToolCall(
    { toolName: 'exec', toolCallId: 'call-2' },
    { sessionKey: 'another-session', agentId: options.agentId },
  );
  assert.equal(emitted.length, 1);

  const unregisterSecond = registerActiveToolRun(options);
  handleBeforeToolCall(
    { toolName: 'exec', toolCallId: 'call-3', runId: 'ambiguous-run' },
    { sessionKey: options.sessionKey, agentId: options.agentId },
  );
  assert.equal(emitted.length, 1);
  unregisterSecond();
  unregisterFirst();
});

test('reports failure without persisting the tool error secret', () => {
  const emitted = [];
  registerActiveToolRun({
    sessionKey: 'session-1',
    agentId: 'agent-1',
    emit: (kind, payload) => emitted.push({ kind, payload }),
  });
  handleAfterToolCall(
    { toolName: 'browser', toolCallId: 'call-9', error: 'credential=top-secret' },
    { sessionKey: 'session-1', agentId: 'agent-1' },
  );
  assert.equal(emitted[0].kind, 'tool.result');
  assert.equal(emitted[0].payload.status, 'failed');
  assert.equal(JSON.stringify(emitted).includes('top-secret'), false);
  assert.equal(emitted[0].payload.error.includes('[redacted]'), true);
});

test('readonly session blocks write/exec tools but allows reads', () => {
  const emitted = [];
  registerActiveToolRun({
    sessionKey: 'session-1',
    agentId: 'agent-1',
    emit: (kind, payload) => emitted.push({ kind, payload }),
  });
  setSessionPermission('session-1', 'readonly');

  const blocked = handleBeforeToolCall(
    { toolName: 'exec', toolCallId: 'call-1' },
    { sessionKey: 'session-1', agentId: 'agent-1' },
  );
  assert.equal(blocked?.block, true);
  assert.ok(blocked?.blockReason?.includes('readonly'));
  assert.equal(emitted.length, 0);

  const allowed = handleBeforeToolCall(
    { toolName: 'read', toolCallId: 'call-2' },
    { sessionKey: 'session-1', agentId: 'agent-1' },
  );
  assert.equal(allowed, undefined);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].kind, 'tool.call');
  assert.equal(emitted[0].payload.tool_name, 'read');
});
