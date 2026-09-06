// Contract tests for XIOT-BUG-0050a (explicit OpenClaw capability declaration).
//
// The channel declares truthful device facts instead of leaving the
// gateway/client to guess. The declaration is published under the exact
// `capabilities` key the Gateway 0048a contract reads (RUNTIMES.LIST runtime
// entries + SESSION.REGISTER payloads) and follows the frozen 0048a
// normalize_declaration shape: strict capabilities_version=1, tri-state
// Core/Optional facts, a structurally valid e2e policy block, and dotted
// adapter-namespaced extensions.
//
// The device NEVER self-reports the gateway-normalized `contract_level`: the
// gateway derives "v1"/"legacy" itself. Because 0050a has no canonical
// COMMAND_ACK lifecycle (that is 0050b), the declaration states
// command_ack=false, which truthfully pins the derived level at "legacy".
//
// The `gatewayNormalizeDeclaration` fixture below is a faithful JS mirror of
// gateway/services/runtime_profile.py on the 0048a branch (PR #16):
// normalize_declaration + normalize_e2e_declaration + build_runtime_profile
// including the openclaw.v1 adapter static fill and the contract_level
// derivation. It exists so these tests exercise the exact input shape the
// gateway consumes — not a private schema.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  OPENCLAW_BINDING_REGISTRY_CAN_SELECT,
  OPENCLAW_BINDING_REGISTRY_LIFECYCLE,
  OPENCLAW_CAPABILITIES_VERSION,
  OPENCLAW_E2E_ALG,
  OPENCLAW_E2E_ENVELOPE,
  OPENCLAW_MODEL_CATALOG_AVAILABLE,
  OPENCLAW_RUNTIME_KIND,
  buildOpenclawCapabilityDeclaration,
  buildOpenclawResourceFacts,
} from '../dist/src/runtime-profile.js';
import { buildOpenclawRuntimeListPayload } from '../dist/src/channel.js';

// ── Gateway 0048a fixture (mirror of runtime_profile.py, PR #16) ─────────

const TRI_STATE_UNKNOWN = 'unknown';

// runtime_profile.py CORE_CAPABILITIES
const CORE_CAPABILITIES = [
  'message_send',
  'message_user_projection',
  'run_lifecycle',
  'command_ack',
  'capability_advertisement',
  'e2e_policy_declaration',
];

// runtime_profile.py OPTIONAL_CAPABILITIES
const OPTIONAL_CAPABILITIES = [
  'conversation_create',
  'conversation_rename',
  'conversation_archive',
  'conversation_delete',
  'conversation_fork',
  'workspace_context',
  'workspace_create',
  'model_selection',
  'model_catalog',
  'interrupt',
  'queue',
  'queue_edit',
  'queue_remove',
  'queue_promote',
  'ask_user',
  'ask_user_custom',
  'approvals',
  'permissions_set',
  'tool_events',
  'reasoning',
  'subagents',
  'attachments',
  'goal',
];

// runtime_profile.py ADAPTER_STATIC_CAPABILITIES['openclaw.v1']
const OPENCLAW_ADAPTER_STATIC = {
  queue: false,
  queue_edit: false,
  queue_remove: false,
  queue_promote: false,
  interrupt: false,
  model_selection: true,
  reasoning: true,
  tool_events: true,
  approvals: true,
  ask_user: true,
  ask_user_custom: false,
  subagents: true,
  conversation_archive: true,
  conversation_delete: true,
  conversation_fork: false,
  attachments: true,
  goal: false,
};

function normalizeTriState(value) {
  if (value === true) return true;
  if (value === false) return false;
  if (typeof value === 'string' && value.trim().toLowerCase() === TRI_STATE_UNKNOWN) {
    return TRI_STATE_UNKNOWN;
  }
  return TRI_STATE_UNKNOWN;
}

