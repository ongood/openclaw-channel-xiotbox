import assert from 'node:assert/strict';
import test from 'node:test';

import {
  handleGatewayApprovalResolve,
  registerActiveApprovalBinding,
  registerApprovalLifecycleAccount,
  resetApprovalLifecycleForTest,
  setApprovalResolverForTest,
  xiotboxApprovalCapability,
} from '../dist/src/approval-lifecycle.js';

test.beforeEach(() => resetApprovalLifecycleForTest());

function setup() {
  const emitted = [];
  const unregisterAccount = registerApprovalLifecycleAccount({
    accountId: 'default',
    deviceId: 'device-1',
    emit: (event) => emitted.push(event),
  });
  const unregisterBinding = registerActiveApprovalBinding({
    accountId: 'default',
    deviceId: 'device-1',
    sessionKey: 'agent:supervisor:xiotbox:device-1:conversation-1',
    bindingId: 'binding-1',
    conversationId: 'conversation-1',
    agentId: 'supervisor',
    runId: 'command-1',
    traceId: 'trace-1',
  });
  return { emitted, unregisterAccount, unregisterBinding };
}

function request(overrides = {}) {
  return {
    id: 'approval-1',
    createdAtMs: 100,
    expiresAtMs: 1000,
    request: {
      command: 'echo super-secret',
      commandPreview: 'secret preview',
      cwd: '/secret/path',
      agentId: 'supervisor',
      sessionKey: 'agent:supervisor:xiotbox:device-1:conversation-1',
      turnSourceChannel: 'xiotbox',
      turnSourceAccountId: 'default',
      toolName: 'exec',
      allowedDecisions: ['allow-once', 'deny'],
      ...overrides,
    },
  };
}

test('projects redacted pending and resolved approval events', async () => {
  const harness = setup();
  const runtime = xiotboxApprovalCapability.nativeRuntime;
  const approvalRequest = request();
  assert.equal(runtime.availability.shouldHandle({ request: approvalRequest }), true);

  const pendingPayload = runtime.presentation.buildPendingPayload({
    request: approvalRequest,
    approvalKind: 'exec',
    view: {
      actions: [
        { decision: 'allow-once' },
        { decision: 'deny' },
      ],
    },
  });
  const prepared = runtime.transport.prepareTarget({ pendingPayload });
  const entry = runtime.transport.deliverPending({ preparedTarget: prepared.target });

  assert.equal(harness.emitted.length, 1);
  assert.equal(harness.emitted[0].kind, 'approval.requested');
  assert.deepEqual(harness.emitted[0].payload.allowed_decisions, ['allow-once', 'deny']);
  assert.equal(JSON.stringify(harness.emitted).includes('super-secret'), false);
  assert.equal(JSON.stringify(harness.emitted).includes('/secret/path'), false);

  runtime.presentation.buildResolvedResult({
    entry,
    resolved: {
      id: 'approval-1',
      decision: 'allow-once',
      resolvedBy: 'user:101',
      ts: 1200,
    },
  });
  assert.equal(harness.emitted.length, 2);
  assert.equal(harness.emitted[1].kind, 'approval.resolved');
  assert.equal(harness.emitted[1].payload.decision, 'allow-once');
  assert.equal(harness.emitted[1].payload.resolved_by, 'user:101');

  harness.unregisterBinding();
  harness.unregisterAccount();
});

test('fails closed for another channel, missing binding, or ambiguous binding', () => {
  const harness = setup();
  const runtime = xiotboxApprovalCapability.nativeRuntime;
  assert.equal(
    runtime.availability.shouldHandle({
      request: request({ turnSourceChannel: 'discord' }),
    }),
    false,
  );
  assert.equal(
    runtime.availability.shouldHandle({
      request: request({ sessionKey: 'unknown' }),
    }),
    false,
  );

  const unregisterSecond = registerActiveApprovalBinding({
    accountId: 'default',
    deviceId: 'device-1',
    sessionKey: 'agent:supervisor:xiotbox:device-1:conversation-1',
    bindingId: 'binding-1',
    conversationId: 'conversation-1',
    agentId: 'supervisor',
    runId: 'command-2',
    traceId: 'trace-2',
  });
  assert.equal(runtime.availability.shouldHandle({ request: request() }), false);
  unregisterSecond();
  harness.unregisterBinding();
  harness.unregisterAccount();
});

test('emits expiry without exposing request content', () => {
  const harness = setup();
  const runtime = xiotboxApprovalCapability.nativeRuntime;
  const approvalRequest = request();
  const pendingPayload = runtime.presentation.buildPendingPayload({
    request: approvalRequest,
    approvalKind: 'exec',
    view: { actions: [{ decision: 'deny' }] },
  });
  const entry = runtime.transport.deliverPending({ preparedTarget: pendingPayload });
  runtime.presentation.buildExpiredResult({ entry });
  assert.equal(harness.emitted[1].kind, 'approval.expired');
  assert.equal(JSON.stringify(harness.emitted).includes('secret'), false);
  harness.unregisterBinding();
  harness.unregisterAccount();
});

test('V2.APPROVAL_RESOLVE handler acknowledges success and failure', async () => {
  const harness = setup();
  const runtime = xiotboxApprovalCapability.nativeRuntime;
  const pendingPayload = runtime.presentation.buildPendingPayload({
    request: request(),
    approvalKind: 'exec',
    view: { actions: [{ decision: 'allow-once' }, { decision: 'deny' }] },
  });
  runtime.transport.deliverPending({ preparedTarget: pendingPayload });

  const resolverCalls = [];
  setApprovalResolverForTest(async (options) => {
    resolverCalls.push(options);
  });

  const acks = [];
  const success = await handleGatewayApprovalResolve({
    accountId: 'default',
    request: {
      request_id: 'request-1',
      approval_id: 'approval-1',
      approval_kind: 'exec',
      decision: 'allow-once',
      reviewer_id: 'user:101',
    },
    cfg: { channels: { xiotbox: {} } },
    sendAck: (ack) => acks.push(ack),
  });

  assert.equal(success.ok, true);
  assert.deepEqual(acks[0], { request_id: 'request-1', status: 'accepted' });
  assert.equal(resolverCalls[0].approvalId, 'approval-1');
  assert.equal(resolverCalls[0].decision, 'allow-once');

  setApprovalResolverForTest(async () => {
    throw new Error('resolver exploded');
  });
  const failure = await handleGatewayApprovalResolve({
    accountId: 'default',
    request: {
      request_id: 'request-2',
      approval_id: 'approval-1',
      approval_kind: 'exec',
      decision: 'deny',
      reviewer_id: 'user:101',
    },
    cfg: { channels: { xiotbox: {} } },
    sendAck: (ack) => acks.push(ack),
  });

  assert.equal(failure.ok, false);
  assert.equal(failure.error, 'resolver exploded');
  assert.deepEqual(acks[1], {
    request_id: 'request-2',
    status: 'rejected',
    error_code: 'approval_resolution_failed',
  });

  harness.unregisterBinding();
  harness.unregisterAccount();
});
