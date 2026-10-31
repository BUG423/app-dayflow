const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntime, clone } = require('./helpers/miniprogram');
const event = (field, value) => ({ currentTarget: { dataset: { field } }, detail: { value } });
const pick = value => event('', value);
function setup() { const runtime = createRuntime(); const page = runtime.page('plans'); page.onShow(); return { runtime, page, plans: runtime.load('miniprogram/services/plans.ts') }; }

function submit(page) { for (let i = 0; i < 3 && page.data.editorStep < 3; i++) { const before = page.data.editorStep; page.onWizardNext(); if (page.data.editorStep === before) return; } page.onSaveSchedule(); }

test('简洁新增默认仅当天，名称时间即可保存一项可打卡任务', () => {
  const { page, plans } = setup(); page.onCreateSchedule();
  assert.equal(page.data.advancedVisible, false); assert.equal(page.data.repeatModeIndex, 0);
  page.onEditorInput(event('title', '晚间阅读')); page.onEditorInput(event('start', '08:00')); page.onEditorInput(event('end', '08:30'));
  submit(page);
  const saved = plans.getTemplate().schedules.find(s => s.title === '晚间阅读');
  assert.ok(saved); assert.equal(saved.effectiveFrom, saved.effectiveTo);
  assert.equal(saved.blocks[0].tasks.length, 1); assert.equal(saved.blocks[0].tasks[0].title, '晚间阅读');
  assert.equal(saved.blocks[0].tasks[0].start, '08:00'); assert.equal(page.data.editorVisible, false);
  assert.equal(plans.getDayBlocks('2026-11-07').some(b => b.title === '晚间阅读'), false);
});

test('普通加班可关闭打卡并设工作日重复，不生成执行目标', () => {
  const { page, plans } = setup(); page.onCreateSchedule();
  page.onEditorInput(event('title', '加班')); page.onEditorInput(event('start', '08:00')); page.onEditorInput(event('end', '08:30'));
  page.onCheckableChange(pick(false)); page.onRepeatModeChange(pick(2)); submit(page);
  const saved = plans.getTemplate().schedules.find(s => s.title === '加班');
  assert.deepEqual(clone(saved.weekdays), [1,2,3,4,5]); assert.equal(saved.effectiveTo, undefined);
  assert.equal(saved.blocks[0].kind, 'fixed'); assert.deepEqual(clone(saved.blocks[0].tasks), []);
});

test('重复按钮提供直观周重复、工作日和非工作日，默认不重复不展开更多设置', () => {
  const { page, plans } = setup(); page.onCreateSchedule();
  assert.deepEqual(clone(page.data.wizardSteps), ['做什么','选时间','重复','确认']);
  assert.deepEqual(clone(page.data.repeatOptions), ['不重复','每天','工作日','自选星期','每周六','非工作日']);
  assert.deepEqual(clone(page.data.repeatChoices).map(item => item.value), [0,4,2,5,1]);
  page.onEditorInput(event('title', '早间阅读')); page.onEditorInput(event('start', '08:00')); page.onEditorInput(event('end', '08:30'));
  page.onChooseRepeat({ currentTarget: { dataset: { index: 1 } } }); assert.equal(page.data.selectedWeekdays.length, 7);
  page.onChooseRepeat({ currentTarget: { dataset: { index: 2 } } }); assert.deepEqual(clone(page.data.selectedWeekdays), [1,2,3,4,5]);
  page.onChooseRepeat({ currentTarget: { dataset: { index: 3 } } }); page.onToggleWeekday({ currentTarget: { dataset: { value: 5 } } });
  assert.deepEqual(clone(page.data.selectedWeekdays), [1,2,3,4]);
  page.onChooseRepeat({ currentTarget: { dataset: { index: 999 } } }); assert.equal(page.data.repeatModeIndex, 3);
  assert.equal(page.data.advancedVisible, false); submit(page);
  assert.deepEqual(clone(plans.getTemplate().schedules.find(item => item.title === '早间阅读').weekdays), [1,2,3,4]);
});

