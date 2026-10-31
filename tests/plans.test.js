const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntime, clone } = require('./helpers/miniprogram');
const DEFAULT_VERSION = 2; // The revised built-in example has its own version.

function setup() { const runtime = createRuntime(); return { runtime, plans: runtime.load('miniprogram/services/plans.ts') }; }
function simpleTemplate(plans, overrides = {}) {
  return { ...clone(plans.getTemplate()), name: '自定义计划', schedules: [{ id: 'custom', title: '自定义规则', weekdays: [0,1,2,3,4,5,6], effectiveFrom: '2026-01-01', exceptions: [], blocks: [{ id: 'custom-block', title: '自主练习', start: '18:30', end: '19:00', kind: 'parallel', category: '兴趣', tasks: [{ id: 'custom-task', title: '练习', start: '18:30', end: '19:00', actions: [] }] }] }], ...overrides };
}
function modernRecord(date, targetId, status, extra = {}) { return { date, targetId, taskId: targetId, status, updatedAt: 1, events: [], ...extra }; }
function envelope(date, targetId, record) { return { schemaVersion: 2, byDate: { [date]: { [targetId]: record } } }; }

test('默认七日模型区分任务和动作，投影保留旧目标标识且不将固定块计入分母', () => {
  const { plans } = setup();
  const preview = plans.previewImport(plans.exportTemplate());
  assert.equal(preview.ok, true);
  assert.equal(preview.summary.schedules, 7);
  const day = plans.getDailyInstance('2026-10-31');
  assert.equal(day.blocks.find(block => block.id === 'music').tasks.length, 2);
  assert.equal(day.blocks.find(block => block.id === 'music').tasks[0].actions.length, 0);
  assert.equal(day.blocks.find(block => block.id === 'training').tasks[0].actions.length, 2);
  const rows = plans.getDayBlocks('2026-10-31');
  assert.equal(rows.find(block => block.id === 'music').actions[0].id, 'music-guitar');
  assert.equal(rows.find(block => block.id === 'music').actions[0].taskId, 'music-guitar');
  assert.equal(rows.find(block => block.id === 'training').actions[0].actionId, 'd6-step-0');
  assert.equal(rows.filter(block => block.kind === 'fixed').every(block => block.actions.length === 0), true);
});

test('无效导入只预览错误，不修改任何存储；未知字段和原型保留标识被拒绝', () => {
  const { runtime, plans } = setup();
  const candidates = [null, [], { ...simpleTemplate(plans), schemaVersion: 2 }, { ...simpleTemplate(plans), unsupported: true }];
  for (const id of ['__proto__', 'constructor', 'prototype']) {
    const candidate = simpleTemplate(plans); candidate.schedules[0].blocks[0].tasks[0].id = id; candidates.push(candidate);
  }
  for (const candidate of candidates) assert.equal(plans.previewImport(JSON.stringify(candidate)).ok, false);
  assert.equal(plans.previewImport('{bad').ok, false);
  assert.equal(plans.previewImport('x'.repeat(262145)).ok, false);
  assert.equal(runtime.storage.size, 0);
});

test('严格校验日历日期、分钟范围、所属时间和顺序动作重叠', () => {
  const { plans } = setup();
  for (const mutate of [
    t => { t.schedules[0].effectiveFrom = '2026-02-30'; },
    t => { t.schedules[0].weekdays = [1,1]; },
    t => { t.schedules[0].blocks[0].end = '18:00'; },
    t => { t.schedules[0].blocks[0].tasks[0].start = '18:00'; },
    t => { t.schedules[0].blocks[0].tasks[0].title = ''; },
    t => { t.schedules[0].blocks[0].kind = 'fixed'; },
    t => { const b = t.schedules[0].blocks[0]; b.kind = 'sequence'; b.tasks[0].actions = [{ id: 'a', title: '第一步', start: '18:30', end: '18:50' }, { id: 'b', title: '第二步', start: '18:40', end: '19:00' }]; }
  ]) { const candidate = simpleTemplate(plans); mutate(candidate); assert.equal(plans.previewImport(JSON.stringify(candidate)).ok, false); }
});

