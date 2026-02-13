type ControlToolOptions = {
  getConfig?: () => any;
  logger?: {
    info?: (msg: string) => void;
    warn?: (msg: string) => void;
    error?: (msg: string) => void;
  };
};

type ControlPlanStep = {
  action: string;
  params: any;
  ttl_ms?: number;
  wait_timeout_ms?: number;
  action_id?: string;
};

type JsonRpcResult = {
  ok: boolean;
  result?: any;
  error?: string;
};

function getChannelConfig(cfg: any) {
  return cfg?.channels?.xiotbox || {};
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

function normalizeInt(value: any, fallback: number, { min, max }: { min: number; max: number }): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.floor(parsed), min), max);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function uuid() {
  // Not cryptographically strong; good enough for request ids / action ids.
  return `act_${Date.now()}_${Math.random().toString(16).slice(2)}_${Math.random().toString(16).slice(2)}`;
}

function jsonResult(payload: any) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

async function jsonRpcCall(
  baseUrl: string,
  path: string,
  params: any,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<JsonRpcResult> {
  if (typeof fetch !== 'function') {
    return { ok: false, error: 'fetch_not_available' };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(`${normalizeBaseUrl(baseUrl)}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...headers,
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params: params || {} }),
      signal: controller.signal,
    });
    const text = await resp.text();
    let data: any = null;
    try {
      data = JSON.parse(text);
    } catch (_err) {
      return { ok: false, error: `invalid_json_response:${resp.status}` };
    }
    if (!resp.ok) {
      return { ok: false, error: data?.error?.message || data?.error || `http_${resp.status}` };
    }
    if (data?.error) {
      return { ok: false, error: data.error?.message || JSON.stringify(data.error) };
    }
    return { ok: true, result: data?.result };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  } finally {
    clearTimeout(timeout);
  }
}

function isObject(value: any): boolean {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeAction(value: any): string {
  return String(value || '').trim();
}

function normalizePlan(value: any): ControlPlanStep[] {
  if (!Array.isArray(value)) return [];
  const out: ControlPlanStep[] = [];
  for (const item of value) {
    if (!isObject(item)) continue;
    const action = normalizeAction((item as any).action);
    if (!action) continue;
    out.push({
      action,
      params: isObject((item as any).params) ? (item as any).params : {},
      ttl_ms: (item as any).ttl_ms,
      wait_timeout_ms: (item as any).wait_timeout_ms,
      action_id: String((item as any).action_id || '').trim() || undefined,
    });
  }
  return out;
}

function normalizeLaunchStrategy(value: any): 'home_click' | 'search_click' | 'fallback_open_app' {
  const v = String(value || '')
    .trim()
    .toLowerCase();
  if (v === 'search_click' || v === 'search') return 'search_click';
  if (v === 'fallback_open_app' || v === 'fallback') return 'fallback_open_app';
  return 'home_click';
}

function safeStr(value: any): string {
  return String(value ?? '').trim();
}

function resultData(result: any): any {
  if (!isObject(result)) return {};
  if (isObject((result as any).data)) return (result as any).data;
  return result;
}

function extractForegroundPackage(appInfoResult: any): string {
  const data = resultData(appInfoResult);
  return safeStr((data as any).window_package || (data as any).package);
}

function extractRootBoundsFromTree(treeResult: any): { left: number; top: number; right: number; bottom: number; w: number; h: number } | null {
  const data = resultData(treeResult);
  const tree = isObject((data as any).tree) ? (data as any).tree : null;
  const boundsStr = safeStr(tree?.bounds);
  if (!boundsStr) return null;
  const parts = boundsStr
    .split(/[^0-9\-]+/)
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, 4);
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isFinite(n))) return null;
  const [left, top, right, bottom] = nums;
  const w = Math.max(1, right - left);
  const h = Math.max(1, bottom - top);
  return { left, top, right, bottom, w, h };
}

function looksLikeLauncherPackage(pkg: string): boolean {
  const p = safeStr(pkg).toLowerCase();
  if (!p) return false;
  if (p.includes('launcher') || p.includes('home')) return true;
  const known = new Set([
    'com.android.launcher',
    'com.android.launcher3',
    'com.google.android.apps.nexuslauncher',
    'com.huawei.android.launcher',
    'com.hihonor.android.launcher',
    'com.miui.home',
    'com.oppo.launcher',
    'com.coloros.launcher',
    'com.vivo.launcher',
    'com.sec.android.app.launcher',
    'com.samsung.android.app.launcher',
    'com.oneplus.launcher',
    'com.transsion.hilauncher',
  ]);
  return known.has(p);
}

export function createXiotboxControlTool(options: ControlToolOptions = {}) {
  const supportedActions = [
    // High-level tool-only action. It will be expanded into primitive control actions.
    'launch_app',
    'open_app',
    'tap',
    'type',
    'swipe',
    'long_press',
    'click_text',
    'get_screen',
    'get_tree',
    'wait_ui_change',
    'get_notifications',
    'get_app_info',
    'open_accessibility_settings',
  ] as const;

  const observeBeforeActions = new Set(['tap', 'swipe', 'long_press', 'click_text', 'type']);
  const waitAfterActions = new Set(['open_app', 'tap', 'swipe', 'long_press', 'click_text', 'type']);

  return {
    name: 'xiotbox_control',
    description:
      'Control a XiotBox phone remotely via XiotBox Gateway (WSS control). Enforces observe-before-operate: auto inserts get_tree/get_screen before UI-changing actions and wait_ui_change after them. Includes a high-level launch_app action that prefers UI click launch and uses open_app only as fallback.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        device_id: {
          type: 'string',
          description: 'Target XiotBox device_id (the phone running XiotBox Control agent).',
        },
        plan: {
          type: 'array',
          description:
            'Array of steps: {action, params}. Tool will auto-insert get_tree/get_screen + wait_ui_change around UI actions.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              action: { type: 'string', enum: [...supportedActions] },
              params: { type: 'object', additionalProperties: true },
              ttl_ms: { type: 'integer', minimum: 1000, maximum: 300000 },
              wait_timeout_ms: { type: 'integer', minimum: 500, maximum: 60000 },
              action_id: { type: 'string', description: 'Optional override for idempotency testing / replay.' },
            },
            required: ['action'],
          },
        },
        timeout_ms: {
          type: 'integer',
          minimum: 1000,
          maximum: 600000,
          description: 'Overall tool timeout in milliseconds.',
        },
        api_base_url: {
          type: 'string',
          description: 'Optional override. Defaults to channels.xiotbox.API_BASE_URL.',
        },
        poll_ms: {
          type: 'integer',
          minimum: 200,
          maximum: 5000,
          description: 'Status polling interval (ms).',
        },
      },
      required: ['device_id', 'plan'],
    },
    async execute(_id: string, rawParams: any) {
      const params = isObject(rawParams) ? rawParams : {};
      const targetDeviceId = String(params.device_id || '').trim();
      if (!targetDeviceId) {
        return jsonResult({ ok: false, error: 'missing_device_id' });
      }

      const plan = normalizePlan(params.plan);
      if (!plan.length) {
        return jsonResult({ ok: false, error: 'empty_plan' });
      }

      const cfg = options.getConfig?.() || {};
      const channelCfg = getChannelConfig(cfg);
      const apiBaseUrl = String(params.api_base_url || channelCfg.API_BASE_URL || '')
        .trim()
        .replace(/\/+$/, '');
      if (!apiBaseUrl) {
        return jsonResult({ ok: false, error: 'missing_api_base_url', message: 'Configure channels.xiotbox.API_BASE_URL' });
      }

      const sourceDeviceId = String(channelCfg.DEVICE_ID || '').trim();
      const sourceToken = String(channelCfg.DEVICE_TOKEN || '').trim();
      if (!sourceDeviceId || !sourceToken) {
        return jsonResult({
          ok: false,
          error: 'missing_device_credentials',
          message: 'Configure channels.xiotbox.DEVICE_ID / DEVICE_TOKEN for device-auth control dispatch.',
        });
      }

      const pollMs = normalizeInt(
        params.poll_ms,
        600,
        { min: 200, max: 5000 },
      );
      const httpTimeoutMs = normalizeInt(
        undefined,
        10000,
        { min: 1000, max: 60000 },
      );
      const overallTimeoutMs = normalizeInt(
        params.timeout_ms,
        120000,
        { min: 1000, max: 600000 },
      );
      const defaultTtlMs = normalizeInt(
        undefined,
        20000,
        { min: 1000, max: 300000 },
      );
      const defaultWaitTimeoutMs = normalizeInt(
        undefined,
        5000,
        { min: 500, max: 60000 },
      );

      const headers = {
        Authorization: `Bearer ${sourceToken}`,
        'X-Device-Id': sourceDeviceId,
      };

      const sessionId = `sess_${Date.now()}_${Math.random().toString(16).slice(2)}`;
      const startedAt = Date.now();
      const deadlineAt = startedAt + overallTimeoutMs;

      const stepsOut: any[] = [];

      const dispatchAndWait = async (action: string, actionParams: any, ttlMs: number, forcedActionId?: string) => {
        const stepStartedAt = Date.now();
        const actionId = String(forcedActionId || '').trim() || uuid();
        const dispatch = await jsonRpcCall(
          apiBaseUrl,
          '/openclaw/device/control/dispatch',
          {
            target_device_id: targetDeviceId,
            action,
            params: isObject(actionParams) ? actionParams : {},
            ttl_ms: ttlMs,
            need_result: true,
            action_id: actionId,
            session_id: sessionId,
          },
          headers,
          httpTimeoutMs,
        );
        if (!dispatch.ok) {
          return {
            ok: false,
            action_id: actionId,
            duration_ms: Date.now() - stepStartedAt,
            error: dispatch.error || 'dispatch_failed',
          };
        }
        const commandId = String(dispatch.result?.command_id || '').trim();
        if (!commandId) {
          return {
            ok: false,
            action_id: actionId,
            duration_ms: Date.now() - stepStartedAt,
            error: 'missing_command_id',
          };
        }

        const pollDeadline = Math.min(Date.now() + ttlMs + 5000, deadlineAt);
        while (Date.now() < pollDeadline) {
          const statusRes = await jsonRpcCall(
            apiBaseUrl,
            '/openclaw/device/control/status',
            { command_id: commandId },
            headers,
            httpTimeoutMs,
          );
          if (statusRes.ok) {
            const status = String(statusRes.result?.status || '').trim().toLowerCase();
            if (status === 'success') {
              return {
                ok: true,
                command_id: commandId,
                action_id: actionId,
                status,
                duration_ms: Date.now() - stepStartedAt,
                result: statusRes.result?.result,
                error_message: statusRes.result?.error_message || '',
              };
            }
            if (status === 'failed' || status === 'timeout') {
              return {
                ok: false,
                command_id: commandId,
                action_id: actionId,
                status,
                duration_ms: Date.now() - stepStartedAt,
                result: statusRes.result?.result,
                error_message: statusRes.result?.error_message || statusRes.result?.error_code || status,
              };
            }
          }
          await sleep(pollMs);
        }
        return {
          ok: false,
          command_id: commandId,
          action_id: actionId,
          status: 'timeout',
          duration_ms: Date.now() - stepStartedAt,
          error_message: 'TIMEOUT',
        };
      };

      const runLaunchApp = async (rawParams: any, groupId: string) => {
        const p = isObject(rawParams) ? rawParams : {};
        const appName = safeStr((p as any).app_name || (p as any).appName);
        const pkgExpected = safeStr((p as any).package);
        const strategy = normalizeLaunchStrategy((p as any).strategy);
        const timeoutMs = normalizeInt((p as any).timeout_ms || (p as any).timeoutMs, 20000, { min: 1000, max: 120000 });
        const maxPages = normalizeInt((p as any).max_pages || (p as any).maxPages, 6, { min: 1, max: 12 });

        const launchStartedAt = Date.now();
        const launchDeadlineAt = Math.min(launchStartedAt + timeoutMs, deadlineAt);
        const attempts: any = { pages: 0, clicks: 0, swipes: 0, used_open_app_fallback: false };
        let usedStrategy: string = 'home_click';
        let lastObservation: any = null;
        let launcherPkgBaseline = '';

        const pushStep = (step: any) => {
          stepsOut.push({ group: groupId, ...step });
        };

        const observePreferTree = async () => {
          const ttl = defaultTtlMs;
          const tree = await dispatchAndWait('get_tree', { max_depth: 8 }, ttl);
          pushStep({ injected: true, action: 'get_tree', ...tree });
          if (tree.ok) {
            lastObservation = {
              kind: 'tree',
              command_id: tree.command_id || '',
              action_id: tree.action_id || '',
              package: safeStr(resultData(tree.result)?.package),
              activity: safeStr(resultData(tree.result)?.activity),
              bounds: safeStr(resultData(tree.result)?.tree?.bounds),
            };
            return { ok: true, kind: 'tree', treeResult: tree };
          }
          // get_screen is a semantic snapshot (not pixels). Use max_items to cap payload size.
          const screen = await dispatchAndWait('get_screen', { max_items: 350 }, ttl);
          pushStep({ injected: true, action: 'get_screen', ...screen });
          lastObservation = {
            kind: 'screen',
            command_id: screen.command_id || '',
            action_id: screen.action_id || '',
            package: safeStr(resultData(screen.result)?.package),
            activity: safeStr(resultData(screen.result)?.activity),
          };
          return { ok: screen.ok, kind: 'screen', screenResult: screen };
        };

        const waitUi = async (ms: number) => {
          const ttl = Math.max(defaultTtlMs, ms + 2000);
          const res = await dispatchAndWait('wait_ui_change', { timeout_ms: ms }, ttl);
          pushStep({ injected: true, action: 'wait_ui_change', ...res });
          return res;
        };

        const getAppInfo = async () => {
          const ttl = defaultTtlMs;
          const res = await dispatchAndWait('get_app_info', {}, ttl);
          pushStep({ injected: true, action: 'get_app_info', ...res });
          return res;
        };

        const verifyLaunched = async () => {
          const info = await getAppInfo();
          if (!info.ok) return { ok: false, reason: 'get_app_info_failed', info };
          const pkg = extractForegroundPackage(info.result);
          if (pkgExpected) {
            if (pkg && pkg === pkgExpected) return { ok: true, package: pkg, info };
            return { ok: false, reason: 'package_mismatch', package: pkg, expected: pkgExpected, info };
          }
          if (launcherPkgBaseline && pkg && pkg !== launcherPkgBaseline) {
            return { ok: true, package: pkg, info };
          }
          // Fallback heuristic: compare with window_package if present.
          const winPkg = safeStr(resultData(info.result)?.window_package);
          if (launcherPkgBaseline && winPkg && winPkg !== launcherPkgBaseline) {
            return { ok: true, package: winPkg, info };
          }
          return { ok: false, reason: 'not_launched', package: pkg, info };
        };

        const tryClickAppNameOnce = async () => {
          await observePreferTree();
          if (Date.now() >= launchDeadlineAt) return { ok: false, error: 'timeout' };
          // Prefer exact match first.
          const exact = await dispatchAndWait('click_text', { text: appName, exact: true }, defaultTtlMs);
          attempts.clicks += 1;
          pushStep({ injected: false, action: 'click_text', params: { text: appName, exact: true }, ...exact });
          if (exact.ok) return { ok: true, used_exact: true };
          // Fallback to contains match.
          const contains = await dispatchAndWait('click_text', { text: appName, exact: false }, defaultTtlMs);
          attempts.clicks += 1;
          pushStep({ injected: false, action: 'click_text', params: { text: appName, exact: false }, ...contains });
          if (contains.ok) return { ok: true, used_exact: false };
          return { ok: false };
        };

        const bestEffortGoHome = async () => {
          const info0 = await getAppInfo();
          if (info0.ok) {
            const currentPkg = extractForegroundPackage(info0.result);
            if (looksLikeLauncherPackage(currentPkg)) {
              launcherPkgBaseline = currentPkg;
              return { ok: true, skipped: true, launcher_pkg: currentPkg };
            }
          }

          // No explicit HOME/BACK actions exist in the current primitive set.
          // Prefer a human-like gesture (swipe-up) to go home; only fallback to open_app if needed.
          const lastTree0 = stepsOut
            .slice()
            .reverse()
            .find((s: any) => s?.group === groupId && s?.action === 'get_tree' && s?.ok);
          const bounds0 = lastTree0 ? extractRootBoundsFromTree(lastTree0.result) : null;
          const w0 = bounds0?.w || 1080;
          const h0 = bounds0?.h || 2400;
          const x = Math.floor(w0 * 0.5);
          const y1 = Math.floor(h0 * 0.92);
          const y2 = Math.floor(h0 * 0.58);

          for (let i = 0; i < 3 && Date.now() < launchDeadlineAt; i += 1) {
            await observePreferTree();
            const swipeUp = await dispatchAndWait('swipe', { x1: x, y1, x2: x, y2, duration_ms: 280 }, defaultTtlMs);
            attempts.swipes += 1;
            pushStep({ injected: false, action: 'swipe', params: { x1: x, y1, x2: x, y2, duration_ms: 280 }, ...swipeUp });
            await waitUi(1200);
            const info = await getAppInfo();
            if (info.ok) {
              const pkg = extractForegroundPackage(info.result);
              if (looksLikeLauncherPackage(pkg)) {
                launcherPkgBaseline = pkg;
                return { ok: true, skipped: false, by: 'gesture_swipe' };
              }
            }
          }

          // Fallback: try launching the system launcher by common labels.
          const candidates = ['\u684c\u9762', 'Launcher', 'Home', '\u542f\u52a8\u5668'];
          for (const label of candidates) {
            if (Date.now() >= launchDeadlineAt) break;
            const res = await dispatchAndWait('open_app', { app_name: label }, defaultTtlMs);
            pushStep({ injected: true, action: 'open_app', params: { app_name: label }, ...res });
            if (res.ok) {
              await waitUi(1800);
              const info1 = await getAppInfo();
              if (info1.ok) {
                const launcherPkg = extractForegroundPackage(info1.result);
                launcherPkgBaseline = launcherPkg;
              }
              return { ok: true, skipped: false, by: 'fallback_open_launcher', label };
            }
          }
          return { ok: false, skipped: false };
        };

        if (!appName) {
          return {
            ok: false,
            final_status: 'FAILED',
            error: 'missing_app_name',
            used_strategy: usedStrategy,
            attempts,
            last_observation: lastObservation,
          };
        }

        // 0) Go to home (best-effort) so paging/clicking behaves like a human launcher workflow.
        await bestEffortGoHome();
        if (!launcherPkgBaseline) {
          const info = await getAppInfo();
          if (info.ok) launcherPkgBaseline = extractForegroundPackage(info.result);
        }

        // 1) Try click on the current home screen.
        if (Date.now() < launchDeadlineAt) {
          const clicked = await tryClickAppNameOnce();
          if (clicked.ok) {
            usedStrategy = 'home_click';
            await waitUi(2500);
            const verified = await verifyLaunched();
            if (verified.ok) {
              return {
                ok: true,
                final_status: 'SUCCESS',
                used_strategy: usedStrategy,
                attempts,
                package: verified.package || '',
                last_observation: lastObservation,
                duration_ms: Date.now() - launchStartedAt,
              };
            }
          }
        }

        // 2) Paging: swipe across home pages and retry click_text.
        usedStrategy = 'paging';
        for (let i = 0; i < maxPages && Date.now() < launchDeadlineAt; i += 1) {
          attempts.pages = i + 1;
          const clicked = await tryClickAppNameOnce();
          if (clicked.ok) {
            await waitUi(2500);
            const verified = await verifyLaunched();
            if (verified.ok) {
              return {
                ok: true,
                final_status: 'SUCCESS',
                used_strategy: usedStrategy,
                attempts,
                package: verified.package || '',
                last_observation: lastObservation,
                duration_ms: Date.now() - launchStartedAt,
              };
            }
          }

          // Prepare swipe coordinates from the latest tree bounds if available.
          const lastTree = stepsOut
            .slice()
            .reverse()
            .find((s: any) => s?.group === groupId && s?.action === 'get_tree' && s?.ok);
          const bounds = lastTree ? extractRootBoundsFromTree(lastTree.result) : null;
          const w = bounds?.w || 1080;
          const h = bounds?.h || 2400;
          // Avoid screen edges (gesture nav zones).
          const x1 = Math.floor(w * 0.82);
          const x2 = Math.floor(w * 0.18);
          const y = Math.floor(h * 0.52);
          await observePreferTree();
          const swipe = await dispatchAndWait('swipe', { x1, y1: y, x2, y2: y, duration_ms: 280 }, defaultTtlMs);
          attempts.swipes += 1;
          pushStep({ injected: false, action: 'swipe', params: { x1, y1: y, x2, y2: y, duration_ms: 280 }, ...swipe });
          await waitUi(900);
        }

        // 3) Optional: search strategy (best-effort). Only if explicitly requested.
        if (strategy === 'search_click' && Date.now() < launchDeadlineAt) {
          usedStrategy = 'search';
          // Pull down to open app drawer/search.
          const lastTree = stepsOut
            .slice()
            .reverse()
            .find((s: any) => s?.group === groupId && s?.action === 'get_tree' && s?.ok);
          const bounds = lastTree ? extractRootBoundsFromTree(lastTree.result) : null;
          const w = bounds?.w || 1080;
          const h = bounds?.h || 2400;
          const x = Math.floor(w * 0.5);
          const y1 = Math.floor(h * 0.35);
          const y2 = Math.floor(h * 0.75);
          await observePreferTree();
          const swipeDown = await dispatchAndWait('swipe', { x1: x, y1, x2: x, y2, duration_ms: 320 }, defaultTtlMs);
          attempts.swipes += 1;
          pushStep({ injected: false, action: 'swipe', params: { x1: x, y1, x2: x, y2, duration_ms: 320 }, ...swipeDown });
          await waitUi(1200);

          // Try to focus a search box.
          await observePreferTree();
          const searchFocus = await dispatchAndWait('click_text', { text: '\u641c\u7d22', exact: false }, defaultTtlMs);
          pushStep({ injected: false, action: 'click_text', params: { text: '\u641c\u7d22', exact: false }, ...searchFocus });
          await waitUi(800);

          await observePreferTree();
          const typed = await dispatchAndWait('type', { text: appName }, defaultTtlMs);
          pushStep({ injected: false, action: 'type', params: { text: appName }, ...typed });
          await waitUi(1200);

          const clicked = await tryClickAppNameOnce();
          if (clicked.ok) {
            await waitUi(2500);
            const verified = await verifyLaunched();
            if (verified.ok) {
              return {
                ok: true,
                final_status: 'SUCCESS',
                used_strategy: usedStrategy,
                attempts,
                package: verified.package || '',
                last_observation: lastObservation,
                duration_ms: Date.now() - launchStartedAt,
              };
            }
          }
        }

        // 5) Fallback: open_app only if package is provided.
        if (pkgExpected && Date.now() < launchDeadlineAt) {
          usedStrategy = 'fallback_open_app';
          attempts.used_open_app_fallback = true;
          const res = await dispatchAndWait('open_app', { package: pkgExpected }, defaultTtlMs);
          pushStep({ injected: false, action: 'open_app', params: { package: pkgExpected }, ...res });
          await waitUi(2500);
          const verified = await verifyLaunched();
          if (verified.ok) {
            return {
              ok: true,
              final_status: 'SUCCESS',
              used_strategy: usedStrategy,
              attempts,
              package: verified.package || '',
              last_observation: lastObservation,
              duration_ms: Date.now() - launchStartedAt,
            };
          }
        }

        return {
          ok: false,
          final_status: 'FAILED',
          used_strategy: usedStrategy,
          error: 'LAUNCH_DENIED',
          attempts,
          last_observation: lastObservation,
          duration_ms: Date.now() - launchStartedAt,
        };
      };

      const maybeObserveBefore = async () => {
        const ttl = defaultTtlMs;
        const tree = await dispatchAndWait('get_tree', { max_depth: 8 }, ttl);
        stepsOut.push({ injected: true, action: 'get_tree', ...tree });
        if (tree.ok) return;
        // get_screen is a semantic snapshot (not pixels). Use max_items to cap payload size.
        const screen = await dispatchAndWait('get_screen', { max_items: 350 }, ttl);
        stepsOut.push({ injected: true, action: 'get_screen', ...screen });
      };

      const maybeWaitAfter = async (waitTimeoutMs: number) => {
        const ttl = Math.max(defaultTtlMs, waitTimeoutMs + 2000);
        const res = await dispatchAndWait('wait_ui_change', { timeout_ms: waitTimeoutMs }, ttl);
        stepsOut.push({ injected: true, action: 'wait_ui_change', ...res });
      };

      for (const step of plan) {
        if (Date.now() >= deadlineAt) {
          stepsOut.push({ ok: false, error: 'overall_timeout' });
          break;
        }
        const action = normalizeAction(step.action);
        if (!supportedActions.includes(action as any)) {
          stepsOut.push({ ok: false, action, error: 'ACTION_NOT_SUPPORTED' });
          continue;
        }

        // High-level action: prefer UI click launch and only fallback to open_app.
        if (action === 'launch_app') {
          const groupId = uuid();
          const summary = await runLaunchApp(step.params, groupId);
          stepsOut.push({ injected: false, action: 'launch_app', params: step.params, group: groupId, ...summary });
          continue;
        }

        // Strategy change: if caller passes app_name for open_app, treat it as a launch intent.
        // Direct open_app remains available when only package is provided, or when explicitly forced.
        if (
          action === 'open_app' &&
          isObject(step.params) &&
          !Boolean((step.params as any).force_open_app || (step.params as any).direct) &&
          safeStr((step.params as any).app_name || (step.params as any).appName)
        ) {
          const groupId = uuid();
          const summary = await runLaunchApp(step.params, groupId);
          stepsOut.push({ injected: false, action: 'launch_app', params: step.params, group: groupId, ...summary });
          continue;
        }

        if (observeBeforeActions.has(action)) {
          await maybeObserveBefore();
        }

        const ttlMs = normalizeInt(step.ttl_ms, defaultTtlMs, { min: 1000, max: 300000 });
        const execRes = await dispatchAndWait(action, step.params, ttlMs, step.action_id);
        stepsOut.push({ injected: false, action, ...execRes, params: step.params });

        if (waitAfterActions.has(action)) {
          const waitTimeoutMs = normalizeInt(step.wait_timeout_ms, defaultWaitTimeoutMs, { min: 500, max: 60000 });
          await maybeWaitAfter(waitTimeoutMs);
        }
      }

      const ok = stepsOut.every((s) => s && s.ok !== false);
      const durationMs = Date.now() - startedAt;
      options.logger?.info?.(
        `[XiotBox] xiotbox_control session=${sessionId} target=${targetDeviceId} steps=${stepsOut.length} ok=${ok} durationMs=${durationMs}`,
      );

      return jsonResult({
        ok,
        session_id: sessionId,
        device_id: targetDeviceId,
        duration_ms: durationMs,
        steps: stepsOut,
      });
    },
  };
}
