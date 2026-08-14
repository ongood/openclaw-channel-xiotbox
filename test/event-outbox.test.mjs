import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { DurableEventOutbox } from '../dist/src/event-outbox.js';

test('durable event outbox survives restart, retries, and removes only on ack', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiotbox-event-outbox-'));
  const filePath = path.join(tempDir, 'events.json');
  let now = 1000;
  const firstSends = [];
  const first = new DurableEventOutbox({
    filePath,
    send: (payload) => firstSends.push(payload),
    now: () => now,
    retryBaseMs: 100,
    retryMaxMs: 1000,
  });
  first.enqueue({ event_id: 'event-1', kind: 'run.started' });
  first.enqueue({ event_id: 'event-1', kind: 'ignored-duplicate' });
  assert.equal(first.size, 1);
  assert.equal(firstSends.length, 1);
  assert.equal(firstSends[0].kind, 'run.started');

  const restartedSends = [];
  const restarted = new DurableEventOutbox({
    filePath,
    send: (payload) => restartedSends.push(payload),
    now: () => now,
    retryBaseMs: 100,
    retryMaxMs: 1000,
  });
  assert.equal(restarted.size, 1);
  restarted.flushDue();
  assert.equal(restartedSends.length, 0);
  now += 100;
  restarted.flushDue();
  assert.equal(restartedSends.length, 1);
  assert.equal(restarted.acknowledge({ event_id: 'event-1', status: 'accepted' }), true);
  assert.equal(restarted.size, 0);

  const persisted = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.deepEqual(persisted.entries, []);
  fs.rmSync(tempDir, { recursive: true, force: true });
});
