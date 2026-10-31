const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntime, clone } = require('./helpers/miniprogram');
const event = (field, value) => ({ currentTarget: { dataset: { field } }, detail: { value } });
const choose = (page, index) => page.onChooseRepeat({ currentTarget: { dataset: { index } } });
const fixed = (id, start = '09:00', end = '12:00') => ({ id, title: id, start, end, kind: 'fixed', category: '工作', tasks: [] });
function fixture(schedules = []) {
  const runtime = createRuntime(), plans = runtime.load('miniprogram/services/plans');
  const template = clone(plans.getTemplate()); template.schedules = schedules;
  plans.saveTemplate(template, template.version);
  const page = runtime.page('plans'); page.onShow();
  return { runtime, plans, page };
}
function finish(page) {
  while (page.data.editorStep < 3) { const before = page.data.editorStep; page.onWizardNext(); assert.notEqual(page.data.editorStep, before, page.data.wizardError); }
  page.onSaveSchedule(); assert.equal(page.data.editorVisible, false, page.data.wizardError);
}

test('周重复跟随安排日期，周三改周四会更新名称与真实星期，最终才保存', () => {
  const { runtime, page, plans } = fixture(); page.onCreateSchedule();
  page.onEditorInput(event('title', '每周整理')); page.onEditorInput(event('effectiveFrom', '2026-11-04'));
  assert.equal(page.data.repeatChoices.find(item => item.value === 4).label, '每周三');
  const before = clone([...runtime.storage]); choose(page, 4);
  assert.deepEqual(clone(page.data.selectedWeekdays), [3]); assert.equal(page.data.effectiveTo, '');
  assert.equal(page.data.summaryRows.find(item => item.label === '重复').value, '每周三');
  page.onEditorInput(event('effectiveFrom', '2026-11-05'));
  assert.deepEqual(clone(page.data.selectedWeekdays), [4]);
  assert.equal(page.data.repeatChoices.find(item => item.value === 4).label, '每周四');
  assert.equal(page.data.summaryRows.find(item => item.label === '重复').value, '每周四');
  assert.deepEqual(clone([...runtime.storage]), before);
  finish(page);
  const saved = plans.getTemplate().schedules.find(item => item.title === '每周整理');
  assert.deepEqual(clone(saved.weekdays), [4]); assert.equal(saved.effectiveFrom, '2026-11-05'); assert.equal(saved.effectiveTo, undefined);
});

test('工作日和非工作日有固定星期语义，每天与自选星期继续兼容', () => {
  const { page, plans, runtime } = fixture(); page.onCreateSchedule(); page.onEditorInput(event('title', '周末练习'));
  choose(page, 2); assert.deepEqual(clone(page.data.selectedWeekdays), [1,2,3,4,5]);
  assert.equal(page.data.summaryRows.find(item => item.label === '重复').value, '工作日');
  choose(page, 1); assert.deepEqual(clone(page.data.selectedWeekdays), [1,2,3,4,5,6,0]);
  choose(page, 5); assert.deepEqual(clone(page.data.selectedWeekdays), [6,0]);
  assert.equal(page.data.summaryRows.find(item => item.label === '重复').value, '非工作日');
  assert.match(page.data.repeatWorkdayHint, /周一至周五.*周六、周日/);
  finish(page); const saved = plans.getTemplate().schedules.find(item => item.title === '周末练习');
  const editor = runtime.load('miniprogram/utils/plan-editor'); assert.equal(editor.repeatMode(saved), 5);
  assert.deepEqual(clone(editor.repeatWeekdays(3, '2026-11-04', [1,3,5])), [1,3,5]);
});

