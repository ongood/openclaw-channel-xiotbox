// Contract tests for XIOT-BUG-0007 (OpenClaw runtime visibility).
//
// The plugin publishes RUNTIMES.LIST on every bot connect so /v2/runtimes and
// orchestrator dispatch see the device as an openclaw runtime. runtime_kind is
// declared explicitly; the gateway default is neutral by design.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

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

test('runtime list entry publishes the 0050a capability declaration under `capabilities`', () => {
  // Gateway 0048a reads runtime.capabilities (bot_ws._handle_runtimes_list →
  // runtime_profile.normalize_declaration). The old `profile` key was dropped
  // by the gateway, so the wire key is pinned here.
  const payload = buildOpenclawRuntimeListPayload('dev-1');
  const runtime = payload.runtimes[0];
  assert.ok(runtime.capabilities, 'runtime entry declares capabilities');
  assert.equal('profile' in runtime, false);
  assert.equal(runtime.capabilities.capabilities_version, 1);
  // The device never self-reports the gateway-derived contract level.
  assert.equal('contract_level' in runtime.capabilities, false);
  // 0050a has no canonical ACK lifecycle: the honest Core fact is false,
  // which pins the gateway-derived level at legacy (never v1).
  assert.equal(runtime.capabilities.command_ack, false);
  assert.equal(runtime.capabilities['openclaw.binding_registry'], 'process_local');
});

test('both declaration wire sites (RUNTIMES.LIST + SESSION.REGISTER) declare runtime_kind + capabilities', () => {
  // The declaration travels on exactly two wire sites: the RUNTIMES.LIST
  // runtime entry (bot_ws._handle_runtimes_list) and the SESSION.REGISTER
  // payload (platform_service.register_bot_session). Each site must carry
  // runtime_kind AND capabilities together, from the single 0050a builder —
  // a third site, a missing site, or a kind-less site would silently
  // desynchronize the declaration between runtimes listing and session
  // registration. Pinned against the built channel.js (the shipped artifact),
  // structurally per site — not just by a global count.
  const built = readFileSync(new URL('../dist/src/channel.js', import.meta.url), 'utf-8');

  const countOf = (haystack, needle) => haystack.split(needle).length - 1;

  // Exactly two declaration sites on the whole built artifact.
  assert.equal(
    countOf(built, 'capabilities: buildOpenclawCapabilityDeclaration()'),
    2,
    'RUNTIMES.LIST entry + SESSION.REGISTER must both declare capabilities',
  );
  assert.equal(
    countOf(built, 'runtime_kind: OPENCLAW_RUNTIME_KIND'),
    2,
    'both declaration sites must declare runtime_kind',
  );

  // ── Site 1: the RUNTIMES.LIST runtime entry builder ──
  const listStart = built.indexOf('export function buildOpenclawRuntimeListPayload(');
  assert.notEqual(listStart, -1, 'runtime list builder present');
  const listEnd = built.indexOf('\nfunction ', listStart);
  assert.notEqual(listEnd, -1, 'runtime list builder region delimited');
  const listRegion = built.slice(listStart, listEnd);
  assert.equal(
    countOf(listRegion, 'runtime_kind: OPENCLAW_RUNTIME_KIND'),
    1,
    'RUNTIMES.LIST entry declares runtime_kind',
  );
  assert.equal(
    countOf(listRegion, 'capabilities: buildOpenclawCapabilityDeclaration()'),
    1,
    'RUNTIMES.LIST entry declares capabilities',
  );

  // ── Site 2: the SESSION.REGISTER payload sender ──
  const registerStart = built.indexOf('const sendSessionRegister = (entry) => {');
  assert.notEqual(registerStart, -1, 'session register sender present');
  const registerEnd = built.indexOf("client.on('SESSION.REGISTER_ACK'", registerStart);
  assert.notEqual(registerEnd, -1, 'session register sender region delimited');
  const registerRegion = built.slice(registerStart, registerEnd);
  assert.equal(
    countOf(registerRegion, 'runtime_kind: OPENCLAW_RUNTIME_KIND'),
    1,
    'SESSION.REGISTER payload declares runtime_kind',
  );
  assert.equal(
    countOf(registerRegion, 'capabilities: buildOpenclawCapabilityDeclaration()'),
    1,
    'SESSION.REGISTER payload declares capabilities',
  );

  // The two regions are distinct structures that together account for the
  // global count — no third site hides outside them.
  assert.ok(registerStart > listStart, 'wire sites live in distinct regions');
  assert.equal(
    countOf(built, 'capabilities: buildOpenclawCapabilityDeclaration()'),
    countOf(listRegion, 'capabilities: buildOpenclawCapabilityDeclaration()') +
      countOf(registerRegion, 'capabilities: buildOpenclawCapabilityDeclaration()'),
    'both sites are fully accounted for by the two structures',
  );
});
