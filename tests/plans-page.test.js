const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntime, clone } = require('./helpers/miniprogram');
const event = (data, value) => ({ currentTarget: { dataset: data }, detail: { value } });

function submit(page) { for (let i = 0; i < 3 && page.data.editorStep < 3; i++) { const before = page.data.editorStep; page.onWizardNext(); if (page.data.editorStep === before) return; } page.onSaveSchedule(); }

test('计划页原生字段可创建并修改规则，确认删除后移除未来规则', () => {
  const runtime = createRuntime(), page = runtime.page('plans'); page.onShow(); page.onCreateSchedule();
  page.onEditorInput(event({ field: 'start' }, '08:00')); page.onEditorInput(event({ field: 'end' }, '08:30'));
  page.onToggleAdvanced();
  page.onEditorInput(event({ field: 'scheduleTitle' }, '晚间练习'));
  page.onEditorInput(event({ field: 'title' }, '自主练习'));
  page.onActionInput(event({ index: 0, field: 'title' }, '练习一'));
  page.onActionInput(event({ index: 0, field: 'description' }, '自主选择内容'));
  submit(page);
  const plans = runtime.load('miniprogram/services/plans.ts');
  const created = plans.getTemplate().schedules.find(s => s.title === '晚间练习');
  assert.ok(created); assert.equal(created.blocks[0].tasks[0].description, '自主选择内容');
  assert.equal(page.data.editorVisible, false);
  page.onEditSchedule(event({ id: created.id })); page.onEditorInput(event({ field: 'title' }, '更新练习')); submit(page);
  assert.equal(plans.getTemplate().schedules.find(s => s.id === created.id).blocks[0].title, '更新练习');
  page.onDeleteSchedule(event({ id: created.id })); runtime.calls.modals.at(-1).success({ confirm: true });
  assert.equal(plans.getTemplate().schedules.some(s => s.id === created.id), false);
});

test('编辑多时间块及含步骤的并行任务时不会丢弃其它块、任务分组或说明', () => {
  const runtime = createRuntime(), plans = runtime.load('miniprogram/services/plans.ts');
  const template = clone(plans.getTemplate());
  const initialVersion = template.version;
  const schedule = template.schedules.find(s => s.weekdays.includes(6));
  const music = schedule.blocks.find(b => b.id === 'music');
  music.tasks[0].actions = [{ id: 'guitar-step', title: '和弦练习', start: '12:05', end: '12:35', description: '逐步练习' }];
  const otherBlocks = clone(schedule.blocks.filter(block => block.id !== 'music'));
  plans.saveTemplate(template, initialVersion);
  const page = runtime.page('plans'); page.onShow(); page.onEditSchedule(event({ id: schedule.id }));
  page.onEditorBlockChange(event({}, schedule.blocks.findIndex(block => block.id === 'music'))); page.onEditorInput(event({ field: 'title' }, '午间练习')); submit(page);
  const saved = plans.getTemplate().schedules.find(s => s.id === schedule.id);
  assert.equal(saved.blocks.length, schedule.blocks.length);
  assert.deepEqual(clone(saved.blocks.filter(block => block.id !== 'music')), otherBlocks);
  const savedMusic = saved.blocks.find(block => block.id === 'music');
  assert.equal(savedMusic.title, '午间练习'); assert.equal(savedMusic.tasks.length, 2);
  assert.equal(savedMusic.tasks[0].actions[0].id, 'guitar-step');
  assert.equal(savedMusic.tasks[0].actions[0].description, '逐步练习');
});

