const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntime, clone } = require('./helpers/miniprogram');

const date = '2026-10-31';
const event = id => ({ currentTarget: { dataset: { id } } });
const input = value => ({ detail: { value } });

test('今日休息可先填写理由或取消，确认前不写数据，错误后保留填写内容', () => {
  const runtime = createRuntime(), page = runtime.page('today');
  page.onLoad();
  const before = clone([...runtime.storage]);
  page.onOpenRest(); page.onRestReasonInput(input('临时有事'));
  assert.equal(page.data.restEditorVisible, true);
  assert.equal(page.data.restFormDate, date);
  assert.deepEqual(clone([...runtime.storage]), before);
  page.onCancelRest();
  assert.equal(page.data.restEditorVisible, false);
  assert.deepEqual(clone([...runtime.storage]), before);
  page.onOpenRest(); page.onRestReasonInput(input('长'.repeat(201))); page.onConfirmRest();
  assert.equal(page.data.restEditorVisible, true);
  assert.equal(page.data.restReasonInput.length, 201);
  assert.match(page.data.restError, /两百字/);
  assert.equal(page.data.restSaving, false);
  assert.deepEqual(clone([...runtime.storage]), before);
});

test('确认今天休息展示全日暂停且保留完成，停止当前执行和倒计时并暂停前台提醒', () => {
  const runtime = createRuntime(), page = runtime.page('today');
  const records = runtime.load('miniprogram/services/records.ts');
  const timer = runtime.load('miniprogram/services/timer.ts');
  const preferences = runtime.load('miniprogram/services/preferences.ts');
  page.onLoad(); records.setStatus(date, 'music-guitar', 'done'); records.setStatus(date, 'music-vocal', 'doing');
  timer.startTimer(date, 'music-vocal', 120); preferences.savePreferences({ taskReminderEnabled: true, leadMinutes: 0 });
  const completed = clone(records.recordDetailsForDate(date)['music-guitar']);
  page.refresh(); const progressBeforeRest = page.data.doneLabel;
  page.onOpenRest(); page.onRestReasonInput(input('出行请假'));
  runtime.setNow(new Date(2026, 9, 31, 12, 5)); page.onConfirmRest();
  assert.equal(page.data.restActive, true); assert.equal(page.data.restReason, '出行请假');
  assert.equal(page.data.heroTitle, '今天休息'); assert.equal(page.data.restEditorVisible, false);
  assert.ok(page.data.blocks.every(block => block.stateText === '今日休息'));
  assert.equal(page.data.doneLabel, progressBeforeRest); assert.match(page.data.doneLabel, /^1 \/ /);
  assert.deepEqual(clone(records.recordDetailsForDate(date)['music-guitar']), completed);
  assert.equal(records.recordDetailsForDate(date)['music-vocal'].status, 'aborted');
  assert.equal(timer.getTimer().status, 'paused'); assert.equal(timer.getTimer().remainingSeconds, 60);
  const toastCount = runtime.calls.toasts.length;
  page.checkReminders(date, 12 * 60 + 5);
  assert.equal(runtime.calls.toasts.length, toastCount);
  assert.equal(page.data.reminderText, '');
  assert.equal(runtime.storage.has('dayflow.remindersShown.v1'), false);
  runtime.setNow(new Date(2026, 9, 31, 12, 10)); page.refresh();
  const stopped = page.data.blocks.find(block => block.id === 'music').actions.find(action => action.id === 'music-vocal');
  assert.equal(stopped.elapsedText, '01:00');
  page.onResumeRest();
  assert.equal(page.data.restActive, false);
  assert.equal(records.recordDetailsForDate(date)['music-vocal'].status, 'aborted');
  assert.equal(timer.getTimer().status, 'paused');
});

test('休息期间今日与详情即使显示旧数据也不能继续打卡、改状态或开启计时', () => {
  const runtime = createRuntime(), page = runtime.page('today'), training = runtime.page('training');
  const rest = runtime.load('miniprogram/services/rest-days.ts');
  page.onLoad(); training.onLoad({ date, blockId: 'training' });
  const id = training.data.actions[0].id;
  rest.startRestToday('休息');
  assert.equal(page.data.restActive, false); assert.equal(training.data.restActive, false);
  const before = clone([...runtime.storage]);
  page.onToggleTask(event('music-guitar')); page.onTaskMenu(event('music-guitar'));
  training.onToggleAction(event(id)); training.onActionMenu(event(id)); training.onStart();
  training.onSelectTimerTarget(event(id)); training.onStartTimer(); training.onResumeTimer(); training.onStop();
  assert.equal(page.data.restActive, true); assert.equal(training.data.restActive, true);
  assert.deepEqual(clone([...runtime.storage]), before);
  assert.equal(runtime.calls.actionSheets.length, 0); assert.equal(runtime.calls.modals.length, 0);
  assert.equal(training.data.showTimerPanel, false);
  assert.match(training.data.heroTitle || training.data.title, /训练|游泳/);
  const target = training.data.actions.find(action => action.id === id);
  assert.equal(target.statusText, '今日休息');
});

test('休息只作用当地今天，跨午夜旧表单不能误暂停新的一天，历史可查看但不能恢复', () => {
  const runtime = createRuntime(new Date(2026, 9, 31, 23, 59)), page = runtime.page('today');
  page.onLoad(); page.onOpenRest(); page.onRestReasonInput(input('稍后再说'));
  runtime.setNow(new Date(2026, 10, 1, 0, 1)); page.onConfirmRest();
  assert.equal(page.data.restEditorVisible, false);
  assert.equal(runtime.storage.has('dayflow.restDays.v1'), false);
  const rest = runtime.load('miniprogram/services/rest-days.ts');
  runtime.setNow(new Date(2026, 9, 31, 23, 59)); rest.startRestToday('出行');
  runtime.setNow(new Date(2026, 10, 1, 0, 1)); page.onShow();
  assert.equal(page.data.selectedDate, '2026-11-01'); assert.equal(page.data.restActive, false);
  page.choose(date);
  assert.equal(page.data.restRecorded, true); assert.equal(page.data.restReason, '出行');
  assert.equal(page.data.restActive, false); assert.equal(page.data.isToday, false);
  const before = clone([...runtime.storage]);
  page.onOpenRest(); page.onResumeRest();
  assert.equal(page.data.restEditorVisible, false); assert.deepEqual(clone([...runtime.storage]), before);
  page.onHide();
});

test('休息存储失败保留理由与表单，不显示成功；损坏休息数据不放行执行', () => {
  const runtime = createRuntime(), page = runtime.page('today');
  page.onLoad(); page.onOpenRest(); page.onRestReasonInput(input('需要休息'));
  const set = runtime.wx.setStorageSync;
  runtime.wx.setStorageSync = (key, value) => { if (key === 'dayflow.restDays.v1') throw new Error('full'); set(key, value); };
  page.onConfirmRest();
  assert.equal(page.data.restActive, false); assert.equal(page.data.restEditorVisible, true);
  assert.equal(page.data.restReasonInput, '需要休息'); assert.match(page.data.restError, /未能保存/);
  assert.ok(!runtime.calls.toasts.some(item => item.title === '今天先好好休息'));
  runtime.wx.setStorageSync = set;
  runtime.storage.set('dayflow.restDays.v1', { broken: true });
  const before = clone([...runtime.storage]); page.onToggleTask(event('music-guitar'));
  assert.deepEqual(clone([...runtime.storage]), before);
  assert.match(runtime.calls.toasts.at(-1).title, /休息/);
});
