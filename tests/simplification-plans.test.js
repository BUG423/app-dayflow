const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntime, clone } = require('./helpers/miniprogram');
const fs = require('node:fs');
const path = require('node:path');
const field = (name, value) => ({ currentTarget: { dataset: { field: name } }, detail: { value } });
const tap = dataset => ({ currentTarget: { dataset } });

function fixture(schedules = []) {
  const runtime = createRuntime(), plans = runtime.load('miniprogram/services/plans');
  const template = clone(plans.getTemplate()); template.schedules = schedules;
  plans.saveTemplate(template, template.version);
  const page = runtime.page('plans'); page.onShow();
  return { runtime, plans, page };
}
function start(page, title = '读书') {
  page.onCreateSchedule(); page.onEditorInput(field('title', title));
  page.applyTimeWindow('18:30', '19:00');
}

test('简化计划仅有两个可见步骤，下一步不提交，第二步一次点击保存', () => {
  const { page, plans, runtime } = fixture(); start(page);
  assert.deepEqual(clone(page.data.simpleWizardSteps), ['事项与时间', '重复并保存']);
  const before = clone([...runtime.storage]);
  page.onSimpleNext(); assert.equal(page.data.editorStep, 2);
  assert.deepEqual(clone([...runtime.storage]), before);
  page.onSimpleSave(); assert.equal(page.data.editorVisible, false);
  const saved = plans.getTemplate().schedules.find(item => item.title === '读书');
  assert.equal(saved.blocks[0].start, '18:30'); assert.equal(saved.blocks[0].end, '19:00');
  assert.equal(saved.effectiveFrom, saved.effectiveTo);
});

test('合法名称与非法时间在首屏阻断，可修复后继续，草稿和存储不丢失', () => {
  const { page, runtime } = fixture(); start(page, '午间阅读');
  page.onEditorInput(field('start', '20:00')); page.onEditorInput(field('end', '19:00'));
  const before = clone([...runtime.storage]);
  page.onSimpleNext(); assert.ok(page.data.editorStep < 2); assert.match(page.data.wizardError, /结束时间/);
  assert.equal(page.data.title, '午间阅读'); assert.equal(page.data.start, '20:00');
  assert.deepEqual(clone([...runtime.storage]), before);
  page.applyTimeWindow('20:00', '20:30'); page.onSimpleNext(); assert.equal(page.data.editorStep, 2);
});

test('第一屏步骤按钮不能跳过名称和时间校验', () => {
  const { page, runtime } = fixture(); page.onCreateSchedule();
  const before = clone([...runtime.storage]);
  page.onSimpleStep(tap({ step: 1 })); assert.equal(page.data.editorStep, 0); assert.match(page.data.wizardError, /名称/);
  page.onSimpleSave(); assert.deepEqual(clone([...runtime.storage]), before);
});

test('第二步返回、关闭和恢复保留名称、时间及重复草稿', () => {
  const { page, runtime } = fixture(); start(page);
  page.onSimpleNext(); page.onChooseRepeat(tap({ index: 2 }));
  const before = clone([...runtime.storage]);
  page.onSimpleBack(); assert.equal(page.data.editorStep, 0);
  page.onCloseEditor(); page.onResumeDraft();
  assert.equal(page.data.title, '读书'); assert.equal(page.data.start, '18:30');
  assert.equal(page.data.repeatModeIndex, 2); assert.deepEqual(clone(page.data.selectedWeekdays), [1,2,3,4,5]);
  page.onSimpleNext(); assert.equal(page.data.editorStep, 2);
  assert.deepEqual(clone([...runtime.storage]), before);
});