test('导入必须先重新校验且经用户确认，取消确认不改模板', () => {
  const runtime = createRuntime(), page = runtime.page('plans'); page.onShow();
  const plans = runtime.load('miniprogram/services/plans.ts'), candidate = clone(plans.getTemplate()); candidate.name = '导入计划';
  const initialVersion = candidate.version;
  page.onImportInput(event({}, JSON.stringify(candidate))); page.onPreviewImport(); assert.equal(page.data.importPreview.ok, true);
  assert.equal(plans.getTemplate().version, initialVersion);
  page.onConfirmImport(); runtime.calls.modals.at(-1).success({ confirm: false }); assert.equal(plans.getTemplate().version, initialVersion);
  page.onConfirmImport(); runtime.calls.modals.at(-1).success({ confirm: true }); assert.equal(plans.getTemplate().version, initialVersion + 1);
  page.onImportInput(event({}, '{bad')); page.onConfirmImport(); assert.equal(plans.getTemplate().version, initialVersion + 1);
});

test('当日替换例外使用当前编辑内容，不同时覆盖基础规则', () => {
  const runtime = createRuntime(), page = runtime.page('plans'); page.onShow();
  page.onEditSchedule(event({ id: 'weekday-6' }));
  const before = page.data.title;
  page.onExceptionDateInput(event({}, '2026-11-07')); page.onExceptionModeChange(event({}, 1)); page.onAddException();
  assert.equal(page.data.title, before);
  page.onEditorInput(event({ field: 'title' }, '例外工作安排'));
  page.onWizardNext(); page.onWizardNext();
  assert.equal(page.data.editingExceptionDate, ''); assert.equal(page.data.title, before);
  submit(page);
  const plans = runtime.load('miniprogram/services/plans.ts');
  assert.equal(plans.getDayBlocks('2026-11-07')[0].title, '例外工作安排');
  assert.equal(plans.getDayBlocks('2026-11-14')[0].title, before);
});

test('延期安排编辑保留来源关联，切换类型会明确拒绝，重新安排仍幂等', () => {
  const runtime = createRuntime(), plans = runtime.load('miniprogram/services/plans.ts'), records = runtime.load('miniprogram/services/records.ts');
  // Explicitly reserve a half-hour in this editor fixture; the real default
  // swimming evening keeps its return trip, overtime, and sleep occupation.
  const template=clone(plans.getTemplate());
  const saturday=template.schedules.find(schedule=>schedule.weekdays.includes(6));
  saturday.blocks=saturday.blocks.filter(block=>block.id!=='swim-return-work');
  runtime.storage.set('dayflow.plans.v1',template);
  records.setStatus('2026-10-30', 'music-guitar', 'deferred', { deferredTo: '2026-10-31' });
  const placed = plans.scheduleDeferredTarget('2026-10-30', 'music-guitar', '2026-10-31');
  const schedule = plans.getTemplate().schedules.find(s => s.blocks.some(b => b.tasks.some(t => t.origin)));
  const page = runtime.page('plans'); page.onShow(); page.onEditSchedule(event({ id: schedule.id }));
  page.onKindChange(event({}, 2)); assert.equal(page.data.kindIndex, 1); assert.match((page.data.wizardError || page.data.errorMessage), /来源关联/);
  page.onEditorInput(event({ field: 'title' }, '更新延期标题')); submit(page);
  assert.deepEqual(clone(plans.scheduleDeferredTarget('2026-10-30', 'music-guitar', '2026-10-31')), clone(placed));
});

test('编辑草稿固定打开时版本，后台更新后返回页面也不能用旧草稿覆盖新版本', () => {
  const runtime = createRuntime(), page = runtime.page('plans'); page.onShow(); page.onEditSchedule(event({ id: 'weekday-6' }));
  page.onEditorInput(event({ field: 'scheduleTitle' }, '旧草稿标题'));
  const plans = runtime.load('miniprogram/services/plans.ts'), next = clone(plans.getTemplate()), initialVersion = next.version; next.name = '另一个入口更新'; plans.saveTemplate(next, initialVersion);
  page.onShow(); assert.equal(page.data.templateVersion, initialVersion + 1);
  submit(page);
  assert.equal(plans.getTemplate().version, initialVersion + 1); assert.notEqual(plans.getTemplate().schedules.find(s => s.id === 'weekday-6').title, '旧草稿标题');
  assert.match((page.data.wizardError || page.data.errorMessage), /已更新/); assert.equal(page.data.editorVisible, true);
});
