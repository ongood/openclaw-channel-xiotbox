export type ConversationProjection = {
  kind: 'message.user' | 'message.assistant' | 'reasoning.block';
  occurrenceId: string;
  payload: Record<string, unknown>;
};

function normalizedText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizedMetadata(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>).filter(
    ([key]) => key.trim().length > 0,
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

// Projection payloads always carry the originating command_id so the client can
// reconcile the echoed timeline event with its local optimistic message
// (sent under the same command_id). Without it the client falls back to parsing
// event_id, which does not round-trip to the original command id, and the local
// optimistic bubble is never hidden, producing a visible duplicate in the live
// timeline (the duplicate disappears on re-entry because local state resets).
function commandIdField(commandId?: unknown): Record<string, unknown> {
  const normalized = typeof commandId === 'string' ? commandId.trim() : '';
  return normalized ? { command_id: normalized } : {};
}

export function projectUserMessage(
  text: unknown,
  metadata?: unknown,
  commandId?: unknown,
): ConversationProjection[] {
  const normalized = normalizedText(text);
  if (!normalized) return [];
  const projectedMetadata = normalizedMetadata(metadata);
  return [{
    kind: 'message.user',
    occurrenceId: 'message:user',
    payload: {
      text: normalized,
      ...(projectedMetadata ? { metadata: projectedMetadata } : {}),
      ...commandIdField(commandId),
    },
  }];
}

export function projectAssistantMessage(
  text: unknown,
  reasoning?: unknown,
  metadata?: unknown,
  commandId?: unknown,
): ConversationProjection[] {
  const normalized = normalizedText(text);
  const normalizedReasoning = normalizedText(reasoning);
  const projectedMetadata = normalizedMetadata(metadata);
  const events: ConversationProjection[] = [];
  if (normalized) {
    events.push({
      kind: 'message.assistant',
      occurrenceId: 'message:assistant',
      payload: {
        text: normalized,
        ...(projectedMetadata ? { metadata: projectedMetadata } : {}),
        ...commandIdField(commandId),
      },
    });
  }
  if (normalizedReasoning) {
    events.push({
      kind: 'reasoning.block',
      occurrenceId: 'reasoning:final',
      payload: {
        text: normalizedReasoning,
        ...commandIdField(commandId),
      },
    });
  }
  return events;
}