test('第二步只读名称日期时间直接跟随草稿，返回修改后再次进入即更新', () => {
  const { page, runtime } = fixture(); start(page, '这是可以完整换行显示的长事项名称');
  const before = clone([...runtime.storage]); page.onSimpleNext();
  const wxml = fs.readFileSync(path.join(__dirname, '../miniprogram/pages/plans/index.wxml'), 'utf8');
  const overview = wxml.match(/class="draft-overview">([\s\S]*?)<\/view><\/view>/)[1];
  const readOverview = () => overview.replace(/{{([^}]+)}}/g, (_match, expression) => expression.trim().split(/\s*\|\|\s*/).map(key => page.data[key]).find(Boolean) || '');
  assert.match(readOverview(), /这是可以完整换行显示的长事项名称/);
  assert.match(readOverview(), /2026-10-31 · 18:30–19:00/);
  page.onSimpleBack(); page.onEditorInput(field('title', '修改后的阅读'));
  page.onEditorInput(field('effectiveFrom', '2026-11-01')); page.applyTimeWindow('20:00', '20:30'); page.onSimpleNext();
  assert.equal(page.data.editorStep, 2); assert.match(readOverview(), /修改后的阅读/);
  assert.match(readOverview(), /2026-11-01 · 20:00–20:30/);
  assert.deepEqual(clone([...runtime.storage]), before);
});

test('计划卡片主体可直接修改，展开管理和取消删除均不提交', () => {
  const schedule = { id: 'saved', title: '已保存阅读', weekdays: [6], effectiveFrom: '2026-10-31', effectiveTo: '2026-10-31', exceptions: [],
    blocks: Array.from({ length: 9 }, (_, index) => ({ id: 'reading-' + index, title: '第' + (index + 1) + '项需要完整保留的中文长安排', start: String(index + 8).padStart(2, '0') + ':00', end: String(index + 8).padStart(2, '0') + ':30', kind: 'fixed', category: '兴趣', tasks: [] })) };
  const { page, runtime } = fixture([schedule]), before = clone([...runtime.storage]);
  const wxml = fs.readFileSync(path.join(__dirname, '../miniprogram/pages/plans/index.wxml'), 'utf8');
  const wxss = fs.readFileSync(path.join(__dirname, '../miniprogram/pages/plans/index.wxss'), 'utf8');
  assert.match(wxml, /class="schedule-meta schedule-times">{{item.blockLabel}}/);
  assert.match(wxss, /\.schedule-times\s*{[^}]*-webkit-line-clamp:\s*2/);
  const listed = page.data.schedules.find(item => item.id === schedule.id);
  for (const block of schedule.blocks) assert.ok(listed.blockLabel.includes(block.title), '列表模型保留所有时段');
  const open = wxml.match(/<button class="schedule-open"[^>]*bindtap="([^"]+)"/);
  page[open[1]](tap({ id: schedule.id }));
  assert.equal(page.data.editorVisible, true); assert.equal(page.data.editingId, 'saved');
  assert.equal(page.data.title, schedule.blocks[0].title);
  assert.deepEqual(clone(page.draftSchedule.blocks), schedule.blocks);
  page.onEditorBlockChange({ detail: { value: 8 } }); assert.equal(page.data.title, schedule.blocks[8].title);
  assert.deepEqual(clone(page.scheduleDraft().blocks), schedule.blocks);
  page.onToggleScheduleActions(tap({ id: schedule.id })); assert.equal(page.data.scheduleActionsId, 'saved');
  page.onDeleteSchedule(tap({ id: schedule.id })); runtime.calls.modals.at(-1).success({ confirm: false });
  assert.deepEqual(clone([...runtime.storage]), before);
});

test('取消具名覆盖确认保留所有原安排和草稿，重新确认后第二步提交', () => {
  const old = { id: 'work', title: '原安排', weekdays: [6], effectiveFrom: '2026-10-31', effectiveTo: '2026-10-31', exceptions: [],
    blocks: [{ id: 'old', title: '阅读课', start: '18:00', end: '19:00', kind: 'fixed', category: '学习', tasks: [] }] };
  const { page, runtime, plans } = fixture([old]); start(page, '自主阅读');
  const before = clone([...runtime.storage]), modal = runtime.calls.modals.at(-1);
  assert.match(modal.content, /阅读课.*18:00–19:00/); modal.success({ confirm: false });
  page.onSimpleNext(); assert.ok(page.data.editorStep < 2);
  assert.equal(page.data.title, '自主阅读'); assert.equal(page.data.start, '18:30');
  assert.deepEqual(clone([...runtime.storage]), before);
  runtime.calls.modals.at(-1).success({ confirm: true });
  page.onSimpleNext(); page.onSimpleSave(); assert.equal(page.data.editorVisible, false);
  assert.ok(plans.getDayBlocks('2026-10-31').some(block => block.title === '自主阅读'));
});

