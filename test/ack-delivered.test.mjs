// Contract tests for XIOT-BUG-0050b (canonical COMMAND_ACK / COMMAND_DELIVERED
// + error normalization). PLAN-0008 §4.1 / §4.5 / §4.6.
//
// 1. Every v1 command answers a canonical COMMAND_ACK before any further
//    validation/processing; accepted:false carries a structured rejection
//    {class:'policy|protocol|runtime', code, detail?} — never a string prefix.
// 2. Commands that pass protocol/security validation emit a reliable
//    COMMAND_DELIVERED when they enter the business entry; chat binds it to
//    the message.user projection via the same command_id (§4.6), replay
//    idempotent. Non-chat commands must not fabricate message.user/run events.
// 3. A capability the profile claims but the runtime vocabulary lacks is
//    normalized to protocol/capability_mismatch (never runtime
//    capability_unsupported) so the Gateway can refresh the profile.
// 4. Legacy error strings are normalized per PLAN §4.5: protocol structure
//    errors → protocol, valid-structure signature/trust/authorization failures
//    → policy, runtime binding loss → runtime.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAckRejection,
  buildCanonicalAck,
  buildCommandDelivered,
  buildChatUserMessageEventId,
  normalizeRuntimeError,
  CommandLifecycleEmitter,
} from '../dist/src/command-ack.js';

import {
  dispatchSessionCommand,
  rememberConversationBinding,
} from '../dist/src/channel.js';

import { projectUserMessage } from '../dist/src/conversation-projection.js';

function fakeClient() {
  const sent = [];
  return {
    sent,
    sendMessage(type, payload) {
      sent.push({ type, payload });
    },
  };
}

function sessionCtx(client) {
  return {
    client,
    lifecycle: new CommandLifecycleEmitter(client.sendMessage),
    cacheResult: () => {},
    log: null,
    deviceId: 'dev1',
  };
}

// ── 1. Structured rejection on the canonical ACK ─────────────────────────────

test('buildAckRejection only accepts the three registered classes', () => {
  assert.deepEqual(buildAckRejection('policy', 'trust_pin_mismatch'), {
    class: 'policy',
    code: 'trust_pin_mismatch',
  });
  assert.deepEqual(buildAckRejection('protocol', 'e2e_required', 'no envelope'), {
    class: 'protocol',
    code: 'e2e_required',
    detail: 'no envelope',
  });
  assert.deepEqual(buildAckRejection('runtime', 'session_binding_not_found'), {
    class: 'runtime',
    code: 'session_binding_not_found',
  });

  // Unregistered class / blank code are protocol violations on our side.
  assert.equal(buildAckRejection('capability', 'whatever'), null);
  assert.equal(buildAckRejection('policy', ''), null);
  assert.equal(buildAckRejection('policy', null), null);
});

test('rejected ACK carries structured rejection, no string prefix protocol', () => {
  const client = fakeClient();
  const emitter = new CommandLifecycleEmitter(client.sendMessage);
  const rejection = buildAckRejection('policy', 'trust_pin_mismatch');

  emitter.ackRejected('cmd_rej_1', rejection, 'tr_1');

  assert.equal(client.sent.length, 1);
  const frame = client.sent[0];
  assert.equal(frame.type, 'COMMAND_ACK');
  assert.equal(frame.payload.command_id, 'cmd_rej_1');
  assert.equal(frame.payload.accepted, false);
  assert.deepEqual(frame.payload.rejection, {
    class: 'policy',
    code: 'trust_pin_mismatch',
  });
  assert.equal(typeof frame.payload.rejection, 'object');
  assert.ok(!('reject_reason' in frame.payload));
  const serialized = JSON.stringify(frame.payload);
  assert.ok(!serialized.includes('policy:'), 'no string-prefix protocol');
});

test('rejected ACK replay re-emits the same canonical frame (idempotent)', () => {
  const client = fakeClient();
  const emitter = new CommandLifecycleEmitter(client.sendMessage);
  const rejection = buildAckRejection('protocol', 'e2e_decrypt_failed', 'aad mismatch');

  emitter.ackRejected('cmd_rej_2', rejection, null);
  emitter.ackRejected('cmd_rej_2', rejection, null);

  assert.equal(client.sent.length, 1, 'duplicate rejection must not double-send');
});

test('a rejected ACK never produces COMMAND_DELIVERED or COMMAND_RESULT', () => {
  const client = fakeClient();
  const emitter = new CommandLifecycleEmitter(client.sendMessage);
  emitter.ackRejected('cmd_rej_3', buildAckRejection('policy', 'signature_invalid'));

  const delivered = emitter.markDelivered('cmd_rej_3');
  assert.equal(delivered, false, 'rejected command must not be marked delivered');
  const types = client.sent.map((f) => f.type);
  assert.ok(!types.includes('COMMAND_DELIVERED'));
  assert.ok(!types.includes('COMMAND_RESULT'));
});

