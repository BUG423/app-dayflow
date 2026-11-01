const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRuntime, clone } = require('./helpers/miniprogram');
const { sunshinePayload } = require('../scripts/sunshine-acceptance-fixtures');
const { wizardPayload } = require('../scripts/wizard-acceptance-fixtures');
const date = '2026-10-31', at = new Date(2026, 9, 31, 20, 30).getTime();

test('周日进入今日可预载下周一，休息基线应在导航稳定后且取消仍保留完整快照', () => {
  const sunday = '2026-11-01', now = new Date(2026, 10, 1, 0, 6), run = createRuntime(now);
  const payload = wizardPayload(sunday, now.getTime(), 'rest');
  Object.entries(payload.values).forEach(([key, value]) => run.storage.set(key, clone(value)));
  const plans = run.page('plans'); plans.onShow();
  const instancesBeforeToday = clone(run.storage.get('dayflow.instances.v1'));
  assert.equal(instancesBeforeToday['2026-11-02'], undefined);
  const today = run.page('today'); today.onLoad(); today.onShow();
  const derived = run.storage.get('dayflow.instances.v1')['2026-11-02'];
  assert.equal(derived.locked, false); assert.equal(derived.templateVersion, 1);
  for (const [key, value] of Object.entries(instancesBeforeToday)) {
    assert.deepEqual(clone(run.storage.get('dayflow.instances.v1')[key]), value);
  }
  const before = clone([...run.storage]);
  today.onOpenRest(); today.onCancelRest();
  assert.deepEqual(clone([...run.storage]), before, 'all storage, including full derived snapshots, stays equal on cancellation');
  today.onHide();
  const script = fs.readFileSync(path.join(__dirname, '../scripts/wechat-planning-wizard.ps1'), 'utf8');
  const rest = script.slice(script.indexOf('function Wz-Rest {'), script.indexOf('function Sz-Seed'));
  assert.ok(rest.indexOf("Ux-Go 'pages/today/index'") < rest.indexOf('$before=Wz-RestSnapshot'));
  assert.ok(rest.indexOf('$before=Wz-RestSnapshot') < rest.indexOf("Tap '.rest-day-open'"));
  assert.match(rest, /@\('plan','versions','snapshots','records'\)/);
});

test('阳光验收夹具经真实模板、记录及快照校验，新版与已锁历史彼此独立', () => {
  for (const scenario of ['sunshine', 'empty']) {
    const payload = sunshinePayload(date, at, scenario), run = createRuntime(new Date(at));
    Object.entries(payload.values).forEach(([key, value]) => run.storage.set(key, clone(value)));
    const plans = run.load('miniprogram/services/plans.ts'), template = plans.getTemplate();
    assert.equal(template.version, 4);
    assert.equal(template.name, '阳光节奏合成验收');
    plans.validateInstances(payload.values['dayflow.instances.v1']);
    run.load('miniprogram/utils/record-validation.ts').validateEnvelope(payload.values['dayflow.records.v2']);
    assert.equal(run.load('miniprogram/utils/plan-validation.ts').validatePlan(template).ok, true);
    assert.equal(payload.wednesdayDate, '2026-11-04');
    assert.equal(payload.thursdayDate, '2026-11-05');
    const before = JSON.stringify(payload.values['dayflow.instances.v1'][payload.historyDate]);
    assert.equal(plans.getDailyInstance(payload.historyDate).templateVersion, 1);
    assert.equal(JSON.stringify(run.storage.get('dayflow.instances.v1')[payload.historyDate]), before);
  }
  for (const invalid of ['2026-02-30', '2026-2-01', 'unknown']) assert.throws(() => sunshinePayload(invalid, at));
  assert.throws(() => sunshinePayload(date, at, 'unknown'));
});

test('阳光夹具可预览新版七日节奏且晨间睡眠占用05点、08点衔接有效', () => {
  const payload = sunshinePayload(date, at), run = createRuntime(new Date(at));
  Object.entries(payload.values).forEach(([key, value]) => run.storage.set(key, clone(value)));
  const plans = run.load('miniprogram/services/plans.ts'), page = run.page('plans'); page.onShow();
  const before = JSON.stringify([...run.storage]); page.onPreviewExample();
  assert.equal(page.data.examplePreview, true); assert.equal(page.data.importPreview.ok, true);
  assert.equal(page.data.importPreview.template.version, 4);
  assert.equal(JSON.stringify([...run.storage]), before, 'preview never rewrites current plan, history or records');
  const block = { id: 'sunshine-candidate', title: '晨间安排', start: '05:00', end: '06:00', kind: 'fixed', category: '生活', tasks: [] };
  const draft = { id: 'sunshine-candidate-rule', title: '晨间安排', effectiveFrom: payload.wednesdayDate, effectiveTo: payload.wednesdayDate, weekdays: [3], exceptions: [], blocks: [block] };
  const available = plans.getScheduleAvailability(draft, block.id, { date: payload.wednesdayDate });
  assert.ok(available.busy.some(b => b.blockId === 'sleep-morning' && b.start === '00:00' && b.end === '08:00'));
  assert.equal(available.allowedStarts.includes('05:00'), false);
  assert.equal(available.allowedStarts.includes('08:00'), true);
  const selection = plans.getOverwriteSelectionAvailability(draft, block.id, { date: payload.wednesdayDate });
  assert.equal(selection.allowedStarts.includes('05:00'), true, 'external sleep can only be replaced after explicit confirmation');
});

