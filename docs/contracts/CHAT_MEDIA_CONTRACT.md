# Chat Media Contract

## 1. Metadata

- Version: `v0.1.0`
- Status: `Frozen`
- Last Updated: `2026-02-18`
- Owner: `Session C (Contract)`
- Scope: `chat text/image/file/audio message contract`

## 2. Hard Rules

1. All message writes (`text` / `image` / `file` / `audio`) must include:
   - `thread_id`
   - `context_epoch`
2. Session isolation is defined by `session_key = (thread_id, context_epoch)`.
3. Messages with the same `thread_id` but different `context_epoch` values must be treated as different sessions.
   - Do not merge context.
   - Do not share replay/history cursors.
4. History fetch/replay must always filter by `(thread_id, context_epoch)`.
   Filtering by `thread_id` alone is not allowed.
5. Legacy rows missing `context_epoch` are read as `0` for backward-compatible reads only.
   New writes must not omit `context_epoch`.

## 3. Canonical Schema (Write Path)

### 3.1 Common fields

```json
{
  "thread_id": "string, required, non-empty",
  "context_epoch": "integer, required, >= 0",
  "kind": "text | image | file | audio",
  "ts": "integer (ms), optional"
}
```

### 3.2 Text

```json
{
  "thread_id": "main",
  "context_epoch": 3,
  "kind": "text",
  "text": "hello"
}
```

### 3.3 Image

```json
{
  "thread_id": "support-A",
  "context_epoch": 3,
  "kind": "image",
  "image": {
    "attachment_id": "att_img_001",
    "mime_type": "image/png",
    "file_name": "photo.png",
    "size_bytes": 123456
  }
}
```

### 3.4 File

```json
{
  "thread_id": "support-A",
  "context_epoch": 3,
  "kind": "file",
  "file": {
    "attachment_id": "att_file_001",
    "mime_type": "application/pdf",
    "file_name": "manual.pdf",
    "size_bytes": 456789,
    "sha256": "hex"
  }
}
```

### 3.5 Audio

```json
{
  "thread_id": "support-A",
  "context_epoch": 3,
  "kind": "audio",
  "audio": {
    "attachment_id": "att_audio_001",
    "mime_type": "audio/m4a",
    "duration_ms": 5200,
    "sample_rate": 16000,
    "size_bytes": 180000,
    "sha256": "hex"
  }
}
```

## 4. Isolation Semantics

### 4.1 Session identity

- Canonical session identity is `session_key = (thread_id, context_epoch)`.
- `thread_id` alone must never be treated as the only session key.

### 4.2 Runtime behavior

- Session cache, dedupe, context window, and token accounting must all be isolated by `session_key`.
- Rows with the same `thread_id` but different `context_epoch` values must not share history or context.

## 5. Replay / History Query Rules

### 5.1 Required filters

History queries must include:

- `thread_id`
- `context_epoch`

Required query semantics:

- `WHERE thread_id = ? AND context_epoch = ?`

### 5.2 Forbidden query mode

The following query style is not allowed:

- `WHERE thread_id = ?` without `context_epoch`

## 6. Compatibility Policy

### 6.1 Legacy read compatibility

- Legacy rows that do not contain `context_epoch` are projected as `context_epoch = 0` on read.
- This rule exists only for read-path compatibility and does not relax new-write requirements.

### 6.2 New write policy

- New writes missing `context_epoch` must be rejected with `INVALID_PARAMS` / `CONTEXT_EPOCH_REQUIRED`.
- New writes with empty `thread_id` must be rejected with `THREAD_ID_REQUIRED`.

## 7. Error Codes

- `THREAD_ID_REQUIRED`
- `CONTEXT_EPOCH_REQUIRED`
- `CONTEXT_EPOCH_INVALID`
- `SESSION_SCOPE_MISMATCH`
- `HISTORY_FILTER_INCOMPLETE`

## 8. Multi-thread Validation Cases

### Case A: same thread, different context

Input 1:

```json
{"thread_id":"thread-X","context_epoch":10,"kind":"text","text":"A"}
```

Input 2:

```json
{"thread_id":"thread-X","context_epoch":11,"kind":"text","text":"B"}
```

Expected:

- They belong to different sessions.
- Querying `(thread-X, 10)` must not return `B`.
- Querying `(thread-X, 11)` must not return `A`.

### Case B: legacy read fallback

Stored legacy row:

```json
{"thread_id":"legacy-thread","kind":"text","text":"old"}
```

Expected read projection:

```json
{"thread_id":"legacy-thread","context_epoch":0,"kind":"text","text":"old"}
```

## 9. Current Repository Alignment

Current code already aligns with key parts of this contract:

- `thread_id` normalization: `/Users/ongood/github/xiot/openclaw-channel-xiotbox/src/channel.ts:62`
- `context_epoch` normalization and fallback cache handling: `/Users/ongood/github/xiot/openclaw-channel-xiotbox/src/channel.ts:104`
- session key includes context epoch: `/Users/ongood/github/xiot/openclaw-channel-xiotbox/src/channel.ts:74`
- response metadata includes `thread_id/context_epoch`: `/Users/ongood/github/xiot/openclaw-channel-xiotbox/src/channel.ts:1068`
