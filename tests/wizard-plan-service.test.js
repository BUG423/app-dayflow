const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntime, clone } = require('./helpers/miniprogram');

function block(id, title, start, end, checkable = true) {
  return { id, title, start, end, kind: checkable ? 'parallel' : 'fixed', category: '工作', tasks: checkable ? [{ id: id + '-task', title, start, end, actions: [] }] : [] };
}
function rule(id, title, weekdays, blocks, extra = {}) {
  return { id, title, weekdays, effectiveFrom: '2026-11-02', exceptions: [], blocks, ...extra };
}
function setup(rules, now) {
  const runtime = createRuntime(now);
  const plans = runtime.load('miniprogram/services/plans.ts');
  plans.saveTemplate({ ...plans.getTemplate(), schedules: clone(rules) }, plans.getTemplate().version);
  return { runtime, plans };
}
const stored = runtime => clone([...runtime.storage.entries()]);

test('扩大重复时仅为真正同日碰撞分离稳定标识，预览零写且不改其他规则', () => {
  const a = rule('a', '早间工作', [1], [block('shared', '工作', '08:00', '09:00')]);
  const b = rule('b', '后续安排', [2], [block('shared', '复盘', '09:00', '10:00')]);
  const { runtime, plans } = setup([a, b]);
  const version = plans.getTemplate().version, edited = clone(a); edited.weekdays.push(2);
  const before = stored(runtime), preview = plans.previewSchedule(edited, version), again = plans.previewSchedule(edited, version);
  assert.equal(preview.ok, true); assert.equal(preview.identityAdjusted, true);
  assert.notEqual(preview.schedule.blocks[0].id, a.blocks[0].id);
  assert.notEqual(preview.schedule.blocks[0].tasks[0].id, a.blocks[0].tasks[0].id);
  assert.deepEqual(clone(preview.schedule), clone(again.schedule));
  assert.deepEqual(stored(runtime), before);
  assert.deepEqual(edited, { ...a, weekdays: [1, 2] });
  const saved = plans.saveSchedule(edited, version);
  assert.deepEqual(clone(saved.schedules.find(item => item.id === 'b')), b);
  assert.deepEqual(clone(saved.schedules.find(item => item.id === 'a')), clone(preview.schedule));
  assert.equal(plans.previewImport(plans.exportTemplate()).ok, true);
});

test('普通改名和分属不同星期的复用标识保持原值，不全量重新编号', () => {
  const a = rule('a', '早间工作', [1], [block('shared', '工作', '08:00', '09:00')]);
  const b = rule('b', '另一天', [2], [block('shared', '工作', '08:00', '09:00')]);
  const { plans } = setup([a, b]); const edited = clone(a); edited.title = '新名称';
  const preview = plans.previewSchedule(edited);
  assert.equal(preview.ok, true); assert.equal(preview.identityAdjusted, false);
  assert.deepEqual(clone(preview.schedule.blocks), a.blocks);
});

test('只有一个执行步骤撞号时只分离该步骤，其他时间块和任务编号保持原值', () => {
  const a = rule('a', '早间练习', [1], [block('a-block', '练习', '08:00', '09:00')]);
  a.blocks[0].tasks[0].actions = [
    { id: 'shared-action', title: '练习第一部分', start: '08:00', end: '08:30' },
    { id: 'unique-action', title: '练习第二部分', start: '08:30', end: '09:00' }
  ];
  const b = rule('b', '后续练习', [2], [block('b-block', '复盘', '09:00', '10:00')]);
  b.blocks[0].tasks[0].actions = [{ id: 'shared-action', title: '复盘', start: '09:00', end: '10:00' }];
  const { plans } = setup([a, b]), edited = clone(a); edited.weekdays.push(2);
  const preview = plans.previewSchedule(edited);
  assert.equal(preview.ok, true); assert.equal(preview.identityAdjusted, true);
  assert.equal(preview.schedule.blocks[0].id, a.blocks[0].id);
  assert.equal(preview.schedule.blocks[0].tasks[0].id, a.blocks[0].tasks[0].id);
  assert.equal(preview.schedule.blocks[0].tasks[0].actions[1].id, 'unique-action');
  assert.notEqual(preview.schedule.blocks[0].tasks[0].actions[0].id, 'shared-action');
});