test('空验收夹具通过真实页面完成24点结束及每周三变每周四，不写旧历史', () => {
  const payload = sunshinePayload(date, at, 'empty'), run = createRuntime(new Date(at));
  Object.entries(payload.values).forEach(([key, value]) => run.storage.set(key, clone(value)));
  const page = run.page('plans'); page.onShow(); page.onCreateSchedule();
  const input = (field, value) => page.onEditorInput({ currentTarget: { dataset: { field } }, detail: { value } });
  input('title', '合成夜间整理'); page.onWizardNext(); input('effectiveFrom', payload.wednesdayDate);
  input('start', '23:00'); input('end', '24:00'); page.onWizardNext();
  page.onChooseRepeat({ currentTarget: { dataset: { index: 4 } } });
  assert.equal(page.data.repeatChoices.find(x => x.value === 4).label, '每周三');
  assert.deepEqual(Array.from(page.data.selectedWeekdays), [3]);
  page.onWizardBack(); input('effectiveFrom', payload.thursdayDate); page.onWizardNext();
  assert.equal(page.data.repeatChoices.find(x => x.value === 4).label, '每周四');
  for (const [mode, days] of [[2, [1,2,3,4,5]], [5, [6,0]], [1, [1,2,3,4,5,6,0]], [4, [4]]]) {
    page.onChooseRepeat({ currentTarget: { dataset: { index: mode } } });
    assert.deepEqual(Array.from(page.data.selectedWeekdays).sort(), [...days].sort());
  }
  const oldRecords = JSON.stringify(run.storage.get('dayflow.records.v2'));
  const oldHistory = JSON.stringify(run.storage.get('dayflow.instances.v1')[payload.historyDate]);
  page.onWizardNext(); assert.equal(page.data.editorStep, 3); page.onSaveSchedule();
  assert.equal(page.data.editorVisible, false, page.data.wizardError);
  const saved = run.storage.get('dayflow.plans.v1').schedules[0];
  assert.equal(saved.blocks[0].end, '24:00'); assert.deepEqual(Array.from(saved.weekdays), [4]);
  assert.equal(JSON.stringify(run.storage.get('dayflow.records.v2')), oldRecords);
  assert.equal(JSON.stringify(run.storage.get('dayflow.instances.v1')[payload.historyDate]), oldHistory);
});

test('五页固定下拉和导航使用样式图标，不再出现生硬Unicode箭头', () => {
  for (const name of ['today', 'plans', 'training', 'stats', 'profile']) {
    const source = fs.readFileSync(path.join(__dirname, '../miniprogram/pages', name, 'index.wxml'), 'utf8');
    assert.doesNotMatch(source, /[⌄⌃›→]/, name + ' still has a decorative text arrow');
  }
});

test('合成自定义旧计划通过实际采用按钮取消与确认，白天兴趣及锁定日事实均保留', () => {
  const payload = sunshinePayload(date, at, 'custom'), run = createRuntime(new Date(at));
  Object.entries(payload.values).forEach(([key, value]) => run.storage.set(key, clone(value)));
  const page = run.page('plans'); page.onShow();
  const before = JSON.stringify([...run.storage]);
  const oldRecords = JSON.stringify(run.storage.get('dayflow.records.v2'));
  const oldToday = JSON.stringify(run.storage.get('dayflow.instances.v1')[date]);
  const oldHistory = JSON.stringify(run.storage.get('dayflow.instances.v1')[payload.historyDate]);
  page.onPreviewEveningUpdate(); assert.equal(page.data.eveningPreview, true); assert.equal(page.data.importPreview.ok, true);
  assert.equal(JSON.stringify([...run.storage]), before);
  page.onConfirmEveningUpdate(); assert.equal(run.calls.modals.at(-1).title, '更新晚间作息？');
  run.calls.modals.at(-1).success({ confirm: false }); assert.equal(JSON.stringify([...run.storage]), before);
  page.onConfirmEveningUpdate(); run.calls.modals.at(-1).success({ confirm: true });
  const saved = run.storage.get('dayflow.plans.v1'); assert.equal(saved.version, 5, page.data.errorMessage);
  const plans = run.load('miniprogram/services/plans.ts'), calendar = run.load('miniprogram/utils/calendar');
  const oldInterest = payload.values['dayflow.plans.v1'].schedules.find(rule => rule.id === 'sunshine-custom-interest');
  assert.deepEqual(clone(saved.schedules.find(rule => rule.id === oldInterest.id)), oldInterest);
  for (let offset = 0; offset < 7; offset++) {
    const day = calendar.shiftDays(payload.wednesdayDate, offset), swim = [2,4,6].includes(calendar.parseLocalDate(day).getDay());
    const blocks = plans.getDayBlocks(day), morning = blocks.find(block => block.id === 'work-morning');
    assert.equal(morning.start, '08:00'); assert.equal(morning.end, '12:00'); assert.equal(morning.title, '自定义白天工作');
    const training = blocks.filter(block => block.category === '训练'); assert.equal(training.length, 1);
    assert.deepEqual([training[0].start, training[0].end], swim ? ['17:30','19:00'] : ['20:30','22:00']);
    const overtime = blocks.filter(block => block.category === '加班');
    assert.equal(overtime.length, 1);
    assert.deepEqual([overtime[0].start, overtime[0].end], swim ? ['19:30','21:30'] : ['17:00','20:00']);
    if (swim) {
      assert.ok(blocks.some(block => block.title === '游泳后返回工作地点' && block.start === '19:00' && block.end === '19:30'));
      assert.ok(blocks.some(block => block.title === '加班后回家' && block.start === '21:30' && block.end === '22:00'));
    }
  }
  assert.equal(JSON.stringify(run.storage.get('dayflow.records.v2')), oldRecords);
  assert.equal(JSON.stringify(run.storage.get('dayflow.instances.v1')[date]), oldToday);
  assert.equal(JSON.stringify(run.storage.get('dayflow.instances.v1')[payload.historyDate]), oldHistory);
});
