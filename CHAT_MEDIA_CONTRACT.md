# Chat Media Contract

## 1. Metadata

- Version: `v0.1.0`
- Status: `Frozen`
- Last Updated: `2026-02-18`
- Owner: `Session C (Contract)`
- Scope: `chat text/image/file/audio message contract`

## 2. Hard Rules (Must)

1. 所有消息（`text`/`image`/`file`/`audio`）写入时必须携带：
   - `thread_id`
   - `context_epoch`
2. 会话隔离键固定为：`(thread_id, context_epoch)`。
3. 同一个 `thread_id` 但 `context_epoch` 不同，必须视为不同会话（不得合并上下文、不得共享历史游标）。
4. 历史拉取/回放必须按 `(thread_id, context_epoch)` 过滤；不允许仅按 `thread_id`。
5. 老消息若缺失 `context_epoch`，读取时按 `0` 处理（只读兼容）；新写入不允许省略 `context_epoch`。

## 3. Canonical Schema (Write Path)

### 3.1 Common fields (all message kinds)

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

- 统一会话主键：`session_key = (thread_id, context_epoch)`。
- 禁止使用 `thread_id` 作为唯一会话键。

### 4.2 Runtime behavior

- 会话缓存、去重、上下文窗口、token 统计都必须按 `session_key` 隔离。
- 同 `thread_id` 且不同 `context_epoch` 不得相互读取历史、不得复用上下文。

## 5. Replay / History Query Rules

### 5.1 Required filters

历史查询请求必须包含：

- `thread_id`
- `context_epoch`

查询语义：

- `WHERE thread_id = ? AND context_epoch = ?`

### 5.2 Forbidden query mode

以下模式禁止：

- `WHERE thread_id = ?`（缺少 `context_epoch`）

## 6. Compatibility Policy

### 6.1 Legacy read compatibility

- 历史记录中缺失 `context_epoch` 的消息，读取时映射为：`context_epoch = 0`。
- 该策略仅用于读路径兼容，不反向修改新写规则。

### 6.2 New write policy

- 新写入缺失 `context_epoch`：必须拒绝（`INVALID_PARAMS` / `CONTEXT_EPOCH_REQUIRED`）。
- 新写入 `thread_id` 为空：必须拒绝（`THREAD_ID_REQUIRED`）。

## 7. Error Codes (Contract-Level)

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

- 归属不同会话。
- 查询 `(thread-X, 10)` 不返回 `B`；查询 `(thread-X, 11)` 不返回 `A`。

### Case B: legacy read fallback

Stored legacy row (no context field):

```json
{"thread_id":"legacy-thread","kind":"text","text":"old"}
```

Expected read projection:

```json
{"thread_id":"legacy-thread","context_epoch":0,"kind":"text","text":"old"}
```

## 9. Implementation Notes (Current Repo Alignment)

Current code already aligns with key parts of this contract:

- `thread_id` normalization: `/Users/ongood/github/xiot/openclaw-channel-xiotbox/src/channel.ts:62`
- `context_epoch` + fallback cache handling: `/Users/ongood/github/xiot/openclaw-channel-xiotbox/src/channel.ts:104`
- session key includes context epoch: `/Users/ongood/github/xiot/openclaw-channel-xiotbox/src/channel.ts:74`
- response metadata includes `thread_id/context_epoch`: `/Users/ongood/github/xiot/openclaw-channel-xiotbox/src/channel.ts:1068`

