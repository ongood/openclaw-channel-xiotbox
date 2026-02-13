#!/usr/bin/env node
/**
 * Minimal e2e runner for xiotbox_control without OpenClaw runtime.
 *
 * Requires:
 * - XIOTBOX_API_BASE_URL (or XIOTBOX_API_BASE)
 * - XIOTBOX_DEVICE_ID / XIOTBOX_DEVICE_TOKEN (source device credentials)
 * - target phone control-agent device_id
 *
 * Example:
 *   XIOTBOX_API_BASE_URL=https://api.xiotbox.com \
 *   XIOTBOX_DEVICE_ID=... XIOTBOX_DEVICE_TOKEN=... \
 *   node scripts/run_xiotbox_control_plan.mjs --device <TARGET_DEVICE_ID> --example 1
 */

import fs from 'node:fs';
import process from 'node:process';

import { createXiotboxControlTool } from '../dist/src/xiotbox-control-tool.js';
import { loadRuntimeConfig } from '../dist/src/runtime_config.js';

function usage(code = 1) {
  const msg = `
Usage:
  node scripts/run_xiotbox_control_plan.mjs --device <TARGET_DEVICE_ID> (--plan <file.json> | --plan-json <json> | --example <1|2|3|4>)

Env:
  XIOTBOX_API_BASE_URL / XIOTBOX_API_BASE
  XIOTBOX_DEVICE_ID
  XIOTBOX_DEVICE_TOKEN

Examples:
  node scripts/run_xiotbox_control_plan.mjs --device <TARGET_DEVICE_ID> --example 1
  node scripts/run_xiotbox_control_plan.mjs --device <TARGET_DEVICE_ID> --plan ./my_plan.json
`.trim();
  console.error(msg);
  process.exit(code);
}

function getArg(name) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return null;
  const v = process.argv[idx + 1];
  return v === undefined ? '' : v;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function readJsonFile(p) {
  const raw = fs.readFileSync(p, 'utf-8');
  return JSON.parse(raw);
}

function buildExamples() {
  const now = Date.now();
  const fixedActionId = `dedupe_${now}`;
  return {
    // Use-case 1: high-level launch (prefer UI click launch; open_app is fallback).
    1: [{ action: 'launch_app', params: { app_name: '设置', strategy: 'home_click' } }],
    // Use-case 2: launch app -> tap -> type (observe-before-operate is injected for UI actions).
    2: [
      { action: 'launch_app', params: { app_name: '设置', package: 'com.android.settings' } },
      { action: 'tap', params: { x: 520, y: 1480 } },
      { action: 'type', params: { text: 'hello' } },
    ],
    // Use-case 3: fallback demonstration (force paging failure then use open_app fallback).
    3: [{ action: 'launch_app', params: { app_name: '__not_exists__', package: 'com.android.settings' } }],
    // Use-case 4: dedupe demonstration (same action_id twice should not execute twice on device).
    4: [
      { action: 'tap', action_id: fixedActionId, params: { x: 10, y: 10 } },
      { action: 'tap', action_id: fixedActionId, params: { x: 10, y: 10 } },
    ],
  };
}

async function main() {
  if (hasFlag('-h') || hasFlag('--help')) usage(0);

  const targetDeviceId = (getArg('--device') || '').trim();
  if (!targetDeviceId) usage(1);

  const planFile = getArg('--plan');
  const planJson = getArg('--plan-json');
  const example = getArg('--example');

  let plan = null;
  if (planFile) {
    plan = readJsonFile(planFile);
  } else if (planJson) {
    plan = JSON.parse(planJson);
  } else if (example) {
    plan = buildExamples()[String(example).trim()];
  }

  if (!Array.isArray(plan) || !plan.length) {
    console.error('ERROR: invalid/empty plan');
    usage(1);
  }

  const runtime = loadRuntimeConfig();
  const { xiotbox } = runtime;

  const apiBaseUrl = (getArg('--api-base-url') || xiotbox.API_BASE_URL || '').trim();
  const sourceDeviceId = (getArg('--source-device-id') || xiotbox.DEVICE_ID || '').trim();
  const sourceDeviceToken = (getArg('--source-device-token') || xiotbox.DEVICE_TOKEN || '').trim();

  if (!apiBaseUrl || !sourceDeviceId || !sourceDeviceToken) {
    console.error('ERROR: missing env/args for source credentials (api base url / device id / device token)');
    usage(1);
  }

  const tool = createXiotboxControlTool({
    getConfig: () => ({
      channels: {
        xiotbox: {
          API_BASE_URL: apiBaseUrl,
          DEVICE_ID: sourceDeviceId,
          DEVICE_TOKEN: sourceDeviceToken,
        },
      },
    }),
    logger: console,
  });

  const timeoutMs = Number(getArg('--timeout-ms') || '0') || undefined;
  const pollMs = Number(getArg('--poll-ms') || '0') || undefined;
  const result = await tool.execute('cli', {
    device_id: targetDeviceId,
    plan,
    ...(timeoutMs ? { timeout_ms: timeoutMs } : {}),
    ...(pollMs ? { poll_ms: pollMs } : {}),
  });

  // Tool returns OpenClaw-style content payload.
  if (result?.content?.[0]?.text) {
    console.log(result.content[0].text);
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});
