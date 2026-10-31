const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntime, clone } = require('./helpers/miniprogram');
const { minutesOf, endMinutesOf, timeState } = require('../miniprogram/utils/calendar');

const block = (id, start, end, kind = 'fixed') => ({ id, title: id, start, end, kind, category: '生活',
  tasks: kind === 'fixed' ? [] : [{ id: id + '-task', title: id, start, end, actions: [] }] });
const schedule = (id, blocks) => ({ id, title: id, weekdays: [1,2,3,4,5,6,0], effectiveFrom: '2026-11-01', exceptions: [], blocks });
const plan = schedules => ({ schemaVersion: 1, id: 'night-plan', name: '日末边界测试', version: 1, updatedAt: 0, schedules });
const plain = value => JSON.parse(JSON.stringify(value));
function modules() {
  const runtime = createRuntime();
  return { ...runtime.load('miniprogram/utils/plan-validation'), ...runtime.load('miniprogram/utils/planning-availability'),
    ...runtime.load('miniprogram/utils/wizard-state'), ...runtime.load('miniprogram/utils/plan-overwrite') };
}

test('24点只表示结束边界，实际时刻和开始时间保持严格', () => {
  assert.equal(endMinutesOf('24:00'), 1440);
  assert.equal(endMinutesOf('23:59'), 1439);
  assert.equal(endMinutesOf('00:00'), 0);
  for (const value of ['24:00', '24:01', '25:00', '00:60']) assert.throws(() => minutesOf(value));
  for (const value of ['24:01', '24:30', '25:00', 1440]) assert.throws(() => endMinutesOf(value));
  assert.equal(timeState('23:00', '24:00', 1439), 'current');
  assert.equal(timeState('23:00', '24:00', 1440), 'past');
  assert.equal(timeState('00:00', '08:00', 0), 'current');
  assert.equal(timeState('00:00', '08:00', 480), 'past');
});

test('模板、任务和步骤可以结束于24点，但不隐含跨日或允许24点起始', () => {
  const e = modules(), input = plan([schedule('night', [block('sleep', '23:00', '24:00'), block('early', '00:00', '08:00')])]);
  assert.equal(e.validatePlan(input).ok, true);
  const sequence = block('late-training', '23:00', '24:00', 'sequence');
  sequence.tasks[0].actions = [{ id: 'last-step', title: '最后一步', start: '23:59', end: '24:00' }];
  assert.equal(e.validatePlan(plan([schedule('late', [sequence])])).ok, true);
  for (const patch of [{start:'24:00',end:'24:00'}, {start:'23:00',end:'24:01'}, {start:'23:00',end:'08:00'}]) {
    const invalid = clone(input); Object.assign(invalid.schedules[0].blocks[0], patch);
    assert.equal(e.validatePlan(invalid).ok, false);
  }
  const invalidTask = clone(sequence); invalidTask.tasks[0].actions[0].start = '24:00';
  assert.equal(e.validatePlan(plan([schedule('late', [invalidTask])])).ok, false);
  const legacy = plan([schedule('old', [block('old', '23:00', '23:59')])]);
  assert.equal(e.validatePlan(legacy).ok, true);
});

test('午夜睡眠双段占用精确到整日末，不留下最后一分钟或吞掉08点衔接', () => {
  const e = modules(), sleep = schedule('sleep', [block('early', '00:00', '08:00'), block('night', '23:00', '24:00')]);
  const draft = schedule('new', [block('work', '08:00', '09:00')]);
  const availability = e.getBlockAvailability(plan([sleep]), draft, 'work');
  assert.deepEqual(plain(availability.freeWindows), [{start:'08:00',end:'23:00'}]);
  assert.equal(availability.allowedStarts.includes('07:59'), false);
  assert.equal(availability.allowedStarts.includes('08:00'), true);
  assert.equal(availability.allowedStarts.includes('23:59'), false);
  assert.equal(e.findScheduleConflicts(plan([sleep]), draft).length, 0);
  draft.blocks[0].start = '23:59'; draft.blocks[0].end = '24:00';
  assert.equal(e.findScheduleConflicts(plan([sleep]), draft).length, 1);
  assert.equal(e.getBlockAvailability(plan([sleep]), draft, 'work').proposedValid, false);
  const allDay = schedule('all-day', [block('all', '00:00', '24:00')]);
  assert.deepEqual(plain(e.getBlockAvailability(plan([allDay]), draft, 'work').freeWindows), []);
});