test('更多设置中的重复期限可以清除，收起后不影响已填时间和打卡摘要', () => {
  const { page, plans } = setup(); page.onCreateSchedule();
  page.onEditorInput(event('title', '晨间安排')); page.onEditorInput(event('start', '08:00')); page.onEditorInput(event('end', '08:30'));
  page.onChooseRepeat({ currentTarget: { dataset: { index: 1 } } });
  page.onToggleAdvanced(); page.onEditorInput(event('effectiveTo', '2026-11-30')); page.onClearRepeatEnd();
  assert.equal(page.data.effectiveTo, ''); page.onToggleAdvanced();
  assert.equal(page.data.start, '08:00'); assert.equal(page.data.end, '08:30');
  assert.equal(page.data.summaryRows.find(row => row.label === '打卡').value, '需要');
  submit(page); assert.equal(plans.getTemplate().schedules.find(item => item.title === '晨间安排').effectiveTo, undefined);
});

test('不打开更多设置保存已有复杂安排，保留原有日期调整和延期来源', () => {
  const { page, plans, runtime } = setup();
  const template = clone(plans.getTemplate());
  const task = { id: 'old-t', title: '原练习', start: '08:00', end: '08:30', actions: [], origin: { date: '2026-10-30', targetId: 'original-t' } };
  const first = { id: 'old-b', title: '原练习', start: '08:00', end: '08:30', kind: 'parallel', category: '兴趣', tasks: [task] };
  const second = { id: 'old-c', title: '看书', start: '08:30', end: '09:00', kind: 'fixed', category: '生活', tasks: [] };
  template.schedules.push({ id: 'old-plan', title: '原组合', weekdays: [0,1,2,3,4,5,6], effectiveFrom: '2026-10-31', blocks: [first, second], exceptions: [{ date: '2026-11-03', kind: 'skip' }, { date: '2026-11-04', kind: 'replace', blocks: [clone(first)] }] });
  plans.saveTemplate(template, template.version); page.onShow();
  const before = clone(plans.getTemplate().schedules.find(item => item.id === 'old-plan'));
  page.onEditSchedule({ currentTarget: { dataset: { id: before.id } } });
  assert.equal(page.data.advancedVisible, false); assert.equal(page.data.simpleMode, false);
  assert.equal(page.data.occupiedVisible, false); page.onToggleOccupied(); assert.equal(page.data.occupiedVisible, true);
  submit(page);
  assert.equal(page.data.editorVisible, false);
  assert.deepEqual(clone(plans.getTemplate().schedules.find(item => item.id === before.id)), before);
  assert.equal(runtime.storage.has('dayflow.records.v2'), false);
});

test('单次日期改变会同步星期和结束日期，每天与自选重复规则明确', () => {
  const { page } = setup(); page.onCreateSchedule();
  page.onEditorInput(event('effectiveFrom', '2027-01-01'));
  assert.equal(page.data.effectiveTo, '2027-01-01'); assert.deepEqual(clone(page.data.selectedWeekdays), [5]);
  page.onRepeatModeChange(pick(1)); assert.equal(page.data.selectedWeekdays.length, 7); assert.equal(page.data.effectiveTo, '');
  page.onRepeatModeChange(pick(3)); page.onToggleWeekday({ currentTarget: { dataset: { value: 0 } } });
  assert.equal(page.data.selectedWeekdays.includes(0), false);
});

test('简洁与详细往返保存草稿及任务标识，描述等可选内容不会丢失', () => {
  const { page, plans } = setup(); page.onCreateSchedule();
  page.onEditorInput(event('title', '保留详情')); page.onEditorInput(event('start', '08:00')); page.onEditorInput(event('end', '08:30'));
  page.onToggleAdvanced(); const id = page.data.actionRows[0].id;
  page.onActionInput({ currentTarget: { dataset: { index: 0, field: 'description' } }, detail: { value: '原有说明' } });
  page.onToggleAdvanced(); assert.equal(page.data.advancedVisible, false); assert.equal(page.data.title, '保留详情');
  page.onEditorInput(event('title', '改名后仍保留')); submit(page);
  const saved = plans.getTemplate().schedules.find(s => s.title === '改名后仍保留');
  assert.equal(saved.blocks[0].tasks[0].id, id); assert.equal(saved.blocks[0].tasks[0].description, '原有说明'); assert.equal(saved.blocks[0].tasks[0].title, '改名后仍保留');
});

