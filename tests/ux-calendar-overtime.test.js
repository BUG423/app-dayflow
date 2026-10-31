const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRuntime, clone } = require('./helpers/miniprogram');

function touch(x, y, identifier = 1) { return { identifier, clientX: x, clientY: y }; }
function oldTemplate(plans) {
  const plan = clone(plans.getTemplate()); plan.version = 1;
  plan.schedules.forEach(schedule => { schedule.blocks = schedule.blocks.filter(block => block.id !== 'overtime'); });
  return plan;
}
function oldInstance(plans, date, overrides = {}) {
  const template = oldTemplate(plans), weekday = new Date(date + 'T12:00:00').getDay();
  return { date, templateId: template.id, templateVersion: 1, blocks: clone(template.schedules.find(schedule => schedule.weekdays.includes(weekday)).blocks), locked: false, mode: 'standard', createdAt: 1, ...overrides };
}

test('日期横滑只接纳单指、明确水平和限定时长，拒绝轻触/纵向/斜向/异常触点', () => {
  const gesture = createRuntime().load('miniprogram/utils/calendar-gesture.ts');
  const start = gesture.beginCalendarGesture([touch(220, 40)], 1000);
  assert.equal(gesture.calendarSwipeDays(start, [touch(80, 42)], 1300), 7);
  assert.equal(gesture.calendarSwipeDays(start, [touch(300, 42)], 1300), -7);
  for (const [end, at] of [[touch(205, 40), 1300], [touch(210, 150), 1300], [touch(100, 100), 1300], [touch(80, 40, 2), 1300], [touch(80, 40), 999], [touch(80, 40), 2500], [touch(NaN, 40), 1300]]) {
    assert.equal(gesture.calendarSwipeDays(start, [end], at), 0);
  }
  assert.equal(gesture.beginCalendarGesture([touch(1, 1), touch(2, 2, 2)], 1000), null);
  assert.equal(gesture.calendarSwipeDays(start, [], 1300), 0);
  assert.equal(gesture.calendarGestureCancelled(start, [touch(210, 90)]), true);
  assert.equal(gesture.calendarGestureCancelled(start, [touch(80, 42)]), false);
});

test('快速明确水平轨迹按距离和方向识别，同一时钟刻度或两毫秒轻触仍不能翻周', () => {
  const runtime = createRuntime(), gesture = runtime.load('miniprogram/utils/calendar-gesture.ts');
  const start = gesture.beginCalendarGesture([touch(352, 185)], 1000);
  assert.equal(gesture.calendarSwipeDays(start, [touch(36, 185)], 1002), 7);
  assert.equal(gesture.calendarSwipeDays(start, [touch(36, 185)], 1000), 7);
  for (const at of [1000, 1002]) {
    assert.equal(gesture.calendarSwipeDays(start, [touch(352, 185)], at), 0);
    assert.equal(gesture.calendarSwipeDays(start, [touch(330, 185)], at), 0);
    assert.equal(gesture.calendarSwipeDays(start, [touch(352, 120)], at), 0);
  }
  assert.equal(gesture.calendarSwipeDays(start, [touch(36, 185)], 999), 0);
  const page = runtime.page('today'); page.onLoad();
  page.onCalendarTouchStart({ touches: [touch(352, 185)] });
  runtime.setNow(new Date(2026, 9, 31, 12, 4, 0, 2));
  page.onCalendarTouchEnd({ changedTouches: [touch(36, 185)] });
  assert.equal(page.data.selectedDate, '2026-11-07');
  page.onCalendarTouchEnd({ changedTouches: [touch(36, 185)] });
  assert.equal(page.data.selectedDate, '2026-11-07');
});

test('今日真实页面手势跨年且一次结束只翻一周，尾随点击受抑制，历史选择不跟随午夜', () => {
  const runtime = createRuntime(new Date(2026, 11, 30, 12)), page = runtime.page('today');
  page.onLoad();
  page.onCalendarTouchStart({ touches: [touch(220, 40)] });
  runtime.setNow(new Date(2026, 11, 30, 12, 0, 0, 300));
  page.onCalendarTouchEnd({ changedTouches: [touch(80, 42)] });
  assert.equal(page.data.selectedDate, '2027-01-06');
  assert.equal(page.data.week[0].monthLabel, '1月');
  page.onCalendarTouchEnd({ changedTouches: [touch(80, 42)] });
  page.onChooseDay({ currentTarget: { dataset: { date: '2026-12-29' } } });
  assert.equal(page.data.selectedDate, '2027-01-06');
  runtime.setNow(new Date(2026, 11, 30, 12, 0, 0, 700));
  page.onChooseDay({ currentTarget: { dataset: { date: '2026-12-29' } } });
  assert.equal(page.data.selectedDate, '2026-12-29');
  runtime.setNow(new Date(2026, 11, 31, 0, 1)); page.updateClock();
  assert.equal(page.data.selectedDate, '2026-12-29');
  page.onToday(); assert.equal(page.data.selectedDate, '2026-12-31');
});

