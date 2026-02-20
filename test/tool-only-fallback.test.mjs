/**
 * Regression test: consecutive tool-only + NO_REPLY must not loop forever.
 *
 * Tests the exported helper functions and counter logic extracted from channel.ts.
 * Run with: node test/tool-only-fallback.test.mjs
 */

// ── Inline the pure functions under test (no runtime/WSS deps) ──

const MAX_CONSECUTIVE_TOOL_ONLY = 3;
const TOOL_ONLY_COUNTER_TTL_MS = 10 * 60 * 1000;

const toolOnlyCounters = new Map();

function toolOnlyCounterKey(deviceId, senderId) {
  return `${deviceId}:${senderId}`;
}

function incrementToolOnlyCounter(key) {
  const fingerprint = arguments.length > 1 ? arguments[1] : 'default';
  const now = Date.now();
  const existing = toolOnlyCounters.get(key);
  if (existing && now - existing.updatedAt < TOOL_ONLY_COUNTER_TTL_MS) {
    if (existing.fingerprint === fingerprint) {
      existing.count += 1;
    } else {
      existing.count = 1;
      existing.fingerprint = fingerprint;
    }
    existing.updatedAt = now;
    return existing.count;
  }
  toolOnlyCounters.set(key, { count: 1, updatedAt: now, fingerprint });
  return 1;
}

function resetToolOnlyCounter(key) {
  toolOnlyCounters.delete(key);
}

function shouldSkipReply(text) {
  const trimmed = (text || '').trim();
  if (!trimmed) return true;
  if (trimmed === 'NO_REPLY') return true;
  if (trimmed.endsWith('NO_REPLY')) return true;
  return false;
}

const HARD_EXIT_PATTERNS = [
  /^\/stop\b/i,
  /^\/exit\b/i,
  /^\/quit\b/i,
  /^\/chat\b/i,
  /^\/text\b/i,
  /退出控制/,
  /结束控制/,
  /停止操控/,
  /结束操控/,
  /停止控制/,
  /退出操控/,
  /退出操作/,
  /结束操作/,
  /切回聊天/,
  /恢复聊天/,
  /只聊天/,
  /仅聊天/,
  /stop\s*control/i,
  /exit\s*control/i,
  /back\s*to\s*chat/i,
];

function isHardExitCommand(text) {
  const trimmed = (text || '').trim();
  return HARD_EXIT_PATTERNS.some((re) => re.test(trimmed));
}

function buildToolSummary(toolNamesSeen) {
  const uniq = Array.from(new Set(toolNamesSeen.map(s => s.trim()).filter(Boolean)));
  if (uniq.length) {
    return `（已执行: ${uniq.join(', ')}）`;
  }
  return '（操作已完成）';
}

function isLikelyNonSubstantiveAck(text) {
  const normalized = (text || '').trim();
  if (!normalized) return true;
  const compact = normalized
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[。.!！?？,，;；:]/g, '');
  const exactAcks = new Set([
    '操作已完成',
    '操作完成',
    '已完成',
    '完成',
    'done',
    'ok',
    'okay',
    'success',
    'completed',
    '任务已完成',
    '处理完成',
  ]);
  if (exactAcks.has(compact)) return true;
  if (compact.length <= 12 && (compact.includes('操作已完成') || compact.includes('任务已完成'))) {
    return true;
  }
  return false;
}

function shouldCountFallback(needsFallback, sawInProgressSignal) {
  return Boolean(needsFallback && !sawInProgressSignal);
}

function compactProgressText(value, maxLen = 80) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > maxLen ? `${text.slice(0, Math.max(0, maxLen - 1))}…` : text;
}

function normalizeProgressPercent(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value >= 0 && value <= 1) return Math.round(value * 100);
    if (value >= 0 && value <= 100) return Math.round(value);
    return undefined;
  }
  if (typeof value === 'string') {
    const compact = value.trim();
    if (!compact) return undefined;
    const percentMatch = compact.match(/(-?\d+(?:\.\d+)?)\s*%/);
    if (percentMatch) {
      const parsed = Number(percentMatch[1]);
      if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 100) {
        return Math.round(parsed);
      }
      return undefined;
    }
    const parsed = Number(compact);
    if (Number.isFinite(parsed)) {
      if (parsed >= 0 && parsed <= 1 && compact.includes('.')) return Math.round(parsed * 100);
      if (parsed >= 0 && parsed <= 100) return Math.round(parsed);
    }
    return undefined;
  }
  if (value && typeof value === 'object') {
    const current = Number(value.current ?? value.done ?? value.completed ?? value.step ?? value.processed);
    const total = Number(value.total ?? value.max ?? value.steps ?? value.count);
    if (Number.isFinite(current) && Number.isFinite(total) && total > 0 && current >= 0) {
      return Math.max(0, Math.min(100, Math.round((current / total) * 100)));
    }
  }
  return undefined;
}

