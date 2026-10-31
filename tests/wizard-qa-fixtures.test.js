const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { createRuntime } = require('./helpers/miniprogram');
const { wizardPayload, seedWizard } = require('../scripts/wizard-acceptance-fixtures');

const date = '2026-10-31', at = new Date(2026, 9, 31, 12, 4).getTime();
function runtime(scenario = 'basic') {
  const run = createRuntime(new Date(at));
  const payload = wizardPayload(date, at, scenario);
  Object.entries(payload.values).forEach(([key, value]) => run.storage.set(key, value));
  return { ...run, payload };
}
test('全部向导合成模型通过真实模板、记录及快照校验', () => {
  for (const scenario of ['basic', 'full', 'identity', 'rest', 'overwrite', 'siblings']) {
    const run = runtime(scenario);
    const result = run.load('miniprogram/utils/plan-validation.ts').validatePlan(run.payload.values['dayflow.plans.v1']);
    assert.equal(result.ok, true, result.errors.join(';'));
    run.load('miniprogram/utils/record-validation.ts').validateEnvelope(run.payload.values['dayflow.records.v2']);
    const plans = run.load('miniprogram/services/plans.ts');
    plans.validateInstances(run.payload.values['dayflow.instances.v1']);
    assert.equal(plans.getTemplate().name, '合成向导验收计划');
    assert.equal(plans.getDailyInstance(run.payload.historyDate).locked, true);
    if (scenario === 'rest') assert.equal(run.payload.values['dayflow.instances.v1'][date].locked, true, 'rest case must preserve an executed day');
    else assert.equal(run.payload.values['dayflow.instances.v1'][date], undefined, 'wizard case must remain editable');
  }
});
test('底层空档分析 fixture 保留12点边界及60天后的真实重复冲突', () => {
  const run = runtime(), template = run.payload.values['dayflow.plans.v1'];
  const engine = run.load('miniprogram/utils/planning-availability.ts');
  const block = { id: 'candidate-block', title: '午间练习', start: '12:00', end: '12:30', kind: 'fixed', category: '生活', tasks: [] };
  const draft = { id: 'candidate', title: '午间练习', weekdays: [6], effectiveFrom: date, effectiveTo: date, exceptions: [], blocks: [block] };
  let result = engine.getBlockAvailability(template, draft, block.id, { notBefore: date });
  assert.equal(result.proposedValid, true);
  assert.ok(result.allowedStarts.includes('12:00'));
  assert.equal(result.allowedStarts.some(time => time >= '08:00' && time < '12:00'), false);
  assert.ok(engine.allowedEnds(result, '12:00').includes('13:00'));
  assert.equal(engine.allowedEnds(result, '12:00').includes('13:01'), false);
  const recurring = { ...draft, weekdays: [0, 1, 2, 3, 4, 5, 6] }; delete recurring.effectiveTo;
  result = engine.getBlockAvailability(template, recurring, block.id, { notBefore: date });
  assert.equal(result.proposedValid, false);
  assert.ok(result.conflicts.some(item => item.date === run.payload.futureDate && item.title === '两个月后会议' && item.start === '12:00' && item.end === '13:00'));
  assert.equal(result.allowedStarts.includes('12:00'), false);
});
test('无空档与复杂编辑 fixture 分别覆盖空候选及保留兄弟占用', () => {
  const full = runtime('full'), engine = full.load('miniprogram/utils/planning-availability.ts');
  const draft = { id: 'candidate', title: '新增', weekdays: [6], effectiveFrom: date, effectiveTo: date, exceptions: [], blocks: [{ id: 'new-block', title: '新增', start: '12:00', end: '12:30', kind: 'fixed', category: '生活', tasks: [] }] };
  assert.equal(engine.getBlockAvailability(full.payload.values['dayflow.plans.v1'], draft, 'new-block', { notBefore: date }).allowedStarts.length, 0);
  const basic = runtime(), template = basic.payload.values['dayflow.plans.v1'], complex = template.schedules.find(s => s.id === 'wizard-complex');
  const available = basic.load('miniprogram/utils/planning-availability.ts').getBlockAvailability(template, complex, 'wizard-sequence', { notBefore: date });
  assert.ok(available.allowedStarts.includes('20:00'));
  assert.equal(available.allowedStarts.includes('20:30'), false);
  assert.ok(available.busy.some(item => item.title === '睡前阅读'));
  const siblings = runtime('siblings'), siblingTemplate = siblings.payload.values['dayflow.plans.v1'];
  const siblingGap = siblings.load('miniprogram/utils/planning-availability.ts').getBlockAvailability(siblingTemplate, siblingTemplate.schedules[0], 'wizard-selected', { notBefore: date });
  assert.equal(siblingGap.allowedStarts.length, 0, 'an occupying sibling is never an external overwrite candidate');
});
test('fixture 构造先拒绝无效日期/时间，注入仅替换 Dayflow 前缀且中文完整', () => {
  for (const invalid of ['2026-02-30', '2026-1-01', 'not-a-date']) assert.throws(() => wizardPayload(invalid, at));
  for (const invalid of [NaN, Infinity, 0]) assert.throws(() => wizardPayload(date, invalid));
  assert.throws(() => wizardPayload(date, at, 'unknown'));
  const storage = new Map([['other.app', { keep: true }], ['dayflow.synthetic-old', 'remove']]);
  const wx = { getStorageInfoSync: () => ({ keys: [...storage.keys()] }), removeStorageSync: k => storage.delete(k), setStorageSync: (k, v) => storage.set(k, v) };
  const seed = vm.runInNewContext('(' + seedWizard.toString() + ')', { wx });
  assert.throws(() => seed({ date, values: { 'other.app': {} } }));
  assert.equal(storage.get('dayflow.synthetic-old'), 'remove', 'invalid payload must not start deleting');
  assert.equal(seed(wizardPayload(date, at)).seeded, true);
  assert.deepEqual(storage.get('other.app'), { keep: true });
  assert.equal(storage.has('dayflow.synthetic-old'), false);
  assert.equal(storage.get('dayflow.plans.v1').schedules[0].title, '上午工作');
  assert.match(seedWizard.toString(), /^[\x00-\x7f]*$/);
});
test('验收 fixture 经真实页面事件可完成重复冲突修复并保留已有日期调整', () => {
  const run = runtime(), page = run.page('plans'); page.onShow();
  const input = (field, value) => page.onEditorInput({ currentTarget: { dataset: { field } }, detail: { value } });
  const choose = (which, value) => {
    const [hour, minute] = value.split(':'), hi = page.data[which + 'TimeRange'][0].indexOf(hour);
    assert.ok(hi >= 0, `missing ${which} hour ${value}`);
    page[which === 'start' ? 'onStartTimeColumnChange' : 'onEndTimeColumnChange']({ detail: { column: 0, value: hi } });
    const mi = page.data[which + 'TimeRange'][1].indexOf(minute); assert.ok(mi >= 0, `missing minute ${value}`);
    page[which === 'start' ? 'onStartTimeChange' : 'onEndTimeChange']({ detail: { value: [hi, mi] } });
    assert.equal(page.data[which], value);
  };
  page.onCreateSchedule(); input('title', '合成午间练习'); page.onWizardNext(); choose('start', '12:00'); choose('end', '12:30'); page.onWizardNext();
  assert.equal(page.data.editorStep, 2);
  page.onChooseRepeat({ currentTarget: { dataset: { index: 1 } } });
  assert.ok(page.data.overwriteRows.some(c => c.title === '两个月后会议'));
  assert.equal(page.data.overwriteRequired, true);
  run.calls.modals.at(-1).success({ confirm: false, cancel: true });
  page.onWizardBack(); assert.equal(page.data.startTimeRange[0].includes('12'), true, 'external occupation remains selectable with explicit replacement');
  page.onWizardStep({ currentTarget: { dataset: { step: 2 } } }); assert.equal(page.data.editorStep, 2);
  page.onChooseRepeat({ currentTarget: { dataset: { index: 0 } } }); page.onWizardNext(); assert.equal(page.data.editorStep, 3);
  page.onSaveSchedule(); assert.equal(page.data.editorVisible, false);
  const historyBefore = JSON.stringify(run.storage.get('dayflow.instances.v1')[run.payload.historyDate]);
  const original = run.payload.values['dayflow.plans.v1'].schedules.find(s => s.id === 'wizard-complex');
  page.onEditSchedule({ currentTarget: { dataset: { id: 'wizard-complex' } } });
  assert.equal(page.data.advancedVisible, false);
  page.onWizardNext(); page.onWizardNext(); page.onWizardNext();
  assert.equal(page.data.editorStep, 3); assert.equal(page.data.reviewExceptions.length, 2);
  page.onSaveSchedule(); assert.equal(page.data.editorVisible, false);
  const saved = run.storage.get('dayflow.plans.v1').schedules.find(s => s.id === original.id);
  assert.equal(JSON.stringify(saved.blocks), JSON.stringify(original.blocks));
  assert.equal(JSON.stringify(saved.exceptions), JSON.stringify(original.exceptions));
  assert.equal(JSON.stringify(run.storage.get('dayflow.instances.v1')[run.payload.historyDate]), historyBefore);
});

