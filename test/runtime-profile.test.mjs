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
// The `gatewayNormalizeDeclaration` / `gatewayNormalizeRuntimeEntry` fixtures
// below are a faithful JS mirror of gateway/services/runtime_profile.py on
// gateway main (review round 3 of PR #16): normalize_declaration,
// normalize_e2e_declaration, adapter_for_runtime_kind and build_runtime_profile,
// including BOTH adapter static contracts, REGISTERED_EXTENSIONS preservation,
// provenance and profile_source. They exist so these tests exercise the exact
// input shape the gateway consumes — not a private schema.
//
// Known mirror limitation (JSON typing, not a semantic gap): the gateway
// rejects a capabilities_version that is not a strict JSON integer, and
// Python's json distinguishes the tokens `1` (int) from `1.0` (float). A JS
// JSON.parse cannot carry that distinction (1.0 parses to 1), so the
// 1.0-is-a-float rejection is not reproducible here; the portable rejections
// (booleans, numeric strings, non-integer numbers, other integers) are all
// pinned below.

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

// ── Gateway 0048a fixture (mirror of runtime_profile.py) ─────────────────

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

// runtime_profile.py ADAPTER_STATIC_CAPABILITIES (both versioned adapters,
// verbatim). Optional-capability facts only — Core is never statically
// provable, so Core stays "unknown" until the device declares it.
const ADAPTER_STATIC_CAPABILITIES = {
  'openclaw.v1': {
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
  },
  'dsh.v1': {
    queue: true,
    queue_edit: true,
    queue_remove: true,
    queue_promote: true,
    interrupt: true,
    model_selection: true,
    reasoning: true,
    tool_events: true,
    approvals: true,
    ask_user: true,
    ask_user_custom: true,
    subagents: true,
    conversation_archive: true,
    conversation_delete: false,
    conversation_fork: true,
    attachments: true,
    goal: true,
  },
};

// runtime_profile.py RUNTIME_KIND_TO_ADAPTER + compat/unknown rules.
const RUNTIME_KIND_TO_ADAPTER = { dsh: 'dsh.v1', openclaw: 'openclaw.v1' };
const UNKNOWN_ADAPTER_ID = 'unknown';
const LEGACY_COMPAT_ADAPTER = 'dsh.v1';

// runtime_profile.py REGISTERED_EXTENSIONS (§3.4.1, review round 3 PR #16).
const REGISTERED_EXTENSIONS = ['openclaw.binding_registry'];

// adapter_for_runtime_kind: absent kind → legacy compat adapter; known kinds
// map through the registry; unknown kinds resolve to "unknown" and are NEVER
// folded into dsh.v1 (XIOT-BUG-0048).
function adapterForRuntimeKind(kind) {
  const normalized = String(kind || '').trim().toLowerCase();
  if (!normalized) return LEGACY_COMPAT_ADAPTER;
  return RUNTIME_KIND_TO_ADAPTER[normalized] || UNKNOWN_ADAPTER_ID;
}

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