test('23点59到24点是可保存的一分钟空档，24点永远不是开始候选', () => {
  const e = modules(), draft = schedule('late', [block('last-minute', '23:59', '24:00')]);
  const availability = e.getBlockAvailability(plan([schedule('busy', [block('earlier', '00:00', '23:59')])]), draft, 'last-minute');
  assert.deepEqual(plain(availability.freeWindows), [{start:'23:59',end:'24:00'}]);
  assert.deepEqual(plain(availability.allowedStarts), ['23:59']);
  assert.deepEqual(plain(e.allowedEnds(availability, '23:59')), ['24:00']);
  assert.equal(availability.proposedValid, true);
  assert.equal(availability.suggestedStart, '23:59'); assert.equal(availability.suggestedEnd, '24:00');
  assert.deepEqual(plain(e.allowedEndMinutes(availability, 1440)), []);
});

test('结束选择器24点仅有00分，移动步骤可抵达但不能越过午夜', () => {
  const e = modules(), columns = e.timeColumns(['23:59','24:00'], '24:00');
  assert.deepEqual(plain(columns.range), [['23','24'],['00']]);
  assert.equal(e.selectedClock(columns.range, columns.indices), '24:00');
  assert.throws(() => e.timeColumns(['24:01'], '24:01'));
  assert.throws(() => e.selectedClock([['24'],['01']], [0,0]));
  assert.equal(e.clockFromMinute(1440), '24:00');
  assert.throws(() => e.clockFromMinute(1441));
  const rows = [{id:'step',start:'22:30',end:'23:00',title:'睡前整理'}];
  const moved = e.moveActionRows(rows, '22:00', '23:00', '23:00', '24:00', false);
  assert.equal(moved[0].start, '23:30'); assert.equal(moved[0].end, '24:00');
  assert.throws(() => e.moveActionRows(rows, '21:59', '23:00', '23:00', '24:00', false));
  assert.deepEqual(rows, [{id:'step',start:'22:30',end:'23:00',title:'睡前整理'}]);
});

test('午夜相邻不触发覆盖，最后一分钟重叠才替换完整夜间旧块', () => {
  const e = modules(), existing = plan([schedule('night', [block('night', '23:00', '24:00')])]);
  const adjacent = schedule('new', [block('prepare', '22:00', '23:00')]);
  assert.equal(e.prepareScheduleOverwrite(existing, adjacent).removed.length, 0);
  adjacent.blocks[0].start = '23:59'; adjacent.blocks[0].end = '24:00';
  const preview = e.prepareScheduleOverwrite(existing, adjacent);
  assert.equal(preview.removed.length, 1); assert.equal(preview.removed[0].end, '24:00');
  assert.equal(e.validatePlan(preview.template).ok, true);
});

test('云端共享校验与客户端一致接受日末睡眠和十五分钟应急边界', () => {
  const calendar = require('../cloudfunctions/dayflowSync/shared/calendar');
  const validator = require('../cloudfunctions/dayflowSync/shared/plan-validation');
  const {validateInstances} = require('../cloudfunctions/dayflowSync/shared/instance-validation');
  assert.equal(calendar.endMinutesOf('24:00'), 1440);
  assert.throws(() => calendar.minutesOf('24:00'));
  const sleep = plan([schedule('sleep', [block('sleep', '23:00', '24:00')])]);
  assert.equal(validator.validatePlan(sleep).ok, true);
  sleep.schedules[0].blocks[0].start = '24:00';
  assert.equal(validator.validatePlan(sleep).ok, false);
  const training = block('training', '23:45', '24:00', 'sequence');
  training.category = '训练';
  training.tasks[0].actions = [{ id: 'finish', title: '自主放松', start: '23:45', end: '24:00' }];
  const instance = {date:'2026-11-01',templateId:'night-plan',templateVersion:1,blocks:[training],locked:false,mode:'emergency',createdAt:0};
  assert.doesNotThrow(() => validateInstances({'2026-11-01':instance}));
  instance.blocks[0].end = '24:01';
  assert.throws(() => validateInstances({'2026-11-01':instance}));
});