test('多指、纵向滚动和取消会清掉手势，正常点击及回今天继续可用', () => {
  const runtime = createRuntime(), page = runtime.page('today'); page.onLoad();
  const original = page.data.selectedDate;
  for (const event of [{ touches: [touch(210, 90)] }, { touches: [touch(200, 40), touch(180, 40, 2)] }]) {
    page.onCalendarTouchStart({ touches: [touch(220, 40)] }); page.onCalendarTouchMove(event);
    runtime.setNow(new Date(2026, 9, 31, 12, 4, 0, 300));
    page.onCalendarTouchEnd({ changedTouches: [touch(80, 42)] });
    assert.equal(page.data.selectedDate, original);
  }
  page.onCalendarTouchStart({ touches: [touch(220, 40)] }); page.onCalendarTouchCancel();
  runtime.setNow(new Date(2026, 9, 31, 12, 4, 0, 600));
  page.onCalendarTouchEnd({ changedTouches: [touch(80, 42)] }); assert.equal(page.data.selectedDate, original);
  page.onChooseDay({ currentTarget: { dataset: { date: '2026-10-26' } } }); assert.equal(page.data.selectedDate, '2026-10-26');
  page.onToday(); assert.equal(page.data.selectedDate, original);
});

test('新版示例在周一至周六明确列加班为普通固定占用，周日不擅自加入且不增加任务分母', () => {
  const runtime = createRuntime(), plans = runtime.load('miniprogram/services/plans.ts');
  const progress = runtime.load('miniprogram/utils/progress.js');
  assert.equal(plans.getTemplate().version, 2);
  for (let day = 2; day <= 7; day++) {
    const date = '2026-11-0' + day, blocks = plans.getDayBlocks(date), overtime = blocks.find(block => block.id === 'overtime');
    assert.equal(overtime.title, '加班'); assert.equal(overtime.kind, 'fixed'); assert.equal(overtime.start, '18:30'); assert.equal(overtime.end, '23:00');
    assert.deepEqual(clone(overtime.actions), []);
    assert.deepEqual(clone(progress.progress(blocks, {})), clone(progress.progress(blocks.filter(block => block.id !== 'overtime'), {})));
  }
  assert.equal(plans.getDayBlocks('2026-11-01').some(block => block.id === 'overtime'), false);
});

test('旧默认历史、仅缓存未锁日期和缺快照旧记录保留原v1安排，未来未执行缓存才更新', () => {
  const runtime = createRuntime(), plans = runtime.load('miniprogram/services/plans.ts');
  const cachedPast = oldInstance(plans, '2026-10-29'), cachedFuture = oldInstance(plans, '2026-11-02');
  runtime.storage.set('dayflow.instances.v1', { [cachedPast.date]: cachedPast, [cachedFuture.date]: cachedFuture });
  runtime.storage.set('dayflow.records.v1', { '2026-10-30': { 'music-guitar': 'done' }, '2026-11-03': { 'music-guitar': 'todo' } });
  const prior = plans.getDailyInstance(cachedPast.date);
  assert.equal(prior.locked, true); assert.deepEqual(clone(prior.blocks), cachedPast.blocks);
  for (const date of ['2026-10-30', '2026-11-03']) {
    const original = plans.getDailyInstance(date);
    assert.equal(original.templateVersion, 1); assert.equal(original.locked, true);
    assert.equal(original.blocks.some(block => block.id === 'overtime'), false);
  }
  const future = plans.getDailyInstance(cachedFuture.date);
  assert.equal(future.templateVersion, 2); assert.equal(future.blocks.some(block => block.id === 'overtime'), true);
});

test('显式保存旧模板或自定义模板不自动插入加班，预览新示例不写数据且确认前历史不动', () => {
  const runtime = createRuntime(), plans = runtime.load('miniprogram/services/plans.ts');
  const saved = oldTemplate(plans); saved.name = '用户自己的计划';
  runtime.storage.set('dayflow.plans.v1', saved);
  assert.deepEqual(clone(plans.getTemplate()), saved);
  assert.equal(plans.getDayBlocks('2026-11-02').some(block => block.id === 'overtime'), false);
  const before = clone([...runtime.storage]);
  const text = plans.exportDefaultTemplate(), preview = plans.previewImport(text);
  assert.equal(preview.ok, true); assert.equal(preview.template.version, 2);
  assert.equal(preview.template.schedules.find(schedule => schedule.weekdays.includes(1)).blocks.some(block => block.id === 'overtime'), true);
  assert.deepEqual(clone([...runtime.storage]), before);
});