test('覆盖 fixture 经真实页面事件一次确认五个工作日，改范围重新确认且最终才保存', () => {
  const run = runtime('overwrite'), page = run.page('plans'); page.onShow();
  const initial = JSON.stringify([...run.storage.entries()]);
  page.onCreateSchedule();
  page.onEditorInput({ currentTarget: { dataset: { field: 'title' } }, detail: { value: '每天上午集中安排' } });
  page.onWizardNext();
  page.onEditorInput({ currentTarget: { dataset: { field: 'effectiveFrom' } }, detail: { value: run.payload.sundayDate } });
  const choose = (which, value) => {
    const [hour, minute] = value.split(':'), hi = page.data[which + 'TimeRange'][0].indexOf(hour);
    page[which === 'start' ? 'onStartTimeColumnChange' : 'onEndTimeColumnChange']({ detail: { column: 0, value: hi } });
    const mi = page.data[which + 'TimeRange'][1].indexOf(minute);
    page[which === 'start' ? 'onStartTimeChange' : 'onEndTimeChange']({ detail: { value: [hi, mi] } });
    assert.equal(page.data[which], value);
  };
  choose('start', '08:00'); choose('end', '12:00'); page.onWizardNext();
  const repeat = index => page.onChooseRepeat({ currentTarget: { dataset: { index } } });
  repeat(1); const confirmation = run.calls.modals.at(-1);
  assert.match(confirmation.content, /上午工作/); assert.match(confirmation.content, /09:00/); assert.match(confirmation.content, /12:00/);
  confirmation.success({ confirm: true, cancel: false });
  assert.equal(page.data.overwriteConfirmed, true);
  assert.equal(page.data.overwriteRows.length, 1);
  assert.equal(page.data.overwriteRows[0].weekdays.length, 5);
  assert.equal(JSON.stringify([...run.storage.entries()]), initial);
  repeat(2); run.calls.modals.at(-1).success({ confirm: false, cancel: true });
  assert.equal(page.data.overwriteConfirmed, false);
  assert.equal(JSON.stringify([...run.storage.entries()]), initial);
  repeat(1); run.calls.modals.at(-1).success({ confirm: true, cancel: false });
  page.onWizardNext(); assert.equal(page.data.editorStep, 3);
  assert.equal(JSON.stringify([...run.storage.entries()]), initial);
  page.onSaveSchedule(); assert.equal(page.data.editorVisible, false);
  const saved = run.storage.get('dayflow.plans.v1');
  assert.equal(saved.version, 2);
  const plans = run.load('miniprogram/services/plans.ts');
  for (let day = 1; day <= 5; day++) {
    const key = run.load('miniprogram/utils/calendar').shiftDays(run.payload.sundayDate, day);
    const blocks = plans.getDayBlocks(key);
    assert.equal(blocks.some(b => b.id === 'wizard-weekday-am' || b.title === '上午工作'), false);
    assert.equal(blocks.filter(b => b.id === 'wizard-weekday-pm' && b.start === '14:00' && b.end === '18:00').length, 1);
  }
  assert.equal(JSON.stringify(saved.schedules.find(s => s.id === 'wizard-unrelated')), JSON.stringify(run.payload.values['dayflow.plans.v1'].schedules.find(s => s.id === 'wizard-unrelated')));
  assert.equal(JSON.stringify(run.storage.get('dayflow.records.v2')), JSON.stringify(run.payload.values['dayflow.records.v2']));
  assert.equal(JSON.stringify(run.storage.get('dayflow.instances.v1')[run.payload.historyDate]), JSON.stringify(run.payload.values['dayflow.instances.v1'][run.payload.historyDate]));
});

