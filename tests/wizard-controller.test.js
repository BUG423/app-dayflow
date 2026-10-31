const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntime, clone } = require('./helpers/miniprogram');
const event = (field, value) => ({ currentTarget: { dataset: { field } }, detail: { value } });
const tap = dataset => ({ currentTarget: { dataset } });
function fixture() {
  const runtime = createRuntime(), plans = runtime.load('miniprogram/services/plans');
  const template = clone(plans.getTemplate());
  const fixed = (id, title, start, end) => ({ id, title, start, end, kind: 'fixed', category: '工作', tasks: [] });
  template.schedules = [{ id: 'work', title: '工作安排', weekdays: [0,1,2,3,4,5,6], effectiveFrom: '2026-10-31', exceptions: [], blocks: [fixed('am', '上午工作', '08:00', '12:00'), fixed('pm', '下午工作', '14:00', '18:00')] },
    { id: 'meeting', title: '未来会议', weekdays: [3], effectiveFrom: '2026-12-30', effectiveTo: '2026-12-30', exceptions: [], blocks: [fixed('meet', '项目会议', '12:00', '13:00')] }];
  plans.saveTemplate(template, template.version);
  const page = runtime.page('plans'); page.onShow(); page.onCreateSchedule();
  return { runtime, plans, page };
}
function fill(page, name = '午间阅读') {
  page.onEditorInput(event('title', name));
  page.applyTimeWindow('12:00', '12:30');
}
function review(page) {
  while (page.data.editorStep < 3) { const previous = page.data.editorStep; page.onWizardNext(); assert.notEqual(page.data.editorStep, previous, page.data.wizardError); }
}

test('四页分别校验，摘要回访与折叠不写入，只有最终确认提交', () => {
  const { runtime, plans, page } = fixture(), before = clone([...runtime.storage]);
  page.onWizardNext(); assert.equal(page.data.editorStep, 0); assert.match(page.data.wizardError, /名称/);
  fill(page); page.onSaveSchedule(); assert.equal(page.data.editorStep, 0); assert.deepEqual(clone([...runtime.storage]), before);
  review(page); assert.equal(page.data.summaryRows[0].value, '午间阅读'); assert.deepEqual(clone([...runtime.storage]), before);
  page.onWizardStep(tap({ step: 0 })); page.onToggleSummary(); page.onEditorInput(event('title', '午间学习'));
  page.onWizardStep(tap({ step: 3 })); assert.equal(page.data.title, '午间学习');
  page.onSaveSchedule(); assert.equal(page.data.editorVisible, false); assert.equal(page.data.draftResumeAvailable, false); assert.equal(page.draftSchedule, null);
  assert.ok(plans.getTemplate().schedules.some(item => item.title === '午间学习'));
});

test('外部占用分钟可选择替换，原占用仍展示，不能注入无效索引', () => {
  const { page } = fixture(); fill(page); page.onWizardNext();
  assert.equal(page.availability.allowedStarts.includes('08:00'), true); assert.equal(page.availability.allowedStarts.includes('11:59'), true);
  assert.equal(page.availability.allowedStarts.includes('12:00'), true);
  assert.equal(page.data.endTimeRange[0].includes('23'), true);
  assert.ok(page.data.occupiedSlots.some(item => item.title === '上午工作' && item.start === '08:00' && item.end === '12:00'));
  page.onStartTimeChange(event('', [999, 0])); assert.equal(page.data.start, '12:00'); assert.match(page.data.wizardError, /时间/);
  const hour = page.data.endTimeRange[0].indexOf('14');
  page.onEndTimeColumnChange({ detail: { column: 0, value: hour } }); assert.equal(page.data.endTimeRange[1].length, 60);
  page.onEndTimeChange(event('', [hour, 0])); assert.equal(page.data.end, '14:00');
});

test('扩大重复只弹一次远期具名替换确认，取消后可缩小范围且旧时间不清空', () => {
  const { page, runtime } = fixture(); fill(page); page.onWizardNext(); page.onWizardNext();
  page.onRepeatModeChange(event('', 1));
  assert.equal(page.data.start, '12:00'); assert.equal(page.data.end, '12:30'); assert.equal(page.data.overwriteRequired, true);
  assert.ok(page.data.overwriteRows.some(item => item.effectiveFrom === '2026-12-30' && item.scheduleTitle === '未来会议' && item.start === '12:00' && item.end === '13:00'));
  assert.match(runtime.calls.modals.at(-1).content, /项目会议.*12:00–13:00/); runtime.calls.modals.at(-1).success({ confirm: false });
  page.onWizardBack(); assert.equal(page.availability.allowedStarts.includes('12:00'), true);
  page.onWizardStep(tap({ step: 2 })); assert.equal(page.data.editorStep, 2);
  page.onRepeatModeChange(event('', 0)); assert.equal(page.data.conflicts.length, 0); assert.equal(page.data.start, '12:00');
  page.onWizardNext(); assert.equal(page.data.editorStep, 3);
});