test('已保存普通安排再次改名时，列表、时段与任务名称保持一致', () => {
  const { page, plans } = setup(); page.onCreateSchedule();
  page.onEditorInput(event('title', '原来的名称')); page.onEditorInput(event('start', '08:00')); page.onEditorInput(event('end', '08:30')); submit(page);
  const created = plans.getTemplate().schedules.find(s => s.title === '原来的名称');
  const targetId = created.blocks[0].tasks[0].id;
  page.onEditSchedule({ currentTarget: { dataset: { id: created.id } } });
  page.onEditorInput(event('title', '修改后的名称')); submit(page);
  const saved = plans.getTemplate().schedules.find(s => s.id === created.id);
  assert.equal(saved.title, '修改后的名称'); assert.equal(saved.blocks[0].title, '修改后的名称');
  assert.equal(saved.blocks[0].tasks[0].title, '修改后的名称'); assert.equal(saved.blocks[0].tasks[0].id, targetId);
  assert.equal(page.data.schedules.find(s => s.id === created.id).title, '修改后的名称');
});

test('普通安排自定义整组名称保持独立，高级明确修改整组名称不会被自动跟随覆盖', () => {
  const { page, plans } = setup(); page.onCreateSchedule();
  page.onEditorInput(event('title', '一个时段')); page.onEditorInput(event('start', '08:00')); page.onEditorInput(event('end', '08:30'));
  page.onToggleAdvanced(); page.onEditorInput(event('scheduleTitle', '独立的组名')); submit(page);
  const created = plans.getTemplate().schedules.find(s => s.title === '独立的组名');
  page.onEditSchedule({ currentTarget: { dataset: { id: created.id } } });
  page.onEditorInput(event('title', '新的时段名')); submit(page);
  assert.equal(plans.getTemplate().schedules.find(s => s.id === created.id).title, '独立的组名');
  assert.equal(plans.getTemplate().schedules.find(s => s.id === created.id).blocks[0].title, '新的时段名');

  page.onCreateSchedule(); page.onEditorInput(event('title', '原本同名')); page.onEditorInput(event('start', '08:35')); page.onEditorInput(event('end', '08:45')); submit(page);
  const linked = plans.getTemplate().schedules.find(s => s.title === '原本同名');
  page.onEditSchedule({ currentTarget: { dataset: { id: linked.id } } }); page.onToggleAdvanced();
  page.onEditorInput(event('scheduleTitle', '用户新设组名')); page.onToggleAdvanced();
  page.onEditorInput(event('title', '另一个时段名')); submit(page);
  assert.equal(plans.getTemplate().schedules.find(s => s.id === linked.id).title, '用户新设组名');
});

test('原复杂安排默认收起更多设置，展开再保存保留所有内容', () => {
  const { page, plans } = setup();
  const before = clone(plans.getTemplate().schedules.find(s => s.id === 'weekday-6'));
  page.onEditSchedule({ currentTarget: { dataset: { id: before.id } } });
  assert.equal(page.data.advancedVisible, false); assert.equal(page.data.simpleMode, false);
  page.onToggleAdvanced(); assert.equal(page.data.advancedVisible, true); page.onToggleAdvanced(); submit(page);
  const saved = plans.getTemplate().schedules.find(s => s.id === before.id);
  assert.deepEqual(clone(saved), before);
});