test('复杂训练计划在两步编辑中保留其他时段、动作详情、例外和来源关联', () => {
  const action = { id: 'a', title: '自选动作', start: '18:30', end: '18:40', dosage: '自选次数', description: '原说明', equipment: '弹力带', searchKeyword: '动作示例', safety: '不适时停止' };
  const block = { id: 'training', title: '训练', start: '18:30', end: '19:00', kind: 'sequence', category: '训练', tasks: [{ id: 'task', title: '训练', start: '18:30', end: '19:00', actions: [action], origin: { date: '2026-10-30', targetId: 'source' } }] };
  const second = { id: 'rest', title: '休息', start: '19:00', end: '19:30', kind: 'fixed', category: '生活', tasks: [] };
  const schedule = { id: 'complex', title: '晚间安排', weekdays: [0,1,2,3,4,5,6], effectiveFrom: '2026-10-31', blocks: [block, second], exceptions: [{ date: '2026-11-01', kind: 'skip' }, { date: '2026-11-02', kind: 'replace', blocks: [clone(block)] }] };
  const { page, plans } = fixture([schedule]); page.onEditSchedule(tap({ id: 'complex' }));
  page.onSimpleNext(); page.onToggleAdvanced();
  page.onActionInput({ currentTarget: { dataset: { index: 0, field: 'description' } }, detail: { value: '修改说明' } });
  page.onSimpleSave(); assert.equal(page.data.editorVisible, false, page.data.wizardError);
  const saved = clone(plans.getTemplate().schedules.find(item => item.id === 'complex'));
  const expected = clone(schedule); expected.blocks[0].tasks[0].actions[0].description = '修改说明';
  assert.deepEqual(saved, expected);
});

test('两步保存仍拒绝过期模板版本，并保留用户草稿', () => {
  const { page, plans, runtime } = fixture(); start(page); page.onSimpleNext();
  const next = clone(plans.getTemplate()); next.name = '其他窗口更新'; plans.saveTemplate(next, next.version);
  const before = clone([...runtime.storage]); page.onSimpleSave();
  assert.equal(page.data.editorVisible, true); assert.equal(page.data.title, '读书');
  assert.match(page.data.wizardError, /已更新/); assert.deepEqual(clone([...runtime.storage]), before);
});

test('扩大重复取消覆盖后可返回并重访第二步缩小重复，保存仍需有效许可', () => {
  const meeting = { id: 'meeting', title: '远期会议', weekdays: [3], effectiveFrom: '2026-12-30', effectiveTo: '2026-12-30', exceptions: [],
    blocks: [{ id: 'meeting-block', title: '项目会议', start: '18:30', end: '19:00', kind: 'fixed', category: '工作', tasks: [] }] };
  const { page, runtime, plans } = fixture([meeting]); start(page); page.onSimpleNext();
  page.onChooseRepeat(tap({ index: 1 })); runtime.calls.modals.at(-1).success({ confirm: false });
  const before = clone([...runtime.storage]);
  page.onSimpleBack(); page.onSimpleStep(tap({ step: 1 })); assert.equal(page.data.editorStep, 2);
  page.onSimpleSave(); assert.equal(page.data.editorVisible, true); assert.deepEqual(clone([...runtime.storage]), before);
  runtime.calls.modals.at(-1).success({ confirm: false });
  page.onChooseRepeat(tap({ index: 0 })); page.onSimpleSave(); assert.equal(page.data.editorVisible, false);
  assert.ok(plans.getTemplate().schedules.some(item => item.id === 'meeting'));
});
