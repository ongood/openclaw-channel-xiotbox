/**
 * Unit tests for xiotbox-control-tool pure functions.
 * Run with: node --test test/control-tool-pure.test.mjs
 */

import assert from 'node:assert/strict';
import test from 'node:test';

// Inline pure functions from xiotbox-control-tool.ts.

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeAction(value) {
  return String(value || '').trim();
}

function normalizePlan(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (!isObject(item)) continue;
    const action = normalizeAction(item.action);
    if (!action) continue;
    out.push({
      action,
      params: isObject(item.params) ? item.params : {},
      ttl_ms: item.ttl_ms,
      wait_timeout_ms: item.wait_timeout_ms,
      action_id: String(item.action_id || '').trim() || undefined,
    });
  }
  return out;
}

function normalizeLaunchStrategy(value) {
  const v = String(value || '').trim().toLowerCase();
  if (v === 'search_click' || v === 'search') return 'search_click';
  if (v === 'fallback_open_app' || v === 'fallback') return 'fallback_open_app';
  return 'home_click';
}

function safeStr(value) {
  return String(value ?? '').trim();
}

function resultData(result) {
  if (!isObject(result)) return {};
  if (isObject(result.data)) return result.data;
  return result;
}

function extractForegroundPackage(appInfoResult) {
  const data = resultData(appInfoResult);
  return safeStr(data.window_package || data.package);
}

function extractRootBoundsFromTree(treeResult) {
  const data = resultData(treeResult);
  const tree = isObject(data.tree) ? data.tree : null;
  const boundsStr = safeStr(tree?.bounds);
  if (!boundsStr) return null;
  const parts = boundsStr.split(/[^0-9\-]+/).map((x) => x.trim()).filter(Boolean).slice(0, 4);
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isFinite(n))) return null;
  const [left, top, right, bottom] = nums;
  const w = Math.max(1, right - left);
  const h = Math.max(1, bottom - top);
  return { left, top, right, bottom, w, h };
}

function looksLikeLauncherPackage(pkg) {
  const p = safeStr(pkg).toLowerCase();
  if (!p) return false;
  if (p.includes('launcher') || p.includes('home')) return true;
  const known = new Set([
    'com.android.launcher', 'com.android.launcher3',
    'com.google.android.apps.nexuslauncher', 'com.huawei.android.launcher',
    'com.hihonor.android.launcher', 'com.miui.home', 'com.oppo.launcher',
    'com.coloros.launcher', 'com.vivo.launcher', 'com.sec.android.app.launcher',
    'com.samsung.android.app.launcher', 'com.oneplus.launcher', 'com.transsion.hilauncher',
  ]);
  return known.has(p);
}

// Tests: normalizePlan

test('normalizePlan returns empty for non-array', () => {
  assert.deepEqual(normalizePlan(null), []);
  assert.deepEqual(normalizePlan(undefined), []);
  assert.deepEqual(normalizePlan('string'), []);
  assert.deepEqual(normalizePlan({}), []);
});

test('normalizePlan filters out invalid items', () => {
  const result = normalizePlan([null, 'string', 42, { noAction: true }]);
  assert.deepEqual(result, []);
});

test('normalizePlan normalizes valid steps', () => {
  const result = normalizePlan([
    { action: 'tap', params: { x: 100, y: 200 } },
    { action: '  swipe  ', params: { direction: 'up' }, ttl_ms: 5000 },
  ]);
  assert.equal(result.length, 2);
  assert.equal(result[0].action, 'tap');
  assert.deepEqual(result[0].params, { x: 100, y: 200 });
  assert.equal(result[1].action, 'swipe');
  assert.equal(result[1].ttl_ms, 5000);
});

test('normalizePlan defaults params to empty object', () => {
  const result = normalizePlan([{ action: 'get_screen' }]);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].params, {});
});

test('normalizePlan preserves action_id when present', () => {
  const result = normalizePlan([{ action: 'tap', action_id: 'id-123' }]);
  assert.equal(result[0].action_id, 'id-123');
});

test('normalizePlan omits action_id when empty', () => {
  const result = normalizePlan([{ action: 'tap', action_id: '' }]);
  assert.equal(result[0].action_id, undefined);
});

