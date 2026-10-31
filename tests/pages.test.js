const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntime } = require('./helpers/miniprogram');

const event = id => ({ currentTarget: { dataset: { id } } });

test('今日页面停留跨起止时间自动刷新，单分钟不重复渲染，隐藏时停止时钟', () => {
  const runtime = createRuntime();
  const page = runtime.page('today');
  page.onLoad();
  page.onShow();
  assert.equal(page.data.heroCaption, '接下来');
  assert.equal(page.data.heroTitle, '吉他与声乐');
  const updates = page.updates;
  runtime.tick();
  assert.equal(page.updates, updates);
  runtime.setNow(new Date(2026, 9, 31, 12, 5));
  runtime.tick();
  assert.equal(page.data.heroCaption, '此刻正在进行');
  assert.equal(page.data.blocks.find(block => block.id === 'music').stateText, '当前时段');
  runtime.setNow(new Date(2026, 9, 31, 12, 35));
  runtime.tick();
  assert.equal(page.data.heroCaption, '接下来');
  assert.equal(page.data.heroTitle, '工作时间');
  page.onShow();
  assert.equal(runtime.timers.size, 1);
  page.onHide();
  assert.equal(runtime.timers.size, 0);
  page.onShow();
  page.onUnload();
  assert.equal(runtime.timers.size, 0);
});

test('今日页面前台和后台跨午夜跟随今天，手选历史日期保持不变', () => {
  for (const background of [false, true]) {
    const runtime = createRuntime(new Date(2026, 9, 31, 23, 59));
    const page = runtime.page('today');
    page.onLoad();
    page.onShow();
    if (background) page.onHide();
    runtime.setNow(new Date(2026, 10, 1, 0, 0));
    if (background) page.onShow(); else runtime.tick();
    assert.equal(page.data.selectedDate, '2026-11-01');
    assert.equal(page.data.week[6].selected, true);
    page.choose('2026-10-29');
    runtime.setNow(new Date(2026, 10, 2, 0, 0));
    runtime.tick();
    assert.equal(page.data.selectedDate, '2026-10-29');
    assert.equal(page.data.isToday, false);
  }
});

test('并行任务独立勾选、跨日期隔离，训练返回刷新并在页面重建后保留', () => {
  const runtime = createRuntime();
  const page = runtime.page('today');
  page.onLoad();
  page.onShow();
  page.onToggleBlock(event('music'));
  assert.equal(page.data.blocks.find(block => block.id === 'music').expanded, true);
  page.onToggleTask(event('music-guitar'));
  const music = page.data.blocks.find(block => block.id === 'music');
  assert.equal(music.actions[0].done, true);
  assert.equal(music.actions[1].done, false);
  assert.equal(music.doneCount, 1);
  page.choose('2026-10-30');
  assert.equal(page.data.blocks.find(block => block.id === 'music').doneCount, 0);
  page.onToday();
  assert.equal(page.data.blocks.find(block => block.id === 'music').doneCount, 1);
  page.onOpenTraining(event('training'));
  assert.match(runtime.calls.navigations[0].url, /date=2026-10-31&blockId=training/);
  const training = runtime.page('training');
  training.onLoad({ date: '2026-10-31', blockId: 'training' });
  training.onToggleAction(event(training.data.actions[0].id));
  page.onHide();
  page.onShow();
  assert.equal(page.data.blocks.find(block => block.id === 'training').doneCount, 1);
  const restarted = createRuntime();
  for (const [key, value] of runtime.storage) restarted.storage.set(key, value);
  const reopened = restarted.page('today');
  reopened.onLoad();
  assert.equal(reopened.data.doneLabel, '2 / 4');
});

test('昨日回顾仅有记录时显示，每日最多一次且不修改完成状态', () => {
  const runtime = createRuntime();
  const page = runtime.page('today');
  page.onLoad();
  page.onShow();
  assert.equal(runtime.calls.modals.length, 0);
  runtime.storage.set('dayflow.records.v1', { '2026-10-30': { 'music-guitar': 'done' } });
  page.onShow();
  assert.equal(runtime.calls.modals.length, 1);
  assert.match(runtime.calls.modals[0].content, /1\/9/);
  page.onShow();
  runtime.tick();
  assert.equal(runtime.calls.modals.length, 1);
  assert.equal(runtime.storage.get('dayflow.records.v1')['2026-10-30']['music-guitar'], 'done');
});

test('训练详情拒绝非法日期和不存在的动作，不产生错误日期记录', () => {
  for (const date of ['invalid', '2026-02-30', '2026-13-01']) {
    const runtime = createRuntime();
    const page = runtime.page('training');
    assert.doesNotThrow(() => page.onLoad({ date }));
    page.onShow();
    page.onToggleAction(event('music-guitar'));
    assert.equal(page.data.dateKey, '');
    assert.equal(runtime.storage.size, 0);
    assert.equal(runtime.calls.toasts[0].title, '日期无效，请从日程重新进入');
  }
  const runtime = createRuntime();
  const page = runtime.page('training');
  page.onLoad({ date: '2026-10-31', blockId: 'missing' });
  assert.equal(page.data.actions.length, 0);
  page.onToggleAction(event('missing'));
  assert.equal(runtime.storage.has('dayflow.records.v2'), false);
});
