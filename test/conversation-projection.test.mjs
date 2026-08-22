import assert from 'node:assert/strict';
import test from 'node:test';

import {
  projectAssistantMessage,
  projectUserMessage,
} from '../dist/src/conversation-projection.js';

test('projects the decrypted user message with orchestration metadata', () => {
  assert.deepEqual(projectUserMessage('  hello  ', {
    route_id: 'route-1',
    role_id: 'builder',
  }), [{
    kind: 'message.user',
    occurrenceId: 'message:user',
    payload: {
      text: 'hello',
      metadata: { route_id: 'route-1', role_id: 'builder' },
    },
  }]);
  assert.deepEqual(projectUserMessage('   '), []);
});

test('projects final assistant text and reasoning before run completion', () => {
  assert.deepEqual(projectAssistantMessage(' answer ', ' thought ', {
    route_id: 'route-2',
  }), [
    {
      kind: 'message.assistant',
      occurrenceId: 'message:assistant',
      payload: {
        text: 'answer',
        metadata: { route_id: 'route-2' },
      },
    },
    {
      kind: 'reasoning.block',
      occurrenceId: 'reasoning:final',
      payload: { text: 'thought' },
    },
  ]);
});

test('does not create empty timeline bubbles', () => {
  assert.deepEqual(projectAssistantMessage('', ''), []);
});