// ── 2. accepted ACK → DELIVERED ──────────────────────────────────────────────

test('accepted ACK then COMMAND_DELIVERED with bound event_id, in order', () => {
  const client = fakeClient();
  const emitter = new CommandLifecycleEmitter(client.sendMessage);

  emitter.ackAccepted('cmd_ok_1', 'tr_2');
  const first = emitter.markDelivered('cmd_ok_1');

  assert.equal(first, true);
  assert.equal(client.sent.length, 2);
  assert.equal(client.sent[0].type, 'COMMAND_ACK');
  assert.equal(client.sent[0].payload.accepted, true);
  assert.equal(client.sent[0].payload.command_id, 'cmd_ok_1');
  assert.equal(client.sent[0].payload.rejection, undefined);
  assert.equal(client.sent[1].type, 'COMMAND_DELIVERED');
  assert.equal(client.sent[1].payload.command_id, 'cmd_ok_1');
  assert.equal(client.sent[1].payload.event_id, buildCommandDelivered('cmd_ok_1').event_id);
  assert.ok(client.sent[0].payload.event_id !== client.sent[1].payload.event_id,
    'ACK and DELIVERED evidence are distinct events');
});

test('COMMAND_DELIVERED retransmission is idempotent per command_id', () => {
  const client = fakeClient();
  const emitter = new CommandLifecycleEmitter(client.sendMessage);

  assert.equal(emitter.markDelivered('cmd_dup_1'), true);
  assert.equal(emitter.markDelivered('cmd_dup_1'), false);
  const deliveredFrames = client.sent.filter((f) => f.type === 'COMMAND_DELIVERED');
  assert.equal(deliveredFrames.length, 1);

  // Deterministic frame: the same command_id always rebuilds the same payload.
  assert.deepEqual(buildCommandDelivered('cmd_dup_1'), buildCommandDelivered('cmd_dup_1'));
  assert.equal(buildCommandDelivered(''), null);
});

// ── 3. chat: message.user ↔ DELIVERED binding on one command_id (§4.6) ──────

test('chat projection and DELIVERED bind to the same command_id and event key', () => {
  const cmdId = 'cmd_chat_bind_1';
  const [userEvent] = projectUserMessage('hello', undefined, cmdId);
  const delivered = buildCommandDelivered(cmdId);

  assert.equal(userEvent.kind, 'message.user');
  assert.equal(userEvent.payload.command_id, cmdId);
  assert.equal(delivered.command_id, cmdId);
  // The message.user durable event key is derived from the same command_id so
  // the Gateway can pair the receive unit (event + DELIVERED) atomically.
  assert.equal(buildChatUserMessageEventId(cmdId), `${cmdId}:${userEvent.occurrenceId}`);
});

test('replaying the chat command rebinds the identical receive unit (replay idempotent)', () => {
  const cmdId = 'cmd_chat_replay_1';
  const first = projectUserMessage('hello', undefined, cmdId)[0];
  const second = projectUserMessage('hello', undefined, cmdId)[0];
  assert.deepEqual(first.payload, second.payload);
  assert.deepEqual(buildCommandDelivered(cmdId), buildCommandDelivered(cmdId));
});

// ── 4. no-turn actions: ACK accepted → DELIVERED → completed, no run events ──

test('model.select delivers then completes without message.user/run events', () => {
  const client = fakeClient();
  rememberConversationBinding('conv_noturn_1', {
    sessionKey: 'agent:main:xiotbox:dev1:conv_noturn_1:0',
    agentId: 'main',
    contextEpoch: 0,
  });

  dispatchSessionCommand(
    sessionCtx(client),
    {
      action: 'model_select',
      payload: {},
      incoming: { conversation_id: 'conv_noturn_1', model: 'provider/model-a' },
      cmdId: 'cmd_noturn_1',
      traceId: 'tr_3',
    },
  );

  const types = client.sent.map((f) => f.type);
  assert.deepEqual(types, ['COMMAND_ACK', 'COMMAND_DELIVERED', 'COMMAND_RESULT']);
  assert.equal(client.sent[0].payload.accepted, true);
  assert.equal(client.sent[1].payload.command_id, 'cmd_noturn_1');
  assert.equal(client.sent[2].payload.status, 'success');
  // No-turn actions must not fabricate chat/run evidence.
  const serialized = JSON.stringify(client.sent);
  assert.ok(!serialized.includes('message.user'), 'no fabricated message.user');
  assert.ok(!serialized.includes('run.started'), 'no fabricated run events');
});