// normalize_e2e_declaration: required_for_commands must be a strict JSON bool;
// envelope/alg/control_plane_identity must be non-empty strings when present.
// Missing required_for_commands voids the policy; missing text keys stay
// "unknown" without voiding it.
function normalizeE2eDeclaration(e2eRaw) {
  const normalized = {};
  let valid = true;
  if ('required_for_commands' in e2eRaw) {
    const raw = e2eRaw.required_for_commands;
    if (raw === true || raw === false) {
      normalized.required_for_commands = raw;
    } else {
      normalized.required_for_commands = TRI_STATE_UNKNOWN;
      valid = false;
    }
  } else {
    normalized.required_for_commands = TRI_STATE_UNKNOWN;
    valid = false;
  }
  for (const textKey of ['envelope', 'alg', 'control_plane_identity']) {
    if (textKey in e2eRaw) {
      const raw = e2eRaw[textKey];
      if (typeof raw === 'string' && raw.trim()) {
        normalized[textKey] = raw.trim();
      } else {
        normalized[textKey] = TRI_STATE_UNKNOWN;
        valid = false;
      }
    } else {
      normalized[textKey] = TRI_STATE_UNKNOWN;
    }
  }
  return [normalized, valid];
}

// normalize_declaration + build_runtime_profile for the openclaw adapter.
// Returns the gateway-shaped normalized profile (or a rejection).
function gatewayNormalizeDeclaration(declaration) {
  if (declaration === null || declaration === undefined) {
    return { accepted: false, rejection: 'missing_capabilities_version' };
  }
  if (typeof declaration !== 'object' || Array.isArray(declaration)) {
    return { accepted: false, rejection: 'declaration_not_object' };
  }
  const rawVersion = declaration.capabilities_version;
  if (rawVersion === undefined || rawVersion === null) {
    return { accepted: false, rejection: 'missing_capabilities_version' };
  }
  if (typeof rawVersion !== 'number' || !Number.isInteger(rawVersion)) {
    return { accepted: false, rejection: 'invalid_capabilities_version' };
  }
  if (rawVersion !== 1) {
    return { accepted: false, rejection: 'unsupported_capabilities_version' };
  }
  const declared = {};
  for (const key of [...CORE_CAPABILITIES, ...OPTIONAL_CAPABILITIES]) {
    if (key in declaration) declared[key] = normalizeTriState(declaration[key]);
  }
  let declaredE2e = {};
  let declaredE2eValid = false;
  if (declaration.e2e && typeof declaration.e2e === 'object' && !Array.isArray(declaration.e2e)) {
    [declaredE2e, declaredE2eValid] = normalizeE2eDeclaration(declaration.e2e);
  }
  if (Object.keys(declared).length === 0 && !declaredE2eValid && Object.keys(declaredE2e).length === 0) {
    return { accepted: false, rejection: 'declaration_empty' };
  }
  const accepted = true;

  const core = {};
  for (const key of CORE_CAPABILITIES) core[key] = key in declared ? declared[key] : TRI_STATE_UNKNOWN;
  const optional = {};
  for (const key of OPTIONAL_CAPABILITIES) optional[key] = key in declared ? declared[key] : TRI_STATE_UNKNOWN;
  // Static contract fills only tri-state gaps; device facts always win.
  for (const [key, value] of Object.entries(OPENCLAW_ADAPTER_STATIC)) {
    if (optional[key] === TRI_STATE_UNKNOWN) optional[key] = value;
  }
  const e2ePolicyValid = Boolean(accepted && declaredE2eValid);
  core.e2e = {
    required_for_commands: declaredE2e.required_for_commands ?? TRI_STATE_UNKNOWN,
    envelope: declaredE2e.envelope ?? TRI_STATE_UNKNOWN,
    alg: declaredE2e.alg ?? TRI_STATE_UNKNOWN,
    control_plane_identity: declaredE2e.control_plane_identity ?? TRI_STATE_UNKNOWN,
  };
  // Resource data rides under optional, never consulted for tri-states.
  optional.workspaces = [];
  optional.models = [];

  // contract_level="v1" only when the device declared every Core fact true
  // AND the e2e policy is structurally valid; everything else is "legacy".
  const contractLevel =
    accepted && CORE_CAPABILITIES.every((key) => core[key] === true) && e2ePolicyValid
      ? 'v1'
      : 'legacy';

  return {
    accepted,
    rejection: null,
    profile: {
      runtime_kind: 'openclaw',
      adapter: 'openclaw.v1',
      protocol_version: 1,
      capabilities_version: 1,
      contract_level: contractLevel,
      profile_source: 'device',
      core,
      optional,
    },
  };
}

