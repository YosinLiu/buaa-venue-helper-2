const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Evaluate only pure selectors and the actual pre-submit selection branch.
// No project imports, network, auth reads, captcha work, or order submission run.
// The main() argument guard is checked separately in an isolated child VM below.
const sourcePath = process.argv[2] || path.resolve(__dirname, '../test-submit.js');
const source = fs.readFileSync(sourcePath, 'utf8');
function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing function: ${name}`);
  const rest = source.slice(start);
  const next = rest.slice(1).search(/\n(?:async )?function /);
  assert.ok(next >= 0, `missing next function after ${name}`);
  return rest.slice(0, next + 1);
}
const names = [
  'normalizeText', 'parseArgs', 'normalizeTimeRange', 'itemText', 'timeLabel',
  'courtLabel', 'flattenSpaces', 'findTime', 'findAvailableRetryItems',
  'selectCompleteRetryCourt', 'selectPreferredConsecutiveTwo',
  'selectBestRetryItems', 'allTargetSlotsSoldOut',
];
const branchStart = source.indexOf('        const allAvailable = findAvailableRetryItems(');
const branchEnd = source.indexOf('        log(`发现可用 ', branchStart);
assert.ok(branchStart >= 0 && branchEnd > branchStart);
const times = ['18:00-19:00', '19:00-20:00', '20:00-21:00', '21:00-22:00'];
const targetDate = '2026-09-28';
const context = vm.createContext({});
vm.runInContext(`${names.map(extractFunction).join('\n')}
function evaluate(dayInfo, argv) {
  const args = parseArgs(argv);
  const retrySlotPrefs = [{ court: '', times: ${JSON.stringify(times)} }];
  const retryTargetDate = ${JSON.stringify(targetDate)};
  const logs = [];
  const log = (message) => logs.push(message);
  let selected = [];
  for (let turn = 0; turn < 1; turn += 1) {
    ${source.slice(branchStart, branchEnd)}
    selected = availableItems;
  }
  return { selected, logs };
}`, context);

function fixture(available = [], defaultStatus = 0) {
  const spaces = [1, 2, 3].map((id) => {
    const space = { id, spaceName: `${id}号` };
    times.forEach((time, index) => {
      space[String(index + 100)] = {
        reservationStatus: available.some(([court, slot]) => court === id && slot === index)
          ? 1 : defaultStatus,
        orderFee: 30,
        spaceName: space.spaceName,
      };
    });
    return space;
  });
  return {
    spaceTimeInfo: times.map((time, index) => ({ id: index + 100, time })),
    reservationDateSpaceInfo: { [targetDate]: spaces },
  };
}

const strict = ['--retry-require-consecutive-two'];
function evaluate(dayInfo, flags = strict) {
  context.dayInfo = dayInfo;
  context.argv = flags;
  return JSON.parse(vm.runInContext('JSON.stringify(evaluate(dayInfo, argv))', context));
}
function chosen(result) {
  return result.selected.map(({ spaceId, timeRange }) => [spaceId, timeRange]);
}

const fullWindow = fixture([[1, 0], [1, 1], [1, 2], [1, 3]]);
assert.deepEqual(chosen(evaluate(fullWindow)), [[1, times[0]], [1, times[1]]]);
assert.equal(evaluate(fixture([[1, 0]])).selected.length, 0);
assert.equal(evaluate(fixture([[1, 0], [1, 2]])).selected.length, 0);
assert.equal(evaluate(fixture([[1, 0], [2, 1]])).selected.length, 0);
assert.deepEqual(chosen(evaluate(fixture([[1, 0], [2, 2], [2, 3]]))),
  [[2, times[2]], [2, times[3]]]);

// Strict mode takes precedence over all existing fallback/size options.
const conflictingFlags = [...strict, '--retry-require-all', '--retry-fallback-single',
  '--retry-prefer-consecutive-two', '--retry-max-slots', '4'];
assert.equal(evaluate(fullWindow, conflictingFlags).selected.length, 2);
assert.equal(evaluate(fixture([[1, 0]]), conflictingFlags).selected.length, 0);
assert.equal(evaluate(fullWindow, [...strict, '--retry-max-slots', '1']).selected.length, 2);

const waiting = evaluate(fixture([[1, 0]]));
assert.ok(waiting.logs.some((line) => line.includes('暂无任意同场连续两小时')));
const soldOut = evaluate(fixture([], 4));
assert.equal(soldOut.selected.length, 0);
assert.ok(soldOut.logs.some((line) => line.includes('停止捡漏')));
assert.ok(!soldOut.logs.some((line) => line.includes('继续等待')));

