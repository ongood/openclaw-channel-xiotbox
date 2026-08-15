import assert from 'node:assert/strict';
import test from 'node:test';

import {
  handleGatewayAskUserResolve,
  handleOutboundAskUserPayload,
  registerActiveAskUserBinding,
  registerAskUserLifecycleAccount,
  resetAskUserLifecycleForTest,
  setAskUserResolverForTest,
} from '../dist/src/ask-user-lifecycle.js';

test.beforeEach(() => resetAskUserLifecycleForTest());

function setup() {
  const emitted = [];
  const unregisterAccount = registerAskUserLifecycleAccount({
    accountId: 'default',
    deviceId: 'device-1',
    emit: (event) => emitted.push(event),
  });
  const unregisterBinding = registerActiveAskUserBinding({
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

function questionPayload(questionId = 'ask_question-1') {
  return {
    text: 'Which module should I refactor first?\n\nReply with the number or option text.',
    channelData: {
      askUser: {
        questionId,
        optionValues: ['auth', 'router', 'storage'],
      },
    },
  };
}

test('projects ask_user.requested from outbound channelData.askUser', () => {
  const harness = setup();
  handleOutboundAskUserPayload({
    accountId: 'default',
    payload: questionPayload(),
    conversationId: 'conversation-1',
  });

  assert.equal(harness.emitted.length, 1);
  assert.equal(harness.emitted[0].kind, 'ask_user.requested');
  assert.equal(harness.emitted[0].binding_id, 'binding-1');
  assert.equal(harness.emitted[0].conversation_id, 'conversation-1');
  assert.equal(harness.emitted[0].run_id, 'command-1');
  assert.equal(harness.emitted[0].payload.question_id, 'ask_question-1');
  assert.equal(harness.emitted[0].payload.status, 'pending');
  assert.ok(harness.emitted[0].payload.question.includes('Which module'));
  assert.deepEqual(harness.emitted[0].payload.option_values, ['auth', 'router', 'storage']);

  // Idempotent: a second delivery of the same question must not re-project.
  handleOutboundAskUserPayload({
    accountId: 'default',
    payload: questionPayload(),
    conversationId: 'conversation-1',
  });
  assert.equal(harness.emitted.length, 1);

  harness.unregisterBinding();
  harness.unregisterAccount();
});

test('skips non-ask_user payloads and unbound questions', () => {
  const harness = setup();
  handleOutboundAskUserPayload({ accountId: 'default', payload: { text: 'hello' } });
  harness.unregisterBinding();
  handleOutboundAskUserPayload({
    accountId: 'unbound-account',
    payload: questionPayload(),
  });
  assert.equal(harness.emitted.length, 0);
  harness.unregisterAccount();
});

test('resolves a pending question and projects ask_user.resolved', async () => {
  const harness = setup();
  handleOutboundAskUserPayload({
    accountId: 'default',
    payload: questionPayload(),
    conversationId: 'conversation-1',
  });

  const resolverCalls = [];
  setAskUserResolverForTest(async (options) => {
    resolverCalls.push(options);
  });

  const acks = [];
  const result = await handleGatewayAskUserResolve({
    accountId: 'default',
    request: {
      request_id: 'request-1',
      question_id: 'ask_question-1',
      answer: 'auth',
      reviewer_id: 'user:101',
    },
    cfg: { channels: { xiotbox: {} } },
    sendAck: (ack) => acks.push(ack),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(acks[0], { request_id: 'request-1', status: 'accepted' });
  assert.equal(resolverCalls[0].questionId, 'ask_question-1');
  assert.equal(resolverCalls[0].optionValue, 'auth');
  assert.equal(harness.emitted.length, 2);
  assert.equal(harness.emitted[1].kind, 'ask_user.resolved');
  assert.equal(harness.emitted[1].payload.answer, 'auth');
  assert.equal(harness.emitted[1].payload.resolved_by, 'user:101');

  harness.unregisterBinding();
  harness.unregisterAccount();
});

test('rejects resolution for unknown or unbound questions', async () => {
  const harness = setup();
  setAskUserResolverForTest(async () => {});

  const acks = [];
  const result = await handleGatewayAskUserResolve({
    accountId: 'default',
    request: {
      request_id: 'request-1',
      question_id: 'ask_never-pending',
      answer: 'auth',
      reviewer_id: 'user:101',
    },
    cfg: { channels: { xiotbox: {} } },
    sendAck: (ack) => acks.push(ack),
  });

  assert.equal(result.ok, false);
  assert.ok(result.error.includes('not pending'));
  assert.deepEqual(acks[0], {
    request_id: 'request-1',
    status: 'rejected',
    error_code: 'ask_user_resolution_failed',
  });
  assert.equal(harness.emitted.length, 0);

  harness.unregisterBinding();
  harness.unregisterAccount();
});