test('archive delivers then enters its real lifecycle (running ack), no run events', () => {
  const client = fakeClient();
  dispatchSessionCommand(
    sessionCtx(client),
    {
      action: 'archive',
      payload: {},
      incoming: { conversation_id: 'conv_noturn_2' },
      cmdId: 'cmd_noturn_2',
      traceId: null,
    },
  );

  const types = client.sent.map((f) => f.type);
  assert.deepEqual(types, ['COMMAND_ACK', 'COMMAND_DELIVERED', 'COMMAND_RESULT', 'SESSION.ARCHIVE']);
  assert.equal(client.sent[2].payload.status, 'running');
  assert.ok(!JSON.stringify(client.sent).includes('message.user'));
});

test('unknown command vocabulary is protocol/capability_mismatch, never runtime capability_unsupported', () => {
  const client = fakeClient();
  dispatchSessionCommand(
    sessionCtx(client),
    {
      action: 'unsupported',
      payload: { command_type: 'queue.promote' },
      incoming: {},
      cmdId: 'cmd_capmismatch_1',
      traceId: null,
    },
  );

  assert.equal(client.sent.length, 1);
  const frame = client.sent[0];
  assert.equal(frame.type, 'COMMAND_ACK');
  assert.equal(frame.payload.accepted, false);
  assert.deepEqual(frame.payload.rejection, {
    class: 'protocol',
    code: 'capability_mismatch',
  });

  // Normalizer agrees with the dispatched frame.
  const normalized = normalizeRuntimeError('unsupported_command_type');
  assert.deepEqual(normalized, { class: 'protocol', code: 'capability_mismatch' });
  assert.notEqual(normalized.code, 'capability_unsupported');
  assert.deepEqual(normalizeRuntimeError('interrupt_unavailable'), {
    class: 'protocol',
    code: 'capability_mismatch',
  });
});

test('session_binding_not_found is a runtime-class rejection, no DELIVERED', () => {
  const client = fakeClient();
  dispatchSessionCommand(
    sessionCtx(client),
    {
      action: 'model_select',
      payload: {},
      incoming: { conversation_id: 'conv_unknown_binding', model: 'm' },
      cmdId: 'cmd_binding_1',
      traceId: null,
    },
  );

  const types = client.sent.map((f) => f.type);
  assert.ok(types.includes('COMMAND_ACK'));
  assert.ok(!types.includes('COMMAND_DELIVERED'), 'never entered the business entry');
  const ack = client.sent.find((f) => f.type === 'COMMAND_ACK');
  assert.equal(ack.payload.accepted, false);
  assert.deepEqual(ack.payload.rejection, {
    class: 'runtime',
    code: 'session_binding_not_found',
  });
});

// ── 5. error normalization (PLAN §4.5) ───────────────────────────────────────

test('protocol structure errors normalize to class=protocol', () => {
  assert.deepEqual(normalizeRuntimeError('e2e_required'), {
    class: 'protocol',
    code: 'e2e_required',
  });
  assert.deepEqual(normalizeRuntimeError('e2e_decrypt_failed'), {
    class: 'protocol',
    code: 'e2e_decrypt_failed',
  });
  assert.deepEqual(normalizeRuntimeError('e2e_peer_missing'), {
    class: 'protocol',
    code: 'e2e_peer_missing',
  });
  assert.equal(normalizeRuntimeError('envelope_missing').class, 'protocol');
});

test('signature/trust/authorization failures normalize to class=policy', () => {
  assert.deepEqual(normalizeRuntimeError('trust_pin_mismatch'), {
    class: 'policy',
    code: 'trust_pin_mismatch',
  });
  assert.deepEqual(normalizeRuntimeError('client_identity_changed'), {
    class: 'policy',
    code: 'client_identity_changed',
  });
  assert.deepEqual(normalizeRuntimeError('signature_invalid'), {
    class: 'policy',
    code: 'signature_invalid',
  });
  assert.equal(normalizeRuntimeError('new_client_identity_not_allowed').class, 'policy');
});

test('runtime binding loss and unknown errors normalize conservatively to runtime', () => {
  assert.deepEqual(normalizeRuntimeError('session_binding_not_found'), {
    class: 'runtime',
    code: 'session_binding_not_found',
  });
  // Unknown values map conservatively to runtime_error with bounded detail.
  const unknown = normalizeRuntimeError('some_unregistered_failure');
  assert.deepEqual(unknown, {
    class: 'runtime',
    code: 'runtime_error',
    detail: 'some_unregistered_failure',
  });
});

test('canonical ACK builder shape', () => {
  const accepted = buildCanonicalAck('cmd_shape_1', { accepted: true });
  assert.deepEqual(accepted, {
    type: 'COMMAND_ACK',
    command_id: 'cmd_shape_1',
    accepted: true,
  });
  const rejected = buildCanonicalAck('cmd_shape_2', {
    accepted: false,
    rejection: { class: 'protocol', code: 'e2e_required' },
  });
  assert.equal(rejected.type, 'COMMAND_ACK');
  assert.equal(rejected.accepted, false);
  assert.deepEqual(rejected.rejection, { class: 'protocol', code: 'e2e_required' });
  assert.equal(buildCanonicalAck('', { accepted: true }), null);
});