test('简洁表单校验或写入失败时保留内容和已存计划，工具入口只影响显示', () => {
  const { page, plans, runtime } = setup(); const before = clone(plans.getTemplate()); page.onCreateSchedule();
  page.onEditorInput(event('title', '尚未保存')); page.onEditorInput(event('end', '17:00')); submit(page);
  assert.equal(page.data.editorVisible, true); assert.equal(page.data.title, '尚未保存'); assert.deepEqual(clone(plans.getTemplate()), before);
  page.onEditorInput(event('start', '08:00')); page.onEditorInput(event('end', '08:30'));
  runtime.wx.setStorageSync = () => { throw new Error('模拟存储失败'); }; submit(page);
  assert.equal(page.data.editorVisible, true); assert.equal(page.data.title, '尚未保存');
  page.onToggleTools(); page.onToggleVersions(); page.onToggleTraining();
  assert.equal(page.data.toolsVisible, true); assert.equal(page.data.versionsVisible, true); assert.equal(page.data.trainingVisible, true);
  assert.deepEqual(clone(plans.getTemplate()), before);
});

test('简化资格拒绝含来源、多个步骤或独立任务标题，防止隐藏字段被压扁', () => {
  const runtime = createRuntime(), editor = runtime.load('miniprogram/utils/plan-editor.ts');
  const block = { id: 'b', title: '练习', start: '08:00', end: '08:30', kind: 'parallel', category: '兴趣', tasks: [{ id: 't', title: '练习', start: '08:00', end: '08:30', actions: [] }] };
  assert.equal(editor.isSimpleBlock(block), true);
  for (const patch of [{ origin: { date: '2026-10-30', targetId: 'old' } }, { title: '独立标题' }, { actions: [{ id: 'step' }] }]) {
    const candidate = clone(block); Object.assign(candidate.tasks[0], patch); assert.equal(editor.isSimpleBlock(candidate), false);
    assert.throws(() => editor.simpleBlock(candidate, { title: '新名', start: '08:00', end: '08:30', category: '兴趣', checkable: true }, 'new'), /完整设置/);
  }
});

test('新版普通示例只读预览，用户取消不改计划，明确确认后才采用新版本', () => {
  const { page, plans, runtime } = setup();
  const before = clone(plans.getTemplate());
  page.onToggleTools(); page.onPreviewExample();
  assert.equal(page.data.examplePreview, true); assert.equal(page.data.importPreview.ok, true);
  assert.equal(page.data.exampleRows.length, 7);
  assert.ok(page.data.exampleRows.some(day => day.blocks.some(block => block.title === '加班')));
  assert.deepEqual(clone(plans.getTemplate()), before); assert.equal(runtime.storage.has('dayflow.plans.v1'), false);
  page.onConfirmImport(); runtime.calls.modals.at(-1).success({ confirm: false });
  assert.deepEqual(clone(plans.getTemplate()), before);
  page.onConfirmImport(); assert.match(runtime.calls.modals.at(-1).content, /替换.*未来安排/);
  runtime.calls.modals.at(-1).success({ confirm: true });
  assert.equal(plans.getTemplate().version, before.version + 1); assert.equal(page.data.importVisible, false);
});

test('今天已有记录时新建默认明天并解释，日期检查不写入任何缓存', () => {
  const { page, plans, runtime } = setup();
  runtime.load('miniprogram/services/records.ts').setStatus('2026-10-31', 'music-guitar', 'done');
  const before = clone([...runtime.storage]); page.onCreateSchedule();
  assert.equal(page.data.effectiveFrom, '2026-11-01'); assert.equal(page.data.effectiveTo, '2026-11-01');
  assert.match(page.data.dateSelectionHint, /今天已有执行记录.*明天/); assert.deepEqual(clone([...runtime.storage]), before);
  page.onEditorInput(event('title', '明天的新安排')); page.onEditorInput(event('start', '08:00')); page.onEditorInput(event('end', '08:30')); submit(page);
  assert.equal(plans.getDayBlocks('2026-10-31').some(b => b.title === '明天的新安排'), false);
  assert.equal(plans.getDayBlocks('2026-11-01').some(b => b.title === '明天的新安排'), true);
});

