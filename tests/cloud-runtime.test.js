const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntime } = require('./helpers/miniprogram');

test('空部署配置保持离线可用，重复初始化不覆盖用户阶段和提醒选择', () => {
  const runtime = createRuntime();
  const config = runtime.load('miniprogram/config/runtime.ts');
  const prefs = runtime.load('miniprogram/services/preferences.ts');
  prefs.savePreferences({ sleepTime: '22:15', taskReminderEnabled: true, trainingPhase: '巩固' });
  config.initializeRuntimeSettings();
  assert.equal(runtime.storage.has('dayflow.sync.v1'), false);
  config.runtimeConfiguration.cloudEnvId = 'fixture-env';
  config.runtimeConfiguration.subscriptionTemplateIds = ['', 'fixture-sleep-template'];
  config.initializeRuntimeSettings(); config.initializeRuntimeSettings();
  const state = runtime.load('miniprogram/services/sync.ts').getSyncState();
  assert.equal(state.enabled, false);
  assert.equal(prefs.getPreferences().sleepTime, '22:15');
  assert.equal(prefs.getPreferences().taskReminderEnabled, true);
  assert.equal(prefs.getPreferences().trainingPhase, '巩固');
  assert.deepEqual(JSON.parse(JSON.stringify(prefs.getPreferences().subscriptionTemplateIds)), ['', 'fixture-sleep-template']);
});

test('个人页未连接云端和缺订阅模板有中文结果且不发云请求', async () => {
  const runtime = createRuntime(); const page = runtime.page('profile');
  runtime.wx.showActionSheet = options => options.success({ tapIndex: 0 });
  page.onShow();
  assert.equal(page.data.version, '本地开发版');
  assert.equal(page.data.sync.configured, false);
  page.onToggleSync({ detail: { value: true } });
  assert.match(runtime.calls.toasts[0].title, /云服务尚未连接/);
  let response;
  runtime.wx.showActionSheet = options => { response = options.success({ tapIndex: 0 }); };
  page.onRequestSubscription(); await response;
  assert.match(page.data.feedbackText, /尚未配置对应订阅模板/);
});
