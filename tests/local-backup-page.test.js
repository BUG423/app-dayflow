const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntime, clone } = require('./helpers/miniprogram');

function setup(overrides = {}) {
  const summary = { exportedAt: new Date(2026, 10, 2, 0, 5).getTime(), sourceDate: '2026-11-02',
    planName: '自己的日程', planVersion: 9, scheduleCount: 7, planVersionCount: 3,
    snapshotCount: 5, recordDateCount: 2, recordCount: 8, restDayCount: 1,
    rangeStart: '2026-11-01', rangeEnd: '2026-11-02' };
  const preview = { ok: true, errors: [], warnings: ['提醒恢复后会保持关闭'], summary, lease: 'private-confirmation-lease' };
  const file = { filePath: 'wxfile://private-backup-file', fileName: 'dayflow-fixture.json', summary };
  const calls = { export: 0, choose: 0, share: 0, restore: [], undo: [], undoPreview: 0, recheck: 0 };
  let state = { canUndo: false, reason: '', recoveryRequired: false };
  const service = {
    exportLocalBackupFile: async () => { calls.export++; return file; },
    chooseLocalBackupFile: async () => { calls.choose++; return { text: 'private-backup-content', fileName: 'chosen.json', preview }; },
    shareLocalBackupFile: async value => { calls.share++; assert.equal(value, file); },
    previewLocalBackup: () => { calls.recheck++; return { ...preview, lease: 'private-rechecked-lease' }; },
    restoreLocalBackup: (text, lease) => { calls.restore.push({ text, lease }); state = { canUndo: true, reason: '', recoveryRequired: false }; },
    getLocalBackupState: () => state,
    previewUndoLocalBackup: () => { calls.undoPreview++; return { ...preview, lease: 'private-undo-lease' }; },
    undoLocalBackup: lease => { calls.undo.push(lease); state = { canUndo: false, reason: '', recoveryRequired: false }; },
    ...overrides
  };
  const runtime = createRuntime(new Date(2026, 10, 2, 8), { modules: {
    'miniprogram/services/local-backup.ts': service,
    'miniprogram/services/local-backup.js': service
  } });
  runtime.storage.set('dayflow.records.v2', { schemaVersion: 2, byDate: {} });
  const page = runtime.page('profile'); page.onShow();
  return { runtime, page, calls, service, preview, file, setState(value) { state = value; } };
}

test('备份入口默认收起，展开只读；导出不会自动发送文件，敏感原值不进入页面data', async () => {
  const { runtime, page, calls, file } = setup();
  const before = clone([...runtime.storage]);
  assert.equal(page.data.localBackupVisible, false);
  page.onToggleSection({ currentTarget: { dataset: { section: 'data' } } });
  page.onToggleLocalBackup();
  assert.equal(page.data.localBackupVisible, true);
  assert.equal(calls.export + calls.choose + calls.share, 0);
  assert.deepEqual(clone([...runtime.storage]), before);
  await page.onExportLocalBackup();
  assert.equal(calls.export, 1); assert.equal(calls.share, 0);
  assert.equal(page.data.backupExportReady, true);
  assert.equal(page.data.backupExportSummary.exportedAtLabel, '2026-11-02 00:05');
  assert.match(page.data.backupMessage, /尚未发送/);
  assert.equal(page.localBackupFile, file);
  assert.doesNotMatch(JSON.stringify(page.data), /wxfile:|private-backup-content|private-confirmation-lease/);
  assert.deepEqual(clone([...runtime.storage]), before);
  await page.onShareLocalBackup(); assert.equal(calls.share, 1);
  assert.match(page.data.backupMessage, /自行确认/);
});

test('异步导出重复点击只执行一次，关闭页面后不会写回旧页面状态', async () => {
  let finish, exports = 0;
  const deferred = new Promise(resolve => { finish = resolve; });
  const { page, file } = setup({ exportLocalBackupFile: () => { exports++; return deferred; } });
  const work = page.onExportLocalBackup();
  assert.equal(page.data.backupBusy, true);
  await page.onExportLocalBackup();
  page.onClearRecords(); page.onResolveConflict();
  assert.equal(exports, 1);
  page.onUnload(); finish(file); await work;
  assert.equal(page.data.backupExportReady, false);
  assert.equal(page.localBackupFile, null);
});

