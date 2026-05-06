import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clearConnectedAt,
  describeGatewayAccountState,
  getGatewayAccount,
  nextGatewayInstanceId,
  registerGatewayAccount,
  removeGatewayAccount,
  setConnectedAt,
  stopGatewayAccount,
} from '../dist/src/gateway-state.js';

function uniqueAccount(name) {
  return `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

test('registerGatewayAccount stores active account state', () => {
  const accountId = uniqueAccount('register');
  registerGatewayAccount(accountId, {
    instanceId: 101,
    startedAt: 1000,
    stop: null,
  });
  assert.deepEqual(getGatewayAccount(accountId), {
    instanceId: 101,
    startedAt: 1000,
    connectedAt: undefined,
    stop: null,
  });
});

test('setConnectedAt and clearConnectedAt update connected snapshot', () => {
  const accountId = uniqueAccount('connected');
  registerGatewayAccount(accountId, {
    instanceId: 201,
    startedAt: 2000,
    stop: null,
  });
  assert.equal(setConnectedAt(accountId, 201, 2500), true);
  assert.deepEqual(describeGatewayAccountState(accountId), {
    connected: true,
    startedAt: 2000,
    lastConnectedAt: 2500,
  });
  assert.equal(clearConnectedAt(accountId, 201), true);
  assert.deepEqual(describeGatewayAccountState(accountId), {
    connected: false,
    startedAt: 2000,
    lastConnectedAt: null,
  });
});

test('old instance cannot mutate new instance state', () => {
  const accountId = uniqueAccount('guard');
  registerGatewayAccount(accountId, {
    instanceId: 301,
    startedAt: 3000,
    stop: null,
  });
  assert.equal(setConnectedAt(accountId, 300, 3500), false);
  assert.equal(setConnectedAt(accountId, 301, 3600), true);
  assert.equal(clearConnectedAt(accountId, 300), false);
  assert.equal(removeGatewayAccount(accountId, 300), false);
  assert.deepEqual(describeGatewayAccountState(accountId), {
    connected: true,
    startedAt: 3000,
    lastConnectedAt: 3600,
  });
});

test('removeGatewayAccount deletes only matching instance', () => {
  const accountId = uniqueAccount('remove');
  registerGatewayAccount(accountId, {
    instanceId: 401,
    startedAt: 4000,
    stop: null,
  });
  assert.equal(removeGatewayAccount(accountId, 400), false);
  assert.ok(getGatewayAccount(accountId));
  assert.equal(removeGatewayAccount(accountId, 401), true);
  assert.equal(getGatewayAccount(accountId), undefined);
});

test('stopGatewayAccount is idempotent under concurrent calls', async () => {
  const accountId = uniqueAccount('stop');
  let calls = 0;
  let resolveStop;
  const stopStarted = new Promise((resolve) => {
    resolveStop = resolve;
  });
  registerGatewayAccount(accountId, {
    instanceId: 501,
    startedAt: 5000,
    stop: async () => {
      calls += 1;
      await stopStarted;
    },
  });

  const first = stopGatewayAccount(accountId, 'first');
  const second = stopGatewayAccount(accountId, 'second');
  assert.equal(calls, 1);
  resolveStop();
  await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.equal(getGatewayAccount(accountId), undefined);
});

test('stopGatewayAccount does not delete a newer replacement instance', async () => {
  const accountId = uniqueAccount('stop-replaced');
  let resolveStop;
  const stopStarted = new Promise((resolve) => {
    resolveStop = resolve;
  });
  registerGatewayAccount(accountId, {
    instanceId: 601,
    startedAt: 6000,
    stop: async () => {
      await stopStarted;
    },
  });

  const stopping = stopGatewayAccount(accountId, 'replace');
  registerGatewayAccount(accountId, {
    instanceId: 602,
    startedAt: 6200,
    stop: null,
  });
  resolveStop();
  await stopping;

  assert.deepEqual(getGatewayAccount(accountId), {
    instanceId: 602,
    startedAt: 6200,
    connectedAt: undefined,
    stop: null,
  });
});

test('stopGatewayAccount removes current account when stop handler is null', async () => {
  const accountId = uniqueAccount('stop-null');
  registerGatewayAccount(accountId, {
    instanceId: 701,
    startedAt: 7000,
    stop: null,
  });

  await stopGatewayAccount(accountId, 'stop-null');

  assert.equal(getGatewayAccount(accountId), undefined);
});

test('nextGatewayInstanceId increments monotonically', () => {
  const first = nextGatewayInstanceId();
  const second = nextGatewayInstanceId();
  assert.equal(second, first + 1);
});
