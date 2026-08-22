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

export function projectUserMessage(
  text: unknown,
  metadata?: unknown,
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
    },
  }];
}

export function projectAssistantMessage(
  text: unknown,
  reasoning?: unknown,
  metadata?: unknown,
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
      },
    });
  }
  if (normalizedReasoning) {
    events.push({
      kind: 'reasoning.block',
      occurrenceId: 'reasoning:final',
      payload: { text: normalizedReasoning },
    });
  }
  return events;
}
