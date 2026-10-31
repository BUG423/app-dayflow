const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntime, clone } = require('./helpers/miniprogram');
const today = '2026-10-31';

test('今天休息停止doing与独立计时，保留完成、待办、历史和计划快照', () => {
  const runtime = createRuntime();
  const records = runtime.load('miniprogram/services/records.ts');
  const timer = runtime.load('miniprogram/services/timer.ts');
  const rest = runtime.load('miniprogram/services/rest-days.ts');
  records.setStatus(today, 'music-guitar', 'done');
  records.setStatus(today, 'music-vocal', 'doing');
  records.setStatus('2026-10-30', 'music-guitar', 'done');
  timer.startTimer(today, 'music-vocal', 120);
  const saved = clone(records.exportEnvelope()), snapshots = clone(runtime.storage.get('dayflow.instances.v1'));
  runtime.setNow(new Date(2026, 9, 31, 12, 5));
  const result = rest.startRestToday('临时有事');
  assert.equal(result.active, true); assert.equal(result.reason, '临时有事');
  const after = records.exportEnvelope();
  assert.deepEqual(clone(after.byDate[today]['music-guitar']), saved.byDate[today]['music-guitar']);
  assert.deepEqual(clone(after.byDate['2026-10-30']), saved.byDate['2026-10-30']);
  const stopped = after.byDate[today]['music-vocal'];
  assert.equal(stopped.status, 'aborted');
  assert.equal(stopped.events.at(-1).from, 'doing');
  assert.match(stopped.events.at(-1).reason, /今天休息：临时有事/);
  assert.equal(Object.keys(after.byDate[today]).length, 2);
  assert.deepEqual(runtime.storage.get('dayflow.instances.v1'), snapshots);
  assert.equal(timer.getTimer().status, 'paused'); assert.equal(timer.getTimer().remainingSeconds, 60);
  assert.throws(() => records.setStatus(today, 'music-vocal', 'doing'), /恢复今日安排/);
  assert.throws(() => records.setStatus(today, 'music-vocal', 'done'), /恢复今日安排/);
  assert.throws(() => timer.startTimer(today, 'music-vocal', 60), /恢复今日安排/);
  assert.throws(() => timer.resumeTimer(), /恢复今日安排/);
});

test('恢复只解除当天休息且不自动重启，重复确认不改首次休息和记录', () => {
  const runtime = createRuntime(), rest = runtime.load('miniprogram/services/rest-days.ts');
  const timer = runtime.load('miniprogram/services/timer.ts');
  timer.startTimer(today, 'music-guitar', 60); rest.startRestToday('');
  const first = clone([...runtime.storage]);
  runtime.setNow(new Date(2026, 9, 31, 12, 6)); rest.startRestToday('再次点击不覆盖理由');
  assert.deepEqual(clone([...runtime.storage]), first);
  const resumed = rest.resumeToday(); assert.equal(resumed.active, false); assert.ok(resumed.resumedAt);
  assert.equal(timer.getTimer().status, 'paused');
  assert.equal(rest.isRestingToday(), false);
  const before = clone([...runtime.storage]); rest.resumeToday(); assert.deepEqual(clone([...runtime.storage]), before);
  timer.resumeTimer(); assert.equal(timer.getTimer().status, 'running');
});

test('休息限本地今天，跨日不影响新一天并保留旧日休息说明', () => {
  const runtime = createRuntime(new Date(2026, 9, 31, 23, 59));
  const rest = runtime.load('miniprogram/services/rest-days.ts');
  rest.startRestToday('出行'); runtime.setNow(new Date(2026, 10, 1, 0, 1));
  assert.equal(rest.isRestingToday(), false);
  assert.equal(rest.getDayRest(today).reason, '出行');
  assert.equal(rest.resumeToday(), undefined);
  rest.startRestToday(''); assert.equal(rest.getDayRest('2026-11-01').active, true);
});

test('理由、损坏休息和计时数据先拒绝，零写入原始数据', () => {
  const runtime = createRuntime(), rest = runtime.load('miniprogram/services/rest-days.ts');
  for (const reason of [null, 42, '长'.repeat(201)]) assert.throws(() => rest.startRestToday(reason), /理由/);
  assert.equal(runtime.storage.size, 0);
  runtime.storage.set('dayflow.restDays.v1', { schemaVersion: 1, byDate: { [today]: { date: today, reason: '', active: true } } });
  let before = clone([...runtime.storage]); assert.throws(() => rest.startRestToday(), /休息记录/);
  assert.deepEqual(clone([...runtime.storage]), before);
  runtime.storage.delete('dayflow.restDays.v1'); runtime.storage.set('dayflow.timer.v1', { status: 'damaged' });
  before = clone([...runtime.storage]); assert.throws(() => rest.startRestToday());
  assert.deepEqual(clone([...runtime.storage]), before);
});

test('休息保存任一阶段失败回滚精确原值、key存在性，未写快照和模板', () => {
  for (const failingKey of ['dayflow.timer.v1', 'dayflow.records.v2', 'dayflow.restDays.v1']) {
    const runtime = createRuntime(), records = runtime.load('miniprogram/services/records.ts');
    const timer = runtime.load('miniprogram/services/timer.ts'), rest = runtime.load('miniprogram/services/rest-days.ts');
    records.setStatus(today, 'music-guitar', 'doing'); timer.startTimer(today, 'music-guitar', 120);
    runtime.storage.set('other.app', 'keep'); const before = clone([...runtime.storage]);
    const set = runtime.wx.setStorageSync; let thrown = false;
    runtime.wx.setStorageSync = (key, value) => { set(key, value); if (key === failingKey && !thrown) { thrown = true; throw new Error('full'); } };
    assert.throws(() => rest.startRestToday('存储故障'), /未能保存/);
    assert.deepEqual(clone([...runtime.storage]), before);
  }
});

test('恢复失败保留休息状态，损坏记录不能被覆盖成成功', () => {
  const runtime = createRuntime(), rest = runtime.load('miniprogram/services/rest-days.ts');
  rest.startRestToday(); const before = clone([...runtime.storage]);
  const set = runtime.wx.setStorageSync; let failed = false;
  runtime.wx.setStorageSync = (key, value) => { if (!failed) { failed = true; throw new Error('full'); } set(key, value); };
  assert.throws(() => rest.resumeToday(), /未能保存/); assert.deepEqual(clone([...runtime.storage]), before);
  runtime.wx.setStorageSync = set; rest.resumeToday();
  runtime.storage.set('dayflow.records.v2', { schemaVersion: 2, byDate: { [today]: { invalid: {} } } });
  const damaged = clone([...runtime.storage]); assert.throws(() => rest.startRestToday());
  assert.deepEqual(clone([...runtime.storage]), damaged);
});