test('关闭与恢复保留当前步骤、摘要、名称和时间，取消放弃不清草稿', () => {
  const { runtime, page } = fixture(); fill(page); page.onWizardNext();
  page.onCloseEditor(); assert.equal(page.data.draftResumeAvailable, true); page.onResumeDraft();
  assert.equal(page.data.editorStep, 1); assert.equal(page.data.title, '午间阅读'); assert.equal(page.data.start, '12:00');
  page.onDiscardDraft(); runtime.calls.modals.at(-1).success({ confirm: false }); assert.ok(page.draftSchedule);
  page.onDiscardDraft(); runtime.calls.modals.at(-1).success({ confirm: true }); assert.equal(page.draftSchedule, null);
});

test('确认后发生模板版本变化，最终保存拒绝且保留草稿和全部存储', () => {
  const { runtime, page, plans } = fixture(); fill(page); review(page);
  const changed = clone(plans.getTemplate()); changed.name = '其他窗口修改'; plans.saveTemplate(changed, changed.version);
  const before = clone([...runtime.storage]); page.onSaveSchedule();
  assert.match(page.data.wizardError, /已更新/); assert.equal(page.data.editorVisible, true); assert.equal(page.data.title, '午间阅读'); assert.deepEqual(clone([...runtime.storage]), before);
});

test('确认后日期新增快照锁，最终保存重新拒绝且不写任何存储', () => {
  const { runtime, page, plans } = fixture(); fill(page); review(page); plans.lockDailyInstance('2026-10-31');
  const before = clone([...runtime.storage]); page.onSaveSchedule();
  assert.match(page.data.wizardError, /执行记录/); assert.equal(page.data.editorVisible, true); assert.deepEqual(clone([...runtime.storage]), before);
});

test('单日替换在隔离作用域编辑，返回恢复未完成草稿，完成后不覆盖基础时间', () => {
  const { runtime, page } = fixture(); fill(page); page.onRepeatModeChange(event('', 1));
  page.onEditorInput(event('start', '18:30')); page.onEditorInput(event('end', '19:00')); page.onWizardNext(); page.onWizardNext();
  const before = clone([...runtime.storage]); page.onExceptionDateInput(event('', '2026-11-01')); page.onExceptionModeChange(event('', 1)); page.onAddException();
  assert.equal(page.data.editingExceptionDate, '2026-11-01'); page.onEditorInput(event('title', '仅这天阅读')); page.onEditorInput(event('start', '19:00')); page.onEditorInput(event('end', '19:30'));
  page.onCancelExceptionEdit(); assert.equal(page.data.title, '午间阅读'); assert.equal(page.data.start, '18:30');
  page.onAddException(); assert.equal(page.data.title, '仅这天阅读'); assert.equal(page.data.start, '19:00');
  page.onWizardNext(); page.onWizardNext(); assert.equal(page.data.editingExceptionDate, ''); assert.equal(page.data.title, '午间阅读');
  assert.equal(page.data.exceptions[0].blocks[0].start, '19:00'); assert.equal(page.data.reviewExceptions[0].blockCount, 1);
  assert.deepEqual(clone([...runtime.storage]), before);
});

test('时分列只提供许可候选，整组移时保留动作持续时间且不截断', () => {
  const { runtime } = fixture(), util = runtime.load('miniprogram/utils/wizard-state');
  assert.deepEqual(clone(util.timeColumns(['12:00','12:01','14:30'], '12:01', '14')), { range: [['12','14'], ['30']], indices: [1,0] });
  const rows = [{ id: 'a', title: '动作', start: '12:00', end: '12:20', description: '保留说明', _taskId: 't' }];
  const moved = util.moveActionRows(rows, '12:00', '12:30', '13:00', '13:10', false);
  assert.equal(moved[0].end, '13:20'); assert.equal(moved[0]._taskId, 't'); assert.equal(rows[0].start, '12:00');
  assert.throws(() => util.moveActionRows(rows, '12:00', '12:30', '23:50', '23:59', false), /当天/);
});

test('已保存普通事项移动时间后，跟随整个时段的任务不受旧行时间阻挡', () => {
  const { plans, page } = fixture(); fill(page); review(page); page.onSaveSchedule();
  const created = plans.getTemplate().schedules.find(item => item.title === '午间阅读');
  page.onEditSchedule(tap({ id: created.id }));
  page.onEditorInput(event('start', '13:00')); page.onEditorInput(event('end', '13:30')); review(page); page.onSaveSchedule();
  const saved = plans.getTemplate().schedules.find(item => item.id === created.id);
  assert.equal(saved.blocks[0].tasks[0].start, '13:00'); assert.equal(saved.blocks[0].tasks[0].end, '13:30');
  assert.equal(saved.blocks[0].tasks[0].id, created.blocks[0].tasks[0].id);
});