test('有效预览与取消确认零写，取消后的迟到确认不能恢复；再次确认只执行一次', async () => {
  const { runtime, page, calls } = setup();
  const before = clone([...runtime.storage]);
  await page.onImportLocalBackup();
  assert.equal(page.data.backupPreviewSummary.recordCount, 8);
  assert.equal(page.data.backupPreviewSummary.dateRangeLabel, '2026-11-01 至 2026-11-02');
  assert.doesNotMatch(JSON.stringify(page.data), /private-backup-content|private-confirmation-lease/);
  assert.deepEqual(clone([...runtime.storage]), before);
  page.onConfirmLocalBackup(); page.onConfirmLocalBackup();
  assert.equal(runtime.calls.modals.length, 1);
  assert.match(runtime.calls.modals[0].content, /提醒恢复后关闭/);
  await runtime.calls.modals[0].success({ confirm: false });
  await runtime.calls.modals[0].success({ confirm: true });
  assert.equal(calls.restore.length, 0);
  assert.ok(page.data.backupPreviewSummary);
  page.onConfirmLocalBackup();
  const confirmed = runtime.calls.modals[1];
  await confirmed.success({ confirm: true });
  await confirmed.success({ confirm: true });
  assert.deepEqual(calls.restore, [{ text: 'private-backup-content', lease: 'private-confirmation-lease' }]);
  assert.equal(page.data.backupPreviewSummary, null);
  assert.equal(page.data.backupBusy, false);
  assert.equal(page.data.backupUndoAvailable, true);
  assert.match(page.data.backupMessage, /恢复前副本已保留/);
});

test('导入取消、损坏文件和过期确认保留原预览与本机内容，失败提示可重新操作', async () => {
  const { runtime, page, service } = setup();
  await page.onExportLocalBackup(); await page.onImportLocalBackup();
  const before = clone([...runtime.storage]), candidate = page.localBackupCandidate;
  service.chooseLocalBackupFile = async () => { throw new Error('已取消选择备份，现有记录未改变'); };
  await page.onImportLocalBackup(); assert.equal(page.localBackupCandidate, candidate);
  assert.match(page.data.backupMessage, /取消选择/);
  service.chooseLocalBackupFile = async () => ({ text: 'invalid', preview: { ok: false, errors: ['文件校验未通过'], warnings: [], summary: null } });
  await page.onImportLocalBackup(); assert.equal(page.localBackupCandidate, candidate);
  assert.match(page.data.backupMessage, /校验未通过/);
  page.onConfirmLocalBackup(); assert.equal(runtime.calls.modals.length, 0);
  page.onRecheckLocalBackupPreview(); const rechecked = page.localBackupCandidate;
  service.restoreLocalBackup = () => { throw new Error('本机内容已变化，请重新选择备份并预览'); };
  page.onConfirmLocalBackup(); await runtime.calls.modals.at(-1).success({ confirm: true });
  assert.equal(page.localBackupCandidate, rechecked);
  assert.equal(page.data.backupExportReady, true);
  assert.equal(page.data.backupBusy, false);
  assert.match(page.data.backupMessage, /内容已变化/);
  assert.deepEqual(clone([...runtime.storage]), before);
  page.onCancelLocalBackupPreview();
  assert.equal(page.localBackupCandidate, null);
  assert.equal(page.data.backupPreviewSummary, null);
  assert.deepEqual(clone([...runtime.storage]), before);
});

test('恢复未完成优先继续恢复原内容，普通内容变化后不弹出可撤销的假确认', async () => {
  const { runtime, page, calls, setState } = setup();
  setState({ canUndo: false, recoveryRequired: true, reason: '恢复前副本已保留，请继续恢复原内容' });
  page.refreshLocalBackupState();
  assert.equal(page.data.backupRecoveryRequired, true);
  page.onUndoLocalBackup(); page.onUndoLocalBackup();
  assert.equal(runtime.calls.modals.length, 1);
  assert.equal(runtime.calls.modals[0].title, '继续恢复原内容？');
  await runtime.calls.modals[0].success({ confirm: true });
  await runtime.calls.modals[0].success({ confirm: true });
  assert.deepEqual(calls.undo, ['private-undo-lease']);
  assert.equal(page.data.backupRecoveryRequired, false);
  assert.match(page.data.backupMessage, /已恢复上次操作前/);
  setState({ canUndo: false, recoveryRequired: false, reason: '恢复后内容已变化，不能直接撤销，副本仍保留' });
  page.onUndoLocalBackup();
  assert.equal(runtime.calls.modals.length, 1);
  assert.match(page.data.backupMessage, /不能直接撤销/);
  assert.equal(page.data.backupBusy, false);
});

