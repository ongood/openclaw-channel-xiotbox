import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  handleSubagentEnded,
  handleSubagentParentAgentEnd,
  handleSubagentSpawned,
  registerActiveSubagentParent,
  registerSubagentLifecycleAccount,
  resetSubagentLifecycleForTest,
} from '../dist/src/subagent-lifecycle.js';
import { registerDirectSender } from '../dist/src/direct-send.js';
import {
  handleBeforeToolCall,
  handleAfterToolCall,
  resetActiveToolRunsForTest,
} from '../dist/src/tool-lifecycle.js';

test.beforeEach(() => {
  resetSubagentLifecycleForTest();
  resetActiveToolRunsForTest();
});

function createHarness() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiotbox-subagent-'));
  const filePath = path.join(tempDir, 'children.json');
  const emitted = [];
  const unregisterAccount = registerSubagentLifecycleAccount({
    deviceId: 'device-1',
    filePath,
    emit: (event) => emitted.push(event),
  });
  return { tempDir, filePath, emitted, unregisterAccount };
}

function registerParent() {
  return registerActiveSubagentParent({
    deviceId: 'device-1',
    sessionKey: 'agent:supervisor:xiotbox:device-1:conversation-1',
    bindingId: 'binding-1',
    conversationId: 'conversation-1',
    threadId: 'thread-1',
    agentId: 'supervisor',
    parentRunId: 'command-1',
    traceId: 'trace-1',
  });
}

function spawnChild() {
  handleSubagentSpawned(
    {
      runId: 'child-run-1',
      childSessionKey: 'agent:worker:subagent:child-1',
      agentId: 'worker',
      label: 'implementation worker',
      mode: 'run',
      threadRequested: true,
      resolvedModel: 'deepseek/deepseek-chat',
      resolvedProvider: 'deepseek',
      task: 'sensitive task body',
    },
    {
      runId: 'child-run-1',
      childSessionKey: 'agent:worker:subagent:child-1',
      requesterSessionKey: 'agent:supervisor:xiotbox:device-1:conversation-1',
    },
  );
}

test('projects a redacted subagent tree after the parent dispatch is complete', () => {
  const harness = createHarness();
  const unregisterParent = registerParent();
  spawnChild();
  unregisterParent();

  assert.equal(harness.emitted.length, 1);
  assert.equal(harness.emitted[0].kind, 'subagent.spawned');
  assert.equal(harness.emitted[0].run_id, 'child-run-1');
  assert.equal(harness.emitted[0].parent_run_id, 'command-1');
  assert.equal(harness.emitted[0].actor.id, 'worker');
  assert.equal(JSON.stringify(harness.emitted).includes('sensitive task body'), false);
  assert.equal(JSON.parse(fs.readFileSync(harness.filePath, 'utf8')).children.length, 1);

  handleSubagentEnded(
    {
      targetSessionKey: 'agent:worker:subagent:child-1',
      targetKind: 'subagent',
      runId: 'child-run-1',
      reason: 'credential=secret reason',
      outcome: 'ok',
      error: 'secret error details',
      endedAt: 1234,
    },
    {
      runId: 'child-run-1',
      childSessionKey: 'agent:worker:subagent:child-1',
      requesterSessionKey: 'agent:supervisor:xiotbox:device-1:conversation-1',
    },
  );

  assert.equal(harness.emitted.length, 2);
  assert.equal(harness.emitted[1].kind, 'subagent.completed');
  assert.equal(harness.emitted[1].payload.status, 'ok');
  assert.equal(JSON.stringify(harness.emitted).includes('secret error details'), false);
  assert.equal(JSON.stringify(harness.emitted).includes('secret reason'), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(harness.filePath, 'utf8')).children, []);
  harness.unregisterAccount();
  fs.rmSync(harness.tempDir, { recursive: true, force: true });
});

test('restores child correlation after plugin restart', () => {
  const harness = createHarness();
  const unregisterParent = registerParent();
  spawnChild();
  unregisterParent();
  harness.unregisterAccount();
  resetSubagentLifecycleForTest();

  const restartedEvents = [];
  registerSubagentLifecycleAccount({
    deviceId: 'device-1',
    filePath: harness.filePath,
    emit: (event) => restartedEvents.push(event),
  });
  handleSubagentEnded(
    {
      targetSessionKey: 'agent:worker:subagent:child-1',
      targetKind: 'subagent',
      runId: 'child-run-1',
      reason: 'completed',
      outcome: 'ok',
    },
    { runId: 'child-run-1', childSessionKey: 'agent:worker:subagent:child-1' },
  );

  assert.equal(restartedEvents.length, 1);
  assert.equal(restartedEvents[0].parent_run_id, 'command-1');
  assert.equal(restartedEvents[0].kind, 'subagent.completed');
  fs.rmSync(harness.tempDir, { recursive: true, force: true });
});