// ── Declaration shape (device facts) ─────────────────────────────────────

test('runtime kind is the stable explicit openclaw identifier', () => {
  assert.equal(OPENCLAW_RUNTIME_KIND, 'openclaw');
});

test('capabilities version is pinned at the strict integer 1', () => {
  assert.equal(OPENCLAW_CAPABILITIES_VERSION, 1);
  assert.equal(typeof OPENCLAW_CAPABILITIES_VERSION, 'number');
  assert.equal(Number.isInteger(OPENCLAW_CAPABILITIES_VERSION), true);
});

test('binding registry lifecycle is declared process_local', () => {
  assert.equal(OPENCLAW_BINDING_REGISTRY_LIFECYCLE, 'process_local');
});

test('declaration is a plain JSON-serializable wire object', () => {
  const declaration = buildOpenclawCapabilityDeclaration();
  const roundTripped = JSON.parse(JSON.stringify(declaration));
  assert.deepEqual(roundTripped, declaration);
});

test('declaration does not self-report a gateway-normalized contract_level', () => {
  // The gateway derives v1/legacy itself; a device-side contract_level key
  // would drift from the 0048a vocabulary.
  const declaration = buildOpenclawCapabilityDeclaration();
  assert.equal('contract_level' in declaration, false);
  assert.equal(JSON.stringify(declaration).includes('contract_level'), false);
});

test('declaration does not smuggle resource data into the tri-state space', () => {
  // models/workspaces are resource facts that ride next to the declaration,
  // never capability keys inside it (0048a rule 4).
  const declaration = buildOpenclawCapabilityDeclaration();
  assert.equal('models' in declaration, false);
  assert.equal('workspaces' in declaration, false);
  const facts = buildOpenclawResourceFacts();
  assert.deepEqual(facts, { workspaces: [], models: [] });
});

test('command_ack is declared false so the gateway can never derive v1 from 0050a', () => {
  // No canonical COMMAND_ACK/COMMAND_DELIVERED lifecycle exists in this
  // increment (0050b). Declaring ack=true would be the v1 lie.
  const declaration = buildOpenclawCapabilityDeclaration();
  assert.equal(declaration.command_ack, false);
});

test('all six Core facts are declared (with the honest command_ack=false)', () => {
  const declaration = buildOpenclawCapabilityDeclaration();
  for (const key of CORE_CAPABILITIES) {
    assert.equal(
      typeof declaration[key], 'boolean',
      `Core fact ${key} must be declared as a strict bool`,
    );
  }
  assert.equal(declaration.message_send, true);
  assert.equal(declaration.message_user_projection, true);
  assert.equal(declaration.run_lifecycle, true);
  assert.equal(declaration.capability_advertisement, true);
  assert.equal(declaration.e2e_policy_declaration, true);
});

test('conversation_create is neutral true (platform creates + binds)', () => {
  // The gateway owns conversation creation and the channel registers the
  // binding (SESSION.REGISTER). The absence of a native session.create
  // command must not flip this to false.
  const declaration = buildOpenclawCapabilityDeclaration();
  assert.equal(declaration.conversation_create, true);
});

test('conversation word list declares the real support matrix', () => {
  const declaration = buildOpenclawCapabilityDeclaration();
  assert.equal(declaration.conversation_create, true);
  assert.equal(declaration.conversation_rename, false);
  assert.equal(declaration.conversation_archive, true);
  assert.equal(declaration.conversation_delete, undefined); // static-contract owned
  assert.equal(declaration.conversation_fork, false);
});

test('workspace_context is false and never derived from the empty list', () => {
  const declaration = buildOpenclawCapabilityDeclaration();
  assert.equal(declaration.workspace_context, false);
  assert.equal(declaration.workspace_create, false);
  assert.deepEqual(buildOpenclawResourceFacts().workspaces, []);
});

