#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

const entrySpecifier = process.env.OPENCLAW_ENTRY_SPECIFIER || 'openclaw/plugin-sdk/channel-entry-contract';
const rootUrl = new URL('../', import.meta.url);
const distIndexUrl = new URL('../dist/index.js', import.meta.url);
const runtimeUrl = new URL('../dist/src/runtime.js', import.meta.url);

async function tryResolve(specifier) {
  try {
    return { ok: true, value: await import.meta.resolve(specifier) };
  } catch (err) {
    return { ok: false, error: err?.code || err?.message || String(err) };
  }
}

async function tryImport(specifier) {
  try {
    return { ok: true, value: await import(specifier) };
  } catch (err) {
    return { ok: false, error: err?.code || err?.message || String(err) };
  }
}

async function probeCurrentManualEntry() {
  const runtime = {
    config: {
      loadConfig: () => ({ channels: { xiotbox: { enabled: true } } }),
    },
  };
  const calls = [];
  const api = {
    logger: {},
    runtime,
    registrationMode: 'full',
    registerChannel(params) {
      calls.push({ type: 'registerChannel', hasPlugin: Boolean(params?.plugin) });
    },
    registerTool(tool, options) {
      calls.push({
        type: 'registerTool',
        id: tool?.id || tool?.name || null,
        optional: Boolean(options?.optional),
      });
    },
  };

  try {
    const entryModule = await import(distIndexUrl.href);
    const runtimeModule = await import(runtimeUrl.href);
    const entry = entryModule?.default;
    if (typeof entry?.register !== 'function') {
      return { ok: false, error: 'dist/index.js default export has no register(api)' };
    }
    entry.register(api);
    const injectedRuntime = runtimeModule.getXiotboxRuntimeOrNull?.();
    return {
      ok: true,
      entryShape: {
        id: entry?.id || null,
        name: entry?.name || null,
        hasPlugin: Boolean(entry?.plugin),
        hasRegister: typeof entry?.register === 'function',
      },
      calls,
      runtimeInjected: injectedRuntime === runtime,
    };
  } catch (err) {
    return { ok: false, error: err?.stack || err?.message || String(err) };
  }
}

function printSection(title) {
  console.log(`\n## ${title}`);
}

const resolved = await tryResolve(entrySpecifier);
const imported = resolved.ok ? await tryImport(entrySpecifier) : { ok: false, error: 'skipped: resolve failed' };
const manualEntry = await probeCurrentManualEntry();

printSection('OpenClaw Entry Contract Spike 3.1');
console.log(`cwd: ${process.cwd()}`);
console.log(`repoRoot: ${new URL('.', rootUrl).pathname}`);
console.log(`scriptImportMetaUrl: ${import.meta.url}`);
console.log(`distIndexUrl: ${distIndexUrl.href}`);
console.log(`entrySpecifier: ${entrySpecifier}`);

printSection('Experiment 1: external package import');
console.log(JSON.stringify({
  resolve: resolved,
  import: imported.ok
    ? {
        ok: true,
        exports: Object.keys(imported.value).sort(),
        hasDefineBundledChannelEntry: typeof imported.value.defineBundledChannelEntry === 'function',
        hasDefineBundledChannelSetupEntry: typeof imported.value.defineBundledChannelSetupEntry === 'function',
      }
    : imported,
}, null, 2));

printSection('Experiment 2: current manual entry regression');
console.log(JSON.stringify(manualEntry, null, 2));

printSection('Decision hint');
if (!resolved.ok || !imported.ok) {
  console.log('defineBundledChannelEntry is not importable in this workspace. Keep the manual entry until an OpenClaw package/source path is provided or the host exposes a stable external SDK import.');
} else if (!manualEntry.ok || !manualEntry.runtimeInjected) {
  console.log('Current manual entry regression failed. Fix existing register/runtime injection before attempting entry migration.');
} else {
  console.log('Entry contract is importable and the current manual entry still passes the local register/runtime injection regression. Continue with an isolated defineBundledChannelEntry prototype.');
}