test('标识唯一性按实际同一天判断，跨不同星期复用合法、同日重复非法', () => {
  const { plans } = setup();
  const template = simpleTemplate(plans);
  template.schedules[0].weekdays = [1];
  template.schedules.push({ ...clone(template.schedules[0]), id: 'other', weekdays: [2] });
  assert.equal(plans.previewImport(JSON.stringify(template)).ok, true);
  template.schedules[1].weekdays = [1];
  assert.equal(plans.previewImport(JSON.stringify(template)).ok, false);
});

test('周期、生效期与跳过/替换例外按本地日期解析；仅一次的替换规则也合法', () => {
  const { plans } = setup();
  const template = simpleTemplate(plans), schedule = template.schedules[0];
  schedule.weekdays = [6]; schedule.effectiveFrom = '2026-10-31'; schedule.effectiveTo = '2026-11-07';
  schedule.exceptions = [{ date: '2026-10-31', kind: 'skip' }, { date: '2026-11-01', kind: 'replace', blocks: clone(schedule.blocks) }];
  plans.saveTemplate(template, DEFAULT_VERSION);
  assert.equal(plans.getDayBlocks('2026-10-31').length, 0);
  assert.equal(plans.getDayBlocks('2026-11-01').length, 1);
  assert.equal(plans.getDayBlocks('2026-11-02').length, 0);
  assert.equal(plans.getDayBlocks('2026-11-07').length, 1);
  assert.equal(plans.getDayBlocks('2026-11-14').length, 0);
  const once = simpleTemplate(plans); once.schedules[0].weekdays = []; once.schedules[0].effectiveFrom = '2026-11-02'; once.schedules[0].effectiveTo = '2026-11-02'; once.schedules[0].exceptions = [{ date: '2026-11-02', kind: 'replace', blocks: clone(once.schedules[0].blocks) }];
  assert.equal(plans.previewImport(JSON.stringify(once)).ok, true);
});

test('创建修改删除规则均递增版本，历史版本可另存为新版本且过时保存被拒绝', () => {
  const { plans } = setup();
  const template = simpleTemplate(plans); plans.saveTemplate(template, DEFAULT_VERSION);
  const schedule = clone(plans.getTemplate().schedules[0]); schedule.title = '修改后'; plans.saveSchedule(schedule, DEFAULT_VERSION + 1);
  assert.equal(plans.getTemplate().version, DEFAULT_VERSION + 2);
  assert.throws(() => plans.deleteSchedule(schedule.id, DEFAULT_VERSION + 1), /已更新/);
  plans.deleteSchedule(schedule.id, DEFAULT_VERSION + 2);
  assert.equal(plans.getTemplate().schedules.length, 0);
  const old = plans.getTemplateVersions().find(version => version.version === DEFAULT_VERSION + 1);
  plans.saveTemplate(old, DEFAULT_VERSION + 3);
  assert.equal(plans.getTemplate().version, DEFAULT_VERSION + 4);
  assert.equal(plans.getTemplate().schedules[0].title, '自定义规则');
  assert.deepEqual(clone(plans.getTemplateVersions().map(version => version.version)), [DEFAULT_VERSION + 4, DEFAULT_VERSION + 3, DEFAULT_VERSION + 2, DEFAULT_VERSION + 1, DEFAULT_VERSION]);
});

test('先编辑后首次迁移旧打卡时，既有日期按编辑前模板锁定而未来更新', () => {
  const { runtime, plans } = setup();
  const legacy = { '2026-10-30': { 'music-guitar': 'done' } };
  runtime.storage.set('dayflow.records.v1', legacy);
  plans.saveTemplate(simpleTemplate(plans, { schedules: [] }), DEFAULT_VERSION);
  assert.equal(plans.getDailyInstance('2026-10-30').locked, true);
  assert.equal(plans.getDayBlocks('2026-10-30').reduce((n, b) => n + b.actions.length, 0), 9);
  assert.equal(plans.getDayBlocks('2026-11-01').length, 0);
  assert.deepEqual(runtime.storage.get('dayflow.records.v1'), legacy);
});