test('e2e policy requires OGE2E1 for chat commands', () => {
  const declaration = buildOpenclawCapabilityDeclaration();
  assert.equal(declaration.e2e.required_for_commands, true);
  assert.equal(declaration.e2e.envelope, 'OGE2E1');
  assert.equal(OPENCLAW_E2E_ENVELOPE, 'OGE2E1');
  assert.equal(declaration.e2e.alg, 'x25519+AES-256-GCM');
  assert.equal(OPENCLAW_E2E_ALG, 'x25519+AES-256-GCM');
  // control_plane_identity is not declared: 0046c owns that line.
  assert.equal('control_plane_identity' in declaration.e2e, false);
});

test('model_catalog=false with an empty models list, model_selection stays independently true', () => {
  assert.equal(OPENCLAW_MODEL_CATALOG_AVAILABLE, false);
  assert.equal(OPENCLAW_BINDING_REGISTRY_CAN_SELECT, true);
  const declaration = buildOpenclawCapabilityDeclaration();
  assert.equal(declaration.model_catalog, false);
  assert.equal(declaration.model_selection, true);
});

test('builder can narrow model_selection without touching model_catalog', () => {
  const declaration = buildOpenclawCapabilityDeclaration({ modelSelection: false });
  assert.equal(declaration.model_selection, false);
  assert.equal(declaration.model_catalog, false);
});

test('binding registry lifecycle is the namespaced extension key', () => {
  const declaration = buildOpenclawCapabilityDeclaration();
  assert.equal(declaration['openclaw.binding_registry'], 'process_local');
  const persistent = buildOpenclawCapabilityDeclaration({ bindingRegistry: 'persistent' });
  assert.equal(persistent['openclaw.binding_registry'], 'persistent');
});

// ── Gateway 0048a normalization outcomes (the shape actually consumed) ───

test('gateway accepts the declaration as a device fact (no rejection)', () => {
  const outcome = gatewayNormalizeDeclaration(buildOpenclawCapabilityDeclaration());
  assert.equal(outcome.accepted, true);
  assert.equal(outcome.rejection, null);
  assert.equal(outcome.profile.profile_source, 'device');
});

test('gateway derives contract_level=legacy from command_ack=false (never v1)', () => {
  const outcome = gatewayNormalizeDeclaration(buildOpenclawCapabilityDeclaration());
  assert.equal(outcome.profile.contract_level, 'legacy');
  assert.notEqual(outcome.profile.contract_level, 'v1');
  assert.equal(outcome.profile.core.command_ack, false);
});

test('gateway profile keeps the declared tri-states verbatim', () => {
  const declaration = buildOpenclawCapabilityDeclaration();
  const outcome = gatewayNormalizeDeclaration(declaration);
  assert.equal(outcome.profile.core.message_send, true);
  assert.equal(outcome.profile.core.message_user_projection, true);
  assert.equal(outcome.profile.core.run_lifecycle, true);
  assert.equal(outcome.profile.core.capability_advertisement, true);
  assert.equal(outcome.profile.core.e2e_policy_declaration, true);
  assert.equal(outcome.profile.optional.conversation_create, true);
  assert.equal(outcome.profile.optional.workspace_context, false);
  assert.equal(outcome.profile.optional.model_selection, true);
  assert.equal(outcome.profile.optional.model_catalog, false);
  assert.equal(outcome.profile.optional.interrupt, false);
  assert.equal(outcome.profile.optional.queue, false);
  assert.equal(outcome.profile.optional.ask_user, true);
  assert.equal(outcome.profile.optional.ask_user_custom, false);
  assert.equal(outcome.profile.optional.subagents, true);
  assert.equal(outcome.profile.optional.reasoning, true);
  assert.equal(outcome.profile.optional.tool_events, true);
  assert.equal(outcome.profile.optional.approvals, true);
  assert.equal(outcome.profile.optional.permissions_set, true);
  assert.equal(outcome.profile.optional.attachments, true);
  assert.equal(outcome.profile.optional.goal, false);
});

test('gateway fills the undeclared conversation_delete from the adapter static contract', () => {
  // The device does not assert conversation_delete; the openclaw.v1 static
  // contract owns that fact. Documented seam — the device never guesses.
  const outcome = gatewayNormalizeDeclaration(buildOpenclawCapabilityDeclaration());
  assert.equal(outcome.profile.optional.conversation_delete, true);
});

