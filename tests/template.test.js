const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntime } = require('./helpers/miniprogram');
const { shiftDays, minutesOf } = require('../miniprogram/utils/calendar');
const { progress } = require('../miniprogram/utils/progress');

test('完整七日模板时间有效、顺序动作不重叠、ID 唯一，固定块不计完成率', () => {
  const { getBlocksForDate } = createRuntime().load('miniprogram/data/template.ts');
  const actionCounts = [7, 2, 7, 2, 7, 2, 7];
  for (let day = 0; day < 7; day++) {
    const blocks = getBlocksForDate(shiftDays('2026-10-26', day));
    const ids = new Set();
    let end = 0;
    for (const block of blocks) {
      assert.ok(minutesOf(block.start) >= end);
      end = minutesOf(block.end);
      assert.ok(end > minutesOf(block.start));
      let previous = minutesOf(block.start);
      for (const action of block.actions) {
        assert.equal(ids.has(action.id), false);
        ids.add(action.id);
        assert.ok(minutesOf(action.start) >= minutesOf(block.start));
        assert.ok(minutesOf(action.end) <= end);
        assert.ok(minutesOf(action.end) > minutesOf(action.start));
        if (block.kind === 'sequence') {
          assert.ok(minutesOf(action.start) >= previous);
          previous = minutesOf(action.end);
        }
      }
    }
    assert.equal(blocks.find(block => block.id === 'training').actions.length, actionCounts[day]);
    assert.equal(progress(blocks, {}).total, actionCounts[day] + 2);
  }
});

test('模板统一拒绝不合法日历日期，按本地星期提供训练', () => {
  const { getBlocksForDate, getWeekdayName } = createRuntime().load('miniprogram/data/template.ts');
  for (const date of ['invalid', '2026-02-30', '2026-13-01', '2026-1-01']) {
    assert.throws(() => getBlocksForDate(date), /Invalid/);
    assert.throws(() => getWeekdayName(date), /Invalid/);
  }
  assert.equal(getWeekdayName('2026-11-01'), '周日');
  assert.equal(getBlocksForDate('2026-11-01').find(block => block.id === 'training').title, '上肢与核心');
});
