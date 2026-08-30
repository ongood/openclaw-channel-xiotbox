// Contract regression test for XIOT-BUG-0005.
//
// command_id is the sole run identity. The channel must NOT replay a cached
// COMMAND_RESULT when the same text arrives under a different command_id:
// that silently swallows legitimate user re-sends ("继续" / "retry").
//
// The content-level dedup layer (contentDedupCache / getCachedByContent /
// setCachedByContent / contentDedupKey) was therefore removed entirely.
// Idempotency remains only at the exact command_id level via the internal
// commandCache, which is intentionally not exported.
//
// This file guards the removal: none of the content-level dedup symbols may
// come back on the channel module surface, and the built artifact must not
// contain the old replay path.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import * as channel from '../dist/src/channel.js';

const REMOVED_SYMBOLS = [
  'contentDedupKey',
  'getCachedByContent',
  'setCachedByContent',
  'contentDedupCache',
];

test('content-level dedup API is removed from the channel module surface', () => {
  for (const symbol of REMOVED_SYMBOLS) {
    assert.strictEqual(
      channel[symbol],
      undefined,
      `channel.js unexpectedly exports removed symbol: ${symbol}`,
    );
  }
});

test('built channel.js no longer contains the content replay path', () => {
  const built = readFileSync(
    new URL('../dist/src/channel.js', import.meta.url),
    'utf8',
  );
  for (const marker of [
    'content_dedup_hit',
    'content_duplicate',
    'getCachedByContent',
    'setCachedByContent',
  ]) {
    assert.ok(
      !built.includes(marker),
      `dist/src/channel.js still contains removed marker: ${marker}`,
    );
  }
});

test('channel module still exports its public surface after the removal', () => {
  const exported = Object.keys(channel);
  assert.ok(
    exported.length > 0,
    `channel.js exports collapsed: [${exported.join(', ')}]`,
  );
});
