import crypto from 'crypto';
import { x25519 } from '@noble/curves/ed25519';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import https from 'https';

const E2E_MAGIC = 'OGE2E1';
const E2E_VERSION = 1;
const E2E_ALG = 'AES-256-GCM';
const E2E_KEY_ALG = 'x25519';
const HKDF_INFO = Buffer.from('OGE2E1-wrap', 'utf-8');

const PUBKEY_LEN = 32;
const WRAP_NONCE_LEN = 12;
const CONTENT_KEY_LEN = 32;
const GCM_TAG_LEN = 16;
const FORCE_NOBLE = ['1', 'true', 'yes', 'on'].includes(
  String(process.env.XIOTBOX_FORCE_NOBLE_X25519 || '').toLowerCase(),
);
const PREFER_NATIVE = ['1', 'true', 'yes', 'on'].includes(
  String(process.env.XIOTBOX_PREFER_NATIVE_X25519 || '').toLowerCase(),
);
const HAS_NATIVE_X25519 = (() => {
  if (FORCE_NOBLE) return false;
  if (!PREFER_NATIVE) return false;
  try {
    return typeof crypto.getCurves === 'function' && crypto.getCurves().includes('x25519');
  } catch (_err) {
    return false;
  }
})();

function b64e(buf: Buffer): string {
  return Buffer.from(buf).toString('base64');
}

function b64d(value: string): Buffer {
  return Buffer.from(value || '', 'base64');
}

function looksLikeHex(value?: string): boolean {
  if (!value) return false;
  const v = value.trim();
  if (!v || v.length % 2) return false;
  return /^[0-9a-fA-F]+$/.test(v);
}

function decodePubkey(pubkey: string): Buffer | null {
  if (!pubkey) return null;
  const raw = pubkey.trim();
  if (!raw) return null;
  try {
    if (looksLikeHex(raw)) {
      return Buffer.from(raw, 'hex');
    }
    return b64d(raw);
  } catch (_err) {
    return null;
  }
}

function computeKeyId(pubRaw: Buffer): string {
  return crypto.createHash('sha256').update(pubRaw).digest('hex').slice(0, 16);
}

function computeFingerprint(pubRaw: Buffer): string {
  return computeKeyId(pubRaw);
}

function aesGcmEncrypt(key: Buffer, nonce: Buffer, plaintext: Buffer, aad?: Buffer | null): Buffer {
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  if (aad && aad.length) {
    cipher.setAAD(aad);
  }
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([ct, tag]);
}

