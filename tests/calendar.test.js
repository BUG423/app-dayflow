const test = require('node:test');
const assert = require('node:assert/strict');
const {
  localDateKey, parseLocalDate, shiftDays, mondayOf, weekDays,
  minutesOf, timeState
} = require('../miniprogram/utils/calendar');

test('本地日期键不依赖 UTC', () => {
  assert.equal(localDateKey(new Date(2026, 9, 31, 23, 30)), '2026-10-31');
  assert.equal(localDateKey(parseLocalDate('2026-01-01')), '2026-01-01');
});

test('周日所在周从上周一开始', () => {
  assert.equal(mondayOf('2026-11-01'), '2026-10-26');
  const days = weekDays('2026-11-01');
  assert.equal(days.length, 7);
  assert.equal(days[0].date, '2026-10-26');
  assert.equal(days[6].date, '2026-11-01');
});

test('跨年日期前后移动', () => {
  assert.equal(shiftDays('2026-12-31', 1), '2027-01-01');
  assert.equal(shiftDays('2026-01-01', -1), '2025-12-31');
});

test('无效日期和时刻被拒绝', () => {
  assert.throws(() => parseLocalDate('2026-02-30'));
  assert.throws(() => minutesOf('24:00'));
  assert.throws(() => minutesOf('12:60'));
});

test('时间块采用左闭右开', () => {
  assert.equal(timeState('12:05', '12:35', minutesOf('12:04')), 'upcoming');
  assert.equal(timeState('12:05', '12:35', minutesOf('12:05')), 'current');
  assert.equal(timeState('12:05', '12:35', minutesOf('12:34')), 'current');
  assert.equal(timeState('12:05', '12:35', minutesOf('12:35')), 'past');
});
