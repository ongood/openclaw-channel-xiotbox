// Contract tests for XIOT-BUG-0050a (explicit OpenClaw runtime profile).
//
// The channel declares a truthful capability profile instead of leaving the
// gateway/client to guess. 0050a is declaration-only: contract_level stays in
// the legacy/transition band (never v1) and the binding registry lifecycle is
// stated explicitly (process_local). Nothing here exercises the 0050b runtime
// lifecycle (ACK/DELIVERED, structured rejection, error normalization).

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  OPENCLAW_BINDING_REGISTRY_CAN_SELECT,
  OPENCLAW_BINDING_REGISTRY_LIFECYCLE,
  OPENCLAW_CAPABILITIES_VERSION,
  OPENCLAW_CONTRACT_LEVEL,
  OPENCLAW_MODEL_CATALOG_AVAILABLE,
  OPENCLAW_RUNTIME_KIND,
  buildOpenclawRuntimeProfile,
} from '../dist/src/runtime-profile.js';

test('runtime kind is the stable explicit openclaw identifier', () => {
  assert.equal(OPENCLAW_RUNTIME_KIND, 'openclaw');
});

test('capabilities version is pinned at 1', () => {
  assert.equal(OPENCLAW_CAPABILITIES_VERSION, 1);
});

test('0050a contract level is transition and never claims v1', () => {
  assert.equal(OPENCLAW_CONTRACT_LEVEL, 'transition');
  assert.notEqual(OPENCLAW_CONTRACT_LEVEL, 'v1');
});

test('binding registry lifecycle is declared process_local', () => {
  assert.equal(OPENCLAW_BINDING_REGISTRY_LIFECYCLE, 'process_local');
});

test('profile declares the full frozen capability shape', () => {
  const profile = buildOpenclawRuntimeProfile();
  assert.deepEqual(profile, {
    runtime_kind: 'openclaw',
    capabilities_version: 1,
    contract_level: 'transition',
    conversation_create: true,
    workspace_context: false,
    e2e: { required_for_commands: true },
    model_catalog: false,
    models: [],
    model_selection: true,
    openclaw: { binding_registry: 'process_local' },
  });
});

test('conversation_create is neutral (platform creates + binds)', () => {
  // The gateway owns conversation creation and binding; the channel does not
  // fork/create/delete conversations on its own.
  assert.equal(buildOpenclawRuntimeProfile().conversation_create, true);
});

test('workspace_context is false (no OpenClaw workspace seam yet)', () => {
  assert.equal(buildOpenclawRuntimeProfile().workspace_context, false);
});

test('e2e requires an OGE2E1 envelope for chat commands', () => {
  assert.equal(buildOpenclawRuntimeProfile().e2e.required_for_commands, true);
});

test('model_catalog=false implies an empty models list', () => {
  const profile = buildOpenclawRuntimeProfile();
  assert.equal(profile.model_catalog, false);
  assert.equal(OPENCLAW_MODEL_CATALOG_AVAILABLE, false);
  assert.deepEqual(profile.models, []);
  assert.equal(profile.models.length, 0);
});

test('model_selection is detected independently from model_catalog', () => {
  // The binding registry supports per-session selection, so model_selection
  // stays true even though no static model catalog is published.
  assert.equal(OPENCLAW_BINDING_REGISTRY_CAN_SELECT, true);
  const profile = buildOpenclawRuntimeProfile();
  assert.equal(profile.model_catalog, false);
  assert.equal(profile.model_selection, true);
});

test('binding registry lifecycle is explicit on the profile', () => {
  assert.equal(
    buildOpenclawRuntimeProfile().openclaw.binding_registry,
    'process_local',
  );
});

test('profile is a plain JSON-serializable wire object', () => {
  const profile = buildOpenclawRuntimeProfile();
  const roundTripped = JSON.parse(JSON.stringify(profile));
  assert.deepEqual(roundTripped, profile);
});

test('builder rejects claiming the v1 contract before 0050b', () => {
  assert.throws(
    () => buildOpenclawRuntimeProfile({ contractLevel: 'v1' }),
    /contract_level_v1_not_claimable/,
  );
});

test('builder allows narrowing the contract level to legacy', () => {
  const profile = buildOpenclawRuntimeProfile({ contractLevel: 'legacy' });
  assert.equal(profile.contract_level, 'legacy');
  assert.notEqual(profile.contract_level, 'v1');
});

test('builder can narrow model_selection independently of model_catalog', () => {
  // If the binding registry ever loses its select seam, model_selection can be
  // narrowed to false without touching model_catalog/models.
  const profile = buildOpenclawRuntimeProfile({ modelSelection: false });
  assert.equal(profile.model_selection, false);
  assert.equal(profile.model_catalog, false);
  assert.deepEqual(profile.models, []);
});

test('builder surfaces a persistent binding registry lifecycle when provided', () => {
  const profile = buildOpenclawRuntimeProfile({ bindingRegistry: 'persistent' });
  assert.equal(profile.openclaw.binding_registry, 'persistent');
});