test('编辑fixture经真实页面区分可确认替换的外部占用与不可替换的同组兄弟', () => {
  const run = runtime(), page = run.page('plans'); page.onShow();
  const before = JSON.stringify([...run.storage.entries()]);
  page.onEditSchedule({ currentTarget: { dataset: { id: 'wizard-work-am' } } }); page.onWizardNext();
  assert.equal(page.data.editorStep, 1);
  assert.equal(page.data.startTimeRange[0].includes('08'), true);
  assert.equal(page.data.startTimeRange[0].includes('14'), true, 'external work time is selectable for explicit replacement');
  assert.equal(page.data.occupiedSlots.some(item => item.title === '上午工作'), false, 'self is not listed as an external occupation');
  assert.ok(page.data.occupiedSlots.some(item => item.title === '下午工作' && item.start === '14:00' && item.end === '18:00'));
  assert.equal(JSON.stringify([...run.storage.entries()]), before);
  const complex = runtime(), detail = complex.page('plans'); detail.onShow();
  detail.onEditSchedule({ currentTarget: { dataset: { id: 'wizard-complex' } } }); detail.onWizardNext();
  assert.equal(detail.data.startTimeRange[0].includes('20'), true);
  assert.ok(detail.data.occupiedSlots.some(item => item.title === '睡前阅读' && item.start === '20:30'));
  const hour = detail.data.startTimeRange[0].indexOf('20');
  detail.onStartTimeColumnChange({ detail: { column: 0, value: hour } });
  assert.equal(detail.data.startTimeRange[1].includes('30'), false, 'sibling busy minutes are still disabled');
});

