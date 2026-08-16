import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  handleSubagentEnded,
  handleSubagentSpawned,
  registerActiveSubagentParent,
  registerSubagentLifecycleAccount,
  resetSubagentLifecycleForTest,
} from '../dist/src/subagent-lifecycle.js';
import { setXiotboxRuntime } from '../dist/src/runtime.js';

test.beforeEach(() => resetSubagentLifecycleForTest());

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

test('wakes the parent supervisor session when a subagent completes', () => {
  const wakes = [];
  setXiotboxRuntime({
    system: {
      requestHeartbeat: (opts) => wakes.push(opts),
    },
  });
  try {
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

    assert.equal(wakes.length, 1);
    assert.equal(wakes[0].source, 'background-task');
    assert.equal(wakes[0].intent, 'immediate');
    assert.equal(wakes[0].reason, 'subagent-completed');
    assert.equal(wakes[0].sessionKey, 'agent:supervisor:xiotbox:device-1:conversation-1');
    assert.equal(wakes[0].agentId, 'supervisor');
  } finally {
    setXiotboxRuntime(null);
  }
});

test('does not wake the parent without a requester session key', () => {
  const wakes = [];
  setXiotboxRuntime({
    system: {
      requestHeartbeat: (opts) => wakes.push(opts),
    },
  });
  try {
    handleSubagentEnded(
      {
        targetSessionKey: 'agent:worker:subagent:child-1',
        targetKind: 'subagent',
        runId: 'child-run-1',
        outcome: 'ok',
      },
      { runId: 'child-run-1', childSessionKey: 'agent:worker:subagent:child-1' },
    );

    assert.equal(wakes.length, 0);
  } finally {
    setXiotboxRuntime(null);
  }
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
