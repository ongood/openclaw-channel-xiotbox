// Regression test: WSSClient.handleMessage must dispatch V2.AGENT_PROFILE_SYNC
// to listeners (previously fell through to "Unknown message type", so the
// channel.ts listener never fired and the gateway push was silently dropped).
import test from 'node:test';
import assert from 'node:assert/strict';
import WSSClient from '../wss_client.js';

function makeClient() {
  return new WSSClient({
    DEVICE_ID: 'test-device',
    GATEWAY_URL: 'ws://127.0.0.1:1',
    OUTBOX_MAX: 10,
  });
}

test('handleMessage emits V2.AGENT_PROFILE_SYNC with payload', () => {
  const client = makeClient();
  const payload = { agent_id: 'chief_engineer', name: 'Chief Engineer' };
  let received = null;
  client.on('V2.AGENT_PROFILE_SYNC', (p) => { received = p; });
  client.handleMessage({ type: 'V2.AGENT_PROFILE_SYNC', payload });
  assert.deepEqual(received, payload);
});

test('handleMessage still emits V2.APPROVAL_RESOLVE', () => {
  const client = makeClient();
  const payload = { request_id: 'req-1' };
  let received = null;
  client.on('V2.APPROVAL_RESOLVE', (p) => { received = p; });
  client.handleMessage({ type: 'V2.APPROVAL_RESOLVE', payload });
  assert.deepEqual(received, payload);
});
