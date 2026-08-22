function normalizedText(value) {
    return typeof value === 'string' ? value.trim() : '';
}
function normalizedMetadata(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return undefined;
    const entries = Object.entries(value).filter(([key]) => key.trim().length > 0);
    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}
// Projection payloads always carry the originating command_id so the client can
// reconcile the echoed timeline event with its local optimistic message
// (sent under the same command_id). Without it the client falls back to parsing
// event_id, which does not round-trip to the original command id, and the local
// optimistic bubble is never hidden, producing a visible duplicate in the live
// timeline (the duplicate disappears on re-entry because local state resets).
function commandIdField(commandId) {
    const normalized = typeof commandId === 'string' ? commandId.trim() : '';
    return normalized ? { command_id: normalized } : {};
}
export function projectUserMessage(text, metadata, commandId) {
    const normalized = normalizedText(text);
    if (!normalized)
        return [];
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
export function projectAssistantMessage(text, reasoning, metadata, commandId) {
    const normalized = normalizedText(text);
    const normalizedReasoning = normalizedText(reasoning);
    const projectedMetadata = normalizedMetadata(metadata);
    const events = [];
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
