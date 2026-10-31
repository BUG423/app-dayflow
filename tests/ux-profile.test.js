const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntime, clone } = require('./helpers/miniprogram');

function toggle(page, section) { page.onToggleSection({ currentTarget: { dataset: { section } } }); }

test('设置入口默认收起，切换分组不会开启权限、请求云端或修改已存偏好', () => {
  const runtime = createRuntime();
  let cloudCalls = 0;
  runtime.wx.cloud = { callFunction() { cloudCalls++; throw new Error('unexpected cloud request'); } };
  const page = runtime.page('profile'); page.onShow();
  const before = clone([...runtime.storage]);
  assert.equal(page.data.expandedSection, '');
  assert.equal(page.data.phaseRulesVisible, false);
  assert.equal(page.data.recordManagementVisible, false);
  for (const section of ['reminders', 'training', 'data', 'about']) {
    toggle(page, section); assert.equal(page.data.expandedSection, section);
    toggle(page, section); assert.equal(page.data.expandedSection, '');
  }
  toggle(page, 'unrecognised'); assert.equal(page.data.expandedSection, '');
  assert.equal(cloudCalls, 0);
  assert.deepEqual(clone([...runtime.storage]), before);
  assert.equal(runtime.calls.modals.length, 0);
  assert.equal(runtime.calls.actionSheets.length, 0);
});

test('训练目标未保存草稿在折叠、页面刷新及其它偏好保存后仍保留，显式保存才提交', () => {
  const runtime = createRuntime(); const page = runtime.page('profile'); page.onShow();
  const prefs = runtime.load('miniprogram/services/preferences.ts');
  const rule = page.data.phaseRuleDrafts[0];
  toggle(page, 'training'); page.onTogglePhaseRules();
  page.onPhaseRuleChange({ currentTarget: { dataset: { id: rule.id, field: 'description' } }, detail: { value: '保持自己的节奏' } });
  const original = prefs.getPreferences().phaseRules[0].description;
  toggle(page, 'data'); toggle(page, 'training'); page.onTogglePhaseRules(); page.onTogglePhaseRules();
  page.onShow();
  page.onSleepTimeChange({ detail: { value: '22:30' } });
  assert.equal(page.data.phaseRuleDrafts[0].description, '保持自己的节奏');
  assert.equal(page.data.phaseRulesDirty, true);
  assert.equal(prefs.getPreferences().phaseRules[0].description, original);
  page.onSavePhaseRules();
  assert.equal(prefs.getPreferences().phaseRules[0].description, '保持自己的节奏');
  assert.equal(page.data.phaseRulesDirty, false);
  assert.equal(page.data.feedbackText, '设置已保存');
});

test('无效阶段输入保存失败仍保留草稿，折叠不会取消提醒预览或执行危险操作', () => {
  const runtime = createRuntime(); const page = runtime.page('profile'); page.onShow();
  const prefs = runtime.load('miniprogram/services/preferences.ts');
  const rule = page.data.phaseRuleDrafts[0]; const original = clone(prefs.getPreferences());
  page.onPhaseRuleChange({ currentTarget: { dataset: { id: rule.id, field: 'minSessions' } }, detail: { value: '-1' } });
  page.onSavePhaseRules();
  assert.equal(page.data.phaseRulesDirty, true);
  assert.equal(page.data.phaseRuleDrafts[0].minSessions, '-1');
  assert.deepEqual(clone(prefs.getPreferences()), original);
  const preview = { title: '这一次的提醒', preparedAt: 10 };
  page.setData({ reminderPreview: preview });
  toggle(page, 'reminders'); toggle(page, 'data'); page.onToggleRecordManagement();
  toggle(page, 'about'); toggle(page, 'reminders');
  assert.deepEqual(clone(page.data.reminderPreview), preview);
  assert.equal(runtime.calls.modals.length, 0);
  assert.equal(runtime.storage.has('dayflow.records.v2'), false);
});