test('最终服务复查数月后才生效的重叠，错误明确日期名称和时间且零写', () => {
  const a = rule('a', '我的工作', [1], [block('a-block', '原工作', '08:00', '08:15')]);
  const b = rule('b', '二月的课程', [1], [block('b-block', '学习', '08:30', '09:30')], { effectiveFrom: '2027-02-01' });
  const { runtime, plans } = setup([a, b]); const edited = clone(a); edited.blocks[0].end = edited.blocks[0].tasks[0].end = '09:00';
  const before = stored(runtime), preview = plans.previewSchedule(edited);
  assert.equal(preview.ok, false); assert.ok(preview.conflicts.length > 0);
  assert.match(preview.errors.join(' '), /2027-02-01.*原工作.*08:00.*09:00.*二月的课程.*学习.*08:30.*09:30/);
  assert.throws(() => plans.saveSchedule(edited), /二月的课程/);
  assert.deepEqual(stored(runtime), before);
});

test('时间块和顺序步骤自动按起止排列，保留步骤标识、说明及分组', () => {
  const sequence = block('sequence', '训练', '08:00', '09:00'); sequence.kind = 'sequence';
  sequence.tasks = [{ id: 'training-task', title: '训练任务', start: '08:00', end: '09:00', actions: [
    { id: 'late', title: '后一步', start: '08:30', end: '09:00', description: '保留说明' },
    { id: 'early', title: '先一步', start: '08:00', end: '08:30' }
  ] }];
  const draft = rule('draft', '我的安排', [1], [block('late-block', '下午', '14:00', '15:00', false), sequence]);
  const { plans } = setup([]), preview = plans.previewSchedule(draft);
  assert.equal(preview.ok, true); assert.equal(preview.schedule.blocks[0].id, 'sequence');
  assert.deepEqual(Array.from(preview.schedule.blocks[0].tasks[0].actions, item => item.id), ['early', 'late']);
  assert.equal(preview.schedule.blocks[0].tasks[0].actions[1].description, '保留说明');
  plans.saveSchedule(draft, plans.getTemplate().version);
  assert.deepEqual(Array.from(plans.getDayBlocks('2026-11-02'), item => item.id), ['sequence', 'late-block']);
});

test('真正重叠的顺序步骤不能靠排序隐去，返回具体两步名称与起止', () => {
  const sequence = block('sequence', '训练', '08:00', '09:00'); sequence.kind = 'sequence';
  sequence.tasks = [{ id: 'training-task', title: '训练任务', start: '08:00', end: '09:00', actions: [
    { id: 'warm', title: '热身', start: '08:00', end: '08:30' },
    { id: 'move', title: '练习', start: '08:20', end: '09:00' }
  ] }];
  const { runtime, plans } = setup([]), before = stored(runtime);
  assert.throws(() => plans.saveSchedule(rule('draft', '早间训练', [1], [sequence])), /训练.*练习.*08:20.*09:00.*热身.*08:00.*08:30/);
  assert.deepEqual(stored(runtime), before);
});

test('内部标识分离不会改写锁定快照、原执行记录或延期来源', () => {
  const a = rule('a', '早间', [1], [block('shared', '工作', '08:00', '09:00')]);
  a.blocks[0].tasks[0].origin = { date: '2026-10-01', targetId: 'original-target' };
  const b = rule('b', '另一天', [2], [block('shared', '复盘', '09:00', '10:00')]);
  const { runtime, plans } = setup([a, b]);
  const snapshot = clone(plans.lockDailyInstance('2026-11-02'));
  const records = { schemaVersion: 2, byDate: { '2026-11-02': { 'shared-task': { date: '2026-11-02', targetId: 'shared-task', taskId: 'shared-task', status: 'done', updatedAt: 1, events: [] } } } };
  runtime.storage.set('dayflow.records.v2', records);
  const edited = clone(a); edited.weekdays.push(2);
  plans.saveSchedule(edited, plans.getTemplate().version);
  assert.deepEqual(clone(plans.getDailyInstance('2026-11-02')), snapshot);
  assert.deepEqual(runtime.storage.get('dayflow.records.v2'), records);
  assert.deepEqual(clone(plans.getTemplate().schedules[0].blocks[0].tasks[0].origin), a.blocks[0].tasks[0].origin);
  assert.notEqual(plans.getTemplate().schedules[0].blocks[0].tasks[0].id, 'shared-task');
});

