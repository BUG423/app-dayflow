const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntime, clone } = require('./helpers/miniprogram');
const event = (field, value) => ({ currentTarget: { dataset: { field } }, detail: { value } });
const tap = dataset => ({ currentTarget: { dataset } });
function fixture() {
  const runtime = createRuntime(), plans = runtime.load('miniprogram/services/plans');
  const template = clone(plans.getTemplate());
  template.schedules = Array.from({ length: 7 }, (_, day) => ({ id: 'work-' + day, title: ['周日','周一','周二','周三','周四','周五','周六'][day] + '安排',
    weekdays: [day], effectiveFrom: '2026-10-01', exceptions: [], blocks: [
      { id: 'am-' + day, title: '上午工作', start: '09:00', end: '12:00', kind: 'fixed', category: '工作', tasks: [] },
      { id: 'pm-' + day, title: '下午工作', start: '13:00', end: '18:00', kind: 'fixed', category: '工作', tasks: [] }
    ] }));
  plans.saveTemplate(template, template.version);
  const page = runtime.page('plans'); page.onShow(); page.onCreateSchedule(); page.onEditorInput(event('title', '新的上午安排'));
  return { runtime, plans, page };
}
function confirm(runtime, answer = true) { const modal = runtime.calls.modals.at(-1); assert.equal(modal.title, '替换已有安排？'); modal.success({ confirm: answer }); }
function review(page) { for (let i = 0; i < 3 && page.data.editorStep < 3; i++) page.onWizardNext(); assert.equal(page.data.editorStep, 3, page.data.wizardError); }

test('每天8到12一次确认七天完整旧时段，最终保存才覆盖且下午仍保留', () => {
  const { runtime, plans, page } = fixture(), before = clone([...runtime.storage]);
  page.onRepeatModeChange(event('', 1)); page.applyTimeWindow('08:00', '12:00');
  assert.equal(runtime.calls.modals.length, 1); const modal = runtime.calls.modals[0];
  assert.equal(modal.confirmText, '替换安排'); assert.equal(modal.cancelText, '返回调整');
  assert.match(modal.content, /7个完整旧时段/); assert.match(modal.content, /上午工作.*09:00–12:00/);
  for (const day of ['周日','周一','周二','周三','周四','周五','周六']) assert.ok(modal.content.includes(day));
  confirm(runtime); assert.equal(page.data.overwriteConfirmed, true); assert.equal(page.data.overwriteRequired, false);
  page.refreshWizard(); page.refreshWizard(); assert.equal(runtime.calls.modals.length, 1);
  assert.deepEqual(clone([...runtime.storage]), before); review(page); page.onSaveSchedule(); assert.equal(page.data.editorVisible, false);
  const endedPrefixes = plans.getTemplate().schedules.filter(item => item.effectiveTo && item.effectiveTo < '2026-10-31');
  assert.ok(endedPrefixes.length > 0, '覆盖保留过去规则段');
  for (const prefix of endedPrefixes) assert.ok(!page.data.schedules.some(item => item.id === prefix.id), '过期前缀不会重复堆在当前安排列表');
  for (const date of ['2026-11-01','2026-11-02','2026-11-03','2026-11-04','2026-11-05','2026-11-06','2026-11-07']) {
    const blocks = plans.getDayBlocks(date);
    assert.ok(blocks.some(block => block.title === '新的上午安排' && block.start === '08:00' && block.end === '12:00'));
    assert.ok(!blocks.some(block => block.title === '上午工作'));
    assert.ok(blocks.some(block => block.title === '下午工作' && block.start === '13:00' && block.end === '18:00'));
  }
});

test('取消覆盖或尚未确认直接保存均零写，草稿可继续调整', () => {
  const { runtime, page } = fixture(), before = clone([...runtime.storage]);
  page.onRepeatModeChange(event('', 1)); page.applyTimeWindow('08:00', '12:00'); confirm(runtime, false);
  assert.equal(page.data.overwriteRequired, true); assert.equal(page.data.overwriteConfirmed, false);
  page.onSaveSchedule(); assert.equal(page.data.editorVisible, true); assert.deepEqual(clone([...runtime.storage]), before);
  page.onConfirmOverwrite(); confirm(runtime); assert.equal(page.data.overwriteConfirmed, true); assert.deepEqual(clone([...runtime.storage]), before);
  page.onCloseEditor(); page.onResumeDraft(); assert.equal(page.data.start, '08:00'); assert.equal(page.data.overwriteConfirmed, true);
});

test('确认后改时间或重复会让许可失效，旧弹窗回调不能确认新范围', () => {
  const { runtime, page } = fixture(); page.onRepeatModeChange(event('', 1)); page.applyTimeWindow('08:00', '12:00');
  const oldModal = runtime.calls.modals.at(-1); confirm(runtime); assert.equal(page.data.overwriteConfirmed, true);
  page.applyTimeWindow('08:30', '12:00'); assert.equal(page.data.overwriteConfirmed, false); assert.equal(page.data.overwriteRequired, true);
  oldModal.success({ confirm: true }); assert.equal(page.data.overwriteConfirmed, false);
  // A fresh, explicit confirmation belongs to the changed draft only.
  const latest = runtime.calls.modals.at(-1); latest.success({ confirm: true }); assert.equal(page.data.overwriteConfirmed, true);
  page.onRepeatModeChange(event('', 2)); assert.equal(page.data.overwriteConfirmed, false); assert.equal(page.data.overwriteRequired, true);
});

test('确认后模板版本变化仍拒绝保存并保留全部当前事实', () => {
  const { runtime, page, plans } = fixture(); page.onRepeatModeChange(event('', 1)); page.applyTimeWindow('08:00', '12:00'); confirm(runtime); review(page);
  const template = clone(plans.getTemplate()); template.name = '另一个窗口更新'; plans.saveTemplate(template, template.version);
  const before = clone([...runtime.storage]); page.onSaveSchedule();
  assert.equal(page.data.editorVisible, true); assert.equal(page.data.overwriteConfirmed, false); assert.match(page.data.wizardError, /已更新/);
  assert.deepEqual(clone([...runtime.storage]), before);
});

test('可见12到13空档与空闲建议点击均使用真正显示的范围', () => {
  const { page } = fixture(); page.onWizardNext();
  const index = page.data.freeWindows.findIndex(item => item.start === '12:00' && item.end === '13:00'); assert.ok(index >= 0);
  page.onChooseFreeWindow(tap({ index })); assert.equal(page.data.start, '12:00'); assert.equal(page.data.end, '12:30');
  page.applyTimeWindow('08:00','12:00');
  const displayed = page.suggestedWindow; assert.ok(displayed);
  page.onChooseSuggestedTime(); assert.equal(page.data.start, displayed.start); assert.equal(page.data.end, displayed.end);
});

test('覆盖只处理外部安排，同组兄弟占用仍不可选择，生成目标标识稳定', () => {
  const { runtime, page } = fixture();
  const before = JSON.stringify(page.scheduleDraft()); page.refreshWizard(); assert.equal(JSON.stringify(page.scheduleDraft()), before);
  page.onAddEditorBlock(); page.onEditorInput(event('title','第二件事')); page.applyTimeWindow('19:00','19:30');
  page.onEditorBlockChange(event('',0));
  assert.equal(page.availability.allowedStarts.includes('19:00'), false); assert.equal(page.availability.allowedStarts.includes('18:30'), true);
  assert.equal(runtime.storage.has('dayflow.records.v2'), false);
});