test('发送取消和原生确认失败不丢失文件或预览，未保存阶段草稿只在确认恢复后放弃', async () => {
  const { runtime, page, service } = setup();
  await page.onExportLocalBackup(); const original = page.localBackupFile;
  service.shareLocalBackupFile = async () => { throw new Error('已取消发送，本机备份文件仍保留'); };
  await page.onShareLocalBackup();
  assert.equal(page.localBackupFile, original);
  assert.match(page.data.backupMessage, /已取消发送/);
  await page.onImportLocalBackup();
  page.setData({ phaseRulesDirty: true });
  page.onConfirmLocalBackup();
  assert.match(runtime.calls.modals[0].content, /尚未保存的训练目标也会放弃/);
  runtime.calls.modals[0].fail({});
  assert.equal(page.data.backupBusy, false);
  assert.equal(page.data.phaseRulesDirty, true);
  assert.ok(page.data.backupPreviewSummary);
  page.onConfirmLocalBackup(); await runtime.calls.modals[1].success({ confirm: true });
  assert.equal(page.data.phaseRulesDirty, false);
});

test('重新进入我的发现未完成恢复时主动展开恢复区，设置、订阅和重置均不写入', async () => {
  const { runtime, page, setState, calls } = setup();
  const before = clone([...runtime.storage]);
  setState({ canUndo: false, recoveryRequired: true, reason: '请先继续恢复原内容' });
  page.onShow();
  assert.equal(page.data.expandedSection, 'data');
  assert.equal(page.data.localBackupVisible, true);
  assert.equal(page.data.backupRecoveryRequired, true);
  page.onSleepReminderChange({ detail: { value: true } });
  page.onRequestSubscription(); page.onConfirmReminderSubscription();
  page.onChoosePhase(); page.onToggleSync({ detail: { value: true } });
  await page.onSyncNow(); page.onResolveConflict(); page.onClearRecords();
  await page.onExportLocalBackup(); await page.onImportLocalBackup();
  assert.equal(calls.export + calls.choose + calls.share, 0);
  assert.equal(runtime.calls.modals.length, 0);
  assert.equal(runtime.calls.actionSheets.length, 0);
  assert.deepEqual(clone([...runtime.storage]), before);
  page.onToggleLocalBackup(); assert.equal(page.data.localBackupVisible, true);
});

test('恢复点状态读取失败也关闭写入口，重新检查成功后可继续备份', async () => {
  let unavailable = true;
  const { runtime, page, calls } = setup({ getLocalBackupState: () => {
    if (unavailable) throw new Error('恢复前副本暂时无法核对，请保留数据并稍后重试');
    return { canUndo: false, reason: '', recoveryRequired: false };
  } });
  const before = clone([...runtime.storage]);
  assert.equal(page.data.backupStateFailed, true);
  assert.equal(page.data.localBackupVisible, true);
  await page.onExportLocalBackup(); await page.onImportLocalBackup(); page.onClearRecords();
  assert.equal(calls.export + calls.choose, 0);
  assert.equal(runtime.calls.modals.length, 0);
  assert.deepEqual(clone([...runtime.storage]), before);
  unavailable = false; page.onRecheckLocalBackupState();
  assert.equal(page.data.backupStateFailed, false);
  await page.onExportLocalBackup(); assert.equal(calls.export, 1);
});

test('过期确认后可直接重新检查同一文件，必须重新核对并确认才保存新租约', async () => {
  const { runtime, page, service, calls } = setup();
  await page.onImportLocalBackup();
  service.restoreLocalBackup = () => { throw new Error('本机内容已变化，请重新预览后确认'); };
  page.onConfirmLocalBackup(); await runtime.calls.modals[0].success({ confirm: true });
  assert.equal(page.data.backupPreviewNeedsRecheck, true);
  page.onConfirmLocalBackup(); assert.equal(runtime.calls.modals.length, 1);
  page.onRecheckLocalBackupPreview();
  assert.equal(calls.recheck, 1);
  assert.equal(page.data.backupPreviewNeedsRecheck, false);
  assert.match(page.data.backupMessage, /请再次核对/);
  assert.equal(calls.restore.length, 0);
  service.restoreLocalBackup = (text, lease) => { calls.restore.push({ text, lease }); };
  page.onConfirmLocalBackup(); await runtime.calls.modals[1].success({ confirm: true });
  assert.deepEqual(calls.restore, [{ text: 'private-backup-content', lease: 'private-rechecked-lease' }]);
});