test('fails closed when parent correlation is missing or ambiguous', () => {
  const harness = createHarness();
  spawnChild();
  assert.equal(harness.emitted.length, 0);

  const unregisterFirst = registerParent();
  const unregisterSecond = registerParent();
  spawnChild();
  assert.equal(harness.emitted.length, 0);

  unregisterSecond();
  unregisterFirst();
  harness.unregisterAccount();
  fs.rmSync(harness.tempDir, { recursive: true, force: true });
});

test('proactively delivers the requester-settle final through XiotBox', () => {
  const harness = createHarness();
  const unregisterParent = registerParent();
  spawnChild();
  unregisterParent();
  const sent = [];
  const unregisterSender = registerDirectSender('default', (params) => {
    sent.push(params);
    return { delivered: true, commandId: 'direct-1' };
  });

  handleSubagentEnded(
    {
      targetSessionKey: 'agent:worker:subagent:child-1',
      targetKind: 'subagent',
      runId: 'child-run-1',
      outcome: 'ok',
    },
    {
      runId: 'child-run-1',
      childSessionKey: 'agent:worker:subagent:child-1',
      requesterSessionKey: 'agent:supervisor:xiotbox:device-1:conversation-1',
    },
  );
  handleSubagentParentAgentEnd(
    {
      runId: 'announce:requester-settle:supervisor:batch-1',
      success: true,
      messages: [
        { role: 'assistant', content: [{ type: 'text', text: '汇总后的最终结果' }] },
      ],
    },
    { sessionKey: 'agent:supervisor:xiotbox:device-1:conversation-1' },
  );

  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, '汇总后的最终结果');
  assert.equal(sent[0].threadId, 'thread-1');
  assert.equal(sent[0].commandId, 'command-1');
  unregisterSender();
  harness.unregisterAccount();
  fs.rmSync(harness.tempDir, { recursive: true, force: true });
});

test('does not deliver ordinary agent_end output as a subagent result', () => {
  const sent = [];
  const unregisterSender = registerDirectSender('default', (params) => {
    sent.push(params);
    return { delivered: true };
  });
  handleSubagentParentAgentEnd(
    { runId: 'ordinary-run', success: true, messages: [{ role: 'assistant', content: 'hello' }] },
    { sessionKey: 'agent:supervisor:xiotbox:device-1:conversation-1' },
  );
  assert.equal(sent.length, 0);
  unregisterSender();
});

test('filters out requester-settle placeholder text', () => {
  const harness = createHarness();
  const unregisterParent = registerParent();
  spawnChild();
  unregisterParent();
  const sent = [];
  const unregisterSender = registerDirectSender('default', (params) => {
    sent.push(params);
    return { delivered: true, commandId: 'direct-1' };
  });

  handleSubagentEnded(
    { targetSessionKey: 'agent:worker:subagent:child-1', targetKind: 'subagent', runId: 'child-run-1', outcome: 'ok' },
    { runId: 'child-run-1', childSessionKey: 'agent:worker:subagent:child-1', requesterSessionKey: 'agent:supervisor:xiotbox:device-1:conversation-1' },
  );
  // The requester-settle agent only produced a hollow placeholder.
  handleSubagentParentAgentEnd(
    {
      runId: 'announce:requester-settle:supervisor:batch-1',
      success: true,
      messages: [
        { role: 'assistant', content: [{ type: 'text', text: '已推送 ✨ 两份调研结果已完成汇总去重并主动发给你了……' }] },
      ],
    },
    { sessionKey: 'agent:supervisor:xiotbox:device-1:conversation-1' },
  );

  assert.equal(sent.length, 0, 'placeholder-only text should not be delivered');
  unregisterSender();
  harness.unregisterAccount();
  fs.rmSync(harness.tempDir, { recursive: true, force: true });
});

test('collects all assistant messages for requester-settle delivery', () => {
  const harness = createHarness();
  const unregisterParent = registerParent();
  spawnChild();
  unregisterParent();
  const sent = [];
  const unregisterSender = registerDirectSender('default', (params) => {
    sent.push(params);
    return { delivered: true, commandId: 'direct-1' };
  });

  handleSubagentEnded(
    { targetSessionKey: 'agent:worker:subagent:child-1', targetKind: 'subagent', runId: 'child-run-1', outcome: 'ok' },
    { runId: 'child-run-1', childSessionKey: 'agent:worker:subagent:child-1', requesterSessionKey: 'agent:supervisor:xiotbox:device-1:conversation-1' },
  );
  // Multiple assistant messages — the real summary followed by the placeholder.
  handleSubagentParentAgentEnd(
    {
      runId: 'announce:requester-settle:supervisor:batch-1',
      success: true,
      messages: [
        { role: 'assistant', content: [{ type: 'text', text: 'Heartbeat agent 检测到…' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'Embedding provider 共 11 种…' }] },
        { role: 'assistant', content: [{ type: 'text', text: '已推送 ✨ 两份调研结果已完成汇总去重并主动发给你了……' }] },
      ],
    },
    { sessionKey: 'agent:supervisor:xiotbox:device-1:conversation-1' },
  );

  assert.equal(sent.length, 1);
  assert.ok(sent[0].text.includes('Heartbeat agent 检测到'));
  assert.ok(sent[0].text.includes('Embedding provider 共 11 种'));
  assert.ok(!sent[0].text.includes('已推送'), 'placeholder should be filtered out');
  unregisterSender();
  harness.unregisterAccount();
  fs.rmSync(harness.tempDir, { recursive: true, force: true });
});

