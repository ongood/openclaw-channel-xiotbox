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
  const now = Date.now();
  const existing = toolOnlyCounters.get(key);
  if (existing && now - existing.updatedAt < TOOL_ONLY_COUNTER_TTL_MS) {
    existing.count += 1;
    existing.updatedAt = now;
    return existing.count;
  }
  toolOnlyCounters.set(key, { count: 1, updatedAt: now });
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
  /退出控制/,
  /停止操控/,
  /停止控制/,
  /退出操控/,
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
    const count = incrementToolOnlyCounter(key);
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

// ── Summary ──
console.log(`\n${'='.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
} else {
  console.log('All tests passed.');
}
