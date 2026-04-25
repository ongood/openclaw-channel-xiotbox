/**
 * Unit tests for session key generation, context epoch, and normalization helpers.
 * Run with: node --test test/session-key.test.mjs
 */

import assert from 'node:assert/strict';
import test from 'node:test';

// Inline pure functions from channel.ts (no runtime dependencies).

const DEFAULT_THREAD_ID = 'default';

function normalizeAccountId(value) {
  const normalized = String(value || '').trim();
  return normalized || 'default';
}

function normalizeThreadId(value) {
  const normalized = String(value || '').trim();
  return normalized || DEFAULT_THREAD_ID;
}

function normalizeContextEpoch(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  const epoch = Math.floor(parsed);
  return epoch > 0 ? epoch : 0;
}

function normalizeAgentId(value) {
  const normalized = String(value || '').trim().toLowerCase();
  const safe = normalized
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
    .slice(0, 64);
  return safe || 'main';
}

function buildSessionKey(agentId, deviceId, threadId, contextEpoch = 0) {
  const base = `agent:${normalizeAgentId(agentId)}:xiotbox:${deviceId}:${normalizeThreadId(threadId)}`;
  return contextEpoch > 0 ? `${base}:ctx${contextEpoch}` : base;
}

function normalizeStrList(value, fallback) {
  if (Array.isArray(value)) {
    const out = value.map((v) => String(v || '').trim()).filter(Boolean);
    return out.length ? out : fallback;
  }
  const raw = String(value || '').trim();
  if (!raw) return fallback;
  const parts = raw.split(',').map((p) => p.trim()).filter(Boolean);
  return parts.length ? parts : fallback;
}

function hasOwn(obj, key) {
  return Boolean(obj && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, key));
}

function contextEpochScopeKey(deviceId, threadId) {
  return `${deviceId}:${normalizeThreadId(threadId)}`;
}

// Simplified resolveInboundContextEpoch (no cache side-effects for unit test)
function resolveInboundContextEpoch(incoming, deviceId, threadId) {
  const hasExplicit = hasOwn(incoming, 'context_epoch') || hasOwn(incoming, 'contextEpoch');
  if (hasExplicit) {
    const val = incoming?.context_epoch ?? incoming?.contextEpoch;
    return { epoch: normalizeContextEpoch(val), source: 'explicit' };
  }
  return { epoch: 0, source: 'default' };
}

// Tests

test('normalizeAccountId returns default for falsy values', () => {
  assert.equal(normalizeAccountId(null), 'default');
  assert.equal(normalizeAccountId(undefined), 'default');
  assert.equal(normalizeAccountId(''), 'default');
  assert.equal(normalizeAccountId('  '), 'default');
});

test('normalizeAccountId trims and returns valid values', () => {
  assert.equal(normalizeAccountId('  acc123  '), 'acc123');
  assert.equal(normalizeAccountId('device_001'), 'device_001');
});

test('normalizeThreadId returns default for falsy values', () => {
  assert.equal(normalizeThreadId(null), 'default');
  assert.equal(normalizeThreadId(undefined), 'default');
  assert.equal(normalizeThreadId(''), 'default');
});

test('normalizeThreadId trims and returns valid values', () => {
  assert.equal(normalizeThreadId('  thread-42  '), 'thread-42');
});

test('normalizeContextEpoch handles various inputs', () => {
  assert.equal(normalizeContextEpoch(0), 0);
  assert.equal(normalizeContextEpoch(1), 1);
  assert.equal(normalizeContextEpoch(3.7), 3);
  assert.equal(normalizeContextEpoch(-1), 0);
  assert.equal(normalizeContextEpoch(NaN), 0);
  assert.equal(normalizeContextEpoch(Infinity), 0);
  assert.equal(normalizeContextEpoch(null), 0);
  assert.equal(normalizeContextEpoch(undefined), 0);
  assert.equal(normalizeContextEpoch('5'), 5);
  assert.equal(normalizeContextEpoch('abc'), 0);
});

test('buildSessionKey without contextEpoch', () => {
  assert.equal(buildSessionKey('main', 'dev1', 'thread1'), 'agent:main:xiotbox:dev1:thread1');
  assert.equal(buildSessionKey('builder', 'dev1', ''), 'agent:builder:xiotbox:dev1:default');
  assert.equal(buildSessionKey('', 'dev1', null), 'agent:main:xiotbox:dev1:default');
});

test('buildSessionKey with contextEpoch', () => {
  assert.equal(
    buildSessionKey('builder', 'dev1', 'thread1', 3),
    'agent:builder:xiotbox:dev1:thread1:ctx3',
  );
  assert.equal(buildSessionKey('builder', 'dev1', 'thread1', 0), 'agent:builder:xiotbox:dev1:thread1');
});

test('normalizeStrList from array', () => {
  assert.deepEqual(normalizeStrList(['a', 'b', 'c'], ['x']), ['a', 'b', 'c']);
  assert.deepEqual(normalizeStrList(['', null, undefined], ['fallback']), ['fallback']);
  assert.deepEqual(normalizeStrList([], ['fallback']), ['fallback']);
});

test('normalizeStrList from comma-separated string', () => {
  assert.deepEqual(normalizeStrList('a, b, c', ['x']), ['a', 'b', 'c']);
  assert.deepEqual(normalizeStrList('', ['fallback']), ['fallback']);
  assert.deepEqual(normalizeStrList(null, ['fallback']), ['fallback']);
});

test('contextEpochScopeKey', () => {
  assert.equal(contextEpochScopeKey('dev1', 'thread1'), 'dev1:thread1');
  assert.equal(contextEpochScopeKey('dev1', ''), 'dev1:default');
});

test('resolveInboundContextEpoch with explicit context_epoch', () => {
  const r = resolveInboundContextEpoch({ context_epoch: 5 }, 'dev1', 'thread1');
  assert.equal(r.epoch, 5);
  assert.equal(r.source, 'explicit');
});

test('resolveInboundContextEpoch with explicit contextEpoch (camelCase)', () => {
  const r = resolveInboundContextEpoch({ contextEpoch: 3 }, 'dev1', 'thread1');
  assert.equal(r.epoch, 3);
  assert.equal(r.source, 'explicit');
});

test('resolveInboundContextEpoch with explicit 0', () => {
  const r = resolveInboundContextEpoch({ context_epoch: 0 }, 'dev1', 'thread1');
  assert.equal(r.epoch, 0);
  assert.equal(r.source, 'explicit');
});

test('resolveInboundContextEpoch without epoch field', () => {
  const r = resolveInboundContextEpoch({ text: 'hello' }, 'dev1', 'thread1');
  assert.equal(r.epoch, 0);
  assert.equal(r.source, 'default');
});
