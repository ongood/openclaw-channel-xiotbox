#!/usr/bin/env node
/**
 * Simple CI guard:
 * - Fails if any file other than src/runtime_config.ts (and its compiled dist)
 *   contains process.env access.
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

/** @param {string} dir */
function walk(dir) {
  /** @type {string[]} */
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    if (entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

const allFiles = walk(ROOT);

const allowlist = new Set([
  path.join(ROOT, 'src', 'runtime_config.ts'),
  path.join(ROOT, 'dist', 'src', 'runtime_config.js'),
]);

/** @type {string[]} */
const offenders = [];

for (const file of allFiles) {
  if (!file.endsWith('.ts') && !file.endsWith('.js') && !file.endsWith('.mjs')) continue;
  const content = fs.readFileSync(file, 'utf-8');
  if (!content.includes('process.env')) continue;
  if (allowlist.has(file)) continue;
  offenders.push(path.relative(ROOT, file));
}

if (offenders.length) {
  // eslint-disable-next-line no-console
  console.error(
    '[check_no_env_outside_runtime_config] Found forbidden process.env usage in:\n' +
      offenders.map((f) => `  - ${f}`).join('\n'),
  );
  process.exit(1);
}

// eslint-disable-next-line no-console
console.log('[check_no_env_outside_runtime_config] OK (no process.env outside runtime_config)');