function buildProgressRunningText(params) {
  const uniqTools = Array.from(new Set((params.toolNames || []).map((name) => compactProgressText(name, 48)).filter(Boolean)));
  const snapshot = params.snapshot || null;
  const segments = [];
  if (snapshot?.stage) segments.push(snapshot.stage);
  if (snapshot?.status) segments.push(snapshot.status);
  if (snapshot?.progressPercent != null) segments.push(`${snapshot.progressPercent}%`);
  if (!segments.length && snapshot?.detail) segments.push(snapshot.detail);
  if (!segments.length && uniqTools.length) segments.push(uniqTools.join(', '));
  const fallbackText = compactProgressText(params.fallbackText, 80);
  if (!segments.length && fallbackText && /progress|running|执行中|处理中/i.test(fallbackText)) {
    segments.push(fallbackText);
  }
  if (!segments.length) return '正在执行，请稍候…';
  return `正在执行：${segments.join(' · ')}`;
}

// ── Test harness ──
let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL: ${msg}`);
  }
}

function test(name, fn) {
  console.log(`\n▸ ${name}`);
  toolOnlyCounters.clear();
  fn();
}

// ── Tests ──

test('Counter increments and resets correctly', () => {
  const key = toolOnlyCounterKey('dev1', 'user1');
  assert(incrementToolOnlyCounter(key) === 1, 'first increment should be 1');
  assert(incrementToolOnlyCounter(key) === 2, 'second increment should be 2');
  assert(incrementToolOnlyCounter(key) === 3, 'third increment should be 3');
  resetToolOnlyCounter(key);
  assert(incrementToolOnlyCounter(key) === 1, 'after reset should be 1');
});

test('Counter keys are scoped to device+sender', () => {
  const k1 = toolOnlyCounterKey('dev1', 'userA');
  const k2 = toolOnlyCounterKey('dev1', 'userB');
  incrementToolOnlyCounter(k1);
  incrementToolOnlyCounter(k1);
  assert(incrementToolOnlyCounter(k1) === 3, 'k1 should be 3');
  assert(incrementToolOnlyCounter(k2) === 1, 'k2 should be 1 (independent)');
});

test('Consecutive tool-only >= 3 triggers auto-reset message', () => {
  const key = toolOnlyCounterKey('dev1', 'user1');
  const results = [];
  for (let i = 0; i < 5; i++) {
    const count = incrementToolOnlyCounter(key, 'tool_only|xiotbox_control');
    if (count >= MAX_CONSECUTIVE_TOOL_ONLY) {
      resetToolOnlyCounter(key);
      results.push('auto_reset');
    } else {
      results.push('tick');
    }
  }
  // Expected: tick, tick, auto_reset, tick, tick
  assert(results[0] === 'tick', 'msg 1 should tick');
  assert(results[1] === 'tick', 'msg 2 should tick');
  assert(results[2] === 'auto_reset', 'msg 3 should auto_reset');
  assert(results[3] === 'tick', 'msg 4 should tick (counter was reset)');
  assert(results[4] === 'tick', 'msg 5 should tick');
});

test('Normal text reply resets counter', () => {
  const key = toolOnlyCounterKey('dev1', 'user1');
  incrementToolOnlyCounter(key);
  incrementToolOnlyCounter(key);
  // Simulate normal text reply
  resetToolOnlyCounter(key);
  assert(incrementToolOnlyCounter(key) === 1, 'after normal reply reset, should be 1');
});

test('shouldSkipReply detects NO_REPLY variants', () => {
  assert(shouldSkipReply('') === true, 'empty string');
  assert(shouldSkipReply('NO_REPLY') === true, 'exact NO_REPLY');
  assert(shouldSkipReply('some text NO_REPLY') === true, 'trailing NO_REPLY');
  assert(shouldSkipReply('Hello world') === false, 'normal text');
  assert(shouldSkipReply('（已执行: xiotbox_control）') === false, 'tool summary');
});

test('Hard exit commands are detected', () => {
  assert(isHardExitCommand('/stop') === true, '/stop');
  assert(isHardExitCommand('/exit') === true, '/exit');
  assert(isHardExitCommand('/Stop now') === true, '/Stop now');
  assert(isHardExitCommand('退出控制') === true, '退出控制');
  assert(isHardExitCommand('停止操控') === true, '停止操控');
  assert(isHardExitCommand('停止控制') === true, '停止控制');
  assert(isHardExitCommand('退出操控') === true, '退出操控');
  assert(isHardExitCommand('结束控制') === true, '结束控制');
  assert(isHardExitCommand('切回聊天') === true, '切回聊天');
  assert(isHardExitCommand('/chat') === true, '/chat');
  assert(isHardExitCommand('back to chat') === true, 'back to chat');
  assert(isHardExitCommand('帮我打开微信') === false, 'normal message');
  assert(isHardExitCommand('') === false, 'empty');
});

test('Hard exit resets counter', () => {
  const key = toolOnlyCounterKey('dev1', 'user1');
  incrementToolOnlyCounter(key);
  incrementToolOnlyCounter(key);
  // Simulate hard exit
  if (isHardExitCommand('/stop')) {
    resetToolOnlyCounter(key);
  }
  assert(incrementToolOnlyCounter(key) === 1, 'after /stop, counter should be 1');
});

test('buildToolSummary produces dynamic text, not fixed placeholder', () => {
  const s1 = buildToolSummary(['xiotbox_control']);
  assert(s1 === '（已执行: xiotbox_control）', 'single tool');
  const s2 = buildToolSummary(['xiotbox_control', 'xiotbox_control', 'bash']);
  assert(s2 === '（已执行: xiotbox_control, bash）', 'deduped tools');
  const s3 = buildToolSummary([]);
  assert(s3 === '（操作已完成）', 'no tools');
  // Must NOT be the old fixed placeholder
  assert(!s1.includes('无额外文字回复'), 'must not contain old placeholder');
});

test('Ack-only reply is treated as non-substantive', () => {
  assert(isLikelyNonSubstantiveAck('（操作已完成）') === true, 'ack with brackets');
  assert(isLikelyNonSubstantiveAck('任务已完成') === true, 'task completed ack');
  assert(isLikelyNonSubstantiveAck('好的，我已经完成并给你结论：xxx') === false, 'substantive text');
});

test('Fallback fingerprint change resets counter instead of accumulating', () => {
  const key = toolOnlyCounterKey('dev1', 'user1');
  assert(incrementToolOnlyCounter(key, 'ack_only|step1') === 1, 'step1 first');
  assert(incrementToolOnlyCounter(key, 'ack_only|step1') === 2, 'step1 second');
  assert(incrementToolOnlyCounter(key, 'ack_only|step2') === 1, 'step2 should reset');
  assert(incrementToolOnlyCounter(key, 'ack_only|step2') === 2, 'step2 second');
});

test('In-progress signal suppresses fallback counter', () => {
  const key = toolOnlyCounterKey('dev1', 'user1');
  const needsFallback = true;
  const sawInProgressSignal = true;
  assert(shouldCountFallback(needsFallback, sawInProgressSignal) === false, 'counter should be suppressed');
  if (shouldCountFallback(needsFallback, sawInProgressSignal)) {
    incrementToolOnlyCounter(key, 'tool_only|in_progress');
  }
  assert(toolOnlyCounters.has(key) === false, 'counter map should stay empty when suppressed');
});

test('Full flow: 3 consecutive tool-only then auto-reset, then normal resumes', () => {
  const key = toolOnlyCounterKey('dev1', 'user1');
  const outputs = [];

  // Simulate 4 messages, first 3 are tool-only, 4th is normal
  for (let i = 0; i < 4; i++) {
    const isToolOnly = i < 3;
    if (isToolOnly) {
      const count = incrementToolOnlyCounter(key);
      if (count >= MAX_CONSECUTIVE_TOOL_ONLY) {
        resetToolOnlyCounter(key);
        outputs.push('auto_reset_with_warning');
      } else {
        outputs.push('tool_summary');
      }
    } else {
      // Normal text reply
      resetToolOnlyCounter(key);
      outputs.push('normal_text');
    }
  }

  assert(outputs[0] === 'tool_summary', 'msg 1: tool summary');
  assert(outputs[1] === 'tool_summary', 'msg 2: tool summary');
  assert(outputs[2] === 'auto_reset_with_warning', 'msg 3: auto reset with warning');
  assert(outputs[3] === 'normal_text', 'msg 4: normal text');
});

test('normalizeProgressPercent handles numeric/string/object values', () => {
  assert(normalizeProgressPercent(0.32) === 32, 'ratio number');
  assert(normalizeProgressPercent(88) === 88, 'integer percent');
  assert(normalizeProgressPercent('56%') === 56, 'percent string');
  assert(normalizeProgressPercent({ current: 2, total: 5 }) === 40, 'progress object');
  assert(normalizeProgressPercent('abc') === undefined, 'invalid string');
});

test('buildProgressRunningText prefers stage/status/percent', () => {
  const text = buildProgressRunningText({
    toolNames: ['xiotbox_control'],
    snapshot: { stage: '拉起本地Core', status: 'running', progressPercent: 35 },
  });
  assert(
    text === '正在执行：拉起本地Core · running · 35%',
    'stage+status+percent',
  );
});

test('buildProgressRunningText falls back to tool names', () => {
  const text = buildProgressRunningText({
    toolNames: ['xiotbox_control', 'xiotbox_control', 'bash'],
    snapshot: null,
  });
  assert(text === '正在执行：xiotbox_control, bash', 'tool-name fallback');
});

// ── Summary ──
console.log(`\n${'='.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
} else {
  console.log('All tests passed.');
}