test('未执行未来缓存可随版本重建，过去或显式锁定的快照不改变', () => {
  const { plans } = setup();
  plans.getDailyInstance('2026-11-01');
  const past = clone(plans.getDailyInstance('2026-10-29'));
  const locked = clone(plans.lockDailyInstance('2026-10-31'));
  plans.saveTemplate(simpleTemplate(plans, { schedules: [] }), DEFAULT_VERSION);
  assert.equal(plans.getDailyInstance('2026-11-01').templateVersion, DEFAULT_VERSION + 1);
  assert.equal(plans.getDayBlocks('2026-11-01').length, 0);
  assert.deepEqual(clone(plans.getDailyInstance('2026-10-29')), past);
  assert.deepEqual(clone(plans.getDailyInstance('2026-10-31')), locked);
});

test('读取损坏记录或快照写入失败时拒绝模板保存，不覆盖记录与当前模板', () => {
  for (const key of ['dayflow.records.v1', 'dayflow.records.v2']) {
    const { runtime, plans } = setup(); runtime.storage.set(key, 'damaged');
    assert.throws(() => plans.saveTemplate(simpleTemplate(plans), DEFAULT_VERSION));
    assert.equal(runtime.storage.has('dayflow.plans.v1'), false);
    assert.equal(runtime.storage.get(key), 'damaged');
  }
  const { runtime, plans } = setup();
  runtime.storage.set('dayflow.records.v1', { '2026-10-30': { 'music-guitar': 'done' } });
  const write = runtime.wx.setStorageSync; runtime.wx.setStorageSync = (key, value) => { if (key === 'dayflow.instances.v1') throw new Error('quota'); write(key, value); };
  assert.throws(() => plans.saveTemplate(simpleTemplate(plans), DEFAULT_VERSION), /quota/);
  assert.equal(plans.getTemplate().version, DEFAULT_VERSION);
  assert.equal(runtime.storage.get('dayflow.records.v1')['2026-10-30']['music-guitar'], 'done');
});

test('记录条目状态或事件损坏时也拒绝计划修改', () => {
  for (const extra of [{ status: 'unknown' }, { events: [{ id: 'e', from: 'todo', to: 'bad', at: 1 }] }]) {
    const { runtime, plans } = setup();
    runtime.storage.set('dayflow.records.v2', envelope('2026-10-30', 'music-guitar', modernRecord('2026-10-30', 'music-guitar', 'done', extra)));
    assert.throws(() => plans.saveTemplate(simpleTemplate(plans), DEFAULT_VERSION));
    assert.equal(runtime.storage.has('dayflow.plans.v1'), false);
  }
});

test('模板最终写入失败保留旧计划，已安全固化的历史快照可保留', () => {
  const { runtime, plans } = setup();
  runtime.storage.set('dayflow.records.v1', { '2026-10-30': { 'music-guitar': 'done' } });
  const write = runtime.wx.setStorageSync; runtime.wx.setStorageSync = (key, value) => { if (key === 'dayflow.plans.v1') throw new Error('quota'); write(key, value); };
  assert.throws(() => plans.saveTemplate(simpleTemplate(plans), DEFAULT_VERSION), /quota/);
  assert.equal(plans.getTemplate().version, DEFAULT_VERSION);
  assert.equal(plans.getDailyInstance('2026-10-30').locked, true);
});

test('自主应急方案恰好十五分钟，未执行可恢复，锁定或有记录时拒绝替换', () => {
  const { runtime, plans } = setup();
  const emergency = plans.setEmergencyPlan('2026-10-31', true), block = emergency.blocks.find(b => b.id === 'training');
  assert.equal(emergency.mode, 'emergency'); assert.equal(block.start, '17:30'); assert.equal(block.end, '17:45'); assert.equal(block.tasks[0].actions.length, 3);
  assert.equal(plans.setEmergencyPlan('2026-10-31', false).blocks.find(b => b.id === 'training').end, '18:30');
  runtime.storage.set('dayflow.records.v1', { '2026-10-31': { 'music-guitar': 'todo' } });
  assert.throws(() => plans.setEmergencyPlan('2026-10-31', true), /已有执行记录/);
  assert.throws(() => plans.setEmergencyPlan('2026-10-30', true), /已有执行记录/);
});

