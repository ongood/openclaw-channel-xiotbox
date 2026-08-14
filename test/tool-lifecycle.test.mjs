import assert from 'node:assert/strict';
import test from 'node:test';

import {
  handleAfterToolCall,
  handleBeforeToolCall,
  registerActiveToolRun,
  resetActiveToolRunsForTest,
} from '../dist/src/tool-lifecycle.js';

test.beforeEach(() => resetActiveToolRunsForTest());

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

  handleBeforeToolCall({ toolName: 'exec', toolCallId: 'call-1', params: { command: 'secret' } }, ctx);
  handleAfterToolCall({
    toolName: 'exec',
    toolCallId: 'call-1',
    result: { stdout: 'secret result' },
    durationMs: 42,
  }, ctx);

  assert.deepEqual(emitted, [
    {
      kind: 'tool.call', occurrenceId: 'tool:call-1:call',
      payload: {
        tool_name: 'exec', tool_call_id: 'call-1', runtime_run_id: 'openclaw-run-1', status: 'running',
      },
    },
    {
      kind: 'tool.result', occurrenceId: 'tool:call-1:result',
      payload: {
        tool_name: 'exec', tool_call_id: 'call-1', runtime_run_id: 'openclaw-run-1',
        status: 'completed', duration_ms: 42,
      },
    },
  ]);
  assert.equal(JSON.stringify(emitted).includes('secret'), false);

  unregister();
  handleBeforeToolCall({ toolName: 'exec', toolCallId: 'call-2' }, ctx);
  assert.equal(emitted.length, 2);
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

test('reports failure without persisting the tool error text', () => {
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
});
