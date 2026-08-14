import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const DEFAULT_MAX_ENTRIES = 2000;
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_RETRY_BASE_MS = 1000;
const DEFAULT_RETRY_MAX_MS = 60000;
const DEFAULT_TICK_MS = 1000;
function safeDeviceId(value) {
    return String(value || 'default').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 160) || 'default';
}
export function resolveEventOutboxPath(deviceId) {
    const configuredHome = String(process.env.OPENCLAW_HOME || '').trim();
    const openclawHome = configuredHome || path.join(os.homedir(), '.openclaw');
    return path.join(openclawHome, 'xiotbox', 'event-outbox', `${safeDeviceId(deviceId)}.json`);
}
export class DurableEventOutbox {
    constructor(options) {
        this.entries = new Map();
        this.timer = null;
        this.filePath = path.resolve(options.filePath);
        this.send = options.send;
        this.logger = options.logger;
        this.maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_MAX_ENTRIES);
        this.ttlMs = Math.max(1000, options.ttlMs ?? DEFAULT_TTL_MS);
        this.retryBaseMs = Math.max(100, options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS);
        this.retryMaxMs = Math.max(this.retryBaseMs, options.retryMaxMs ?? DEFAULT_RETRY_MAX_MS);
        this.tickMs = Math.max(100, options.tickMs ?? DEFAULT_TICK_MS);
        this.now = options.now ?? Date.now;
        this.load();
    }
    get size() {
        return this.entries.size;
    }
    start() {
        if (this.timer)
            return;
        this.timer = setInterval(() => this.flushDue(), this.tickMs);
        this.timer.unref?.();
    }
    stop() {
        if (!this.timer)
            return;
        clearInterval(this.timer);
        this.timer = null;
    }
    enqueue(payload) {
        const eventId = String(payload?.event_id || '').trim();
        if (!eventId)
            throw new Error('event_id required for durable outbox');
        const isNew = !this.entries.has(eventId);
        if (isNew) {
            const now = this.now();
            this.entries.set(eventId, {
                payload: { ...payload, event_id: eventId },
                createdAt: now,
                attempts: 0,
                nextAttemptAt: now,
            });
            this.prune(now);
            this.persist();
        }
        if (isNew)
            this.flushEvent(eventId, true);
    }
    acknowledge(ack) {
        const eventId = String(ack?.event_id || '').trim();
        const status = String(ack?.status || '').trim().toLowerCase();
        if (!eventId || !['accepted', 'rejected'].includes(status))
            return false;
        const removed = this.entries.delete(eventId);
        if (removed)
            this.persist();
        if (status === 'rejected') {
            this.logger?.error?.(`[XiotBox] v2 event rejected event_id=${eventId} error=${ack?.error || 'unknown'}`);
        }
        return removed;
    }
    flushDue(force = false) {
        const now = this.now();
        this.prune(now);
        for (const eventId of this.entries.keys()) {
            this.flushEvent(eventId, force);
        }
    }
    flushEvent(eventId, force) {
        const entry = this.entries.get(eventId);
        if (!entry)
            return;
        const now = this.now();
        if (!force && entry.nextAttemptAt > now)
            return;
        try {
            this.send(entry.payload);
            entry.attempts += 1;
            const delay = Math.min(this.retryBaseMs * (2 ** Math.min(entry.attempts - 1, 16)), this.retryMaxMs);
            entry.nextAttemptAt = now + delay;
            this.entries.set(eventId, entry);
            this.persist();
        }
        catch (err) {
            entry.nextAttemptAt = now + this.retryBaseMs;
            this.entries.set(eventId, entry);
            this.persist();
            this.logger?.warn?.(`[XiotBox] v2 event send failed event_id=${eventId} error=${err instanceof Error ? err.message : String(err)}`);
        }
    }
    prune(now) {
        for (const [eventId, entry] of this.entries) {
            if (now - entry.createdAt > this.ttlMs)
                this.entries.delete(eventId);
        }
        while (this.entries.size > this.maxEntries) {
            const oldest = [...this.entries.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
            if (!oldest)
                break;
            this.entries.delete(oldest[0]);
            this.logger?.error?.(`[XiotBox] v2 event outbox overflow dropped event_id=${oldest[0]}`);
        }
    }
    load() {
        try {
            if (!fs.existsSync(this.filePath))
                return;
            const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
            if (parsed?.version !== 1 || !Array.isArray(parsed.entries))
                return;
            const now = this.now();
            for (const entry of parsed.entries) {
                const eventId = String(entry?.payload?.event_id || '').trim();
                if (!eventId || !Number.isFinite(entry?.createdAt))
                    continue;
                this.entries.set(eventId, {
                    payload: { ...entry.payload, event_id: eventId },
                    createdAt: Number(entry.createdAt),
                    attempts: Math.max(0, Number(entry.attempts) || 0),
                    nextAttemptAt: Math.max(0, Number(entry.nextAttemptAt) || now),
                });
            }
            this.prune(now);
        }
        catch (err) {
            this.logger?.error?.(`[XiotBox] v2 event outbox load failed path=${this.filePath} error=${err instanceof Error ? err.message : String(err)}`);
        }
    }
    persist() {
        const dir = path.dirname(this.filePath);
        fs.mkdirSync(dir, { recursive: true });
        const tempPath = `${this.filePath}.${process.pid}.tmp`;
        const data = { version: 1, entries: [...this.entries.values()] };
        fs.writeFileSync(tempPath, JSON.stringify(data), { encoding: 'utf8', mode: 0o600 });
        fs.renameSync(tempPath, this.filePath);
    }
}