test('只有替换例外的存量安排编辑实际作用域，四步保存保留基础块与来源', () => {
  const { runtime, plans, page } = fixture(); page.onDiscardDraft(); runtime.calls.modals.at(-1).success({ confirm: true });
  const template = clone(plans.getTemplate());
  const task = { id: 'defer-task', title: '待补阅读', start: '18:30', end: '19:00', actions: [], origin: { date: '2026-10-30', targetId: 'source' } };
  const block = { id: 'defer-block', title: '待补阅读', start: '18:30', end: '19:00', kind: 'parallel', category: '兴趣', tasks: [task] };
  template.schedules.push({ id: 'defer', title: '待补阅读', weekdays: [], effectiveFrom: '2026-10-31', effectiveTo: '2026-10-31', blocks: [clone(block)], exceptions: [{ date: '2026-10-31', kind: 'replace', blocks: [clone(block)] }] });
  plans.saveTemplate(template, template.version); page.onShow(); page.onEditSchedule(tap({ id: 'defer' }));
  assert.equal(page.data.exceptionOnly, true); assert.equal(page.data.editingExceptionDate, '2026-10-31');
  page.onEditorInput(event('title', '修改延期显示')); review(page); page.onSaveSchedule();
  const saved = plans.getTemplate().schedules.find(item => item.id === 'defer');
  assert.equal(saved.blocks[0].title, '待补阅读'); assert.equal(saved.exceptions[0].blocks[0].title, '修改延期显示');
  assert.deepEqual(clone(saved.exceptions[0].blocks[0].tasks[0].origin), task.origin); assert.equal(page.data.editorVisible, false);
});

test('移除旧跳过日期重新纳入远期替换清单，未确认前不能前进', () => {
  const { page, runtime } = fixture(); fill(page); page.onRepeatModeChange(event('', 1)); runtime.calls.modals.at(-1).success({ confirm: false });
  page.onExceptionDateInput(event('', '2026-12-30')); page.onAddException();
  assert.equal(page.data.conflictCount, 0);
  page.onWizardNext(); page.onWizardNext(); assert.equal(page.data.editorStep, 2);
  page.onRemoveException(tap({ index: 0 }));
  assert.ok(page.data.overwriteRows.some(item => item.effectiveFrom === '2026-12-30' && item.scheduleTitle === '未来会议'));
  assert.equal(page.data.overwriteRequired, true); page.onWizardNext(); assert.equal(page.data.editorStep, 2);
});

test('已有重复规则首次打开即冲突时仍能回访范围缩小重复，不能跳过最终确认', () => {
  const { runtime, plans, page } = fixture(); page.onDiscardDraft(); runtime.calls.modals.at(-1).success({ confirm: true });
  const template = clone(plans.getTemplate());
  template.schedules.push({ id: 'existing', title: '已有阅读', weekdays: [0,1,2,3,4,5,6], effectiveFrom: '2026-10-31', exceptions: [], blocks: [{ id: 'reading', title: '已有阅读', start: '12:00', end: '12:30', kind: 'fixed', category: '个人', tasks: [] }] });
  plans.saveTemplate(template, template.version); page.onShow(); page.onEditSchedule(tap({ id: 'existing' }));
  page.onWizardNext(); assert.equal(page.data.editorStep, 1); assert.equal(page.data.overwriteRequired, true);
  page.onWizardStep(tap({ step: 2 })); assert.equal(page.data.editorStep, 2);
  page.onSaveSchedule(); assert.equal(page.data.editorVisible, true); assert.match(page.data.wizardError, /确认页/);
  page.onRepeatModeChange(event('', 0)); page.onWizardNext(); assert.equal(page.data.editorStep, 3); page.onSaveSchedule();
  assert.equal(page.data.editorVisible, false); assert.equal(plans.getTemplate().schedules.find(item => item.id === 'existing').effectiveTo, '2026-10-31');
});

test('编辑器仍打开时再次新增或修改其他卡不会覆盖正在填写的草稿', () => {
  const { runtime, page } = fixture(); fill(page); page.onWizardNext();
  const draftId = page.draftSchedule.id, before = clone([...runtime.storage]);
  page.onCreateSchedule(); assert.equal(page.draftSchedule.id, draftId); assert.equal(page.data.title, '午间阅读'); assert.equal(page.data.editorStep, 1);
  page.onEditSchedule(tap({ id: 'work' }));
  assert.equal(page.draftSchedule.id, draftId); assert.equal(page.data.title, '午间阅读'); assert.equal(page.data.start, '12:00'); assert.equal(page.data.editorStep, 1);
  assert.match(page.data.wizardError, /草稿/); assert.deepEqual(clone([...runtime.storage]), before);
});