test('emits child tool events with run_id and parent_run_id', () => {
  const harness = createHarness();
  const unregisterParent = registerParent();
  // Spawn a child — this now registers a tool run for the child session.
  spawnChild();
  unregisterParent();

  // Simulate a tool call in the child session.
  handleBeforeToolCall(
    { toolName: 'exec', toolCallId: 'tc-1', params: { command: 'echo hello' } },
    { sessionKey: 'agent:worker:subagent:child-1', agentId: 'worker', runId: 'child-run-1', toolCallId: 'tc-1' },
  );

  // The tool.call event should have been emitted via the subagent lifecycle account.
  const toolCallEvent = harness.emitted.find((e) => e.kind === 'tool.call');
  assert.ok(toolCallEvent, 'tool.call event should be emitted for child');
  assert.equal(toolCallEvent.run_id, 'child-run-1');
  assert.equal(toolCallEvent.parent_run_id, 'command-1');
  assert.equal(toolCallEvent.actor.type, 'subagent');
  assert.equal(toolCallEvent.payload.tool_name, 'exec');
  assert.equal(toolCallEvent.payload.status, 'running');

  // After the child ends, tool calls should no longer be emitted.
  handleSubagentEnded(
    { targetSessionKey: 'agent:worker:subagent:child-1', targetKind: 'subagent', runId: 'child-run-1', outcome: 'ok' },
    { runId: 'child-run-1', childSessionKey: 'agent:worker:subagent:child-1', requesterSessionKey: 'agent:supervisor:xiotbox:device-1:conversation-1' },
  );

  const beforeCount = harness.emitted.length;
  handleBeforeToolCall(
    { toolName: 'read', toolCallId: 'tc-2', params: { path: '/tmp/x' } },
    { sessionKey: 'agent:worker:subagent:child-1', agentId: 'worker', runId: 'child-run-1', toolCallId: 'tc-2' },
  );
  // No new tool.call event should have been emitted after the child ended.
  const afterToolCall = harness.emitted.slice(beforeCount).find((e) => e.kind === 'tool.call');
  assert.equal(afterToolCall, undefined, 'should not emit tool events after child ends');

  harness.unregisterAccount();
  fs.rmSync(harness.tempDir, { recursive: true, force: true });
});

test('child tool events do not leak into main session view', () => {
  const harness = createHarness();
  const unregisterParent = registerParent();
  spawnChild();
  unregisterParent();

  // Simulate a tool call in the child session.
  handleBeforeToolCall(
    { toolName: 'exec', toolCallId: 'tc-1', params: { command: 'echo hello' } },
    { sessionKey: 'agent:worker:subagent:child-1', agentId: 'worker', runId: 'child-run-1', toolCallId: 'tc-1' },
  );
  handleAfterToolCall(
    { toolName: 'exec', toolCallId: 'tc-1', durationMs: 100, result: 'hello' },
    { sessionKey: 'agent:worker:subagent:child-1', agentId: 'worker', runId: 'child-run-1', toolCallId: 'tc-1' },
  );

  // All child events carry parent_run_id so the Flutter main view can filter them.
  for (const event of harness.emitted) {
    if (event.kind === 'tool.call' || event.kind === 'tool.result') {
      assert.equal(event.parent_run_id, 'command-1', `child ${event.kind} must have parent_run_id`);
      assert.equal(event.run_id, 'child-run-1', `child ${event.kind} must have run_id`);
    }
  }

  harness.unregisterAccount();
  fs.rmSync(harness.tempDir, { recursive: true, force: true });
});

test('preserves a damaged state file and disables projection', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiotbox-subagent-invalid-'));
  const filePath = path.join(tempDir, 'children.json');
  fs.writeFileSync(filePath, '{invalid-json', 'utf8');
  const errors = [];
  const emitted = [];
  registerSubagentLifecycleAccount({
    deviceId: 'device-1',
    filePath,
    emit: (event) => emitted.push(event),
    logger: { error: (message) => errors.push(message) },
  });
  const unregisterParent = registerParent();
  spawnChild();

  assert.equal(emitted.length, 0);
  assert.equal(errors.length, 1);
  assert.equal(fs.readFileSync(filePath, 'utf8'), '{invalid-json');
  unregisterParent();
  fs.rmSync(tempDir, { recursive: true, force: true });
});