test('延期只经用户调用安排，保留来源状态、另找空档且相同来源目标不会重复生成', () => {
  const { runtime, plans } = setup(); const source = modernRecord('2026-10-30', 'music-guitar', 'deferred', { deferredTo: '2026-10-31' });
  runtime.storage.set('dayflow.records.v2', envelope(source.date, source.targetId, source));
  const first = plans.scheduleDeferredTarget(source.date, source.targetId, source.deferredTo);
  // Afternoon work begins at 13:00: the entire half-hour must move after it.
  assert.equal(first.start, '17:00'); assert.equal(first.end, '17:30');
  const second = plans.scheduleDeferredTarget(source.date, source.targetId, source.deferredTo);
  assert.deepEqual(clone(second), clone(first));
  assert.equal(plans.getTemplate().version, DEFAULT_VERSION + 1);
  assert.equal(runtime.storage.get('dayflow.records.v2').byDate[source.date][source.targetId].status, 'deferred');
});

test('延期训练保留训练分类，目标日锁定或无可用空档会明确拒绝', () => {
  const { runtime, plans } = setup();
  const source = modernRecord('2026-10-30', 'd5-step-1', 'deferred', { taskId: 'training-task', actionId: 'd5-step-1', deferredTo: '2026-10-31' });
  runtime.storage.set('dayflow.records.v2', envelope(source.date, source.targetId, source));
  const result = plans.scheduleDeferredTarget(source.date, source.targetId, source.deferredTo);
  const target = plans.getDayBlocks(result.date).find(block => block.actions.some(action => action.id === result.targetId));
  assert.equal(target.category, '训练');
  const other = setup(); other.runtime.storage.set('dayflow.records.v2', envelope(source.date, source.targetId, source)); other.plans.lockDailyInstance(source.deferredTo);
  assert.throws(() => other.plans.scheduleDeferredTarget(source.date, source.targetId, source.deferredTo), /已有执行记录/);
});

test('纯快照校验不写入且拒绝损坏结构', () => {
  const { runtime, plans } = setup();
  assert.throws(() => plans.validateInstances([]));
  assert.throws(() => plans.validateInstances({ '2026-02-30': {} }));
  assert.equal(runtime.storage.size, 0);
  const item = plans.getDailyInstance('2026-10-31'); const before = clone([...runtime.storage.entries()]);
  assert.doesNotThrow(() => plans.validateInstances({ '2026-10-31': item }));
  assert.deepEqual(clone([...runtime.storage.entries()]), before);
});

test('新版本空记录作为唯一权威，残留旧版今日及未来打卡不会重新锁住或复活完成', () => {
  const { runtime, plans } = setup();
  runtime.storage.set('dayflow.records.v1', { '2026-10-31': { 'music-guitar': 'done' }, '2026-11-01': { 'music-guitar': 'done' } });
  runtime.storage.set('dayflow.records.v2', { schemaVersion: 2, byDate: {} });
  plans.getDailyInstance('2026-11-01');
  plans.saveTemplate(simpleTemplate(plans), DEFAULT_VERSION);
  assert.equal(plans.getDailyInstance('2026-10-31').locked, false);
  assert.equal(plans.getDailyInstance('2026-11-01').locked, false);
  assert.equal(plans.getDayBlocks('2026-10-31')[0].id, 'custom-block');
  assert.equal(plans.getDayBlocks('2026-11-01')[0].id, 'custom-block');
  const records = runtime.load('miniprogram/services/records.ts');
  assert.equal(Object.keys(records.forDate('2026-10-31')).length, 0);
  assert.equal(Object.keys(records.forDate('2026-11-01')).length, 0);
  assert.equal(runtime.storage.get('dayflow.records.v1')['2026-10-31']['music-guitar'], 'done');
});

