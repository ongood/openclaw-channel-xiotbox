// Regression test: content-level deduplication must catch the case where the
// same user message is re-sent with a different command_id (client retry after
// ACK timeout, gateway re-delivery, etc.). Without this layer the existing
// commandCache only dedups by exact command_id, so duplicates with unique ids
// bypass it and trigger duplicate OpenClaw dispatches.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  contentDedupKey,
  getCachedByContent,
  setCachedByContent,
  contentDedupCache,
} from '../dist/src/channel.js';

// Helper: clear the shared cache between tests to avoid cross-test pollution.
function resetContentDedupCache() {
  contentDedupCache.clear();
}

test('contentDedupKey is deterministic for same session+text', () => {
  resetContentDedupCache();
  const k1 = contentDedupKey('agent:main:xiotbox:dev1:conv1', 'Hello world');
  const k2 = contentDedupKey('agent:main:xiotbox:dev1:conv1', 'Hello world');
  assert.strictEqual(k1, k2);
});

test('contentDedupKey differs for different text', () => {
  resetContentDedupCache();
  const k1 = contentDedupKey('agent:main:xiotbox:dev1:conv1', 'Hello world');
  const k2 = contentDedupKey('agent:main:xiotbox:dev1:conv1', 'Goodbye world');
  assert.notStrictEqual(k1, k2);
});

test('contentDedupKey differs for different session', () => {
  resetContentDedupCache();
  const k1 = contentDedupKey('agent:main:xiotbox:dev1:conv1', 'Hello world');
  const k2 = contentDedupKey('agent:main:xiotbox:dev1:conv2', 'Hello world');
  assert.notStrictEqual(k1, k2);
});

test('contentDedupKey normalizes whitespace', () => {
  resetContentDedupCache();
  const k1 = contentDedupKey('sess', 'Hello   world');
  const k2 = contentDedupKey('sess', 'Hello world');
  assert.strictEqual(k1, k2);
});

test('getCachedByContent returns null for unseen content', () => {
  resetContentDedupCache();
  const result = getCachedByContent('sess', 'new message');
  assert.strictEqual(result, null);
});

test('getCachedByContent returns cached payload for duplicate content', () => {
  resetContentDedupCache();
  const sessionKey = 'agent:main:xiotbox:dev1:conv1';
  const text = 'Hello world';
  const originalPayload = { command_id: 'cmd_001', status: 'success', result: { foo: 'bar' } };

  setCachedByContent(sessionKey, text, originalPayload, 'cmd_001');
  const cached = getCachedByContent(sessionKey, text);
  assert.ok(cached);
  assert.deepEqual(cached.payload, originalPayload);
  assert.strictEqual(cached.originalCmdId, 'cmd_001');
});

test('getCachedByContent is session-scoped', () => {
  resetContentDedupCache();
  const sess1 = 'agent:main:xiotbox:dev1:conv1';
  const sess2 = 'agent:main:xiotbox:dev1:conv2';
  const text = 'Hello world';
  const payload = { command_id: 'cmd_001', status: 'success' };

  setCachedByContent(sess1, text, payload, 'cmd_001');
  const hit = getCachedByContent(sess1, text);
  const miss = getCachedByContent(sess2, text);
  assert.ok(hit);
  assert.strictEqual(miss, null);
});

test('getCachedByContent returns null for different text', () => {
  resetContentDedupCache();
  const sessionKey = 'agent:main:xiotbox:dev1:conv1';
  const text1 = 'Hello world';
  const text2 = 'Different message';
  const payload = { command_id: 'cmd_001', status: 'success' };

  setCachedByContent(sessionKey, text1, payload, 'cmd_001');
  const hit = getCachedByContent(sessionKey, text1);
  const miss = getCachedByContent(sessionKey, text2);
  assert.ok(hit);
  assert.strictEqual(miss, null);
});