test('旧单星期重复按实际星期显示，生效起点不同也不误改原期限或日期调整', () => {
  const old = { id: 'old-weekly', title: '周三安排', weekdays: [3], effectiveFrom: '2000-01-01', effectiveTo: '2026-12-31', blocks: [fixed('old-am')],
    exceptions: [{ date: '2026-11-04', kind: 'skip' }, { date: '2026-11-11', kind: 'replace', blocks: [fixed('old-extra', '13:00', '14:00')] }] };
  const { page, plans } = fixture([old]); page.onEditSchedule({ currentTarget: { dataset: { id: old.id } } });
  assert.equal(page.data.repeatModeIndex, 4); assert.equal(page.data.repeatChoices.find(item => item.value === 4).label, '每周三');
  assert.equal(page.data.summaryRows.find(item => item.label === '重复').value, '每周三');
  finish(page); assert.deepEqual(clone(plans.getTemplate().schedules.find(item => item.id === old.id)), old);
});

test('周重复日期改动使覆盖许可失效，旧弹窗不能确认新日期范围', () => {
  const old = { id: 'existing', title: '原周三工作', weekdays: [3], effectiveFrom: '2026-01-01', blocks: [fixed('old-work')], exceptions: [] };
  const { page, runtime } = fixture([old]); page.onCreateSchedule(); page.onEditorInput(event('title', '新周安排'));
  page.onEditorInput(event('effectiveFrom', '2026-11-04')); choose(page, 4); page.applyTimeWindow('08:00', '12:00');
  const modal = runtime.calls.modals.at(-1); assert.equal(modal.title, '替换已有安排？'); modal.success({ confirm: true });
  assert.equal(page.data.overwriteConfirmed, true); const before = clone([...runtime.storage]);
  page.onEditorInput(event('effectiveFrom', '2026-11-05'));
  assert.equal(page.data.overwriteConfirmed, false); assert.equal(page.overwriteApproval, null);
  modal.success({ confirm: true }); assert.equal(page.data.overwriteConfirmed, false);
  assert.deepEqual(clone([...runtime.storage]), before); assert.deepEqual(clone(page.data.selectedWeekdays), [4]);
});

test('固定安排可由结束选择器保存24点，开始选择器仍不接受24点', () => {
  const { page, plans } = fixture(); page.onCreateSchedule(); page.onEditorInput(event('title', '晚间睡眠')); page.onCheckableChange(event('', false));
  page.applyTimeWindow('23:00', '23:30');
  assert.equal(page.data.startTimeRange[0].includes('24'), false);
  page.onStartTimeChange(event('', [24,0])); assert.equal(page.data.start, '23:00');
  const hour = page.data.endTimeRange[0].indexOf('24'); assert.ok(hour >= 0);
  page.onEndTimeColumnChange({ detail: { column: 0, value: hour } });
  assert.deepEqual(clone(page.data.endTimeRange[1]), ['00']);
  page.onEndTimeChange(event('', [hour,0])); assert.equal(page.data.end, '24:00');
  assert.equal(page.wizardStepError(1), ''); finish(page);
  const saved = plans.getTemplate().schedules.find(item => item.title === '晚间睡眠');
  assert.equal(saved.blocks[0].start, '23:00'); assert.equal(saved.blocks[0].end, '24:00');
  assert.equal(saved.blocks[0].kind, 'fixed'); assert.deepEqual(clone(saved.blocks[0].tasks), []);
});

test('游泳显示独立配色且保留训练统计，前往泳池不误分为训练', () => {
  const runtime = createRuntime(new Date(2026, 10, 3, 17, 30)), page = runtime.page('today'); page.onLoad();
  const swimming = page.data.blocks.find(block => block.id === 'training');
  assert.equal(swimming.colorCategory, 'swim'); assert.equal(swimming.category, '训练');
  assert.equal(page.data.blocks.find(block => block.id === 'swim-commute').colorCategory, 'life');
  const insights = runtime.load('miniprogram/services/insights');
  const today = insights.getWeeklySummary('2026-11-03').days.find(day => day.date === '2026-11-03');
  assert.equal(today.trainingTotal, swimming.actions.length); assert.ok(today.trainingTotal > 0);
  page.choose('2026-11-04');
  assert.equal(page.data.blocks.find(block => block.id === 'training').colorCategory, 'training');
});