test('原生文件异常与混合路径不进入页面data，受控中文JSON提示仍可理解', async () => {
  for (const message of ['readFile:fail wxfile://usr/private-backup.json', '无法读取 C:\\Users\\private\\backup.json', '读取失败 /usr/private-backup.json']) {
    const { page } = setup({ exportLocalBackupFile: async () => { throw new Error(message); } });
    await page.onExportLocalBackup();
    assert.equal(page.data.backupMessage, '备份文件未能生成，现有记录已保留');
    assert.doesNotMatch(JSON.stringify(page.data), /wxfile:|C:\\\\Users|private-backup\.json/);
  }
  const { page } = setup({ chooseLocalBackupFile: async () => { throw new Error('请选择不超过四兆的JSON备份文件'); } });
  await page.onImportLocalBackup();
  assert.equal(page.data.backupMessage, '请选择不超过四兆的JSON备份文件');
  const second = setup();
  second.service.chooseLocalBackupFile = async () => ({ text: 'bad', preview: { ok: false, errors: ['读取失败 wxfile://usr/private-backup.json'], warnings: [], summary: null } });
  await second.page.onImportLocalBackup();
  assert.doesNotMatch(JSON.stringify(second.page.data), /wxfile:|private-backup\.json/);
});

test('暂停计时须独立确认结束，迟到确认不能清新计时，结束后仅重新检查文件不自动恢复', async () => {
  const { runtime, page, service, calls, preview } = setup();
  const timer = runtime.load('miniprogram/services/timer');
  const records = runtime.load('miniprogram/services/records');
  records.setStatus('2026-11-01', 'music-guitar', 'done');
  timer.startTimer('2026-11-02', 'music-guitar', 60); timer.pauseTimer();
  service.getLocalBackupState = () => {
    const value = timer.getTimer();
    return { canUndo: false, recoveryRequired: false, reason: '', blockingTimer: value && ['running', 'paused'].includes(value.status) ? value : undefined };
  };
  service.chooseLocalBackupFile = async () => ({ text: 'private-backup-content', fileName: 'chosen.json',
    preview: { ok: false, errors: ['请先结束或清除当前计时，再恢复备份'], warnings: [], summary: null } });
  page.refreshLocalBackupState(); await page.onImportLocalBackup();
  assert.equal(page.data.backupTimerBlocked, true);
  assert.equal(page.data.backupPreviewSummary, null);
  const beforeRecords = clone(runtime.storage.get('dayflow.records.v2'));
  const beforeCancel = clone([...runtime.storage].sort(([a], [b]) => a.localeCompare(b)));
  page.onClearLocalBackupTimer(); page.onClearLocalBackupTimer();
  assert.equal(runtime.calls.modals.length, 1);
  assert.match(runtime.calls.modals[0].content, /不改变任务完成情况/);
  runtime.calls.modals[0].success({ confirm: false });
  assert.deepEqual(clone([...runtime.storage].sort(([a], [b]) => a.localeCompare(b))), beforeCancel);
  page.onClearLocalBackupTimer();
  const stale = runtime.calls.modals[1];
  runtime.setNow(new Date(2026, 10, 2, 8, 1));
  timer.startTimer('2026-11-02', 'music-voice', 90); timer.pauseTimer();
  const newer = clone(runtime.storage.get('dayflow.timer.v1'));
  stale.success({ confirm: true });
  assert.deepEqual(runtime.storage.get('dayflow.timer.v1'), newer);
  assert.match(page.data.backupMessage, /计时已经变化/);
  page.onClearLocalBackupTimer();
  runtime.calls.modals[2].success({ confirm: true });
  runtime.calls.modals[2].success({ confirm: true });
  assert.equal(runtime.storage.has('dayflow.timer.v1'), false);
  assert.deepEqual(runtime.storage.get('dayflow.records.v2'), beforeRecords);
  assert.equal(calls.restore.length, 0);
  assert.equal(calls.recheck, 1);
  assert.equal(page.data.backupPreviewSummary.recordCount, preview.summary.recordCount);
  assert.match(page.data.backupMessage, /请核对后确认恢复/);
  assert.equal(page.data.backupTimerBlocked, false);
});

test('非关键原生提示失败不会把已经保存的备份误报为失败', async () => {
  const { runtime, page, calls } = setup();
  runtime.wx.showToast = () => { throw new Error('toast unavailable'); };
  await page.onExportLocalBackup();
  assert.equal(page.data.backupExportReady, true);
  assert.match(page.data.backupMessage, /备份文件已生成/);
  await page.onImportLocalBackup(); page.onConfirmLocalBackup();
  await runtime.calls.modals[0].success({ confirm: true });
  assert.equal(calls.restore.length, 1);
  assert.match(page.data.backupMessage, /备份已恢复/);
  assert.equal(page.data.backupPreviewNeedsRecheck, false);
});

