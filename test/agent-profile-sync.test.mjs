import assert from 'node:assert/strict';
import test from 'node:test';

import {
  handleAgentProfileSync,
  setConfigMutatorForTest,
} from '../dist/src/agent-profile-sync.js';

test.beforeEach(() => setConfigMutatorForTest(null));

async function run(request, mutator) {
  const acks = [];
  setConfigMutatorForTest(mutator);
  await handleAgentProfileSync({
    request,
    sendAck: (ack) => acks.push(ack),
  });
  return acks;
}

test('rejects missing agent_id without touching config', async () => {
  let called = false;
  const acks = await run({ name: 'x' }, async () => {
    called = true;
    return null;
  });
  assert.equal(acks.length, 1);
  assert.equal(acks[0].ok, false);
  assert.equal(acks[0].error, 'missing agent_id');
  assert.equal(called, false);
});

test('merges agent into agents.entries and acks ok', async () => {
  let captured = null;
  const acks = await run(
    {
      agent_id: 'chief_engineer',
      name: '首席工程师',
      model: 'deepseek/chat',
      config: { workspace: '/ws/chief' },
    },
    async (mutator) => {
      captured = mutator;
      return null;
    },
  );
  assert.equal(acks.length, 1);
  assert.deepEqual(acks[0], { ok: true, agent_id: 'chief_engineer' });

  const next = captured({ agents: { entries: {} } });
  assert.deepEqual(next.agents.entries.chief_engineer, {
    name: '首席工程师',
    model: 'deepseek/chat',
    workspace: '/ws/chief',
  });
});

test('preserves existing agent fields when merging', async () => {
  let captured = null;
  await run({ agent_id: 'support_agent', name: 'Support' }, async (mutator) => {
    captured = mutator;
    return null;
  });
  const next = captured({ agents: { entries: { support_agent: { model: 'gpt/x' } } } });
  assert.deepEqual(next.agents.entries.support_agent, {
    model: 'gpt/x',
    name: 'Support',
  });
});

test('acks error when config mutation fails', async () => {
  const acks = await run(
    { agent_id: 'boom' },
    async () => {
      throw new Error('write failed');
    },
  );
  assert.equal(acks.length, 1);
  assert.equal(acks[0].ok, false);
  assert.equal(acks[0].error, 'write failed');
});
