import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

type Maybe<T> = T | null | undefined;

type XiotboxConfigFile = {
  GATEWAY_WSS_URL: string;
  GATEWAY_API_URL: string;
  USE_QUERY_AUTH: boolean;
  TENANT_ID: string;
  COMMAND_TIMEOUT: number;

  OUTBOX_MAX: number;
  OUTBOX_TTL_MS: number;
  COMMAND_CACHE_TTL_MS: number;
  COMMAND_CACHE_MAX: number;
  STREAMING: boolean;
  STREAM_THROTTLE_MS: number;

  API_BASE_URL: string;
  E2E_KEY_PATH: string;
  E2E_ROTATE: string;
  IDENTITY_KEY_PATH: string;
  TRUST_PATH: string;
  ALLOW_NEW_CLIENT_IDENTITIES: any;

  LOCAL_CONTROL_BASE_URL: string;
  LOCAL_CONTROL_TIMEOUT_MS: number;
};

type BridgeConfigFile = {
  enabled: boolean;
  /**
   * XiotBox bridge endpoint for talking to XiotBox Gateway.
   * Default keeps backward compatible localhost XiotBox Gateway.
   */
  endpoint: string;
  /**
   * Safety allowlist for bridge → XiotBox / OpenClaw localhost usage.
   * This is *not* a security boundary, just a guard rail for misconfig.
   */
  allowlist: string[];
  /**
   * Local OpenClaw gateway host/port that the bridge connects to.
   */
  openclawHost: string;
  openclawPort: number;
  /**
   * Target agent id on the OpenClaw gateway (operator client).
   */
  agentId: string;
};

type XiotboxSecretsFile = {
  DEVICE_ID: string;
  DEVICE_TOKEN: string;
  LOCAL_CONTROL_TOKEN: string;
};

type BridgeSecretsFile = {
  GATEWAY_TOKEN: string;
};

type ConfigFileShape = {
  xiotbox: XiotboxConfigFile;
  bridge: BridgeConfigFile;
};

type SecretFileShape = {
  xiotbox: XiotboxSecretsFile;
  bridge: BridgeSecretsFile;
};

export type XiotboxRuntimeConfig = XiotboxConfigFile & XiotboxSecretsFile;

export type BridgeRuntimeConfig = BridgeConfigFile & BridgeSecretsFile;

export type RuntimeConfig = {
  /**
   * Base directory for xiotbox runtime config.
   * Usually: $OPENCLAW_HOME/xiotbox or ~/.openclaw/xiotbox
   */
  baseDir: string;
  configPath: string;
  secretPath: string;
  xiotbox: XiotboxRuntimeConfig;
  bridge: BridgeRuntimeConfig;
};

function truthyEnv(value: Maybe<string>): boolean {
  const v = String(value ?? '').trim().toLowerCase();
  if (!v) return false;
  return ['1', 'true', 'yes', 'on'].includes(v);
}

function getOpenclawHome(): string {
  const raw = String(process.env.OPENCLAW_HOME ?? '').trim();
  if (raw) return raw;
  return path.join(os.homedir(), '.openclaw');
}

function ensureDir(p: string): void {
  if (!fs.existsSync(p)) {
    fs.mkdirSync(p, { recursive: true });
  }
}

function readJsonFile<T>(filePath: string, fallback: T): T {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf-8');
    if (!raw.trim()) return fallback;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return fallback;
    return { ...fallback, ...parsed };
  } catch {
    return fallback;
  }
}

function writeJsonFile(filePath: string, data: any): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

function defaultConfig(): ConfigFileShape {
  return {
    xiotbox: {
      GATEWAY_WSS_URL: 'ws://localhost:8069/ws/openclaw',
      GATEWAY_API_URL: '',
      USE_QUERY_AUTH: false,
      TENANT_ID: '',
      COMMAND_TIMEOUT: 300_000,

      OUTBOX_MAX: 200,
      OUTBOX_TTL_MS: 5 * 60 * 1000,
      COMMAND_CACHE_TTL_MS: 10 * 60 * 1000,
      COMMAND_CACHE_MAX: 500,
      STREAMING: true,
      STREAM_THROTTLE_MS: 35,

      API_BASE_URL: '',
      E2E_KEY_PATH: '',
      E2E_ROTATE: '',
      IDENTITY_KEY_PATH: '',
      TRUST_PATH: '',
      ALLOW_NEW_CLIENT_IDENTITIES: undefined,

      LOCAL_CONTROL_BASE_URL: 'http://127.0.0.1:17777',
      LOCAL_CONTROL_TIMEOUT_MS: 8000,
    },
    bridge: {
      enabled: false,
      endpoint: 'ws://localhost:8069/ws/openclaw',
      allowlist: ['127.0.0.1', 'localhost', '::1'],
      openclawHost: '127.0.0.1',
      openclawPort: 18789,
      agentId: 'main',
    },
  };
}

function defaultSecrets(): SecretFileShape {
  return {
    xiotbox: {
      DEVICE_ID: '',
      DEVICE_TOKEN: '',
      LOCAL_CONTROL_TOKEN: '',
    },
    bridge: {
      GATEWAY_TOKEN: '',
    },
  };
}

/**
 * Optional one-shot migration from legacy local config.json at package root
 * (used by older bridge/config tooling) into the unified OPENCLAW_HOME/xiotbox
 * layout. This does NOT read any environment variables and only touches
 * existing JSON files.
 */