test('gateway normalizes the undeclared control_plane_identity to unknown', () => {
  const outcome = gatewayNormalizeDeclaration(buildOpenclawCapabilityDeclaration());
  assert.equal(outcome.profile.core.e2e.required_for_commands, true);
  assert.equal(outcome.profile.core.e2e.envelope, 'OGE2E1');
  assert.equal(outcome.profile.core.e2e.alg, 'x25519+AES-256-GCM');
  assert.equal(outcome.profile.core.e2e.control_plane_identity, 'unknown');
});

test('gateway treats resource data as empty arrays under optional', () => {
  const outcome = gatewayNormalizeDeclaration(buildOpenclawCapabilityDeclaration());
  assert.deepEqual(outcome.profile.optional.workspaces, []);
  assert.deepEqual(outcome.profile.optional.models, []);
});

test('gateway drops the openclaw.binding_registry extension (recorded cross-repo seam)', () => {
  // The declaration carries the extension truthfully, but the 0048a
  // normalize_declaration consumes only the frozen vocabulary: the
  // normalized profile has NO binding_registry field. Extension preservation
  // is a gateway-side (0048a line) change — this test pins the current
  // reality so the OpenClaw side never pretends it is consumed.
  const outcome = gatewayNormalizeDeclaration(buildOpenclawCapabilityDeclaration());
  assert.equal('openclaw.binding_registry' in outcome.profile, false);
  assert.equal(JSON.stringify(outcome.profile).includes('binding_registry'), false);
});

test('a command_ack=true declaration would derive v1 (proves the guard is real)', () => {
  // Control experiment: flip only command_ack and the same declaration
  // reaches v1 — which is exactly why 0050a must declare false.
  const forged = {
    ...buildOpenclawCapabilityDeclaration(),
    command_ack: true,
  };
  const outcome = gatewayNormalizeDeclaration(forged);
  assert.equal(outcome.profile.contract_level, 'v1');
});

test('declaration without capabilities_version is rejected by the gateway shape', () => {
  const { capabilities_version, ...versionless } = buildOpenclawCapabilityDeclaration();
  const outcome = gatewayNormalizeDeclaration(versionless);
  assert.equal(outcome.accepted, false);
  assert.equal(outcome.rejection, 'missing_capabilities_version');
});

test('declaration with a non-1 capabilities_version is rejected by the gateway shape', () => {
  const forged = { ...buildOpenclawCapabilityDeclaration(), capabilities_version: 2 };
  const outcome = gatewayNormalizeDeclaration(forged);
  assert.equal(outcome.accepted, false);
  assert.equal(outcome.rejection, 'unsupported_capabilities_version');
});

test('e2e block without required_for_commands voids the policy at the gateway', () => {
  const forged = { ...buildOpenclawCapabilityDeclaration() };
  delete forged.e2e;
  const outcome = gatewayNormalizeDeclaration(forged);
  // Still a valid declaration of facts, but the e2e policy is not
  // structurally valid → contract_level stays legacy, required=unknown.
  assert.equal(outcome.accepted, true);
  assert.equal(outcome.profile.core.e2e.required_for_commands, 'unknown');
  assert.equal(outcome.profile.contract_level, 'legacy');
});

// ── Wire placement: RUNTIMES.LIST entry uses the gateway-read key ────────

test('runtime list entry publishes the declaration under `capabilities` (not `profile`)', () => {
  const payload = buildOpenclawRuntimeListPayload('dev-1');
  const runtime = payload.runtimes[0];
  assert.equal('profile' in runtime, false);
  assert.deepEqual(runtime.capabilities, buildOpenclawCapabilityDeclaration());
});

test('runtime list entry keeps resource facts as siblings of the declaration', () => {
  const payload = buildOpenclawRuntimeListPayload('dev-1');
  const runtime = payload.runtimes[0];
  assert.deepEqual(runtime.workspaces, []);
  assert.deepEqual(runtime.models, []);
  assert.equal(runtime.runtime_kind, 'openclaw');
});
