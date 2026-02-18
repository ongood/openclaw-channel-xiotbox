import assert from 'node:assert/strict';
import test from 'node:test';

import { buildInboundMediaContext } from '../dist/src/channel.js';

test('maps explicit media arrays into MsgContext fields', () => {
  const ctx = buildInboundMediaContext({
    media_paths: ['/tmp/photo.png', 'https://example.com/doc.pdf'],
    media_types: ['image/png', 'application/pdf'],
  });

  assert.equal(ctx.MediaPath, '/tmp/photo.png');
  assert.equal(ctx.MediaUrl, '/tmp/photo.png');
  assert.deepEqual(ctx.MediaPaths, ['/tmp/photo.png', 'https://example.com/doc.pdf']);
  assert.deepEqual(ctx.MediaUrls, ['/tmp/photo.png', 'https://example.com/doc.pdf']);
  assert.deepEqual(ctx.MediaTypes, ['image/png', 'application/pdf']);
  assert.equal(ctx.MediaType, 'image/png');
});

test('maps attachments/files/voice entries and preserves order', () => {
  const ctx = buildInboundMediaContext({
    attachments: [
      { path: '/tmp/a.jpg', mime_type: 'image/jpeg' },
      { file_url: 'https://example.com/manual.pdf', mime_type: 'application/pdf' },
    ],
    voice: {
      file_path: '/tmp/voice.m4a',
      content_type: 'audio/m4a',
    },
  });

  assert.deepEqual(ctx.MediaPaths, [
    '/tmp/a.jpg',
    'https://example.com/manual.pdf',
    '/tmp/voice.m4a',
  ]);
  assert.deepEqual(ctx.MediaUrls, [
    '/tmp/a.jpg',
    'https://example.com/manual.pdf',
    '/tmp/voice.m4a',
  ]);
  assert.deepEqual(ctx.MediaTypes, [
    'image/jpeg',
    'application/pdf',
    'audio/m4a',
  ]);
});

test('fills missing media type from duplicate structured entry', () => {
  const ctx = buildInboundMediaContext({
    media_path: '/tmp/script.py',
    attachments: [
      { path: '/tmp/script.py', mime_type: 'text/x-python' },
      { url: 'https://example.com/readme.txt', mime_type: 'text/plain' },
    ],
  });

  assert.deepEqual(ctx.MediaPaths, ['/tmp/script.py', 'https://example.com/readme.txt']);
  assert.deepEqual(ctx.MediaTypes, ['text/x-python', 'text/plain']);
});

test('reads nested content media payloads', () => {
  const ctx = buildInboundMediaContext({
    content: {
      attachments: [
        { download_url: 'https://example.com/note.txt', content_type: 'text/plain' },
      ],
      audio: {
        media_url: 'https://example.com/voice.wav',
        media_type: 'audio/wav',
      },
    },
  });

  assert.deepEqual(ctx.MediaPaths, [
    'https://example.com/note.txt',
    'https://example.com/voice.wav',
  ]);
  assert.deepEqual(ctx.MediaTypes, ['text/plain', 'audio/wav']);
});

test('supports primitive string media values', () => {
  const ctx = buildInboundMediaContext({
    files: ['/tmp/notes.txt', 'https://example.com/code.py'],
  });

  assert.deepEqual(ctx.MediaPaths, ['/tmp/notes.txt', 'https://example.com/code.py']);
  assert.deepEqual(ctx.MediaUrls, ['/tmp/notes.txt', 'https://example.com/code.py']);
});

test('returns empty mapping when no usable media fields are present', () => {
  const ctx = buildInboundMediaContext({
    text: 'hello',
    attachments: [{ attachment_id: 'att_only_id' }],
  });

  assert.deepEqual(ctx, {});
});
