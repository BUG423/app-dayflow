const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntime, clone } = require('./helpers/miniprogram');

test('旧泳日无加班计划可经页面确认更新：先游泳再返回加班，取消零写且执行历史保留', () => {
  const runtime = createRuntime(new Date(2026, 10, 1, 12, 4));
  const plans = runtime.load('miniprogram/services/plans');
  const old = JSON.parse(plans.exportDefaultTemplate(3));
  old.version = 9;
  old.name = '已保存的旧作息';
  for (const rule of old.schedules) {
    const morning = rule.blocks.find(block => block.id === 'work-morning');
    morning.start = '08:00';
    morning.end = '12:00';
  }
  runtime.storage.set('dayflow.plans.v1', old);
  const records = { schemaVersion: 2, byDate: {
    '2026-11-01': { 'music-guitar': { date: '2026-11-01', targetId: 'music-guitar', taskId: 'music-guitar', status: 'done', updatedAt: 1, events: [] } }
  } };
  runtime.storage.set('dayflow.records.v2', records);
  const executed = clone(plans.lockDailyInstance('2026-11-01'));
  const page = runtime.page('plans');
  page.onShow();
  const before = clone([...runtime.storage]);
  page.onPreviewEveningUpdate();
  assert.equal(page.data.importPreview.ok, true);
  assert.equal(page.data.exampleRows.length, 7);
  assert.deepEqual(clone([...runtime.storage]), before);
  const tuesday = page.data.exampleRows.find(row => row.title === '周二晚间作息');
  const monday = page.data.exampleRows.find(row => row.title === '周一晚间作息');
  assert.ok(tuesday && monday);
  assert.deepEqual(clone(tuesday.blocks.filter(block => block.time >= '17:00' && block.time < '22:00').map(block => block.time)),
    ['17:00–17:30', '17:30–19:00', '19:00–19:30', '19:30–21:30', '21:30–22:00']);
  assert.match(tuesday.blocks.find(block => block.time === '19:00–19:30').title, /返回.*工作/);
  assert.equal(tuesday.blocks.find(block => block.time === '19:30–21:30').title, '加班');
  assert.deepEqual(clone(monday.blocks.filter(block => block.time >= '17:00' && block.time < '22:00').map(block => block.time)),
    ['17:00–20:00', '20:00–20:30', '20:30–22:00']);

  page.onConfirmEveningUpdate();
  const cancelled = runtime.calls.modals.at(-1);
  assert.match(cancelled.content, /周二、四、六先游泳，返回工作地点后加班/);
  assert.match(cancelled.content, /周一、三、五、日先加班，再回家锻炼/);
  assert.doesNotMatch(cancelled.content, /不加班/);
  cancelled.success({ confirm: false });
  assert.deepEqual(clone([...runtime.storage]), before);
  page.onConfirmEveningUpdate();
  runtime.calls.modals.at(-1).success({ confirm: true });
  assert.equal(plans.getTemplate().version, 10);
  assert.equal(page.data.eveningPreview, false);
  assert.match(page.data.saveNotice, /今天已有执行记录，继续保留原安排/);
  assert.deepEqual(clone(plans.getDailyInstance('2026-11-01')), executed);
  assert.deepEqual(runtime.storage.get('dayflow.records.v2'), records);
  const future = plans.getDayBlocks('2026-11-03');
  assert.deepEqual(clone(future.filter(block => block.category === '加班').map(block => [block.start, block.end])), [['19:30', '21:30']]);
  assert.deepEqual(clone(future.filter(block => block.id === 'work-morning').map(block => [block.start, block.end])), [['08:00', '12:00']]);
});