test('新记录空状态仍是权威，旧未来打卡不阻止新版示例；旧应急覆盖仅保留训练选择', () => {
  const runtime = createRuntime(), plans = runtime.load('miniprogram/services/plans.ts');
  runtime.storage.set('dayflow.records.v1', { '2026-11-02': { 'music-guitar': 'done' } });
  runtime.storage.set('dayflow.records.v2', { schemaVersion: 2, byDate: {} });
  const updated = plans.getDailyInstance('2026-11-02'); assert.equal(updated.templateVersion, 2); assert.equal(updated.locked, false);
  const emergency = plans.setEmergencyPlan('2026-11-03', true); emergency.templateVersion = 1;
  emergency.blocks = emergency.blocks.filter(block => block.id !== 'overtime');
  const instances = runtime.storage.get('dayflow.instances.v1'); instances[emergency.date] = emergency;
  runtime.storage.set('dayflow.instances.v1', instances);
  const rebased = plans.getDailyInstance(emergency.date);
  assert.equal(rebased.mode, 'emergency'); assert.equal(rebased.templateVersion, 2);
  assert.equal(rebased.blocks.find(block => block.id === 'training').end, '17:45');
  assert.equal(rebased.blocks.some(block => block.id === 'overtime'), true);
});

test('今日日期栏只保留七日点选与触摸入口，删除重复日期标题和左右箭头', () => {
  const markup = fs.readFileSync(path.join(__dirname, '../miniprogram/pages/today/index.wxml'), 'utf8');
  assert.doesNotMatch(markup, /week-title|week-arrow|\{\{dayTitle\}\}/);
  assert.match(markup, /bindtouchstart="onCalendarTouchStart"/);
  assert.match(markup, /bindtouchcancel="onCalendarTouchCancel"/);
});

test('编辑日期状态查询完全只读，不为今天或未来候选生成快照，过去日期明确锁定', () => {
  const runtime = createRuntime(), plans = runtime.load('miniprogram/services/plans.ts');
  runtime.wx.setStorageSync = () => { throw new Error('Date selection must not write storage'); };
  assert.deepEqual(clone(plans.getDateEditState('2026-10-31')), { locked: false, reason: '' });
  assert.deepEqual(clone(plans.getDateEditState('2026-11-07')), { locked: false, reason: '' });
  assert.deepEqual(clone(plans.getDateEditState('2026-10-30')), { locked: true, reason: 'past' });
  assert.throws(() => plans.getDateEditState('2026-02-30'), /日期无效/);
  assert.equal(runtime.storage.size, 0);
});

test('编辑日期合并真实记录与仅照片等显式快照锁，无快照的新记录同样不可覆盖', () => {
  const runtime = createRuntime(), plans = runtime.load('miniprogram/services/plans.ts');
  const photoOnly = oldInstance(plans, '2026-11-02', { locked: true });
  const derived = oldInstance(plans, '2026-11-03');
  runtime.storage.set('dayflow.instances.v1', { [photoOnly.date]: photoOnly, [derived.date]: derived });
  const record = { date: '2026-11-04', targetId: 'music-guitar', taskId: 'music-guitar', status: 'todo', updatedAt: 1, events: [] };
  runtime.storage.set('dayflow.records.v2', { schemaVersion: 2, byDate: { [record.date]: { [record.targetId]: record } } });
  const before = clone([...runtime.storage]);
  runtime.wx.setStorageSync = () => { throw new Error('Date selection must not write storage'); };
  assert.deepEqual(clone(plans.getDateEditState(photoOnly.date)), { locked: true, reason: 'snapshot' });
  assert.deepEqual(clone(plans.getDateEditState(derived.date)), { locked: false, reason: '' });
  assert.deepEqual(clone(plans.getDateEditState(record.date)), { locked: true, reason: 'recorded' });
  assert.deepEqual(clone([...runtime.storage]), before);
});

test('编辑日期使用v2空记录权威，旧记录仅在v2缺失时锁定，读取损坏则失败关闭且零写', () => {
  const runtime = createRuntime(), plans = runtime.load('miniprogram/services/plans.ts');
  runtime.storage.set('dayflow.records.v1', { '2026-11-02': { 'music-guitar': 'done' } });
  assert.deepEqual(clone(plans.getDateEditState('2026-11-02')), { locked: true, reason: 'recorded' });
  runtime.storage.set('dayflow.records.v2', { schemaVersion: 2, byDate: {} });
  assert.deepEqual(clone(plans.getDateEditState('2026-11-02')), { locked: false, reason: '' });
  for (const key of ['dayflow.records.v2', 'dayflow.instances.v1']) {
    const original = clone(runtime.storage.get(key)); runtime.storage.set(key, 'damaged');
    const before = clone([...runtime.storage]);
    assert.throws(() => plans.getDateEditState('2026-11-02'));
    assert.deepEqual(clone([...runtime.storage]), before);
    if (original === undefined) runtime.storage.delete(key); else runtime.storage.set(key, original);
  }
  const read = runtime.wx.getStorageSync;
  runtime.wx.getStorageSync = key => { if (key === 'dayflow.records.v2') throw new Error('Storage unavailable'); return read(key); };
  const before = clone([...runtime.storage]);
  assert.throws(() => plans.getDateEditState('2026-11-02'), /Storage unavailable/);
  assert.deepEqual(clone([...runtime.storage]), before);
});
