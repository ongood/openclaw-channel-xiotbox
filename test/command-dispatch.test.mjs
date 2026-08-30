// Contract tests for XIOT-BUG-0006 (session command dispatch).
//
// The gateway flattens command_type into the bot COMMAND payload. Non-chat
// session commands must be routed before the chat/E2E path (they carry plain
// JSON and no OGE2E1 envelope) and must resolve back to the bound OpenClaw
// session via the conversation binding registry.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveSessionCommandAction,
  rememberConversationBinding,
  lookupConversationBinding,
  settleSessionArchiveAck,
  pendingSessionArchives,
} from '../dist/src/channel.js';

test('chat commands (and absent command_type) stay on the chat path', () => {
  assert.equal(resolveSessionCommandAction(''), 'chat');
  assert.equal(resolveSessionCommandAction('chat'), 'chat');
  assert.equal(resolveSessionCommandAction(undefined), 'chat');
  assert.equal(resolveSessionCommandAction('  chat  '), 'chat');
});

test('session commands map to their dispatch actions', () => {
  assert.equal(resolveSessionCommandAction('session.model.select'), 'model_select');
  assert.equal(resolveSessionCommandAction('session.archive'), 'archive');
  assert.equal(resolveSessionCommandAction('session.interrupt'), 'interrupt');
});

test('unknown command types fail fast instead of entering the chat path', () => {
  assert.equal(resolveSessionCommandAction('queue.promote'), 'unsupported');
  assert.equal(resolveSessionCommandAction('orchestrator.create'), 'unsupported');
});

test('conversation binding registry round-trips and expires unknown ids', () => {
  rememberConversationBinding('conv_test_1', {
    sessionKey: 'agent:main:xiotbox:dev1:conv_test_1:0',
    agentId: 'main',
    contextEpoch: 0,
  });
  const known = lookupConversationBinding('conv_test_1');
  assert.ok(known);
  assert.equal(known.sessionKey, 'agent:main:xiotbox:dev1:conv_test_1:0');
  assert.equal(known.agentId, 'main');

  assert.equal(lookupConversationBinding('conv_unknown'), null);
  assert.equal(lookupConversationBinding(''), null);
});

test('rememberConversationBinding ignores blank conversation ids', () => {
  rememberConversationBinding('   ', {
    sessionKey: 'sk',
    agentId: 'main',
    contextEpoch: 0,
  });
  assert.equal(lookupConversationBinding(''), null);
});

test('settleSessionArchiveAck resolves pending archives by conversation_id', () => {
  const sent = [];
  const fakeClient = { sendMessage: (type, payload) => sent.push({ type, payload }) };

  pendingSessionArchives.set('conv_ack_1', {
    cmdId: 'cmd_arch_1',
    traceId: 'tr_1',
    client: fakeClient,
    timer: null,
  });

  const settled = settleSessionArchiveAck({
    ok: true,
    archived: true,
    conversation_id: 'conv_ack_1',
    session_id: '',
  });

  assert.equal(settled, true);
  assert.equal(pendingSessionArchives.has('conv_ack_1'), false);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'COMMAND_RESULT');
  assert.equal(sent[0].payload.command_id, 'cmd_arch_1');
  assert.equal(sent[0].payload.status, 'success');
  assert.deepEqual(sent[0].payload.result, { conversation_id: 'conv_ack_1' });

  // Unrelated acks settle nothing.
  assert.equal(settleSessionArchiveAck({ ok: true, conversation_id: 'conv_other' }), false);
});

test('settleSessionArchiveAck maps failed acks to failed COMMAND_RESULT', () => {
  const sent = [];
  const fakeClient = { sendMessage: (type, payload) => sent.push({ type, payload }) };

  pendingSessionArchives.set('conv_ack_2', {
    cmdId: 'cmd_arch_2',
    traceId: null,
    client: fakeClient,
    timer: null,
  });

  // Gateway error acks echo only session_id (which we set to conversation_id).
  const settled = settleSessionArchiveAck({
    ok: false,
    error: 'db down',
    session_id: 'conv_ack_2',
  });

  assert.equal(settled, true);
  assert.equal(sent[0].payload.status, 'failed');
  assert.equal(sent[0].payload.error, 'db down');
});
