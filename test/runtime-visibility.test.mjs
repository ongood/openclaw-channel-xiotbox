// Contract tests for XIOT-BUG-0007 (OpenClaw runtime visibility).
//
// The plugin publishes RUNTIMES.LIST on every bot connect so /v2/runtimes and
// orchestrator dispatch see the device as an openclaw runtime. runtime_kind is
// declared explicitly; the gateway default is neutral by design.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  OPENCLAW_RUNTIME_KIND,
  buildOpenclawRuntimeId,
  buildOpenclawRuntimeListPayload,
} from '../dist/src/channel.js';

test('runtime kind is the stable openclaw identifier', () => {
  assert.equal(OPENCLAW_RUNTIME_KIND, 'openclaw');
});

test('runtime id is device-scoped and never empty for a real device', () => {
  assert.equal(buildOpenclawRuntimeId('dev-quanzhou-01'), 'openclaw-dev-quanzhou-01');
  assert.equal(buildOpenclawRuntimeId('  dev-1  '), 'openclaw-dev-1');
  assert.equal(buildOpenclawRuntimeId(''), '');
});

test('runtime list payload matches the gateway RUNTIMES.LIST contract', () => {
  const payload = buildOpenclawRuntimeListPayload('dev-1');
  assert.equal(payload.device_id, 'dev-1');
  assert.equal(payload.runtimes.length, 1);

  const runtime = payload.runtimes[0];
  assert.equal(runtime.runtime_id, 'openclaw-dev-1');
  // Explicit kind: never rely on the (neutral) gateway default.
  assert.equal(runtime.runtime_kind, 'openclaw');
  assert.equal(runtime.status, 'online');
  // Local paths never leave the bot; workspaces come later behind a
  // dedicated seam.
  assert.deepEqual(runtime.workspaces, []);
});

test('runtime list payload degrades to an empty registry without a device id', () => {
  const payload = buildOpenclawRuntimeListPayload('');
  assert.deepEqual(payload, { device_id: '', runtimes: [] });
});
