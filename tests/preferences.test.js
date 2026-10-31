const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntime, clone } = require('./helpers/miniprogram');

test('提醒默认关闭，输入校验失败不会改写偏好，阶段只能由用户选择', () => {
  const runtime = createRuntime();
  const prefs = runtime.load('miniprogram/services/preferences.ts');
  assert.equal(prefs.getPreferences().taskReminderEnabled, false);
  assert.equal(prefs.getPreferences().trainingPhase, '基础');
  prefs.savePreferences({ sleepTime: '22:35', trainingPhase: '巩固' });
  const before = clone(runtime.storage.get('dayflow.preferences.v1'));
  for (const patch of [{ sleepTime: '24:00' }, { leadMinutes: -1 }, { trainingPhase: '自动解锁' }]) {
    assert.throws(() => prefs.savePreferences(patch));
    assert.deepEqual(runtime.storage.get('dayflow.preferences.v1'), before);
  }
});

test('订阅需要对应模板且保留空槽；拒绝或平台缺失不伪造成功', async () => {
  const runtime = createRuntime();
  const prefs = runtime.load('miniprogram/services/preferences.ts');
  let calls = 0;
  runtime.wx.requestSubscribeMessage = options => { calls++; options.success({ [options.tmplIds[0]]: 'reject' }); };
  assert.equal((await prefs.requestReminderSubscription('task')).status, 'unconfigured');
  prefs.savePreferences({ subscriptionTemplateIds: ['', 'fixture-sleep-template'] });
  assert.equal((await prefs.requestReminderSubscription('task')).status, 'unconfigured');
  assert.equal((await prefs.requestReminderSubscription('sleep')).status, 'rejected');
  assert.equal(calls, 1);
  delete runtime.wx.requestSubscribeMessage;
  assert.equal((await prefs.requestReminderSubscription('sleep')).status, 'unavailable');
});

test('前台提醒按本地分钟和日期去重，固定占用不提醒，后台不承诺送达', () => {
  const runtime = createRuntime();
  const prefs = runtime.load('miniprogram/services/preferences.ts');
  const blocks = [
    { id: 'work', title: '工作', kind: 'fixed', start: '12:05' },
    { id: 'music', title: '吉他与声乐', kind: 'parallel', start: '12:05' }
  ];
  assert.equal(prefs.getDueReminders('2026-10-31', 720, blocks).length, 0);
  prefs.savePreferences({ taskReminderEnabled: true, leadMinutes: 10, sleepReminderEnabled: true, sleepTime: '23:00' });
  const due = prefs.getDueReminders('2026-10-31', 720, blocks);
  assert.equal(due.length, 1);
  assert.match(due[0].title, /吉他与声乐/);
  prefs.markReminderShown(due[0].key);
  assert.equal(prefs.getDueReminders('2026-10-31', 725, blocks).length, 0);
  assert.equal(prefs.getDueReminders('2026-11-01', 720, blocks).length, 1);
  assert.equal(prefs.getDueReminders('2026-10-31', 1380, []).length, 1);
  assert.equal(prefs.getDueReminders('2026-10-31', 1386, []).length, 0);
  const next = [{ id: 'early', title: '清晨练习', kind: 'parallel', start: '00:05' }];
  const cross = prefs.getDueReminders('2026-10-31', 1435, [], next);
  assert.equal(cross.length, 1);
  prefs.markReminderShown(cross[0].key);
  assert.equal(prefs.getDueReminders('2026-11-01', 0, next).length, 0);
});