function migrateLegacyConfigIfNeeded(configPath: string, secretPath: string): void {
  if (fs.existsSync(configPath) || fs.existsSync(secretPath)) return;

  // dist/src/runtime_config.js -> package root
  const thisFile = fileURLToPath(import.meta.url);
  const pkgRoot = path.resolve(path.dirname(thisFile), '..', '..');
  const legacyConfigPath = path.join(pkgRoot, 'config.json');
  if (!fs.existsSync(legacyConfigPath)) return;

  const baseCfg = defaultConfig();
  const baseSecrets = defaultSecrets();

  try {
    const raw = fs.readFileSync(legacyConfigPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      writeJsonFile(configPath, baseCfg);
      writeJsonFile(secretPath, baseSecrets);
      return;
    }

    const legacy: any = parsed;
    const cfg: ConfigFileShape = {
      ...baseCfg,
      xiotbox: {
        ...baseCfg.xiotbox,
        GATEWAY_WSS_URL: String(legacy.GATEWAY_WSS_URL ?? baseCfg.xiotbox.GATEWAY_WSS_URL),
        GATEWAY_API_URL: String(legacy.GATEWAY_API_URL ?? baseCfg.xiotbox.GATEWAY_API_URL),
        TENANT_ID: String(legacy.TENANT_ID ?? baseCfg.xiotbox.TENANT_ID),
        USE_QUERY_AUTH: Boolean(legacy.USE_QUERY_AUTH ?? baseCfg.xiotbox.USE_QUERY_AUTH),
        COMMAND_TIMEOUT: Number(legacy.COMMAND_TIMEOUT ?? baseCfg.xiotbox.COMMAND_TIMEOUT),
      },
      bridge: {
        ...baseCfg.bridge,
      },
    };

    const secrets: SecretFileShape = {
      ...baseSecrets,
      xiotbox: {
        ...baseSecrets.xiotbox,
        DEVICE_ID: String(legacy.DEVICE_ID ?? ''),
        DEVICE_TOKEN: String(legacy.DEVICE_TOKEN ?? ''),
      },
      bridge: {
        ...baseSecrets.bridge,
      },
    };

    writeJsonFile(configPath, cfg);
    writeJsonFile(secretPath, secrets);
  } catch {
    writeJsonFile(configPath, baseCfg);
    writeJsonFile(secretPath, baseSecrets);
  }
}

export function loadRuntimeConfig(): RuntimeConfig {
  const openclawHome = getOpenclawHome();
  const baseDir = path.join(openclawHome, 'xiotbox');
  ensureDir(baseDir);

  const configPath = path.join(baseDir, 'config.json');
  const secretPath = path.join(baseDir, 'secret.json');

  // Best-effort migration from legacy local config.json (package root).
  migrateLegacyConfigIfNeeded(configPath, secretPath);

  const cfgDefaults = defaultConfig();
  const secretDefaults = defaultSecrets();

  const cfgFromFile = readJsonFile<ConfigFileShape>(configPath, cfgDefaults);
  const secretsFromFile = readJsonFile<SecretFileShape>(secretPath, secretDefaults);

  const cfg: ConfigFileShape = {
    xiotbox: {
      ...cfgDefaults.xiotbox,
      ...(cfgFromFile?.xiotbox ?? {}),
    },
    bridge: {
      ...cfgDefaults.bridge,
      ...(cfgFromFile?.bridge ?? {}),
    },
  };

  const secrets: SecretFileShape = {
    xiotbox: {
      ...secretDefaults.xiotbox,
      ...(secretsFromFile?.xiotbox ?? {}),
    },
    bridge: {
      ...secretDefaults.bridge,
      ...(secretsFromFile?.bridge ?? {}),
    },
  };

  // Optional, non-sensitive env overrides for bridge mode only.
  let mutatedConfig = false;
  if (typeof process.env.XIOTBOX_BRIDGE_ENABLED === 'string') {
    const nextEnabled = truthyEnv(process.env.XIOTBOX_BRIDGE_ENABLED);
    if (nextEnabled !== cfg.bridge.enabled) {
      cfg.bridge.enabled = nextEnabled;
      mutatedConfig = true;
    }
  }
  if (typeof process.env.XIOTBOX_BRIDGE_ENDPOINT === 'string') {
    const nextEndpoint = String(process.env.XIOTBOX_BRIDGE_ENDPOINT || '').trim();
    if (nextEndpoint && nextEndpoint !== cfg.bridge.endpoint) {
      cfg.bridge.endpoint = nextEndpoint;
      mutatedConfig = true;
    }
  }

  if (!fs.existsSync(configPath) || mutatedConfig) {
    writeJsonFile(configPath, cfg);
  }
  if (!fs.existsSync(secretPath)) {
    writeJsonFile(secretPath, secrets);
  }

  const xiotbox: XiotboxRuntimeConfig = {
    ...cfg.xiotbox,
    DEVICE_ID: secrets.xiotbox.DEVICE_ID || '',
    DEVICE_TOKEN: secrets.xiotbox.DEVICE_TOKEN || '',
    LOCAL_CONTROL_TOKEN: secrets.xiotbox.LOCAL_CONTROL_TOKEN || '',
  };

  const bridge: BridgeRuntimeConfig = {
    ...cfg.bridge,
    GATEWAY_TOKEN: secrets.bridge.GATEWAY_TOKEN || '',
  };

  return {
    baseDir,
    configPath,
    secretPath,
    xiotbox,
    bridge,
  };
}

