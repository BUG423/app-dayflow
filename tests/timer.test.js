const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntime, clone } = require('./helpers/miniprogram');

test('独立倒计时后台/重建恢复，结束不写任务完成记录', () => {
  const runtime = createRuntime(new Date(2026, 9, 31, 12, 0));
  const timer = runtime.load('miniprogram/services/timer.ts');
  timer.startTimer('2026-10-31', 'd6-step-0', 60);
  runtime.setNow(new Date(2026, 9, 31, 12, 0, 25));
  assert.equal(timer.getTimer().remainingSeconds, 35);
  const restarted = createRuntime(new Date(2026, 9, 31, 12, 1, 5));
  for (const [key, value] of runtime.storage) restarted.storage.set(key, value);
  const ended = restarted.load('miniprogram/services/timer.ts').getTimer();
  assert.equal(ended.status, 'finished');
  assert.equal(ended.remainingSeconds, 0);
  assert.equal(restarted.storage.has('dayflow.records.v2'), false);
});

test('暂停冻结剩余，继续按新截止时间，重置保持暂停且时钟回拨不能超原剩余', () => {
  const runtime = createRuntime(new Date(2026, 9, 31, 12, 0));
  const timer = runtime.load('miniprogram/services/timer.ts');
  timer.startTimer('2026-10-31', 'step', 60);
  runtime.setNow(new Date(2026, 9, 31, 12, 0, 10));
  assert.equal(timer.pauseTimer().remainingSeconds, 50);
  runtime.setNow(new Date(2026, 9, 31, 12, 5));
  assert.equal(timer.getTimer().remainingSeconds, 50);
  timer.resumeTimer();
  runtime.setNow(new Date(2026, 9, 31, 12, 4));
  assert.equal(timer.getTimer().remainingSeconds, 50);
  const reset = timer.resetTimer();
  assert.equal(reset.status, 'paused');
  assert.equal(reset.remainingSeconds, 60);
});

test('计时非法参数、损坏数据和保存失败均不覆盖已有值', () => {
  const runtime = createRuntime();
  const timer = runtime.load('miniprogram/services/timer.ts');
  for (const seconds of [0, 4, 10801, 2.5, NaN]) assert.throws(() => timer.startTimer('2026-10-31', 'step', seconds), /五秒/);
  assert.throws(() => timer.startTimer('2026-02-30', 'step', 30), /日期/);
  runtime.storage.set('dayflow.timer.v1', { broken: true });
  assert.throws(() => timer.startTimer('2026-10-31', 'step', 30), /损坏/);
  assert.deepEqual(runtime.storage.get('dayflow.timer.v1'), { broken: true });
  runtime.storage.delete('dayflow.timer.v1'); timer.startTimer('2026-10-31', 'step', 30);
  const before = clone(runtime.storage.get('dayflow.timer.v1'));
  runtime.wx.setStorageSync = () => { throw new Error('full'); };
  assert.throws(() => timer.pauseTimer(), /full/);
  assert.deepEqual(runtime.storage.get('dayflow.timer.v1'), before);
});

test('训练页倒计时隐藏仅停显示，返回恢复；替换取消与到点均不改完成状态', () => {
  const runtime = createRuntime(new Date(2026, 9, 31, 12, 0));
  const page = runtime.page('training'); page.onLoad({ date: '2026-10-31', blockId: 'training' }); page.onShow();
  page.onSelectTimerTarget({ currentTarget: { dataset: { id: 'd6-step-0' } } });
  page.onTimerDurationInput({ detail: { value: '60' } }); page.onStartTimer();
  assert.equal(page.data.timerRemainingText, '01:00');
  page.onCloseTimerPanel();
  assert.equal(page.data.showTimerPanel, false);
  page.onHide(); assert.equal(runtime.timers.size, 0);
  runtime.setNow(new Date(2026, 9, 31, 12, 0, 20)); page.onShow();
  assert.equal(page.data.timerRemainingText, '00:40');
  page.onSelectTimerTarget({ currentTarget: { dataset: { id: 'd6-step-1' } } }); page.onStartTimer();
  runtime.calls.modals.at(-1).success({ confirm: false });
  assert.equal(page.data.timerState.targetId, 'd6-step-0');
  runtime.setNow(new Date(2026, 9, 31, 12, 1, 10)); runtime.tick();
  assert.equal(page.data.timerStatusText, '计时结束');
  assert.equal(page.data.actions[0].done, false);
  assert.equal(runtime.storage.has('dayflow.records.v2'), false);
  const toasts = runtime.calls.toasts.length; runtime.tick();
  assert.equal(runtime.calls.toasts.length, toasts);
  page.onUnload(); assert.equal(runtime.timers.size, 0);
});
