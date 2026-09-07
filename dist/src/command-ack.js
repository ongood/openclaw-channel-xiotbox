// Canonical command lifecycle frames for v1 commands (XIOT-BUG-0050b /
// XIOT-PLAN-0008 §4.1, §4.5, §4.6).
//
// Every v1 command answers exactly one canonical COMMAND_ACK before any
// further processing. accepted:false carries a structured rejection
// {class:'policy'|'protocol'|'runtime', code, detail?} — string prefixes are
// never protocol. Commands that pass protocol/security validation emit a
// COMMAND_DELIVERED when they enter the business entry; chat binds it to the
// message.user projection via the same command_id (§4.6).
export const ACK_REJECTION_CLASSES = [
    'policy',
    'protocol',
    'runtime',
];
const REJECTION_DETAIL_MAX = 512;
function trimId(value) {
    return typeof value === 'string' ? value.trim() : '';
}
function trimBoundedDetail(value) {
    const text = typeof value === 'string' ? value.trim() : '';
    return text ? text.slice(0, REJECTION_DETAIL_MAX) : '';
}
export function buildAckRejection(cls, code, detail) {
    if (cls !== 'policy' && cls !== 'protocol' && cls !== 'runtime')
        return null;
    const trimmedCode = trimId(code);
    if (!trimmedCode)
        return null;
    const rejection = { class: cls, code: trimmedCode };
    const boundedDetail = trimBoundedDetail(detail);
    if (boundedDetail)
        rejection.detail = boundedDetail;
    return rejection;
}
// PLAN-0008 §4.5 registered exact-code table. Only codes registered here may
// be classified; unknown values map conservatively to runtime_error (§4.1).
const RUNTIME_ERROR_CLASS_BY_CODE = {
    // Protocol structure errors: envelope missing / unparseable / undecryptable
    // / AAD mismatch / identity-signature fields missing, malformed types or
    // encodings (§4.5 rows 1-2). Not yet an identity-authenticity verdict.
    e2e_required: 'protocol',
    e2e_decrypt_failed: 'protocol',
    e2e_peer_missing: 'protocol',
    missing_peer_key: 'protocol',
    envelope_missing: 'protocol',
    conversation_binding_invalid: 'protocol',
    conversation_id_required: 'protocol',
    model_required: 'protocol',
    client_identity_missing: 'protocol',
    client_identity_unsupported_alg: 'protocol',
    client_identity_invalid: 'protocol',
    // Runtime-local security policy: identity material parses, but
    // authenticity / trust pinning / authorization checks failed (§4.5 row 3).
    signature_invalid: 'policy',
    client_identity_changed: 'policy',
    trust_pin_mismatch: 'policy',
    new_client_identity_not_allowed: 'policy',
    // Runtime-local state loss (§4.5: session_binding_not_found).
    session_binding_not_found: 'runtime',
    session_archive_ack_timeout: 'runtime',
};
// Profile claims the capability but the runtime command vocabulary lacks it:
// normalized to protocol/capability_mismatch so the Gateway refreshes the
// profile. Runtime capability_unsupported is forbidden (§4.1 / §4.5).
const CAPABILITY_MISMATCH_CODES = new Set([
    'unsupported_command_type',
    'interrupt_unavailable',
]);
export const CAPABILITY_MISMATCH_CODE = 'capability_mismatch';
export function normalizeRuntimeError(rawCode) {
    const code = trimId(rawCode);
    if (CAPABILITY_MISMATCH_CODES.has(code)) {
        return { class: 'protocol', code: CAPABILITY_MISMATCH_CODE };
    }
    const cls = RUNTIME_ERROR_CLASS_BY_CODE[code];
    if (cls)
        return { class: cls, code };
    return { class: 'runtime', code: 'runtime_error', detail: code || 'unknown_error' };
}
export function buildCanonicalAck(commandId, opts) {
    const id = trimId(commandId);
    if (!id)
        return null;
    const accepted = opts?.accepted === true;
    const frame = {
        type: 'COMMAND_ACK',
        command_id: id,
        accepted,
    };
    if (!accepted) {
        const rejection = opts?.rejection || null;
        if (!rejection || typeof rejection !== 'object')
            return null;
        frame.rejection = rejection;
    }
    const eventId = trimId(opts?.eventId);
    if (eventId)
        frame.event_id = eventId;
    const traceId = trimId(opts?.traceId);
    if (traceId)
        frame.trace_id = traceId;
    return frame;
}
export function buildCommandDelivered(commandId) {
    const id = trimId(commandId);
    if (!id)
        return null;
    // Deterministic event id: the same command_id always rebuilds the same
    // receive unit, so gateway-side and device-side replay stay idempotent.
    return { type: 'COMMAND_DELIVERED', command_id: id, event_id: `command_delivered:${id}` };
}
// The v1 chat receive unit pairs the COMMAND_DELIVERED evidence with the
// durable message.user projection; both derive their key from the sole
// command_id (§4.6: 均绑定 command_id / event_id). The chat run identity is
// the command_id, so the durable message.user event id is
// `${command_id}:message:user`.
export const CHAT_USER_MESSAGE_OCCURRENCE_ID = 'message:user';
export function buildChatUserMessageEventId(commandId) {
    const id = trimId(commandId);
    if (!id)
        return null;
    return `${id}:${CHAT_USER_MESSAGE_OCCURRENCE_ID}`;
}
const DEFAULT_EVIDENCE_TTL_MS = 24 * 60 * 60 * 1000;
const EVIDENCE_MAX_ENTRIES = 5000;
// Owns the per-command ACK/DELIVERED evidence emission. One instance per
// gateway account/connection. The command_id is the SOLE idempotency key:
// a command may be claimed (accepted) exactly once, delivered evidence is
// emitted at most once, and an already-accepted command_id can never be
// re-classified to accepted:false. Duplicates/redeliveries replay the
// recorded lifecycle evidence instead of re-entering the business path.
//
// Lifecycle separation (XIOT-BUG-0050b R1): ACTIVE execution ownership is
// never evicted (no TTL, no capacity pressure); it is released only by an
// explicit markTerminal() AFTER the caller cached the terminal result.
// Terminal ownership, rejection ACKs and DELIVERED frames are evictable
// replay evidence (ttlMs / maxEntries) — duplicates of terminal commands
// must hit the caller's terminal cache instead, so eviction never re-opens
// duplicate execution.
export class CommandLifecycleEmitter {
    constructor(send, opts) {
        this.rejectedAcks = new Map();
        this.ownership = new Map();
        this.deliveredFrames = new Map();
        this.send = typeof send === 'function' ? send : () => { };
        this.now = typeof opts?.now === 'function' ? opts.now : Date.now;
        const ttl = Number(opts?.ttlMs);
        this.ttlMs = Number.isFinite(ttl) && ttl > 0 ? ttl : DEFAULT_EVIDENCE_TTL_MS;
        const maxEntries = Number(opts?.maxEntries);
        this.maxEntries = Number.isFinite(maxEntries) && maxEntries > 0 ? maxEntries : EVIDENCE_MAX_ENTRIES;
    }
    prune() {
        const cutoff = this.now() - this.ttlMs;
        for (const [id, entry] of this.rejectedAcks) {
            if (entry.ts < cutoff)
                this.rejectedAcks.delete(id);
        }
        for (const [id, entry] of this.ownership) {
            // ONLY terminal ownership ages out — active execution ownership is
            // never a prune victim, whatever ttlMs says.
            if (entry.terminal && (entry.terminalAt ?? 0) < cutoff)
                this.ownership.delete(id);
        }
        for (const [id, entry] of this.deliveredFrames) {
            if (entry.ts < cutoff)
                this.deliveredFrames.delete(id);
        }
        this.evictEvictableOverflow(this.rejectedAcks, (entry) => entry.ts);
        this.evictEvictableOverflow(this.deliveredFrames, (entry) => entry.ts);
        this.evictOwnershipOverflow();
    }
    evictEvictableOverflow(map, tsOf) {
        while (map.size > this.maxEntries) {
            let oldestId;
            let oldestTs = Infinity;
            for (const [id, entry] of map) {
                const ts = tsOf(entry);
                if (ts < oldestTs) {
                    oldestTs = ts;
                    oldestId = id;
                }
            }
            if (oldestId === undefined)
                break;
            map.delete(oldestId);
        }
    }
    // Capacity pressure may only evict TERMINAL ownership entries, oldest
    // terminal first. Active ownership is untouchable: if every entry is still
    // active the map grows until they terminalize (bounded by real in-flight
    // work).
    evictOwnershipOverflow() {
        const terminalEntries = [...this.ownership.entries()]
            .filter(([, entry]) => entry.terminal)
            .sort((a, b) => (a[1].terminalAt ?? 0) - (b[1].terminalAt ?? 0));
        let overflow = terminalEntries.length - this.maxEntries;
        for (const [id] of terminalEntries) {
            if (overflow <= 0)
                break;
            this.ownership.delete(id);
            overflow -= 1;
        }
    }
    // Per-command execution gate. First call for a command_id: emits the
    // canonical COMMAND_ACK {accepted:true} and returns true — the caller may
    // proceed into the business path. Any later call for the same command_id
    // (redelivery / duplicate / same-tick race): replays the recorded
    // lifecycle evidence (accepted ACK plus COMMAND_DELIVERED when already
    // emitted) and returns false — the caller MUST short-circuit instead of
    // re-entering the business path. A rejected command_id never re-claims.
    ackAccepted(commandId, traceId) {
        const id = trimId(commandId);
        if (!id)
            return false;
        const existing = this.ownership.get(id);
        if (existing) {
            this.send(existing.frame.type, existing.frame);
            const delivered = this.deliveredFrames.get(id);
            if (delivered)
                this.send(delivered.frame.type, delivered.frame);
            return false;
        }
        const frame = buildCanonicalAck(id, { accepted: true, traceId });
        if (!frame)
            return false;
        this.prune();
        this.ownership.set(id, { frame, claimedAt: this.now(), terminal: false });
        this.send(frame.type, frame);
        return true;
    }
    isAccepted(commandId) {
        return this.ownership.has(trimId(commandId));
    }
    // Releases the execution ownership AFTER the caller cached the terminal
    // result (ordering contract: cache first, then release — no window where a
    // duplicate can re-claim). The entry stays as evictable replay evidence
    // until TTL/capacity pruning removes it; while present, duplicates keep
    // replaying the recorded evidence. Returns true when an ACTIVE ownership
    // was released; false for unknown/rejected/already-terminal ids.
    markTerminal(commandId) {
        const id = trimId(commandId);
        if (!id)
            return false;
        const entry = this.ownership.get(id);
        if (!entry || entry.terminal)
            return false;
        entry.terminal = true;
        entry.terminalAt = this.now();
        return true;
    }
    // Replays the recorded lifecycle evidence for an accepted command (accepted
    // ACK plus COMMAND_DELIVERED when recorded). Returns true when anything was
    // replayed. Used on gateway redelivery while the terminal result is still
    // pending; once the terminal result is cached the caller replays that
    // instead.
    replayLifecycleEvidence(commandId) {
        const id = trimId(commandId);
        if (!id)
            return false;
        const accepted = this.ownership.get(id);
        if (!accepted)
            return false;
        this.send(accepted.frame.type, accepted.frame);
        const delivered = this.deliveredFrames.get(id);
        if (delivered)
            this.send(delivered.frame.type, delivered.frame);
        return true;
    }
    // Sends the structured rejection ACK. Idempotent per command_id: a second
    // rejection for an already-rejected command is suppressed, and an
    // ALREADY-ACCEPTED command_id can never be re-classified to accepted:false
    // (XIOT-BUG-0050b R1: no contradictory lifecycle) — the recorded evidence
    // is replayed and null is returned so nothing new is cached. Returns the
    // emitted frame (or the previously emitted one) so callers can cache it
    // for gateway-side redelivery replay.
    ackRejected(commandId, rejection, traceId) {
        const id = trimId(commandId);
        if (!id)
            return null;
        const existing = this.rejectedAcks.get(id);
        if (existing)
            return existing.frame;
        if (this.ownership.has(id)) {
            this.replayLifecycleEvidence(id);
            return null;
        }
        const frame = buildCanonicalAck(id, { accepted: false, rejection, traceId });
        if (!frame)
            return null;
        this.prune();
        this.rejectedAcks.set(id, { frame, ts: this.now() });
        this.send(frame.type, frame);
        return frame;
    }
    // Replays the stored rejection frame (gateway redelivery of a command the
    // device already rejected). Returns true when a frame was re-sent.
    replayRejectedAck(commandId) {
        const id = trimId(commandId);
        if (!id)
            return false;
        const entry = this.rejectedAcks.get(id);
        if (!entry)
            return false;
        this.send(entry.frame.type, entry.frame);
        return true;
    }
    hasRejectedAck(commandId) {
        return this.rejectedAcks.has(trimId(commandId));
    }
    // Emits the reliable COMMAND_DELIVERED evidence at the business entry.
    // Returns false (and sends nothing) when this command_id was already
    // delivered, was rejected, or the id is empty. The frame is stored so
    // duplicates replay the exact recorded evidence.
    markDelivered(commandId) {
        const id = trimId(commandId);
        if (!id)
            return false;
        if (this.rejectedAcks.has(id))
            return false;
        if (this.deliveredFrames.has(id))
            return false;
        const frame = buildCommandDelivered(id);
        if (!frame)
            return false;
        this.prune();
        this.deliveredFrames.set(id, { frame, ts: this.now() });
        this.send(frame.type, frame);
        return true;
    }
    hasDelivered(commandId) {
        return this.deliveredFrames.has(trimId(commandId));
    }
}