// Existing preference and require-all behavior remains available unchanged.
const legacySingle = evaluate(fixture([[1, 0]]), ['--retry-prefer-consecutive-two']);
assert.deepEqual(chosen(legacySingle), [[1, times[0]]]);
assert.ok(legacySingle.logs.some((line) => line.includes('降级为单时段')));
assert.equal(evaluate(fullWindow, ['--retry-require-all']).selected.length, 4);
assert.equal(evaluate(fixture([[1, 0]]), ['--retry-require-all', '--retry-fallback-single']).selected.length, 1);

// Default retry selection must never book multiple courts for the same hour.
// Cover both the <= maxSlots shortcut and the > maxSlots fill-up branch.
const defaultFlags = ['--retry-max-slots', '2'];
assert.deepEqual(chosen(evaluate(fixture([[1, 0], [2, 0]]), defaultFlags)),
  [[1, times[0]]]);
assert.deepEqual(chosen(evaluate(
  fixture([[1, 0], [1, 2], [2, 0], [2, 2], [3, 0]]), defaultFlags)),
  [[1, times[0]], [1, times[2]]]);
assert.deepEqual(chosen(evaluate(fixture([[1, 0], [2, 2], [2, 3]]), defaultFlags)),
  [[2, times[2]], [2, times[3]]]);
assert.deepEqual(chosen(evaluate(fixture([[1, 0], [2, 2]]), defaultFlags)),
  [[1, times[0]], [2, times[2]]]);
console.log('PASS: default retry selection deduplicates hours, respects maxSlots, and preserves same-court consecutive priority.');

// The strict selector cannot mistake non-hour durations for a complete 2h pair.
context.malformed = [
  { spaceId: 1, timeRange: '18:00-20:00' },
  { spaceId: 1, timeRange: '19:00-20:00' },
];
assert.equal(vm.runInContext('selectPreferredConsecutiveTwo(malformed, false).length', context), 0);
assert.equal(vm.runInContext('parseArgs([]).retryRequireConsecutiveTwo', context), false);
assert.equal(vm.runInContext('parseArgs(["--retry-require-consecutive-two"]).retryRequireConsecutiveTwo', context), true);

console.log('PASS: strict 2h window selection, no single/split/nonconsecutive/4h orders, later-court pair, wait/sold-out branches, CLI precedence, legacy fallback, and duration guard. No network or orders.');

// Exercise the real main() guard in a subprocess with no project imports.
// The VM exposes neither network APIs nor the helpers that submit orders; its
// readConfig stub fails immediately if argument validation ever reaches it.
const mainStart = source.indexOf('async function main() {');
const mainEnd = source.indexOf('\nmain().catch(', mainStart);
assert.ok(mainStart >= 0 && mainEnd > mainStart, 'missing main() boundary');
const isolatedGuardSource = `${extractFunction('normalizeText')}
${extractFunction('parseArgs')}
${source.slice(mainStart, mainEnd)}
main()`;
const guardChild = spawnSync(process.execPath, ['-'], {
  input: `
    const vm = require('node:vm');
    let configReads = 0;
    const context = vm.createContext({
      process: { argv: ['node', 'test-submit.js', '--account', 'offline-test',
        '--timing-test', '--execute'] },
      readConfig() {
        configReads += 1;
        throw new Error('UNEXPECTED_CONFIG_READ');
      },
    });
    Promise.resolve(vm.runInContext(${JSON.stringify(isolatedGuardSource)}, context,
      { timeout: 1000 })).then(() => {
        console.error('UNEXPECTED_MAIN_SUCCESS');
        process.exitCode = 2;
      }, (error) => {
        console.error(error.message);
        console.log('configReads=' + configReads);
        process.exitCode = 1;
      });
  `,
  encoding: 'utf8',
  timeout: 5000,
});
assert.ifError(guardChild.error);
assert.equal(guardChild.status, 1, guardChild.stderr);
assert.equal(guardChild.signal, null);
assert.equal(guardChild.stdout.trim(), 'configReads=0');
assert.equal(guardChild.stderr.trim(),
  '--timing-test 与 --execute 不能同时使用；计时测试保证不会提交订单。');
console.log('PASS: --timing-test + --execute is rejected before readConfig(), in an isolated subprocess without network APIs.');
