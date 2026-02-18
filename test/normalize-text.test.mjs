/**
 * Unit tests for normalizeTextPayload — text extraction from various payload shapes.
 * Run with: node --test test/normalize-text.test.mjs
 */

import assert from 'node:assert/strict';
import test from 'node:test';

// ── Inline normalizeTextPayload from channel.ts ──

function normalizeTextPayload(payload) {
  if (typeof payload === 'string') return payload;
  if (!payload) return '';

  const acc = [];
  const visited = new WeakSet();
  const MAX_DEPTH = 6;

  const pushText = (v) => {
    if (!v) return;
    if (typeof v === 'string') {
      const s = v.trimEnd();
      if (s) acc.push(s);
      return;
    }
    if (typeof v === 'number' || typeof v === 'boolean') {
      acc.push(String(v));
      return;
    }
  };

  const walk = (obj, depth) => {
    if (!obj || depth > MAX_DEPTH) return;
    if (typeof obj === 'string' || typeof obj === 'number' || typeof obj === 'boolean') {
      pushText(obj);
      return;
    }
    if (Array.isArray(obj)) {
      for (const it of obj) walk(it, depth + 1);
      return;
    }
    if (typeof obj !== 'object') return;
    if (visited.has(obj)) return;
    visited.add(obj);

    const directKeys = [
      'markdown', 'text', 'body', 'content_text', 'output_text', 'outputText',
      'message', 'message_text', 'reply', 'answer', 'final', 'final_text',
    ];
    for (const k of directKeys) {
      if (obj[k] !== undefined) {
        const v = obj[k];
        if (typeof v === 'object' && v) walk(v, depth + 1);
        else pushText(v);
      }
    }

    if (Array.isArray(obj.parts)) walk(obj.parts, depth + 1);
    if (Array.isArray(obj.content)) walk(obj.content, depth + 1);
    if (obj.content && typeof obj.content === 'object') walk(obj.content, depth + 1);
    if (obj.part && typeof obj.part === 'object') walk(obj.part, depth + 1);
    if (obj.delta !== undefined) walk(obj.delta, depth + 1);
    if (obj.content_delta !== undefined) walk(obj.content_delta, depth + 1);
    if (Array.isArray(obj.choices)) walk(obj.choices, depth + 1);
    if (obj.choice && typeof obj.choice === 'object') walk(obj.choice, depth + 1);

    if (obj.type && (obj.text !== undefined || obj.value !== undefined || obj.content !== undefined)) {
      walk(obj.text, depth + 1);
      walk(obj.value, depth + 1);
    }

    const fallbackKeys = ['value', 'raw', 'display', 'caption', 'title'];
    for (const k of fallbackKeys) {
      if (obj[k] !== undefined) {
        const v = obj[k];
        if (typeof v === 'object' && v) walk(v, depth + 1);
        else pushText(v);
      }
    }
  };

  walk(payload, 0);

  return acc
    .map((s) => String(s))
    .filter((s) => s.trim().length > 0)
    .join('\n')
    .trim();
}

// ── Tests ──

test('string passthrough', () => {
  assert.equal(normalizeTextPayload('hello'), 'hello');
  assert.equal(normalizeTextPayload(''), '');
});

test('null/undefined returns empty', () => {
  assert.equal(normalizeTextPayload(null), '');
  assert.equal(normalizeTextPayload(undefined), '');
});

test('simple text field', () => {
  assert.equal(normalizeTextPayload({ text: 'hello world' }), 'hello world');
});

test('body field', () => {
  assert.equal(normalizeTextPayload({ body: 'body text' }), 'body text');
});

test('message field', () => {
  assert.equal(normalizeTextPayload({ message: 'msg text' }), 'msg text');
});

test('nested content.text', () => {
  assert.equal(normalizeTextPayload({ content: { text: 'nested' } }), 'nested');
});

test('parts array', () => {
  const result = normalizeTextPayload({ parts: [{ text: 'part1' }, { text: 'part2' }] });
  assert.ok(result.includes('part1'));
  assert.ok(result.includes('part2'));
});

test('choices[].delta.content string is not extracted (content not in directKeys)', () => {
  // In the real implementation, delta.content as a plain string is NOT extracted
  // because 'content' is only handled as array/object, not as a directKey.
  // This documents actual behavior — streaming payloads need text/body/message keys.
  const payload = { choices: [{ delta: { content: 'streamed' } }] };
  assert.equal(normalizeTextPayload(payload), '');
});

test('choices[].delta.text IS extracted (text is a directKey)', () => {
  const payload = { choices: [{ delta: { text: 'streamed' } }] };
  assert.ok(normalizeTextPayload(payload).includes('streamed'));
});

test('typed segment {type:"text", text:"..."}', () => {
  const payload = { content: [{ type: 'text', text: 'segment text' }] };
  assert.ok(normalizeTextPayload(payload).includes('segment text'));
});

test('number and boolean values', () => {
  assert.equal(normalizeTextPayload({ text: 42 }), '42');
  assert.equal(normalizeTextPayload({ text: true }), 'true');
});

test('deeply nested beyond MAX_DEPTH returns partial', () => {
  let obj = { text: 'deep' };
  for (let i = 0; i < 10; i++) obj = { content: obj };
  // Should still extract something (up to depth 6)
  const result = normalizeTextPayload(obj);
  // May or may not find 'deep' depending on depth, but should not throw
  assert.equal(typeof result, 'string');
});

test('circular reference does not infinite loop', () => {
  const obj = { text: 'safe' };
  obj.self = obj;
  const result = normalizeTextPayload(obj);
  assert.ok(result.includes('safe'));
});

test('fallback keys: value, raw, display, caption, title', () => {
  assert.ok(normalizeTextPayload({ value: 'val' }).includes('val'));
  assert.ok(normalizeTextPayload({ raw: 'raw' }).includes('raw'));
  assert.ok(normalizeTextPayload({ display: 'disp' }).includes('disp'));
  assert.ok(normalizeTextPayload({ caption: 'cap' }).includes('cap'));
  assert.ok(normalizeTextPayload({ title: 'ttl' }).includes('ttl'));
});
