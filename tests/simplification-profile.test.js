const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRuntime, clone } = require('./helpers/miniprogram');

const section = value => ({ currentTarget: { dataset: { section: value } } });
const input = value => ({ detail: { value } });

test('LEAN-01 我的记录使用普通页面导航，打开入口不修改已存内容', () => {
  const runtime = createRuntime(), page = runtime.page('profile');
  page.onShow();
  let tabCalls = 0;
  runtime.wx.switchTab = () => { tabCalls++; };
  const before = clone([...runtime.storage]);
  page.onOpenRecords();
  assert.deepEqual(clone(runtime.calls.navigations), [{ url: '/pages/stats/index' }]);
  assert.equal(tabCalls, 0);
  assert.deepEqual(clone([...runtime.storage]), before);
});

test('LEAN-06 其他设置按需打开，收起不保存训练草稿或请求云服务', () => {
  const runtime = createRuntime(), page = runtime.page('profile');
  let cloudCalls = 0;
  runtime.wx.cloud = { callFunction() { cloudCalls++; throw new Error('unexpected request'); } };
  page.onShow();
  const before = clone([...runtime.storage]);
  assert.equal(page.data.otherSettingsVisible, false);
  page.onToggleOtherSettings();
  page.onToggleSection(section('training'));
  const rule = page.data.phaseRuleDrafts[0];
  page.onPhaseRuleChange({ currentTarget: { dataset: { id: rule.id, field: 'description' } }, detail: { value: '自己选择的阶段目标' } });
  page.onToggleOtherSettings();
  assert.equal(page.data.otherSettingsVisible, false);
  assert.equal(page.data.expandedSection, '');
  page.onToggleOtherSettings();
  page.onToggleSection(section('about'));
  assert.equal(page.data.expandedSection, 'about');
  assert.equal(page.data.phaseRuleDrafts[0].description, '自己选择的阶段目标');
  assert.equal(page.data.phaseRulesDirty, true);
  assert.equal(cloudCalls, 0);
  assert.deepEqual(clone([...runtime.storage]), before);
});

test('LEAN-06 数据备份一次打开导出恢复操作，切换入口保留预览', () => {
  const runtime = createRuntime(), page = runtime.page('profile');
  page.onShow();
  const before = clone([...runtime.storage]);
  page.setData({ backupPreviewSummary: { planName: '待核对的合成备份' }, backupPreviewWarnings: ['请核对范围'] });
  page.onOpenDataBackup();
  assert.equal(page.data.expandedSection, 'data');
  assert.equal(page.data.localBackupVisible, true);
  page.onOpenDataBackup();
  assert.equal(page.data.expandedSection, '');
  page.onOpenDataBackup();
  assert.equal(page.data.localBackupVisible, true);
  assert.equal(page.data.backupPreviewSummary.planName, '待核对的合成备份');
  assert.deepEqual(clone([...runtime.storage]), before);
});

test('LEAN-06 云能力暂失仍显示已启用状态与关闭入口，关闭只改同步选择', () => {
  const source = fs.readFileSync(path.join(__dirname, '../miniprogram/pages/profile/index.wxml'), 'utf8');
  const switchCondition = source.match(/wx:if="{{([^}]+)}}" class="row"><text>云端同步<\/text><switch class="sync-switch"/)[1];
  const summary = source.match(/section-data[^\n]+class="setting-summary">{{([^}]+)}}/)[1];
  const runtime = createRuntime();
  const original = { enabled: true, envId: 'fixture-env', version: 3, accountId: 'fixture-owner', queued: false, conflict: false };
  runtime.storage.set('dayflow.sync.v1', original);
  const page = runtime.page('profile'); page.onShow(); page.onOpenDataBackup();
  assert.equal(page.data.sync.configured, false);
  assert.equal(vm.runInNewContext(switchCondition, { sync: page.data.sync }), true);
  assert.equal(vm.runInNewContext(summary, { sync: page.data.sync }), '已开启云端同步');
  const before = clone([...runtime.storage].filter(([key]) => key !== 'dayflow.sync.v1'));
  page.onToggleSync(input(false));
  assert.deepEqual(clone(runtime.storage.get('dayflow.sync.v1')), { ...original, enabled: false });
  assert.deepEqual(clone([...runtime.storage].filter(([key]) => key !== 'dayflow.sync.v1')), before);
  assert.equal(vm.runInNewContext(switchCondition, { sync: page.data.sync }), false);
  assert.equal(vm.runInNewContext(summary, { sync: page.data.sync }), '记录保存在本机');
  assert.equal(runtime.calls.modals.length, 0);
});

test('LEAN-06 云配置暂失不隐藏已有冲突，原选择与二次确认流程仍可达', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../miniprogram/pages/profile/index.wxml'), 'utf8');
  const condition = source.match(/wx:if="{{([^}]+)}}" class="conflict-notice"/)[1];
  const choices = [];
  const state = { enabled: false, configured: false, pending: false, conflict: true };
  const runtime = createRuntime(undefined, { modules: { 'miniprogram/services/sync.ts': {
    getSyncState: () => state,
    resolveSyncConflict: async choice => { choices.push(choice); return { message: '两份记录仍保留' }; }
  } } });
  const page = runtime.page('profile'); page.onShow(); page.onOpenDataBackup();
  assert.equal(vm.runInNewContext(condition, { sync: page.data.sync }), true);
  const before = clone([...runtime.storage]);
  page.onResolveConflict();
  runtime.calls.actionSheets[0].success({ tapIndex: 0 });
  assert.equal(runtime.calls.modals.length, 1);
  assert.match(runtime.calls.modals[0].content, /另一份内容会继续保留/);
  assert.deepEqual(choices, []);
  await runtime.calls.modals[0].success({ confirm: false });
  assert.deepEqual(choices, []);
  page.onResolveConflict(); runtime.calls.actionSheets[1].success({ tapIndex: 1 });
  await runtime.calls.modals[1].success({ confirm: true });
  assert.deepEqual(choices, ['remote']);
  assert.deepEqual(clone([...runtime.storage]), before);
});