function aesGcmDecrypt(key: Buffer, nonce: Buffer, ciphertext: Buffer, aad?: Buffer | null): Buffer {
  const ct = ciphertext.slice(0, Math.max(0, ciphertext.length - GCM_TAG_LEN));
  const tag = ciphertext.slice(Math.max(0, ciphertext.length - GCM_TAG_LEN));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  if (aad && aad.length) {
    decipher.setAAD(aad);
  }
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

function x25519Keypair(): { priv: Buffer; pub: Buffer } {
  if (HAS_NATIVE_X25519) {
    const ecdh = crypto.createECDH('x25519');
    ecdh.generateKeys();
    return { priv: ecdh.getPrivateKey(), pub: ecdh.getPublicKey() };
  }
  const priv = crypto.randomBytes(32);
  const pub = Buffer.from(x25519.getPublicKey(priv));
  return { priv, pub };
}

function x25519SharedSecret(priv: Buffer, pub: Buffer): Buffer {
  if (HAS_NATIVE_X25519) {
    const ecdh = crypto.createECDH('x25519');
    ecdh.setPrivateKey(priv);
    return ecdh.computeSecret(pub);
  }
  return Buffer.from(x25519.getSharedSecret(priv, pub));
}

export function buildEnvelope(
  plaintext: Buffer,
  receiverPubkey: Buffer,
  keyId: string,
  aad?: Buffer | null,
): Record<string, any> {
  if (!receiverPubkey || receiverPubkey.length !== PUBKEY_LEN) {
    throw new Error('invalid_pubkey_len');
  }
  const contentKey = crypto.randomBytes(CONTENT_KEY_LEN);
  const contentNonce = crypto.randomBytes(12);
  const ciphertext = aesGcmEncrypt(contentKey, contentNonce, plaintext, aad);

  const { priv: epkPriv, pub: epkPub } = x25519Keypair();
  const shared = x25519SharedSecret(epkPriv, receiverPubkey);
  const wrapKey = crypto.hkdfSync('sha256', shared, Buffer.alloc(0), HKDF_INFO, 32);
  const wrapNonce = crypto.randomBytes(WRAP_NONCE_LEN);
  const wrappedKey = aesGcmEncrypt(wrapKey, wrapNonce, contentKey, null);

  const ekBlob = Buffer.concat([epkPub, wrapNonce, wrappedKey]);
  const envelope: Record<string, any> = {
    magic: E2E_MAGIC,
    version: E2E_VERSION,
    alg: E2E_ALG,
    key_id: keyId || '',
    nonce_b64: b64e(contentNonce),
    ek_b64: b64e(ekBlob),
    ct_b64: b64e(ciphertext),
  };
  if (aad && aad.length) {
    envelope.aad_b64 = b64e(aad);
  }
  return envelope;
}

export function decryptEnvelope(
  envelope: Record<string, any>,
  privRaw: Buffer,
  aad?: Buffer | null,
): Buffer {
  if (!envelope || envelope.magic !== E2E_MAGIC || envelope.version !== E2E_VERSION) {
    throw new Error('invalid_envelope');
  }
  const ekBlob = b64d(envelope.ek_b64 || '');
  if (ekBlob.length < PUBKEY_LEN + WRAP_NONCE_LEN + GCM_TAG_LEN) {
    throw new Error('invalid_ek');
  }
  const epk = ekBlob.slice(0, PUBKEY_LEN);
  const wrapNonce = ekBlob.slice(PUBKEY_LEN, PUBKEY_LEN + WRAP_NONCE_LEN);
  const wrapped = ekBlob.slice(PUBKEY_LEN + WRAP_NONCE_LEN);
  const shared = x25519SharedSecret(privRaw, epk);
  const wrapKey = crypto.hkdfSync('sha256', shared, Buffer.alloc(0), HKDF_INFO, 32);
  const contentKey = aesGcmDecrypt(wrapKey, wrapNonce, wrapped, null);

  const nonce = b64d(envelope.nonce_b64 || '');
  const ciphertext = b64d(envelope.ct_b64 || '');
  const envAad = envelope.aad_b64 ? b64d(envelope.aad_b64) : null;
  if (aad && envAad && !aad.equals(envAad)) {
    throw new Error('aad_mismatch');
  }
  const aadToUse = aad || envAad || null;
  return aesGcmDecrypt(contentKey, nonce, ciphertext, aadToUse);
}

function resolveKeyPath(cfg: any, deviceId: string): string {
  if (cfg?.E2E_KEY_PATH) return cfg.E2E_KEY_PATH;
  const base = path.join(os.homedir(), '.openclaw');
  return path.join(base, `xiotbox_e2e_${deviceId}.json`);
}

function loadKeypair(cfg: any, deviceId: string): { priv: Buffer; pub: Buffer; keyId: string } | null {
  const keyPath = resolveKeyPath(cfg, deviceId);
  if (!fs.existsSync(keyPath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(keyPath, 'utf-8'));
    const privRaw = b64d(raw.priv_b64 || '');
    const pubRaw = b64d(raw.pub_b64 || '');
    if (privRaw.length !== 32 || pubRaw.length !== 32) return null;
    return { priv: privRaw, pub: pubRaw, keyId: raw.key_id || computeKeyId(pubRaw) };
  } catch (_err) {
    return null;
  }
}

function saveKeypair(cfg: any, deviceId: string, priv: Buffer, pub: Buffer): { priv: Buffer; pub: Buffer; keyId: string } {
  const keyPath = resolveKeyPath(cfg, deviceId);
  const dir = path.dirname(keyPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const keyId = computeKeyId(pub);
  const payload = {
    v: 1,
    alg: E2E_KEY_ALG,
    priv_b64: b64e(priv),
    pub_b64: b64e(pub),
    key_id: keyId,
  };
  fs.writeFileSync(keyPath, JSON.stringify(payload));
  try {
    fs.chmodSync(keyPath, 0o600);
  } catch (_err) {
    // best effort
  }
  return { priv, pub, keyId };
}

function generateKeypair(cfg: any, deviceId: string): { priv: Buffer; pub: Buffer; keyId: string } {
  const { priv, pub } = x25519Keypair();
  return saveKeypair(cfg, deviceId, priv, pub);
}

async function postJsonRpc(url: string, params: Record<string, any>, headers: Record<string, string>): Promise<any> {
  const body = JSON.stringify({ jsonrpc: '2.0', method: 'call', params });
  if (typeof fetch === 'function') {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
      body,
    });
    const data = await resp.json().catch(() => null);
    if (!data) throw new Error('invalid_response');
    if (data.error) throw new Error(data.error?.data?.message || data.error?.message || 'rpc_error');
    return data.result;
  }
  return await new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        method: 'POST',
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        res.on('end', () => {
          try {
            const text = Buffer.concat(chunks).toString('utf-8');
            const data = JSON.parse(text);
            if (data.error) {
              reject(new Error(data.error?.data?.message || data.error?.message || 'rpc_error'));
              return;
            }
            resolve(data.result);
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

export class OpenClawE2E {
  cfg: any;
  log: any;
  privRaw: Buffer | null = null;
  pubRaw: Buffer | null = null;
  keyId: string = '';
  peerPublicKey: string = '';
  peerKeyId: string = '';
  threadId: string = '';
  encV: number = E2E_VERSION;

  constructor(cfg: any, log?: any) {
    this.cfg = cfg || {};
    this.log = log;
  }

  init() {
    const existing = loadKeypair(this.cfg, this.cfg.DEVICE_ID);
    const rotateFlag = String(this.cfg.E2E_ROTATE || '').toLowerCase();
    const rotate = ['1', 'true', 'yes', 'on'].includes(rotateFlag);
    const keypair = rotate || !existing ? generateKeypair(this.cfg, this.cfg.DEVICE_ID) : existing;
    this.privRaw = keypair.priv;
    this.pubRaw = keypair.pub;
    this.keyId = keypair.keyId;
    if (this.log?.info) {
      const backend = HAS_NATIVE_X25519 ? 'native' : 'noble';
      this.log.info(`[XiotBox] E2E x25519 backend: ${backend}`);
    }
  }

  async refreshPeerKey() {
    const apiBase = this.cfg.API_BASE_URL || this._deriveApiBase();
    if (!apiBase) throw new Error('missing_api_base');
    const url = `${apiBase.replace(/\/$/, '')}/openclaw/devices/e2e/peer_key`;
    const headers = {
      Authorization: `Bearer ${this.cfg.DEVICE_TOKEN}`,
      'X-Device-Id': this.cfg.DEVICE_ID,
    };
    const payload: Record<string, any> = {};
    if (this.pubRaw) {
      payload.pubkey = b64e(this.pubRaw);
      payload.key_id = this.keyId || computeKeyId(this.pubRaw);
      payload.algo = E2E_KEY_ALG;
      payload.enc_v = this.encV || E2E_VERSION;
      payload.fingerprint = computeFingerprint(this.pubRaw);
    }
    let result;
    try {
      result = await postJsonRpc(url, payload, headers);
    } catch (err: any) {
      if (!this.cfg.API_BASE_URL) {
        throw new Error('missing_api_base');
      }
      throw err;
    }
    this.peerPublicKey = result?.client_public_key || '';
    this.peerKeyId = result?.client_key_id || '';
    this.threadId = result?.thread_id || '';
    this.encV = result?.enc_v || E2E_VERSION;
    return result;
  }

  helloPayload() {
    if (!this.pubRaw) return null;
    return {
      pubkey: b64e(this.pubRaw),
      key_id: this.keyId || computeKeyId(this.pubRaw),
      algo: E2E_KEY_ALG,
      enc_v: this.encV || E2E_VERSION,
      fingerprint: computeFingerprint(this.pubRaw),
    };
  }

  buildAad(meta: {
    direction: string;
    device_id: string;
    thread_id: string;
    command_id: string;
    content_type: string;
    chunk_seq?: number;
    enc_v?: number;
  }): Buffer {
    const encV = meta.enc_v || this.encV || E2E_VERSION;
    const parts = [
      `v=${encV}`,
      `dir=${meta.direction || ''}`,
      `device=${meta.device_id || ''}`,
      `thread=${meta.thread_id || ''}`,
      `cmd=${meta.command_id || ''}`,
      `type=${meta.content_type || ''}`,
      `seq=${meta.chunk_seq || 0}`,
    ];
    return Buffer.from(`oc|${parts.join('|')}`, 'utf-8');
  }

  ensurePeerKey() {
    const raw = decodePubkey(this.peerPublicKey || '');
    if (!raw) throw new Error('missing_peer_key');
    return raw;
  }

  encryptText(text: string, meta: any) {
    if (!this.pubRaw || !this.privRaw) throw new Error('missing_keypair');
    const peerRaw = this.ensurePeerKey();
    const aad = this.buildAad(meta);
    const keyId = this.peerKeyId || computeKeyId(peerRaw);
    return buildEnvelope(Buffer.from(text || '', 'utf-8'), peerRaw, keyId || '', aad);
  }

  decryptText(envelope: Record<string, any>, meta: any): string {
    if (!this.privRaw) throw new Error('missing_keypair');
    const aad = this.buildAad(meta);
    const raw = decryptEnvelope(envelope, this.privRaw, aad);
    return raw.toString('utf-8');
  }

  _deriveApiBase(): string {
    const wssUrl = this.cfg.GATEWAY_WSS_URL;
    if (!wssUrl) return '';
    try {
      const u = new URL(wssUrl);
      const scheme = u.protocol === 'wss:' ? 'https:' : 'http:';
      return `${scheme}//${u.host}`;
    } catch (_err) {
      return '';
    }
  }
}
