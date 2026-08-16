import assert from 'node:assert/strict';
import test from 'node:test';

import {
  handleBeforeModelResolve,
  resetSessionModelOverridesForTest,
  setSessionModelOverride,
} from '../dist/src/session-model.js';

test.beforeEach(() => resetSessionModelOverridesForTest());

test('resolves a provider/model override for the session', () => {
  setSessionModelOverride('agent:main:xiotbox:device-1:conv-1', 'deepseek/deepseek-chat');

  const result = handleBeforeModelResolve({ prompt: 'hi' }, {
    sessionKey: 'agent:main:xiotbox:device-1:conv-1',
  });

  assert.deepEqual(result, {
    providerOverride: 'deepseek',
    modelOverride: 'deepseek-chat',
  });
});

test('treats a bare model id as a model-only override', () => {
  setSessionModelOverride('agent:main:xiotbox:device-1:conv-1', 'deepseek-chat');

  const result = handleBeforeModelResolve({ prompt: 'hi' }, {
    sessionKey: 'agent:main:xiotbox:device-1:conv-1',
  });

  assert.deepEqual(result, { modelOverride: 'deepseek-chat' });
});

test('returns undefined when the session has no override', () => {
  const result = handleBeforeModelResolve({ prompt: 'hi' }, {
    sessionKey: 'agent:main:xiotbox:device-1:other',
  });

  assert.equal(result, undefined);
});

test('clears the override when an empty ref is set', () => {
  setSessionModelOverride('agent:main:xiotbox:device-1:conv-1', 'deepseek/deepseek-chat');
  setSessionModelOverride('agent:main:xiotbox:device-1:conv-1', '');

  assert.equal(
    handleBeforeModelResolve({ prompt: 'hi' }, {
      sessionKey: 'agent:main:xiotbox:device-1:conv-1',
    }),
    undefined,
  );
});
