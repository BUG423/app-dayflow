const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntime, clone } = require('./helpers/miniprogram');
const accountId = 'a'.repeat(64);
function setup() {
  const runtime = createRuntime(new Date(2026, 9, 31, 12, 4)); const calls = [];
  runtime.wx.cloud = { init() {}, callFunction(options) {
    calls.push({ name: options.name, data: clone(options.data) });
    let result;
    if (options.name === 'dayflowSync') result = { ok: true, accountId, uploadPrefix: 'dayflow-photos/' + accountId + '/' };
    else if (options.data.action === 'capability') result = { ok: true, accountId, available: true, templateId: 'fixture-template-task' };
    else if (options.data.action === 'register') result = { ok: true, accountId, job: { ...options.data.candidate, id: 'b'.repeat(64), status: 'pending' } };
    else result = { ok: true, accountId, jobs: [] };
    options.success({ result });
  } };
  runtime.load('miniprogram/services/sync.ts').configureSync({ enabled: true, envId: 'fixture-env' });
  runtime.load('miniprogram/services/preferences.ts').savePreferences({ subscriptionTemplateIds: ['fixture-template-task', ''] });
  return { ...runtime, calls, service: runtime.load('miniprogram/services/reminders.ts') };
}
test('后台候选独立于前台开关且按本地时间选择下一条，跨午夜保留目标日期', () => {
  const runtime = setup(); const next = runtime.service.getNextReminderCandidate('task');
  assert.equal(next.kind, 'task'); assert.ok(next.dueAt > new Date(2026, 9, 31, 12, 4).getTime());
  assert.equal(next.dateKey, '2026-10-31');
  const plan = runtime.load('miniprogram/services/plans.ts').getTemplate();
  plan.schedules = [{ id: 'daily', title: '每日', weekdays: [0,1,2,3,4,5,6], effectiveFrom: '2026-10-31', exceptions: [],
    blocks: [{ id: 'early', title: '零点练习', category: 'practice', start: '00:05', end: '00:15', kind: 'parallel', tasks: [{ id: 'practice', title: '练习', start: '00:05', end: '00:15', actions: [] }] }] }];
  runtime.load('miniprogram/services/plans.ts').saveTemplate(plan);
  runtime.setNow(new Date(2026, 9, 31, 23, 50));
  const midnight = runtime.service.getNextReminderCandidate('task');
  assert.equal(midnight.targetDate, '2026-11-01'); assert.equal(midnight.dateKey, '2026-10-31'); assert.equal(midnight.time, '23:55');
});
test('仅接受明确本次授权且候选/预览新鲜，偏好改变必须重新预览', async () => {
  const runtime = setup(); const preview = await runtime.service.prepareReminder('task');
  await assert.rejects(runtime.service.registerReminder(preview, false));
  for (const preparedAt of [NaN, Infinity, -1, preview.preparedAt + 60000]) await assert.rejects(runtime.service.registerReminder({ ...preview, preparedAt }, true));
  const result = await runtime.service.registerReminder(preview, true); assert.equal(result.status, 'pending');
  runtime.load('miniprogram/services/preferences.ts').savePreferences({ leadMinutes: 20 });
  await assert.rejects(runtime.service.registerReminder(preview, true), /重新预览/);
  assert.equal(runtime.calls.filter(item => item.data.action === 'register').length, 1);
});
test('页面先预载预览，确认按钮直接请求原生授权；拒绝不会登记', async () => {
  const runtime = setup(); const page = runtime.page('profile'); page.onShow(); let previewPromise;
  runtime.wx.showActionSheet = options => { previewPromise = options.success({ tapIndex: 0 }); };
  page.onRequestSubscription(); await previewPromise; assert.ok(page.data.reminderPreview);
  assert.equal(runtime.calls.filter(item => item.data.action === 'register').length, 0);
  const before = runtime.calls.length; let permissionCalled = false;
  runtime.wx.requestSubscribeMessage = options => { permissionCalled = true; assert.equal(runtime.calls.length, before); options.success({ 'fixture-template-task': 'reject' }); };
  page.onConfirmReminderSubscription(); assert.equal(permissionCalled, true);
  assert.equal(runtime.calls.filter(item => item.data.action === 'register').length, 0);
});
test('关闭数据同步后仍可主动查询和取消已绑定账户提醒，不会重新开启同步', async () => {
  const runtime = setup(); await runtime.service.prepareReminder('task');
  const sync = runtime.load('miniprogram/services/sync.ts');
  sync.configureSync({ enabled: false, envId: 'fixture-env' });
  await runtime.service.listReminders();
  assert.equal(sync.getSyncState().enabled, false);
  await assert.rejects(runtime.service.prepareReminder('task'));
  assert.equal(runtime.calls.filter(item => item.data.action === 'push').length, 0);
});
test('合法长标题在授权前预览按二十个Unicode字符截取，源计划不变且可登记', async () => {
  const title = '🏊'.repeat(10) + '按自己的节奏完成今天的训练并记录练习感受'.repeat(3);
  const block = { id: 'long-title', title, category: 'training', kind: 'parallel', start: '13:00', end: '13:15',
    tasks: [{ id: 'practice', title: '练习', start: '13:00', end: '13:15', actions: [] }] };
  const runtime = setup();
  const plans = runtime.load('miniprogram/services/plans.ts');
  const template = plans.getTemplate();
  template.schedules = [{ id: 'daily', title: '每天练习', weekdays: [0,1,2,3,4,5,6], effectiveFrom: '2026-10-31', exceptions: [], blocks: [block] }];
  plans.saveTemplate(template);
  let authorizations = 0;
  runtime.wx.requestSubscribeMessage = () => { authorizations++; };
  const preview = await runtime.service.prepareReminder('task');
  assert.equal(authorizations, 0);
  assert.equal(Array.from(preview.title).length, 20);
  assert.equal(preview.title, Array.from(title).slice(0, 20).join(''));
  assert.equal(plans.getTemplate().schedules[0].blocks[0].title, title);
  const result = await runtime.service.registerReminder(preview, true);
  assert.equal(result.status, 'pending');
  // Exercise the actual server validator with the same exported candidate.
  const { createHandler } = require('../cloudfunctions/dayflowReminders/jobs');
  const serverNow = preview.preparedAt;
  const server = createHandler({ async transact(_id, update) { return (await update(null)).result; } },
    { enabled: true, miniprogramState: 'developer', templates: { task: { id: preview.templateId, titleField: 'thing1', timeField: 'time2' } } }, () => serverNow);
  const context = { OPENID: 'fixture-user', APPID: 'fixture-app' };
  const capability = await server({ action: 'capability', kind: 'task' }, context);
  const { templateId, accountId: _accountId, preparedAt: _preparedAt, ...candidate } = preview;
  const registered = await server({ action: 'register', candidate, expectedAccountId: capability.accountId, templateId }, context);
  assert.equal(registered.ok, true);
});