// normalize_declaration mirror. Returns the exact 7-field outcome tuple as an
// object: {accepted, rejection, declared, declaredE2e, declaredVersion,
// declaredE2eValid, declaredExtensions}. Rejection rules are applied to the
// WHOLE declaration — no partial application, no per-field guessing (§9.1 N2).
function gatewayNormalizeDeclarationFields(declaration) {
  const fail = (rejection, declaredVersion, declaredE2eValid) => ({
    accepted: false,
    rejection,
    declared: {},
    declaredE2e: {},
    declaredVersion,
    declaredE2eValid,
    declaredExtensions: {},
  });
  if (declaration === null || declaration === undefined) {
    // runtime_profile.py: a None declaration is "absent", not malformed —
    // rejected fail-closed with rejection=None (the per-entry legacy path).
    return fail(null, null, false);
  }
  if (typeof declaration !== 'object' || Array.isArray(declaration)) {
    return fail('declaration_not_object', null, false);
  }
  const rawVersion = declaration.capabilities_version;
  if (rawVersion === undefined || rawVersion === null) {
    return fail('missing_capabilities_version', null, false);
  }
  // Strict typing: booleans, floats and numeric strings must stay rejections.
  if (typeof rawVersion !== 'number' || !Number.isInteger(rawVersion)) {
    return fail('invalid_capabilities_version', null, false);
  }
  if (rawVersion !== 1) {
    return fail('unsupported_capabilities_version', rawVersion, false);
  }
  const declared = {};
  for (const key of [...CORE_CAPABILITIES, ...OPTIONAL_CAPABILITIES]) {
    if (key in declaration) declared[key] = normalizeTriState(declaration[key]);
  }
  // Preserve registered adapter-namespaced extensions verbatim. Namespaced
  // keys that are not registered, and bare unknown keys, stay ignored: the
  // registry — not the sender — decides what the control plane understands.
  const declaredExtensions = {};
  for (const key of Object.keys(declaration)) {
    if (REGISTERED_EXTENSIONS.includes(key)) declaredExtensions[key] = declaration[key];
  }
  let declaredE2e = {};
  let declaredE2eValid = false;
  if (declaration.e2e && typeof declaration.e2e === 'object' && !Array.isArray(declaration.e2e)) {
    [declaredE2e, declaredE2eValid] = normalizeE2eDeclaration(declaration.e2e);
  }
  // A declaration that names no known capability and no e2e block is not a
  // declaration at all. (An e2e dict that normalizes to all-unknown still
  // counts as a declaration — it is accepted with an invalid policy.)
  if (Object.keys(declared).length === 0 && Object.keys(declaredE2e).length === 0) {
    return fail('declaration_empty', rawVersion, declaredE2eValid);
  }
  return {
    accepted: true,
    rejection: null,
    declared,
    declaredE2e,
    declaredVersion: rawVersion,
    declaredE2eValid,
    declaredExtensions,
  };
}

// build_runtime_profile mirror: the full normalized profile shape the gateway
// stores per runtime (§3.2) and per SESSION.REGISTER.
function buildRuntimeProfileMirror({
  runtimeKind = '',
  adapterId = null,
  runtimeId = null,
  declaration = null,
  workspaces = null,
  models = null,
} = {}) {
  const kind = String(runtimeKind || '').trim().toLowerCase();
  const adapter = String(adapterId || '').trim() || UNKNOWN_ADAPTER_ID;
  const n = gatewayNormalizeDeclarationFields(declaration);
  const staticCaps = Object.prototype.hasOwnProperty.call(ADAPTER_STATIC_CAPABILITIES, adapter)
    ? ADAPTER_STATIC_CAPABILITIES[adapter]
    : null;
  const staticApplied = staticCaps !== null;

  // `declared` only carries keys the device actually sent, so presence
  // distinguishes a true omission (fillable by the static contract) from an
  // explicit device "unknown" — a device fact that static must never override.
  const core = {};
  for (const key of CORE_CAPABILITIES) {
    core[key] = key in n.declared ? n.declared[key] : TRI_STATE_UNKNOWN;
  }
  const optional = {};
  for (const key of OPTIONAL_CAPABILITIES) {
    optional[key] = key in n.declared ? n.declared[key] : TRI_STATE_UNKNOWN;
  }
  if (staticCaps) {
    for (const [key, value] of Object.entries(staticCaps)) {
      if (!(key in n.declared)) optional[key] = value;
    }
  }

  // Registered extensions ride next to the neutral gate; a rejected
  // declaration is fail-closed as a whole (no extensions survive).
  const extensions = n.accepted ? { ...n.declaredExtensions } : {};
  const e2ePolicyValid = Boolean(n.accepted && n.declaredE2eValid);
  core.e2e = {
    required_for_commands: n.declaredE2e.required_for_commands ?? TRI_STATE_UNKNOWN,
    envelope: n.declaredE2e.envelope ?? TRI_STATE_UNKNOWN,
    alg: n.declaredE2e.alg ?? TRI_STATE_UNKNOWN,
    control_plane_identity: n.declaredE2e.control_plane_identity ?? TRI_STATE_UNKNOWN,
  };

  let source;
  if (n.accepted) {
    source = 'device';
  } else if (!kind && adapter === LEGACY_COMPAT_ADAPTER) {
    // Undeclared-kind migration path (§6.3/§10.2): marked before the generic
    // static fill so legacy compat can never masquerade as a declared
    // adapter contract.
    source = 'legacy_compat';
  } else if (staticApplied) {
    source = 'adapter_static';
  } else {
    source = 'unknown';
  }

  // v1 requires the DEVICE to have declared every Core fact true plus a
  // structurally valid e2e policy; static fills and legacy compat can never
  // manufacture v1.
  const contractLevel =
    source === 'device' &&
    CORE_CAPABILITIES.every((key) => core[key] === true) &&
    e2ePolicyValid
      ? 'v1'
      : 'legacy';

  // Resource data rides under optional, never consulted for tri-states.
  optional.workspaces = Array.isArray(workspaces) ? [...workspaces] : [];
  optional.models = Array.isArray(models) ? [...models] : [];

  const profile = {
    runtime_kind: kind,
    adapter,
    protocol_version: 1,
    capabilities_version: 1,
    contract_level: contractLevel,
    profile_source: source,
    provenance: {
      device_declared: n.accepted,
      device_capabilities_version:
        n.accepted && n.declaredVersion !== null ? n.declaredVersion : null,
      adapter_static_applied: staticApplied,
      legacy_compat: source === 'legacy_compat',
      e2e_policy_valid: e2ePolicyValid,
      extensions_preserved: Object.keys(extensions).sort(),
      declaration_rejected: n.rejection,
    },
    core,
    optional,
    extensions,
  };
  if (runtimeId !== null && runtimeId !== undefined && String(runtimeId).trim()) {
    profile.runtime_id = String(runtimeId).trim();
  }
  return profile;
}

