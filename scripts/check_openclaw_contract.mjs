import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contract = JSON.parse(
  fs.readFileSync(path.join(pluginRoot, 'contracts', 'openclaw-baselines.json'), 'utf8'),
);
const repoArgIndex = process.argv.indexOf('--repo');
const openclawRepo = path.resolve(
  repoArgIndex >= 0 && process.argv[repoArgIndex + 1]
    ? process.argv[repoArgIndex + 1]
    : process.env.OPENCLAW_SOURCE_DIR || path.join(pluginRoot, '..', 'openclaw'),
);

function git(args, options = {}) {
  return execFileSync('git', ['-C', openclawRepo, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
}

function fail(message) {
  console.error(`OpenClaw contract failed: ${message}`);
  process.exitCode = 1;
}

if (!fs.existsSync(path.join(openclawRepo, '.git'))) {
  fail(`repository not found: ${openclawRepo}`);
} else {
  for (const baseline of contract.baselines) {
    let baselineFailed = false;
    try {
      git(['cat-file', '-e', `${baseline.ref}^{commit}`]);
      const pkg = JSON.parse(git(['show', `${baseline.ref}:package.json`]));
      if (pkg.version !== baseline.version) {
        fail(`${baseline.name} ${baseline.ref} has version ${pkg.version}; expected ${baseline.version}`);
        baselineFailed = true;
      }
      for (const file of contract.requiredFiles) {
        try {
          git(['cat-file', '-e', `${baseline.ref}:${file}`]);
        } catch {
          fail(`${baseline.name} ${baseline.ref} is missing ${file}`);
          baselineFailed = true;
        }
      }
      for (const symbol of contract.requiredSymbols) {
        try {
          git(['grep', '-q', '-F', symbol, baseline.ref, '--', 'src']);
        } catch {
          fail(`${baseline.name} ${baseline.ref} is missing runtime symbol ${symbol}`);
          baselineFailed = true;
        }
      }
      if (!baselineFailed) {
        console.log(`OpenClaw contract baseline passed: ${baseline.name} ${baseline.ref} (${pkg.version})`);
      }
    } catch (error) {
      fail(`${baseline.name} ${baseline.ref} could not be inspected: ${error.message}`);
    }
  }
}

const pluginSources = [
  path.join(pluginRoot, 'index.ts'),
  ...fs.readdirSync(path.join(pluginRoot, 'src'))
    .filter((name) => name.endsWith('.ts'))
    .map((name) => path.join(pluginRoot, 'src', name)),
];
for (const sourcePath of pluginSources) {
  const source = fs.readFileSync(sourcePath, 'utf8');
  for (const forbiddenImport of contract.forbiddenPluginImports) {
    if (source.includes(forbiddenImport)) {
      fail(`${path.relative(pluginRoot, sourcePath)} imports forbidden surface ${forbiddenImport}`);
    }
  }
}

if (!process.exitCode) {
  console.log('OpenClaw dual-baseline contract passed.');
}