test('真实页面和备份服务可完成文件预览、取消、恢复与撤销，照片和云绑定不被改写', async () => {
  const runtime = createRuntime(new Date(2026, 10, 2, 8));
  const files = new Map(), directories = new Set(['wxfile://usr']);
  runtime.wx.env = { USER_DATA_PATH: 'wxfile://usr' };
  runtime.wx.getFileSystemManager = () => ({
    mkdirSync(dir) { directories.add(dir); },
    readdirSync(dir) { return [...files.keys()].filter(key => key.startsWith(dir + '/')).map(key => key.slice(dir.length + 1)); },
    writeFileSync(file, content) { files.set(file, content); },
    readFileSync(file) { if (!files.has(file)) throw new Error('file missing'); return files.get(file); },
    statSync(file) {
      if (files.has(file)) return { size: Buffer.byteLength(files.get(file), 'utf8'), isFile: () => true, isDirectory: () => false };
      if (directories.has(file)) return { size: 0, isFile: () => false, isDirectory: () => true };
      throw new Error('file missing');
    },
    unlinkSync(file) { files.delete(file); }
  });
  let shares = 0;
  runtime.wx.shareFileMessage = value => { shares++; value.success({}); };
  const plans = runtime.load('miniprogram/services/plans'), records = runtime.load('miniprogram/services/records');
  const preferences = runtime.load('miniprogram/services/preferences');
  records.setStatus('2026-11-01', 'music-guitar', 'done');
  runtime.storage.set('dayflow.sync.v1', { enabled: false, envId: 'fixture-env', version: 3, accountId: 'fixture-owner', queued: false, conflict: false });
  runtime.storage.set('dayflow.media.v1', [{ id: 'kept-cloud-photo', dateKey: '2026-11-01', targetId: 'music-guitar', createdAt: 1, cloudFileID: 'cloud://fixture/owned-photo' }]);
  const page = runtime.page('profile'); page.onShow();
  await page.onExportLocalBackup();
  assert.equal(page.data.backupExportReady, true, page.data.backupMessage);
  assert.equal(shares, 0);
  const exported = page.localBackupFile, originalPlanName = plans.getTemplate().name;
  assert.doesNotMatch(files.get(exported.filePath), /fixture-owner|owned-photo/);
  const changed = clone(plans.getTemplate()); changed.name = '本机稍后修改的计划'; plans.saveTemplate(changed, changed.version);
  preferences.savePreferences({ sleepReminderEnabled: true, taskReminderEnabled: true });
  const beforeRestore = clone([...runtime.storage].sort(([a], [b]) => a.localeCompare(b)));
  runtime.wx.chooseMessageFile = value => value.success({ tempFiles: [{ path: exported.filePath, name: exported.fileName, size: Buffer.byteLength(files.get(exported.filePath), 'utf8') }] });
  await page.onImportLocalBackup();
  assert.ok(page.data.backupPreviewSummary, page.data.backupMessage);
  assert.equal(page.data.backupPreviewSummary.recordCount, 1);
  assert.equal(plans.getTemplate().name, changed.name);
  page.onConfirmLocalBackup(); await runtime.calls.modals.at(-1).success({ confirm: false });
  assert.deepEqual(clone([...runtime.storage].sort(([a], [b]) => a.localeCompare(b))), beforeRestore);
  page.onConfirmLocalBackup(); await runtime.calls.modals.at(-1).success({ confirm: true });
  assert.equal(plans.getTemplate().name, originalPlanName, page.data.backupMessage);
  assert.equal(preferences.getPreferences().sleepReminderEnabled, false);
  assert.equal(preferences.getPreferences().taskReminderEnabled, false);
  assert.equal(page.data.backupUndoAvailable, true, page.data.backupUndoReason);
  assert.equal(runtime.storage.get('dayflow.media.v1')[0].cloudFileID, 'cloud://fixture/owned-photo');
  assert.equal(shares, 0);
  page.onUndoLocalBackup(); await runtime.calls.modals.at(-1).success({ confirm: true });
  assert.deepEqual(clone([...runtime.storage].sort(([a], [b]) => a.localeCompare(b))), beforeRestore);
  assert.equal(page.data.backupRecoveryRequired, false);
  assert.equal(page.data.backupUndoAvailable, false);
});
