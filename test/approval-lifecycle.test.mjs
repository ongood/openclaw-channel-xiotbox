import assert from 'node:assert/strict';
import test from 'node:test';

import {
  handleGatewayApprovalResolve,
  handleOutboundApprovalPayload,
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
  assert.equal(harness.emitted.length, 2);
  assert.equal(harness.emitted[1].kind, 'approval.resolved');
  assert.equal(harness.emitted[1].payload.decision, 'allow-once');
  assert.equal(harness.emitted[1].payload.resolved_by, 'user:101');

  const failingPayload = runtime.presentation.buildPendingPayload({
    request: { ...request(), id: 'approval-2' },
    approvalKind: 'exec',
    view: { actions: [{ decision: 'deny' }] },
  });
  runtime.transport.deliverPending({ preparedTarget: failingPayload });

  setApprovalResolverForTest(async () => {
    throw new Error('resolver exploded');
  });
  const failure = await handleGatewayApprovalResolve({
    accountId: 'default',
    request: {
      request_id: 'request-2',
      approval_id: 'approval-2',
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
  assert.equal(harness.emitted.length, 3);

  harness.unregisterBinding();
  harness.unregisterAccount();
});

// Regression: OpenClaw 2026.8.1 delivers exec/plugin approval prompts to this
// channel as outbound text payloads (agent tool-result followup / approval
// forwarder), not through the channel-native approval runtime. The outbound
// afterDeliverPayload hook must project approval.requested from the
// structured channelData.execApproval metadata so Flutter gets buttons.
test('outbound pending approval payload projects approval.requested via session key binding', () => {
  const harness = setup();
  const pendingPayload = {
    text: 'Approval required.\nRun: /approve approval-1 allow-once',
    channelData: {
      execApproval: {
        approvalId: 'approval-1',
        approvalSlug: 'approval-1',
        approvalKind: 'exec',
        agentId: 'supervisor',
        allowedDecisions: ['allow-once', 'deny'],
        sessionKey: 'agent:supervisor:xiotbox:device-1:conversation-1',
      },
    },
  };

  assert.equal(
    handleOutboundApprovalPayload({ accountId: 'default', payload: pendingPayload }),
    undefined,
  );
  assert.equal(harness.emitted.length, 1);
  assert.equal(harness.emitted[0].kind, 'approval.requested');
  assert.equal(harness.emitted[0].binding_id, 'binding-1');
  assert.equal(harness.emitted[0].conversation_id, 'conversation-1');
  assert.equal(harness.emitted[0].run_id, 'command-1');
  assert.deepEqual(harness.emitted[0].payload.allowed_decisions, ['allow-once', 'deny']);
  assert.equal(harness.emitted[0].payload.approval_kind, 'exec');
  assert.equal(harness.emitted[0].payload.agent_id, 'supervisor');

  // Idempotent: a second delivery of the same approval must not re-project.
  handleOutboundApprovalPayload({ accountId: 'default', payload: pendingPayload });
  assert.equal(harness.emitted.length, 1);

  harness.unregisterBinding();
  harness.unregisterAccount();
});

test('outbound pending approval keeps its conversation after active dispatch ends', () => {
  const harness = setup();
  harness.unregisterBinding();

  handleOutboundApprovalPayload({
    accountId: 'default',
    payload: {
      text: 'Approval required.',
      channelData: {
        execApproval: {
          approvalId: 'approval-late',
          approvalKind: 'exec',
          allowedDecisions: ['allow-once', 'deny'],
          sessionKey: 'agent:supervisor:xiotbox:device-1:conversation-1',
        },
      },
    },
  });

  assert.equal(harness.emitted.length, 1);
  assert.equal(harness.emitted[0].kind, 'approval.requested');
  assert.equal(harness.emitted[0].conversation_id, 'conversation-1');
  assert.equal(harness.emitted[0].run_id, 'command-1');
  harness.unregisterAccount();
});

test('outbound pending approval without sessionKey falls back to single account binding', () => {
  const harness = setup();
  handleOutboundApprovalPayload({
    accountId: 'default',
    payload: {
      text: 'Approval required.',
      channelData: {
        execApproval: {
          approvalId: 'approval-2',
          approvalKind: 'exec',
          allowedDecisions: ['deny'],
        },
      },
    },
  });
  assert.equal(harness.emitted.length, 1);
  assert.equal(harness.emitted[0].kind, 'approval.requested');
  assert.equal(harness.emitted[0].payload.approval_id, 'approval-2');
  assert.equal(harness.emitted[0].run_id, 'command-1');
  harness.unregisterBinding();
  harness.unregisterAccount();
});

test('delayed outbound approval without sessionKey uses target conversation binding', () => {
  const harness = setup();
  const unregisterOther = registerActiveApprovalBinding({
    accountId: 'default',
    deviceId: 'device-1',
    sessionKey: 'agent:other:xiotbox:device-1:conversation-2',
    bindingId: 'binding-2',
    conversationId: 'conversation-2',
    agentId: 'other',
    runId: 'command-2',
    traceId: 'trace-2',
  });
  harness.unregisterBinding();
  unregisterOther();

  handleOutboundApprovalPayload({
    accountId: 'default',
    conversationId: 'conversation-1',
    payload: {
      text: 'Approval required.',
      channelData: {
        execApproval: {
          approvalId: 'approval-delayed-no-session',
          approvalKind: 'exec',
          allowedDecisions: ['allow-once', 'deny'],
        },
      },
    },
  });

  assert.equal(harness.emitted.length, 1);
  assert.equal(harness.emitted[0].binding_id, 'binding-1');
  assert.equal(harness.emitted[0].conversation_id, 'conversation-1');
  assert.equal(harness.emitted[0].run_id, 'command-1');
  harness.unregisterAccount();
});

test('text-only exec approval fallback projects while dispatch binding is active', () => {
  const harness = setup();
  handleOutboundApprovalPayload({
    accountId: 'default',
    conversationId: 'conversation-1',
    payload: {
      text: [
        'Approval required.',
        'Run:',
        '```txt',
        '/approve approval-text allow-once',
        '```',
        'Pending command:',
        '```sh',
        'echo redacted',
        '```',
        'Other options:',
        '```txt',
        '/approve approval-text deny',
        '```',
        'Expires in: 30m',
        'Full id: `approval-text-full-id`',
      ].join('\n'),
    },
  });

  assert.equal(harness.emitted.length, 1);
  assert.equal(harness.emitted[0].kind, 'approval.requested');
  assert.equal(harness.emitted[0].payload.approval_id, 'approval-text-full-id');
  assert.deepEqual(harness.emitted[0].payload.allowed_decisions, ['allow-once', 'deny']);
  assert.equal(typeof harness.emitted[0].payload.expires_at, 'number');
  assert.ok(harness.emitted[0].payload.expires_at > Date.now() / 1000 + 1700);
  assert.equal(JSON.stringify(harness.emitted[0]).includes('echo redacted'), false);
  harness.unregisterBinding();
  harness.unregisterAccount();
});

test('text-only approval followup projects approval.resolved', () => {
  const harness = setup();
  handleOutboundApprovalPayload({
    accountId: 'default',
    conversationId: 'conversation-1',
    payload: {
      text: [
        'Approval required.',
        'Run: /approve approval-text-resolved allow-once',
        'Pending command:',
        'echo redacted',
        'Expires in: 30m',
        'Full id: `approval-text-resolved`',
      ].join('\n'),
    },
  });
  handleOutboundApprovalPayload({
    accountId: 'default',
    payload: {
      text: 'Exec approval allowed once. Resolved by user:5. ID: approval-text-resolved',
    },
  });

  assert.equal(harness.emitted.length, 2);
  assert.equal(harness.emitted[1].kind, 'approval.resolved');
  assert.equal(harness.emitted[1].payload.decision, 'allow-once');
  assert.equal(harness.emitted[1].payload.resolved_by, 'user:5');
  harness.unregisterBinding();
  harness.unregisterAccount();
});

test('outbound resolved approval payload projects approval.resolved with parsed decision', () => {
  const harness = setup();
  handleOutboundApprovalPayload({
    accountId: 'default',
    payload: {
      text: 'Approval required.',
      channelData: {
        execApproval: {
          approvalId: 'approval-1',
          approvalKind: 'exec',
          allowedDecisions: ['allow-once', 'deny'],
          sessionKey: 'agent:supervisor:xiotbox:device-1:conversation-1',
        },
      },
    },
  });
  assert.equal(harness.emitted.length, 1);

  handleOutboundApprovalPayload({
    accountId: 'default',
    payload: {
      text: '✅ Exec approval allowed once. Resolved by user:101. ID: approval-1',
      channelData: {
        execApproval: {
          approvalId: 'approval-1',
          approvalSlug: 'approval-1',
          state: 'resolved',
        },
      },
    },
  });
  assert.equal(harness.emitted.length, 2);
  assert.equal(harness.emitted[1].kind, 'approval.resolved');
  assert.equal(harness.emitted[1].payload.decision, 'allow-once');
  assert.equal(harness.emitted[1].payload.resolved_by, 'user:101');
  assert.equal(harness.emitted[1].payload.status, 'resolved');
  harness.unregisterBinding();
  harness.unregisterAccount();
});

test('outbound expiry notice projects approval.expired', () => {
  const harness = setup();
  handleOutboundApprovalPayload({
    accountId: 'default',
    payload: {
      text: 'Approval required.',
      channelData: {
        execApproval: {
          approvalId: 'approval-1',
          approvalKind: 'exec',
          allowedDecisions: ['deny'],
          sessionKey: 'agent:supervisor:xiotbox:device-1:conversation-1',
        },
      },
    },
  });
  assert.equal(harness.emitted.length, 1);

  handleOutboundApprovalPayload({
    accountId: 'default',
    payload: { text: '⏱️ Exec approval expired. ID: approval-1' },
  });
  assert.equal(harness.emitted.length, 2);
  assert.equal(harness.emitted[1].kind, 'approval.expired');
  assert.equal(harness.emitted[1].payload.status, 'expired');

  // Resolving after expiry finds no pending entry.
  handleOutboundApprovalPayload({
    accountId: 'default',
    payload: {
      text: '✅ Exec approval allowed once. ID: approval-1',
      channelData: { execApproval: { approvalId: 'approval-1', state: 'resolved' } },
    },
  });
  assert.equal(harness.emitted.length, 2);
  harness.unregisterBinding();
  harness.unregisterAccount();
});

test('outbound projection skips non-approval payloads and unbound approvals', () => {
  const harness = setup();
  handleOutboundApprovalPayload({ accountId: 'default', payload: { text: 'hello' } });
  harness.unregisterBinding();
  handleOutboundApprovalPayload({
    accountId: 'unbound-account',
    payload: {
      text: 'Approval required.',
      channelData: { execApproval: { approvalId: 'unknown-1', approvalKind: 'exec' } },
    },
  });
  handleOutboundApprovalPayload({
    accountId: 'default',
    payload: {
      text: '✅ Exec approval allowed once. ID: never-pending',
      channelData: { execApproval: { approvalId: 'never-pending', state: 'resolved' } },
    },
  });
  assert.equal(harness.emitted.length, 0);
  harness.unregisterAccount();
});