for (const failure of ['recovery-required', 'read-failed']) {
  test('LEAN-06 ' + failure + ' 自动显露恢复入口，其他设置与分组切换不能隐藏且继续拒写', async () => {
    let fileActions = 0;
    const service = {
      getLocalBackupState() {
        if (failure === 'read-failed') throw new Error('恢复状态暂时无法读取，请保留数据');
        return { canUndo: false, recoveryRequired: true, reason: '请继续恢复原内容' };
      },
      exportLocalBackupFile: async () => { fileActions++; },
      chooseLocalBackupFile: async () => { fileActions++; }
    };
    const runtime = createRuntime(undefined, { modules: { 'miniprogram/services/local-backup.ts': service } });
    const page = runtime.page('profile'); page.onShow();
    const before = clone([...runtime.storage]);
    assert.equal(page.data.backupRecoveryRequired, failure === 'recovery-required');
    assert.equal(page.data.backupStateFailed, failure === 'read-failed');
    for (const name of ['training', 'about', 'reminders', 'data']) {
      page.onToggleOtherSettings();
      page.onToggleSection(section(name));
      page.onOpenDataBackup(); page.onToggleLocalBackup();
      assert.equal(page.data.expandedSection, 'data');
      assert.equal(page.data.localBackupVisible, true);
    }
    page.onSleepReminderChange(input(true)); page.onSleepTimeChange(input('22:30'));
    page.onChoosePhase(); page.onRequestSubscription(); page.onToggleSync(input(true));
    page.onClearRecords(); page.onToggleRecordManagement();
    await page.onExportLocalBackup(); await page.onImportLocalBackup(); await page.onSyncNow();
    assert.equal(page.data.recordManagementVisible, false);
    assert.equal(fileActions, 0);
    assert.equal(runtime.calls.modals.length, 0);
    assert.equal(runtime.calls.actionSheets.length, 0);
    assert.deepEqual(clone([...runtime.storage]), before);
  });
}

test('LEAN-07 默认本周七天，未来日期不计完成率；历史筛选与原始事件展开仍可用', () => {
  const runtime = createRuntime();
  const records = runtime.load('miniprogram/services/records.ts');
  records.setStatus('2026-10-30', 'music-guitar', 'done');
  records.saveFeedback('2026-10-30', 'music-guitar', { effort: 2, discomfort: false, note: '按自己节奏完成' });
  const page = runtime.page('stats'); page.onShow();
  const before = clone([...runtime.storage]);
  assert.equal(page.data.historyVisible, false);
  assert.equal(page.data.days.length, 7);
  assert.deepEqual(clone(page.data.days.filter(day => day.future).map(day => day.date)), ['2026-11-01']);
  const summary = runtime.load('miniprogram/services/insights.ts').getWeeklySummary(page.data.anchorDate);
  assert.equal(page.data.weeklyDone, summary.completed);
  assert.equal(page.data.weeklyTotal, summary.total);
  page.onToggleHistory();
  assert.equal(page.data.historyVisible, true);
  page.onHistoryFromChange(input('2026-10-30')); page.onHistoryToChange(input('2026-10-30')); page.onApplyHistoryRange();
  assert.equal(page.data.historyCount, 1);
  const row = page.data.historyRecords.find(item => item.recordKey === '2026-10-30:music-guitar');
  assert.equal(row.actualStartLabel, '未记录');
  assert.match(row.feedbackLabel, /按自己节奏完成/);
  assert.ok(row.eventCount > 0);
  page.onToggleHistoryRecord({ currentTarget: { dataset: { id: row.recordKey } } });
  page.onToggleHistory(); page.onToggleHistory();
  assert.equal(page.data.historyRecords.find(item => item.recordKey === row.recordKey).expanded, true);
  assert.equal(page.data.fromDate, '2026-10-30');
  page.onOpenHistoryDay({ currentTarget: { dataset: { date: '2026-10-30' } } });
  assert.match(runtime.calls.modals.at(-1).content, /按自己节奏完成/);
  page.onNextWeek();
  assert.equal(page.data.days.length, 7);
  assert.ok(page.data.days.every(day => day.future));
  assert.equal(page.data.weeklyTotal, 0);
  assert.deepEqual(clone([...runtime.storage]), before);
});

test('LEAN-06/07 可见区域契约：低频设置与历史收纳，离线不展示云开通提示', () => {
  const read = name => fs.readFileSync(path.join(__dirname, '../miniprogram/pages', name, 'index.wxml'), 'utf8');
  const profile = read('profile'), stats = read('stats');
  const other = profile.indexOf('wx:if="{{otherSettingsVisible}}"');
  assert.ok(profile.indexOf('section-records') < profile.indexOf('section-reminders'));
  assert.ok(profile.indexOf('section-data') < other);
  assert.ok(profile.indexOf('section-training') > other);
  assert.ok(profile.indexOf('section-about') > other);
  assert.doesNotMatch(profile, /尚未开通|云端功能就绪后/);
  assert.ok(stats.indexOf('wx:if="{{historyVisible}}"') < stats.indexOf('class="card history-filter"'));
  assert.ok(stats.indexOf('wx:if="{{historyVisible}}"') < stats.indexOf('class="metric-grid"'));
  assert.match(stats, /bindtap="onToggleHistoryRecord"/);
});