test('模板修改先锁定刚过期的派生快照，清理未执行未来缓存不会覆盖历史事实', () => {
  const { runtime, plans } = setup();
  const old = clone(plans.getDailyInstance('2026-11-01'));
  runtime.setNow(new Date(2026, 10, 2, 12));
  plans.saveTemplate(simpleTemplate(plans, { schedules: [] }), DEFAULT_VERSION);
  const saved = plans.getDailyInstance('2026-11-01');
  assert.equal(saved.locked, true); assert.deepEqual(clone(saved.blocks), old.blocks);
  assert.equal(plans.getDayBlocks('2026-11-03').length, 0);
});

test('目标日没有足够空档时不生成延期规则，也不改变来源记录', () => {
  const { runtime, plans } = setup();
  const source = modernRecord('2026-10-30', 'music-guitar', 'deferred', { deferredTo: '2026-10-31' });
  runtime.storage.set('dayflow.records.v2', envelope(source.date, source.targetId, source));
  const next = simpleTemplate(plans); next.schedules[0].blocks = [{ id: 'occupied', title: '整日占用', start: '00:00', end: '23:59', kind: 'fixed', category: '生活', tasks: [] }];
  plans.saveTemplate(next, DEFAULT_VERSION);
  assert.throws(() => plans.scheduleDeferredTarget(source.date, source.targetId, source.deferredTo), /没有足够空档/);
  assert.equal(plans.getTemplate().version, DEFAULT_VERSION + 1);
  assert.equal(runtime.storage.get('dayflow.records.v2').byDate[source.date][source.targetId].status, 'deferred');
});

test('用户主动简化选择在模板版本更新后仍保留，只在主动退出后恢复最新标准计划', () => {
  const { plans } = setup();
  plans.setEmergencyPlan('2026-10-31', true, 'training');
  const next = clone(plans.getTemplate());
  next.schedules.find(s => s.weekdays.includes(6)).blocks.find(b => b.id === 'work-morning').title = '新的工作标题';
  plans.saveTemplate(next, DEFAULT_VERSION);
  const kept = plans.getDailyInstance('2026-10-31');
  assert.equal(kept.mode, 'emergency'); assert.equal(kept.templateVersion, DEFAULT_VERSION + 1);
  assert.equal(kept.blocks.find(b => b.id === 'training').end, '17:45');
  assert.equal(kept.blocks.find(b => b.id === 'work-morning').title, '新的工作标题');
  const standard = plans.setEmergencyPlan('2026-10-31', false);
  assert.equal(standard.mode, 'standard'); assert.equal(standard.blocks.find(b => b.id === 'training').end, '18:30');
});

test('延期不能自动排到已选择简化覆盖的日期，不能返回成功却遗漏事项', () => {
  const { runtime, plans } = setup();
  const source = modernRecord('2026-10-30', 'music-guitar', 'deferred', { deferredTo: '2026-10-31' });
  runtime.storage.set('dayflow.records.v2', envelope(source.date, source.targetId, source));
  plans.setEmergencyPlan('2026-10-31', true);
  assert.throws(() => plans.scheduleDeferredTarget(source.date, source.targetId, source.deferredTo), /已选择简化方案/);
  assert.equal(plans.getTemplate().version, DEFAULT_VERSION);
});

test('多训练块明确保留用户选中的块，已经覆盖时不伪称另一个块已切换', () => {
  const { plans } = setup();
  const next = clone(plans.getTemplate()), saturday = next.schedules.find(s => s.weekdays.includes(6));
  saturday.blocks = saturday.blocks.filter(block => block.id !== 'overtime');
  saturday.blocks.push({ id: 'training-other', title: '另一训练', start: '20:00', end: '20:30', kind: 'sequence', category: '训练', tasks: [{ id: 'other-task', title: '另一训练', start: '20:00', end: '20:30', actions: [{ id: 'other-step', title: '自选活动', start: '20:00', end: '20:30' }] }] });
  plans.saveTemplate(next, DEFAULT_VERSION);
  const chosen = plans.setEmergencyPlan('2026-10-31', true, 'training-other');
  assert.equal(chosen.blocks.find(b => b.category === '训练').id, 'training-other');
  assert.equal(chosen.blocks.find(b => b.id === 'training-other').end, '20:15');
  assert.throws(() => plans.setEmergencyPlan('2026-10-31', true, 'training'), /另一训练块/);
});