test('手选锁定日期的单次安排在写入前拒绝，保留草稿和全部原始存储', () => {
  const { page, runtime } = setup();
  runtime.load('miniprogram/services/records.ts').setStatus('2026-10-31', 'music-guitar', 'done');
  page.onCreateSchedule(); page.onEditorInput(event('effectiveFrom', '2026-10-31'));
  page.onEditorInput(event('title', '不能消失的新安排')); page.onEditorInput(event('start', '08:00')); page.onEditorInput(event('end', '08:30'));
  const before = clone([...runtime.storage]); submit(page);
  assert.equal(page.data.editorVisible, true); assert.equal(page.data.title, '不能消失的新安排'); assert.match((page.data.wizardError || page.data.errorMessage), /请选择尚未执行的日期/);
  assert.deepEqual(clone([...runtime.storage]), before);
});

test('编辑器打开后日期才被锁定也会在保存前再次检查', () => {
  const { page, runtime } = setup(); page.onCreateSchedule();
  page.onEditorInput(event('title', '稍后被锁')); page.onEditorInput(event('start', '08:00')); page.onEditorInput(event('end', '08:30'));
  runtime.load('miniprogram/services/records.ts').setStatus('2026-10-31', 'music-guitar', 'done');
  const before = clone([...runtime.storage]); submit(page);
  assert.equal(page.data.editorVisible, true); assert.match((page.data.wizardError || page.data.errorMessage), /执行记录/); assert.deepEqual(clone([...runtime.storage]), before);
});

test('显式快照锁也会跳过，七天均锁定时保留选择入口并明确解释', () => {
  const { page, plans, runtime } = setup();
  const calendar = runtime.load('miniprogram/utils/calendar');
  for (let offset = 0; offset <= 7; offset++) plans.lockDailyInstance(calendar.shiftDays('2026-10-31', offset));
  const before = clone([...runtime.storage]); page.onCreateSchedule();
  assert.equal(page.data.editorVisible, true); assert.equal(page.data.effectiveFrom, '2026-10-31');
  assert.match(page.data.dateSelectionHint, /未来七天.*自行选择/); assert.deepEqual(clone([...runtime.storage]), before);
  page.onEditorInput(event('effectiveFrom', '2026-11-08')); assert.equal(page.data.dateSelectionHint, '');
  page.onEditorInput(event('title', '手动选新日期')); page.onEditorInput(event('start', '08:00')); page.onEditorInput(event('end', '08:30')); submit(page);
  assert.equal(page.data.editorVisible, false); assert.equal(plans.getDayBlocks('2026-11-08').some(b => b.title === '手动选新日期'), true);
});

test('重复安排从锁定今天开始只更新未来，并明确告诉用户今天保留原计划', () => {
  const { page, plans, runtime } = setup();
  runtime.load('miniprogram/services/records.ts').setStatus('2026-10-31', 'music-guitar', 'done');
  const today = clone(plans.getDailyInstance('2026-10-31'));
  page.onCreateSchedule(); page.onEditorInput(event('effectiveFrom', '2026-10-31')); page.onRepeatModeChange(pick(1));
  page.onEditorInput(event('title', '未来每天安排')); page.onEditorInput(event('start', '08:00')); page.onEditorInput(event('end', '08:30')); submit(page);
  assert.equal(page.data.editorVisible, false); assert.match(page.data.saveNotice, /未来安排已保存.*今天已有执行记录.*保留原计划/);
  assert.deepEqual(clone(plans.getDailyInstance('2026-10-31')), today);
  assert.equal(plans.getDayBlocks('2026-11-01').some(b => b.title === '未来每天安排'), true);
  assert.equal(runtime.calls.toasts.at(-1).title, '未来安排已保存');
});

test('新建日期状态读取失败时不打开假定可编辑日期、不写缓存', () => {
  const { page, runtime } = setup(); const before = clone([...runtime.storage]);
  const original = runtime.wx.getStorageSync;
  runtime.wx.getStorageSync = key => { if (key === 'dayflow.instances.v1') throw new Error('日期状态无法读取'); return original(key); };
  page.onCreateSchedule();
  assert.equal(page.data.editorVisible, false); assert.match((page.data.wizardError || page.data.errorMessage), /日期状态无法读取/); assert.deepEqual(clone([...runtime.storage]), before);
});
