import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];

function readJson(relPath) {
  return JSON.parse(fs.readFileSync(path.join(root, relPath), 'utf-8'));
}

function readText(relPath) {
  return fs.readFileSync(path.join(root, relPath), 'utf-8');
}

function fail(message) {
  errors.push(message);
}

const pkg = readJson('package.json');
const lock = readJson('package-lock.json');
const manifest = readJson('openclaw.plugin.json');
const version = pkg.version;

const versionChecks = [
  ['package-lock.json', lock.version],
  ['package-lock.json packages[""].version', lock.packages?.['']?.version],
  ['openclaw.plugin.json', manifest.version],
];

for (const [label, value] of versionChecks) {
  if (value !== version) {
    fail(`${label} version is ${value || '<missing>'}; expected ${version}`);
  }
}

const releaseRefs = [
  'scripts/update_openclaw_xiotbox.sh',
  'scripts/install_configure_xiotbox.sh',
  'scripts/bootstrap_xiotbox_termux.sh',
  'scripts/test_install_xiotbox_termux.sh',
  'docs/plugins-git-install-termux.md',
];

for (const relPath of releaseRefs) {
  const text = readText(relPath);
  if (!text.includes(version)) {
    fail(`${relPath} does not mention current version ${version}`);
  }
}

const distPairs = [
  ['index.ts', 'dist/index.js'],
  ['setup-entry.ts', 'dist/setup-entry.js'],
  ['wss_client.js', 'dist/wss_client.js'],
  ['src/channel.ts', 'dist/src/channel.js'],
  ['src/runtime.ts', 'dist/src/runtime.js'],
  ['src/e2e.ts', 'dist/src/e2e.js'],
  ['src/runtime_config.ts', 'dist/src/runtime_config.js'],
];

for (const [srcRel, distRel] of distPairs) {
  const srcPath = path.join(root, srcRel);
  const distPath = path.join(root, distRel);
  if (!fs.existsSync(distPath)) {
    fail(`${distRel} is missing; run npm run build`);
    continue;
  }
  const srcStat = fs.statSync(srcPath);
  const distStat = fs.statSync(distPath);
  if (srcStat.mtimeMs - distStat.mtimeMs > 1000) {
    fail(`${distRel} is older than ${srcRel}; run npm run build`);
  }
}

if (errors.length) {
  console.error('Release check failed:');
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log(`Release check passed for ${version}`);