// Wrapper preserving the outcome shape the tests below consume: openclaw
// adapter defaults, plus the normalized profile.
function gatewayNormalizeDeclaration(declaration) {
  const n = gatewayNormalizeDeclarationFields(declaration);
  return {
    accepted: n.accepted,
    rejection: n.rejection,
    profile: buildRuntimeProfileMirror({
      runtimeKind: 'openclaw',
      adapterId: 'openclaw.v1',
      declaration,
    }),
  };
}

// Faithful mirror of the per-entry loop in gateway/ws/bot_ws.py
// _handle_runtimes_list: every RUNTIMES.LIST entry is normalized
// independently, with the raw capabilities payload passed through.
function gatewayNormalizeRuntimeEntry(entry) {
  return buildRuntimeProfileMirror({
    runtimeId: entry.runtime_id,
    runtimeKind: String(entry.runtime_kind || ''),
    adapterId: adapterForRuntimeKind(entry.runtime_kind),
    declaration: entry.capabilities !== undefined ? entry.capabilities : null,
    workspaces: entry.workspaces,
    models: entry.models,
  });
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

test('an explicit device unknown beats the adapter static contract (review round 3)', () => {
  // Static fills only true omissions. A device that answers "unknown" has
  // answered the question — the static contract must never override it.
  const hedged = {
    ...buildOpenclawCapabilityDeclaration(),
    model_selection: 'unknown',
    interrupt: 'unknown',
  };
  const outcome = gatewayNormalizeDeclaration(hedged);
  assert.equal(outcome.accepted, true);
  // openclaw.v1 static would say model_selection=true / interrupt=false…
  assert.equal(ADAPTER_STATIC_CAPABILITIES['openclaw.v1'].model_selection, true);
  assert.equal(ADAPTER_STATIC_CAPABILITIES['openclaw.v1'].interrupt, false);
  // …but the explicit device unknown wins both.
  assert.equal(outcome.profile.optional.model_selection, 'unknown');
  assert.equal(outcome.profile.optional.interrupt, 'unknown');
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

test('provenance records the full normalization outcome of the declaration', () => {
  const outcome = gatewayNormalizeDeclaration(buildOpenclawCapabilityDeclaration());
  assert.deepEqual(outcome.profile.provenance, {
    device_declared: true,
    device_capabilities_version: 1,
    adapter_static_applied: true,
    legacy_compat: false,
    e2e_policy_valid: true,
    extensions_preserved: ['openclaw.binding_registry'],
    declaration_rejected: null,
  });
});

test('gateway preserves the registered openclaw.binding_registry extension verbatim', () => {
  // runtime_profile.py REGISTERED_EXTENSIONS (review round 3, PR #16): the
  // extension survives normalization verbatim as hint metadata
  // (profile.extensions + provenance.extensions_preserved). Preservation is
  // not consumption: no control-plane consumer acts on the value yet.
  const outcome = gatewayNormalizeDeclaration(buildOpenclawCapabilityDeclaration());
  assert.deepEqual(outcome.profile.extensions, {
    'openclaw.binding_registry': 'process_local',
  });
  assert.deepEqual(outcome.profile.provenance.extensions_preserved, [
    'openclaw.binding_registry',
  ]);

  // The registry — not the sender — decides what is preserved: an
  // unregistered namespaced key and a bare unknown key stay dropped.
  const noisy = {
    ...buildOpenclawCapabilityDeclaration(),
    'openclaw.future_flag': true,
    custom_flag: true,
  };
  const noisyOutcome = gatewayNormalizeDeclaration(noisy);
  assert.deepEqual(noisyOutcome.profile.extensions, {
    'openclaw.binding_registry': 'process_local',
  });
  assert.equal('openclaw.future_flag' in noisyOutcome.profile.extensions, false);
  assert.equal('custom_flag' in noisyOutcome.profile.extensions, false);

  // A persistent override round-trips verbatim too.
  const persistent = gatewayNormalizeDeclaration(
    buildOpenclawCapabilityDeclaration({ bindingRegistry: 'persistent' }),
  );
  assert.equal(persistent.profile.extensions['openclaw.binding_registry'], 'persistent');
});

test('extensions never participate in the contract_level gate', () => {
  // The extension rides next to the neutral gate: removing it must not move
  // the derived contract level, and a rejected declaration keeps no
  // extensions (fail-closed as a whole).
  const withoutExt = buildOpenclawCapabilityDeclaration();
  delete withoutExt['openclaw.binding_registry'];
  const outcome = gatewayNormalizeDeclaration(withoutExt);
  assert.equal(outcome.profile.contract_level, 'legacy');
  assert.deepEqual(outcome.profile.extensions, {});
  assert.deepEqual(outcome.profile.provenance.extensions_preserved, []);
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

test('strict version typing: true, "1" and 1.5 are invalid_capabilities_version', () => {
  // Python must not coerce True/1.0/"1" through int(); the JS mirror pins
  // every portable case (the literal 1.0 token is not representable in JS
  // JSON — see the header note).
  for (const badVersion of [true, false, '1', 1.5, 0, -1]) {
    const forged = {
      ...buildOpenclawCapabilityDeclaration(),
      capabilities_version: badVersion,
    };
    const outcome = gatewayNormalizeDeclaration(forged);
    assert.equal(outcome.accepted, false, `version ${String(badVersion)} must be rejected`);
    if (typeof badVersion === 'number' && Number.isInteger(badVersion)) {
      assert.equal(outcome.rejection, 'unsupported_capabilities_version');
    } else {
      assert.equal(outcome.rejection, 'invalid_capabilities_version');
    }
  }
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
  assert.equal(outcome.profile.provenance.e2e_policy_valid, false);
});

test('an e2e-only declaration is accepted but keeps the policy invalid', () => {
  // An e2e dict normalizes to a non-empty declared_e2e even when every field
  // is garbage, so the declaration is not "empty" — it is accepted
  // fail-closed with e2e_policy_valid=false (runtime_profile.py review
  // round 2 semantics).
  const outcome = gatewayNormalizeDeclaration({ capabilities_version: 1, e2e: {} });
  assert.equal(outcome.accepted, true);
  assert.equal(outcome.rejection, null);
  assert.equal(outcome.profile.provenance.e2e_policy_valid, false);
  assert.equal(outcome.profile.core.e2e.required_for_commands, 'unknown');
  assert.equal(outcome.profile.contract_level, 'legacy');
});

test('a garbage e2e block value keeps the profile fail-closed, not crashed', () => {
  const outcome = gatewayNormalizeDeclaration({
    ...buildOpenclawCapabilityDeclaration(),
    e2e: 'not-a-dict',
  });
  // A non-dict e2e is treated as absent ({} / invalid), the capability facts
  // still normalize: accepted, policy invalid, contract legacy.
  assert.equal(outcome.accepted, true);
  assert.equal(outcome.profile.provenance.e2e_policy_valid, false);
  assert.equal(outcome.profile.core.e2e.required_for_commands, 'unknown');
  assert.equal(outcome.profile.contract_level, 'legacy');
});

test('runtime_id rides on the normalized profile when present', () => {
  const withId = buildRuntimeProfileMirror({
    runtimeId: 'openclaw-dev-1',
    runtimeKind: 'openclaw',
    adapterId: 'openclaw.v1',
    declaration: buildOpenclawCapabilityDeclaration(),
  });
  assert.equal(withId.runtime_id, 'openclaw-dev-1');
  const withoutId = buildRuntimeProfileMirror({
    runtimeKind: 'openclaw',
    adapterId: 'openclaw.v1',
    declaration: buildOpenclawCapabilityDeclaration(),
  });
  assert.equal('runtime_id' in withoutId, false);
});

// ── Per-entry legacy/compat paths (declaration absent or malformed) ──────

test('a runtime entry without capabilities is fail-closed, not rejected-as-missing', () => {
  // runtime_profile.py: declaration=None → accepted=False, rejection=None.
  // The entry is not malformed; the device simply declared nothing, and the
  // gateway fills the adapter static contract instead.
  const outcome = gatewayNormalizeDeclaration(null);
  assert.equal(outcome.accepted, false);
  assert.equal(outcome.rejection, null);
  assert.equal(outcome.profile.profile_source, 'adapter_static');
  assert.equal(outcome.profile.contract_level, 'legacy');
  for (const key of CORE_CAPABILITIES) {
    assert.equal(outcome.profile.core[key], 'unknown', `core.${key} stays unknown`);
  }
  assert.equal(outcome.profile.provenance.device_declared, false);
  assert.equal(outcome.profile.provenance.declaration_rejected, null);
  assert.equal(outcome.profile.provenance.adapter_static_applied, true);
});

test('a non-dict capabilities payload is visible as declaration_not_object provenance', () => {
  // bot_ws.py passes the RAW entry value through: a string payload must show
  // up as declaration_not_object, never silently as absent.
  const outcome = gatewayNormalizeDeclaration('garbage');
  assert.equal(outcome.accepted, false);
  assert.equal(outcome.rejection, 'declaration_not_object');
  const profile = buildRuntimeProfileMirror({
    runtimeKind: 'openclaw',
    adapterId: 'openclaw.v1',
    declaration: 'garbage',
  });
  assert.equal(profile.provenance.declaration_rejected, 'declaration_not_object');
  assert.equal(profile.provenance.device_declared, false);
  assert.equal(profile.contract_level, 'legacy');
});

// ── Multi-Runtime: one RUNTIMES.LIST, per-entry parsing (0050a) ──────────
//
// A device can host several runtimes (openclaw channel + dsh channel + bots
// that predate the declaration). bot_ws._handle_runtimes_list normalizes
// EVERY entry independently; these tests pin that the openclaw declaration
// travels with its own entry only and never contaminates the fleet.

const DEVICE_ID = 'dev-multi-1';

// Entry 1 — the real openclaw channel payload, verbatim from the builder.
const openclawEntry = buildOpenclawRuntimeListPayload(DEVICE_ID).runtimes[0];

// Entry 2 — a dsh runtime that predates the 0050a declaration.
const dshEntry = {
  runtime_id: 'dsh-dev-multi-1',
  runtime_kind: 'dsh',
  name: 'Local DSH',
  status: 'online',
  workspaces: [
    { workspace_id: 'ws-1', name: 'WS 1', readable: true, writable: true },
  ],
};

// Entry 3 — a legacy bot that never declared a runtime identity at all.
const legacyEntry = {
  runtime_id: 'legacy-bot-1',
  name: 'Legacy bot',
  status: 'online',
};

// Entry 4 — an unknown third-party kind with a full, complete declaration.
const completeDeclaration = {
  capabilities_version: 1,
  message_send: true,
  message_user_projection: true,
  run_lifecycle: true,
  command_ack: true,
  capability_advertisement: true,
  e2e_policy_declaration: true,
  e2e: {
    required_for_commands: true,
    envelope: 'OGE2E1',
    alg: 'x25519+AES-256-GCM',
  },
};
const unknownKindEntry = {
  runtime_id: 'codex-dev-multi-1',
  runtime_kind: 'codex',
  name: 'Third-party runtime',
  status: 'online',
  capabilities: completeDeclaration,
};

// The wire payload exactly as the mixed device sends it, normalized exactly
// as bot_ws._handle_runtimes_list does — one profile per entry.
const multiRuntimePayload = {
  device_id: DEVICE_ID,
  runtimes: [openclawEntry, dshEntry, legacyEntry, unknownKindEntry],
};
const fleetProfiles = multiRuntimePayload.runtimes.map(gatewayNormalizeRuntimeEntry);

test('a mixed-fleet RUNTIMES.LIST normalizes every entry independently', () => {
  assert.equal(fleetProfiles.length, 4);
  // The openclaw entry keeps its declaration byte-for-byte on the wire.
  assert.deepEqual(openclawEntry.capabilities, buildOpenclawCapabilityDeclaration());
  // Each entry produced a runtime-scoped profile (no shared/merged object).
  const runtimeIds = fleetProfiles.map((p) => p.runtime_id);
  assert.deepEqual(runtimeIds, [
    'openclaw-dev-multi-1',
    'dsh-dev-multi-1',
    'legacy-bot-1',
    'codex-dev-multi-1',
  ]);
});

test('the openclaw entry of a mixed fleet keeps the device profile', () => {
  const p = fleetProfiles[0];
  assert.equal(p.runtime_kind, 'openclaw');
  assert.equal(p.adapter, 'openclaw.v1');
  assert.equal(p.profile_source, 'device');
  assert.equal(p.contract_level, 'legacy');
  assert.equal(p.provenance.device_declared, true);
  assert.deepEqual(p.extensions, { 'openclaw.binding_registry': 'process_local' });
  assert.equal(p.core.message_send, true);
  assert.equal(p.core.command_ack, false);
  assert.deepEqual(p.optional.workspaces, []);
});

test('the undeclared dsh entry gets the dsh.v1 static contract, never openclaw facts', () => {
  const p = fleetProfiles[1];
  assert.equal(p.runtime_kind, 'dsh');
  assert.equal(p.adapter, 'dsh.v1');
  assert.equal(p.profile_source, 'adapter_static');
  // Static facts come from dsh.v1, NOT from the openclaw static table.
  assert.equal(p.optional.queue, true);
  assert.equal(p.optional.interrupt, true);
  assert.equal(p.optional.conversation_delete, false);
  assert.equal(p.optional.conversation_fork, true);
  assert.equal(p.optional.ask_user_custom, true);
  assert.equal(p.optional.goal, true);
  assert.equal(p.optional.model_selection, true);
  // Static contracts can never prove Core facts: all six stay unknown.
  for (const key of CORE_CAPABILITIES) {
    assert.equal(p.core[key], 'unknown', `dsh core.${key} stays unknown`);
  }
  // No extension: the dsh entry declared nothing, so nothing is preserved.
  assert.deepEqual(p.extensions, {});
  assert.deepEqual(p.provenance.extensions_preserved, []);
  // Resource data rides along untouched.
  assert.deepEqual(p.optional.workspaces, [
    { workspace_id: 'ws-1', name: 'WS 1', readable: true, writable: true },
  ]);
});

test('no cross-contamination between the openclaw and dsh entries', () => {
  const openclawProfile = fleetProfiles[0];
  const dshProfile = fleetProfiles[1];
  // conversation_delete: openclaw static=true, dsh static=false.
  assert.equal(openclawProfile.optional.conversation_delete, true);
  assert.equal(dshProfile.optional.conversation_delete, false);
  // queue: openclaw static=false, dsh static=true.
  assert.equal(openclawProfile.optional.queue, false);
  assert.equal(dshProfile.optional.queue, true);
  // The openclaw extension exists ONLY on the openclaw profile.
  assert.equal('openclaw.binding_registry' in openclawProfile.extensions, true);
  assert.equal('openclaw.binding_registry' in dshProfile.extensions, false);
  // And the dsh profile never inherited the openclaw declaration facts.
  assert.equal(dshProfile.core.message_send, 'unknown');
  assert.equal(dshProfile.core.e2e.required_for_commands, 'unknown');
});

test('an entry without runtime_kind walks the legacy_compat path (§6.3/§10.2)', () => {
  const p = fleetProfiles[2];
  assert.equal(p.runtime_kind, '');
  assert.equal(p.adapter, 'dsh.v1');
  assert.equal(p.profile_source, 'legacy_compat');
  assert.equal(p.provenance.legacy_compat, true);
  assert.equal(p.contract_level, 'legacy');
  assert.equal(p.provenance.device_declared, false);
  assert.equal(p.provenance.declaration_rejected, null);
  // Legacy compat is a migration mark, never a device capability fact: Core
  // stays unknown even though the dsh static table applied.
  for (const key of CORE_CAPABILITIES) {
    assert.equal(p.core[key], 'unknown', `legacy core.${key} stays unknown`);
  }
});

test('an unknown runtime kind is never folded into dsh.v1 (XIOT-BUG-0048)', () => {
  const p = fleetProfiles[3];
  assert.equal(p.runtime_kind, 'codex');
  assert.equal(p.adapter, 'unknown');
  assert.equal(p.provenance.adapter_static_applied, false);
  // The device declaration IS accepted — contract level follows the
  // declaration, not adapter recognition.
  assert.equal(p.profile_source, 'device');
  assert.equal(p.contract_level, 'v1');
  assert.equal(p.provenance.e2e_policy_valid, true);
  // No static table applied: undeclared optional facts stay unknown instead
  // of leaking dsh/openclaw static values.
  assert.equal(p.optional.model_selection, 'unknown');
  assert.equal(p.optional.queue, 'unknown');
  // Declared facts stay verbatim.
  assert.equal(p.core.command_ack, true);
  assert.equal(p.core.e2e.required_for_commands, true);
  assert.equal(p.core.e2e.envelope, 'OGE2E1');
});

test('a malformed capabilities payload inside a fleet entry stays visible', () => {
  const brokenEntry = {
    runtime_id: 'broken-dev-multi-1',
    runtime_kind: 'openclaw',
    capabilities: 'not-an-object',
  };
  const p = gatewayNormalizeRuntimeEntry(brokenEntry);
  assert.equal(p.provenance.declaration_rejected, 'declaration_not_object');
  assert.equal(p.provenance.device_declared, false);
  assert.equal(p.profile_source, 'adapter_static');
  assert.equal(p.contract_level, 'legacy');
  // Fail-closed as a whole: no extensions survive a rejected declaration.
  assert.deepEqual(p.extensions, {});
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