test('特殊日期的顺序步骤错误对应实际日期与替换内容，不误指基础时段', () => {
  const sequence = block('exception-training', '周二训练', '08:00', '09:00'); sequence.kind = 'sequence';
  sequence.tasks = [{ id: 'training-task', title: '训练任务', start: '08:00', end: '09:00', actions: [
    { id: 'warm', title: '热身', start: '08:00', end: '08:30' },
    { id: 'move', title: '练习', start: '08:20', end: '09:00' }
  ] }];
  const draft = rule('draft', '工作日安排', [1], [block('base', '基础工作', '08:00', '09:00', false)], {
    exceptions: [{ date: '2026-11-03', kind: 'replace', blocks: [sequence] }]
  });
  const { plans } = setup([]), preview = plans.previewSchedule(draft);
  assert.equal(preview.ok, false); assert.match(preview.errors.join(' '), /2026-11-03.*周二训练.*练习.*08:20.*热身.*08:00/);
  assert.doesNotMatch(preview.errors.join(' '), /基础工作/);
});

test('未结束且未锁快照的计时目标不会被标识分离遗留，结束后可继续保存', () => {
  const a = rule('a', '早间', [1], [block('shared', '工作', '08:00', '09:00')]);
  const b = rule('b', '另一天', [2], [block('shared', '复盘', '09:00', '10:00')]);
  const { runtime, plans } = setup([a, b], new Date(2026, 10, 2, 8));
  plans.getDailyInstance('2026-11-02');
  const timer = runtime.load('miniprogram/services/timer.ts');
  timer.startTimer('2026-11-02', 'shared-task', 60);
  const edited = clone(a); edited.weekdays.push(2); const before = stored(runtime);
  assert.throws(() => plans.saveSchedule(edited), /计时/); assert.deepEqual(stored(runtime), before);
  timer.pauseTimer(); const paused = stored(runtime);
  assert.throws(() => plans.saveSchedule(edited), /计时/); assert.deepEqual(stored(runtime), paused);
  timer.resumeTimer();
  runtime.setNow(new Date(2026, 10, 2, 8, 2));
  assert.doesNotThrow(() => plans.saveSchedule(edited));
});

test('旧的其他重叠仍可读取，修复一个不相交的安排不被旧问题阻挡', () => {
  const a = rule('a', '旧工作', [1], [block('a-block', '工作', '08:00', '10:00')]);
  const b = rule('b', '旧课程', [1], [block('b-block', '课程', '09:00', '11:00')]);
  const c = rule('c', '午间', [1], [block('c-block', '阅读', '12:00', '13:00')]);
  const { plans } = setup([a, b, c]); assert.equal(plans.getTemplate().schedules.length, 3);
  const edited = clone(c); edited.blocks[0].start = edited.blocks[0].tasks[0].start = '14:00'; edited.blocks[0].end = edited.blocks[0].tasks[0].end = '15:00';
  assert.equal(plans.previewSchedule(edited).ok, true);
  assert.doesNotThrow(() => plans.saveSchedule(edited));
});

test('仅在既有锁定日期发生的时间重叠不阻止未来重复修改，预览不产生快照', () => {
  const a = rule('a', '未来重复', [1], [block('a-block', '早间工作', '08:00', '09:00')]);
  const once = rule('once', '仅锁定日课程', [1], [block('once-block', '课程', '10:00', '11:00')], { effectiveTo: '2026-11-02' });
  const { runtime, plans } = setup([a, once]);
  const locked = clone(plans.lockDailyInstance('2026-11-02')), edited = clone(a);
  edited.blocks[0].start = edited.blocks[0].tasks[0].start = '10:00';
  edited.blocks[0].end = edited.blocks[0].tasks[0].end = '11:00';
  const before = stored(runtime), preview = plans.previewSchedule(edited), availability = plans.getScheduleAvailability(edited, 'a-block');
  assert.equal(preview.ok, true); assert.equal(availability.proposedValid, true);
  assert.equal(plans.getScheduleConflicts(edited).length, 0);
  assert.ok(availability.allowedStarts.includes('10:00')); assert.deepEqual(stored(runtime), before);
  const imported = { ...plans.getTemplate(), schedules: [edited, once] };
  assert.equal(plans.previewImport(JSON.stringify(imported)).ok, true); assert.deepEqual(stored(runtime), before);
  plans.saveSchedule(edited, plans.getTemplate().version);
  assert.deepEqual(clone(plans.getDailyInstance('2026-11-02')), locked);
  assert.equal(plans.getDayBlocks('2026-11-09').find(item => item.id === 'a-block').start, '10:00');
});