// Tests: normalizeLaunchStrategy

test('normalizeLaunchStrategy defaults to home_click', () => {
  assert.equal(normalizeLaunchStrategy(null), 'home_click');
  assert.equal(normalizeLaunchStrategy(''), 'home_click');
  assert.equal(normalizeLaunchStrategy('unknown'), 'home_click');
  assert.equal(normalizeLaunchStrategy('HOME_CLICK'), 'home_click');
});

test('normalizeLaunchStrategy recognizes search_click', () => {
  assert.equal(normalizeLaunchStrategy('search_click'), 'search_click');
  assert.equal(normalizeLaunchStrategy('search'), 'search_click');
  assert.equal(normalizeLaunchStrategy('SEARCH_CLICK'), 'search_click');
});

test('normalizeLaunchStrategy recognizes fallback_open_app', () => {
  assert.equal(normalizeLaunchStrategy('fallback_open_app'), 'fallback_open_app');
  assert.equal(normalizeLaunchStrategy('fallback'), 'fallback_open_app');
});

// Tests: extractForegroundPackage

test('extractForegroundPackage from data.window_package', () => {
  assert.equal(extractForegroundPackage({ data: { window_package: 'com.example.app' } }), 'com.example.app');
});

test('extractForegroundPackage from data.package', () => {
  assert.equal(extractForegroundPackage({ data: { package: 'com.example.pkg' } }), 'com.example.pkg');
});

test('extractForegroundPackage prefers window_package', () => {
  assert.equal(extractForegroundPackage({ data: { window_package: 'win', package: 'pkg' } }), 'win');
});

test('extractForegroundPackage returns empty for bad input', () => {
  assert.equal(extractForegroundPackage(null), '');
  assert.equal(extractForegroundPackage({}), '');
  assert.equal(extractForegroundPackage({ data: {} }), '');
});

// Tests: extractRootBoundsFromTree

test('extractRootBoundsFromTree parses bounds string', () => {
  const result = extractRootBoundsFromTree({ data: { tree: { bounds: '[0,0][1080,2400]' } } });
  assert.deepEqual(result, { left: 0, top: 0, right: 1080, bottom: 2400, w: 1080, h: 2400 });
});

test('extractRootBoundsFromTree returns null for missing tree', () => {
  assert.equal(extractRootBoundsFromTree({ data: {} }), null);
  assert.equal(extractRootBoundsFromTree(null), null);
});

test('extractRootBoundsFromTree returns null for malformed bounds', () => {
  assert.equal(extractRootBoundsFromTree({ data: { tree: { bounds: 'bad' } } }), null);
  assert.equal(extractRootBoundsFromTree({ data: { tree: { bounds: '' } } }), null);
});

test('extractRootBoundsFromTree ensures min w/h of 1', () => {
  const result = extractRootBoundsFromTree({ data: { tree: { bounds: '[0,0][0,0]' } } });
  assert.equal(result.w, 1);
  assert.equal(result.h, 1);
});

// Tests: looksLikeLauncherPackage

test('looksLikeLauncherPackage detects known launchers', () => {
  assert.equal(looksLikeLauncherPackage('com.miui.home'), true);
  assert.equal(looksLikeLauncherPackage('com.android.launcher3'), true);
  assert.equal(looksLikeLauncherPackage('com.samsung.android.app.launcher'), true);
});

test('looksLikeLauncherPackage detects by keyword', () => {
  assert.equal(looksLikeLauncherPackage('com.custom.launcher'), true);
  assert.equal(looksLikeLauncherPackage('com.custom.home'), true);
});

test('looksLikeLauncherPackage rejects non-launchers', () => {
  assert.equal(looksLikeLauncherPackage('com.whatsapp'), false);
  assert.equal(looksLikeLauncherPackage('com.tencent.mm'), false);
});

test('looksLikeLauncherPackage handles empty/null', () => {
  assert.equal(looksLikeLauncherPackage(''), false);
  assert.equal(looksLikeLauncherPackage(null), false);
  assert.equal(looksLikeLauncherPackage(undefined), false);
});