test('休息 fixture 含真实执行记录和倒计时，可停止进行中事项且完整保留已完成与历史', () => {
  const run = runtime('rest'), rests = run.load('miniprogram/services/rest-days.ts');
  const plansBefore = JSON.stringify(run.storage.get('dayflow.plans.v1'));
  const snapshotsBefore = JSON.stringify(run.storage.get('dayflow.instances.v1'));
  const recordsBefore = run.storage.get('dayflow.records.v2');
  const doneBefore = JSON.stringify(recordsBefore.byDate[date]['wizard-action-a']);
  const historicalBefore = JSON.stringify(recordsBefore.byDate[run.payload.historyDate]);
  rests.startRestToday('合成验收：今天休息');
  const recordsAfter = run.storage.get('dayflow.records.v2');
  assert.equal(recordsAfter.byDate[date]['wizard-action-b'].status, 'aborted');
  assert.equal(recordsAfter.byDate[date]['wizard-action-b'].events.at(-1).to, 'aborted');
  assert.equal(recordsAfter.byDate[date]['wizard-action-c'], undefined, 'todo must not become fabricated skipped records');
  assert.equal(JSON.stringify(recordsAfter.byDate[date]['wizard-action-a']), doneBefore);
  assert.equal(JSON.stringify(recordsAfter.byDate[run.payload.historyDate]), historicalBefore);
  assert.equal(JSON.stringify(run.storage.get('dayflow.plans.v1')), plansBefore);
  assert.equal(JSON.stringify(run.storage.get('dayflow.instances.v1')), snapshotsBefore);
  assert.equal(run.storage.get('dayflow.timer.v1').status, 'paused');
  rests.resumeToday();
  assert.equal(rests.getDayRest(date).active, false);
  assert.equal(run.storage.get('dayflow.timer.v1').status, 'paused');
  assert.equal(run.storage.get('dayflow.records.v2').byDate[date]['wizard-action-b'].status, 'aborted');
});