test('首个重复日已锁定也必须检查下个真实重复日，有记录无快照同样只读保护', () => {
  const a = rule('a', '未来重复', [1], [block('a-block', '早间工作', '08:00', '09:00')]);
  const b = rule('b', '持续课程', [1], [block('b-block', '课程', '10:00', '11:00')]);
  const { runtime, plans } = setup([a, b]);
  runtime.storage.set('dayflow.records.v2', { schemaVersion: 2, byDate: { '2026-11-02': {
    'a-block-task': { date: '2026-11-02', targetId: 'a-block-task', taskId: 'a-block-task', status: 'done', updatedAt: 1, events: [] }
  } } });
  const edited = clone(a); edited.blocks[0].start = edited.blocks[0].tasks[0].start = '10:00';
  edited.blocks[0].end = edited.blocks[0].tasks[0].end = '11:00';
  const before = stored(runtime), preview = plans.previewSchedule(edited);
  assert.equal(preview.ok, false); assert.match(preview.errors.join(' '), /2026-11-09.*持续课程/);
  assert.match(plans.getScheduleConflicts(edited)[0].message, /2026-11-09.*持续课程/);
  assert.deepEqual(stored(runtime), before); assert.equal(runtime.storage.has('dayflow.instances.v1'), false);
  const availability = plans.getScheduleAvailability(edited, 'a-block');
  assert.equal(availability.proposedValid, false); assert.ok(!availability.allowedStarts.includes('10:00'));
  assert.deepEqual(stored(runtime), before);
});

test('单日锁定、损坏存储或过期版本均在服务层拒绝，预览不写派生数据', () => {
  const { runtime, plans } = setup([]);
  const draft = rule('new', '新任务', [6], [block('new-block', '新任务', '12:00', '13:00')], { effectiveFrom: '2026-10-31', effectiveTo: '2026-10-31' });
  plans.lockDailyInstance('2026-10-31'); const before = stored(runtime);
  assert.throws(() => plans.saveSchedule(draft), /已有记录|历史日期/); assert.deepEqual(stored(runtime), before);
  assert.equal(plans.previewSchedule(draft, plans.getTemplate().version - 1).ok, false); assert.deepEqual(stored(runtime), before);
  runtime.storage.set('dayflow.records.v2', { invalid: true }); const damaged = stored(runtime);
  assert.equal(plans.previewSchedule(draft).ok, false); assert.deepEqual(stored(runtime), damaged);
  const recurring = clone(draft); delete recurring.effectiveTo;
  assert.equal(plans.previewSchedule(recurring).ok, false); assert.deepEqual(stored(runtime), damaged);
});

test('新导入预览具名说明未来重叠，存量模板和版本恢复仍保持可读', () => {
  const a = rule('a', '早间工作', [1], [block('a-block', '工作', '08:00', '10:00')]);
  const b = rule('b', '学习计划', [1], [block('b-block', '学习', '09:00', '11:00')]);
  const { runtime, plans } = setup([a, b]), template = clone(plans.getTemplate()), before = stored(runtime);
  const preview = plans.previewImport(JSON.stringify(template));
  assert.equal(preview.ok, false);
  assert.match(preview.errors.join(' '), /2026-11-02.*学习.*09:00.*11:00.*早间工作.*工作.*08:00.*10:00/);
  assert.deepEqual(stored(runtime), before);
  assert.throws(() => plans.importTemplate(JSON.stringify(template)), /早间工作/);
  assert.deepEqual(stored(runtime), before);
  assert.doesNotThrow(() => plans.getTemplate());
  assert.doesNotThrow(() => plans.saveTemplate(template, template.version));
});

test('导入中重复的同日编号明确作为模板问题，不提示用户操作内部执行目标', () => {
  const a = rule('a', '早间', [1], [block('shared', '工作', '08:00', '09:00')]);
  const b = rule('b', '下午', [2], [block('shared', '学习', '14:00', '15:00')]);
  const { plans } = setup([a, b]), template = clone(plans.getTemplate()); template.schedules[1].weekdays = [1];
  const preview = plans.previewImport(JSON.stringify(template));
  assert.equal(preview.ok, false); assert.match(preview.errors.join(' '), /导入模板.*同一天.*编号/);
  assert.doesNotMatch(preview.errors.join(' '), /执行目标标识/);
});
