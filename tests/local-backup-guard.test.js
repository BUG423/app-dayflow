const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { createRuntime, clone } = require('./helpers/miniprogram');

const KEY = 'dayflow.localBackup.restorePoint.v1';
const account = 'a'.repeat(64);
const state = { enabled: true, envId: 'fixture-env', accountId: account, version: 0, queued: false, conflict: false };
const point = (status = 'restored') => ({
  schemaVersion: 1, kind: 'dayflow-local-record-restore-manifest', state: status,
  filePath: 'wxfile://usr/dayflow-backups/dayflow-restore-1-abc-fixture.json',
  fileName: 'dayflow-restore-1-abc-fixture.json', nonce: 'abc-fixture', createdAt: 1,
  journalByteLength: 100, journalChecksum: 'fnv1a32-utf16le:1234abcd'
});
const snapshot = runtime => clone([...runtime.storage]);
const flush = () => new Promise(resolve => setImmediate(resolve));
function simulateRestoreAndUndo(runtime, guard) {
  guard.advanceLocalBackupEpoch(); runtime.storage.set(KEY, point('writing'));
  runtime.storage.set(KEY, point());
  guard.advanceLocalBackupEpoch(); runtime.storage.delete(KEY);
}

test('恢复门禁按存在性识别缺失，完整restored允许，损坏或读取失败均拒绝且不泄露原诊断', () => {
  for (const value of [undefined, '', point()]) {
    const runtime = createRuntime();
    if (typeof value === 'object') runtime.storage.set(KEY, value);
    else { const read = runtime.wx.getStorageSync; runtime.wx.getStorageSync = key => key === KEY ? value : read(key); }
    const before = snapshot(runtime), guard = runtime.load('miniprogram/services/local-backup-guard');
    const token = guard.getLocalBackupCheckpoint(); guard.assertNoPendingLocalBackup(token);
    assert.deepEqual(snapshot(runtime), before);
  }
  for (const value of [undefined, '', null, false, 0, [], {}, point('writing'), point('recovery-required'),
    { ...point(), extra: true }, { ...point(), createdAt: -1 }, { ...point(), createdAt: 1e300 },
    { ...point(), filePath: 'wxfile://usr/../' + point().fileName },
    { ...point(), fileName: 'other.json' }, { ...point(), nonce: 'wrong-token' },
    { ...point(), journalByteLength: 0 }, { ...point(), journalChecksum: 'invalid' }]) {
    const runtime = createRuntime(); runtime.storage.set(KEY, value); const before = snapshot(runtime);
    assert.throws(() => runtime.load('miniprogram/services/local-backup-guard').assertNoPendingLocalBackup(), /恢复尚未完成.*我的/);
    assert.deepEqual(snapshot(runtime), before);
  }
  const runtime = createRuntime(); runtime.wx.getStorageSync = () => { throw new Error('private-fixture-diagnostic'); };
  assert.throws(() => runtime.load('miniprogram/services/local-backup-guard').assertNoPendingLocalBackup(), error =>
    /恢复尚未完成/.test(error.message) && !error.message.includes('private-fixture'));
  const infoFailed = createRuntime(); infoFailed.wx.getStorageInfoSync = () => { throw new Error('private-info-fixture'); };
  assert.throws(() => infoFailed.load('miniprogram/services/local-backup-guard').assertNoPendingLocalBackup(), /恢复尚未完成/);
});

test('present空恢复点拒绝常规写且标记恢复路由，不能被当作不存在放行', () => {
  for (const value of [undefined, '', null]) {
    const runtime = createRuntime(); runtime.storage.set(KEY, value);
    const before = snapshot(runtime), guard = runtime.load('miniprogram/services/local-backup-guard');
    assert.equal(guard.hasPendingLocalBackupRecovery(), true);
    assert.throws(() => runtime.load('miniprogram/services/preferences').savePreferences({ leadMinutes: 15 }), /恢复尚未完成/);
    assert.deepEqual(snapshot(runtime), before);
    assert.equal(runtime.storage.has(KEY), true);
  }
});

test('writing或recovery-required禁止所有常规业务写入、文件选择和云端操作，只读旧记录仍可归一', async () => {
  for (const phase of ['writing', 'recovery-required']) {
    const runtime = createRuntime(); let externalCalls = 0;
    runtime.wx.cloud = { init() { externalCalls++; }, callFunction() { externalCalls++; }, uploadFile() { externalCalls++; } };
    runtime.wx.chooseMedia = () => { externalCalls++; };
    runtime.wx.requestSubscribeMessage = () => { externalCalls++; };
    runtime.wx.getFileSystemManager = () => { externalCalls++; return {}; };
    runtime.storage.set('dayflow.records.v1', { '2026-10-30': { 'unknown-old-target': 'done' } });
    runtime.storage.set('dayflow.timer.v1', { schemaVersion: 1, dateKey: '2026-10-31', targetId: 'music-guitar',
      durationSeconds: 30, remainingSeconds: 20, status: 'paused', updatedAt: 1 });
    runtime.storage.set('dayflow.restDays.v1', { schemaVersion: 1, byDate: { '2026-10-31': {
      date: '2026-10-31', reason: '合成休息', startedAt: 1, updatedAt: 1, active: true
    } } });
    runtime.storage.set('dayflow.media.v1', [{ id: 'fixture-photo', dateKey: '2026-10-31', targetId: 'music-guitar', localPath: 'app-saved-copy', createdAt: 1 }]);
    runtime.storage.set('dayflow.sync.v1', state);
    runtime.storage.set(KEY, point(phase));
    const before = snapshot(runtime);
    const records = runtime.load('miniprogram/services/records'), prefs = runtime.load('miniprogram/services/preferences');
    const timer = runtime.load('miniprogram/services/timer'), rests = runtime.load('miniprogram/services/rest-days');
    const media = runtime.load('miniprogram/services/media'), sync = runtime.load('miniprogram/services/sync');
    const reminders = runtime.load('miniprogram/services/reminders');
    for (const action of [
      () => records.setStatus('2026-10-31', 'music-guitar', 'done'),
      () => records.saveFeedback('2026-10-31', 'music-guitar', { note: '合成反馈' }),
      () => records.replaceEnvelope({ schemaVersion: 2, byDate: {} }),
      () => records.setLastReviewKey('2026-10-31'), () => records.clearRecords(),
      () => prefs.savePreferences({ sleepReminderEnabled: true }),
      () => prefs.markReminderShown('2026-10-31:sleep:23:00'),
      () => timer.startTimer('2026-10-31', 'music-guitar', 30),
      () => timer.pauseTimer(), () => timer.resumeTimer(), () => timer.resetTimer(),
      () => timer.clearTimer({ dateKey: '2026-10-31', targetId: 'music-guitar', updatedAt: 1 }),
      () => rests.startRestToday('合成理由'), () => rests.resumeToday(),
      () => media.removePhoto('fixture-photo'),
      () => media.markPhotoUploaded('fixture-photo', 'cloud://fixture/photo.jpg'),
      () => sync.configureSync({ enabled: false, envId: 'fixture-env' })
    ]) assert.throws(action, /恢复尚未完成/);
    for (const action of [
      () => prefs.requestReminderSubscription(),
      () => media.chooseAndSavePhoto('2026-10-31', 'music-guitar'),
      () => sync.syncNow(), () => sync.resolveSyncConflict('remote'),
      () => sync.getTrustedCloudContext(), () => sync.uploadPhoto('fixture-photo'),
      () => sync.getPhotoPreviewPath({ cloudFileID: 'cloud://fixture/photo.jpg' }),
      () => reminders.prepareReminder('task'), () => reminders.registerReminder({}, true),
      () => reminders.listReminders(), () => reminders.cancelReminder('b'.repeat(64))
    ]) await assert.rejects(action, /恢复尚未完成/);
    assert.equal(records.exportEnvelope().byDate['2026-10-30']['unknown-old-target'].status, 'done');
    assert.equal(timer.getTimer().status, 'paused');
    assert.equal(media.getPhotos().length, 1);
    assert.equal(await sync.getPhotoPreviewPath({ localPath: 'app-saved-copy' }), 'app-saved-copy');
    assert.equal(prefs.getPreferences().sleepReminderEnabled, false);
    records.toggleDone('2026-10-31', 'music-guitar');
    assert.match(runtime.calls.toasts.at(-1).title, /我的.*恢复/);
    assert.equal(externalCalls, 0);
    assert.deepEqual(snapshot(runtime), before);
  }
});

test('完整restored恢复点不阻止随后正常的设置和计时操作', () => {
  const runtime = createRuntime(); runtime.storage.set(KEY, point());
  const prefs = runtime.load('miniprogram/services/preferences');
  prefs.savePreferences({ leadMinutes: 15 });
  assert.equal(prefs.getPreferences().leadMinutes, 15);
  const timer = runtime.load('miniprogram/services/timer');
  assert.equal(timer.startTimer('2026-10-31', 'music-guitar', 30).status, 'running');
  assert.deepEqual(runtime.storage.get(KEY), point());
});

test('内存epoch令restore再undo回到原manifest也会使旧异步token失效', () => {
  const runtime = createRuntime(), guard = runtime.load('miniprogram/services/local-backup-guard');
  const before = snapshot(runtime), token = guard.getLocalBackupCheckpoint();
  simulateRestoreAndUndo(runtime, guard);
  assert.deepEqual(snapshot(runtime), before);
  assert.throws(() => guard.assertNoPendingLocalBackup(token), /刚刚恢复/);
  guard.assertNoPendingLocalBackup(guard.getLocalBackupCheckpoint());
});

test('选图等待中跨越已完成的restore和undo时不再保存或关联旧选择', async () => {
  const runtime = createRuntime(), guard = runtime.load('miniprogram/services/local-backup-guard');
  let chooser, saves = 0;
  runtime.wx.chooseMedia = options => { chooser = options; };
  runtime.wx.getFileSystemManager = () => ({ saveFile() { saves++; } });
  const media = runtime.load('miniprogram/services/media');
  const operation = media.chooseAndSavePhoto('2026-10-31', 'music-guitar');
  assert.ok(chooser);
  simulateRestoreAndUndo(runtime, guard);
  const before = snapshot(runtime);
  chooser.success({ tempFiles: [{ tempFilePath: 'album-fixture', size: 100 }] });
  await assert.rejects(operation, /刚刚恢复/);
  assert.equal(saves, 0); assert.deepEqual(snapshot(runtime), before);
});

test('持久保存等待时出现恢复门禁，仅清理本次副本，不删除原图或写照片关联', async () => {
  const runtime = createRuntime(); let saving; const removed = [];
  runtime.wx.chooseMedia = options => options.success({ tempFiles: [{ tempFilePath: 'album-fixture', size: 100 }] });
  runtime.wx.getFileSystemManager = () => ({
    saveFile(options) { saving = options; },
    removeSavedFile(options) { removed.push(options.filePath); options.success({}); }
  });
  const media = runtime.load('miniprogram/services/media');
  const operation = media.chooseAndSavePhoto('2026-10-31', 'music-guitar');
  await flush(); assert.ok(saving);
  runtime.storage.set(KEY, point('recovery-required')); const before = snapshot(runtime);
  saving.success({ savedFilePath: 'new-app-saved-fixture' });
  await assert.rejects(operation, /未能关联/);
  assert.deepEqual(removed, ['new-app-saved-fixture']);
  assert.deepEqual(snapshot(runtime), before);
});

test('云上传已返回后跨恢复时不落旧关联或声称没有上传，保留可检查的提示', async () => {
  const runtime = createRuntime(), guard = runtime.load('miniprogram/services/local-backup-guard');
  let uploading; const requests = [];
  runtime.storage.set('dayflow.sync.v1', state);
  runtime.storage.set('dayflow.media.v1', [{ id: 'fixture-photo', dateKey: '2026-10-31', targetId: 'music-guitar', localPath: 'saved-fixture', createdAt: 1 }]);
  runtime.wx.cloud = {
    init() {},
    callFunction(options) {
      requests.push(options.data.action);
      options.success({ result: { ok: true, accountId: account, uploadPrefix: 'dayflow-photos/' + account + '/', mediaEnabled: true } });
    },
    uploadFile(options) { uploading = options; }
  };
  const operation = runtime.load('miniprogram/services/sync').uploadPhoto('fixture-photo');
  await flush(); assert.ok(uploading);
  simulateRestoreAndUndo(runtime, guard); const before = snapshot(runtime);
  uploading.success({ fileID: 'cloud://fixture/photo.jpg' });
  await assert.rejects(operation, error => /上传请求已返回/.test(error.message) && !/上传未完成/.test(error.message));
  assert.deepEqual(requests, ['identity']); assert.deepEqual(snapshot(runtime), before);
});

test('同步push在恢复代次变化后不再写离线queue状态', async () => {
  const runtime = createRuntime(), guard = runtime.load('miniprogram/services/local-backup-guard'); let pushing;
  runtime.storage.set('dayflow.sync.v1', state);
  runtime.wx.cloud = {
    init() {},
    callFunction(options) {
      if (options.data.action === 'push') pushing = options;
      else options.success({ result: { ok: true, accountId: account, uploadPrefix: 'dayflow-photos/' + account + '/' } });
    }
  };
  const operation = runtime.load('miniprogram/services/sync').syncNow();
  await flush(); assert.ok(pushing);
  simulateRestoreAndUndo(runtime, guard); const before = snapshot(runtime);
  pushing.success({ result: { ok: true, version: 1 } });
  await assert.rejects(operation, /刚刚恢复/); assert.deepEqual(snapshot(runtime), before);
});

test('后台取消请求已经返回后发生恢复不改本机缓存，也不伪称请求没有发送', async () => {
  const runtime = createRuntime(new Date(2026, 9, 31, 12, 4), { modules: {
    'miniprogram/services/sync.ts': { getTrustedCloudContext: async () => ({ envId: 'fixture-env', accountId: account }) }
  } });
  const guard = runtime.load('miniprogram/services/local-backup-guard'); let cancelling;
  runtime.wx.cloud = { callFunction(options) { cancelling = options; } };
  const operation = runtime.load('miniprogram/services/reminders').cancelReminder('b'.repeat(64));
  await flush(); assert.ok(cancelling);
  simulateRestoreAndUndo(runtime, guard); const before = snapshot(runtime);
  cancelling.success({ result: { ok: true, accountId: account, job: { status: 'cancelled' } } });
  await assert.rejects(operation, error => /请求已返回/.test(error.message) && !/未发送/.test(error.message));
  assert.deepEqual(snapshot(runtime), before);
});

test('用户明确结束当前暂停或已到点计时，仅移除匹配身份的计时，不改执行记录', () => {
  for (const current of [
    { status: 'paused', remainingSeconds: 20 },
    { status: 'running', remainingSeconds: 20, endsAt: new Date(2026, 9, 31, 12, 3).getTime() }
  ]) {
    const runtime = createRuntime();
    const value = { schemaVersion: 1, dateKey: '2026-10-31', targetId: 'music-guitar', durationSeconds: 30, updatedAt: 1, ...current };
    runtime.storage.set('dayflow.timer.v1', value);
    runtime.storage.set('dayflow.records.v2', { schemaVersion: 2, byDate: {} });
    const records = clone(runtime.storage.get('dayflow.records.v2'));
    const timer = runtime.load('miniprogram/services/timer'), shown = timer.getTimer();
    assert.equal(shown.status, current.status === 'running' ? 'finished' : 'paused');
    timer.clearTimer({ dateKey: shown.dateKey, targetId: shown.targetId, updatedAt: shown.updatedAt });
    assert.equal(runtime.storage.has('dayflow.timer.v1'), false);
    assert.deepEqual(runtime.storage.get('dayflow.records.v2'), records);
    timer.clearTimer({ dateKey: shown.dateKey, targetId: shown.targetId, updatedAt: shown.updatedAt });
  }
});

test('结束计时身份过期、数据损坏、恢复未完成时不会误清当前计时', () => {
  const runtime = createRuntime();
  const value = { schemaVersion: 1, dateKey: '2026-10-31', targetId: 'music-guitar', durationSeconds: 30, remainingSeconds: 20, status: 'paused', updatedAt: 2 };
  runtime.storage.set('dayflow.timer.v1', value);
  const timer = runtime.load('miniprogram/services/timer');
  for (const expected of [undefined, { dateKey: '2026-10-31', targetId: 'music-guitar', updatedAt: 1 },
    { dateKey: '2026-10-30', targetId: 'music-guitar', updatedAt: 2 },
    { dateKey: '2026-10-31', targetId: 'other-task', updatedAt: 2 }]) {
    assert.throws(() => timer.clearTimer(expected), /重新查看|已经变化/);
    assert.deepEqual(runtime.storage.get('dayflow.timer.v1'), value);
  }
  runtime.storage.set(KEY, point('writing'));
  assert.throws(() => timer.clearTimer(value), /恢复尚未完成/);
  assert.deepEqual(runtime.storage.get('dayflow.timer.v1'), value);
  runtime.storage.delete(KEY); runtime.storage.set('dayflow.timer.v1', { ...value, remainingSeconds: -1 });
  assert.throws(() => timer.clearTimer(value), /计时数据损坏/);
  assert.equal(runtime.storage.get('dayflow.timer.v1').remainingSeconds, -1);
});

test('结束计时删除失败或未确认删除时不显示成功且不暴露原始错误', () => {
  for (const mode of ['throw', 'silent']) {
    const runtime = createRuntime();
    const value = { schemaVersion: 1, dateKey: '2026-10-31', targetId: 'music-guitar', durationSeconds: 30, remainingSeconds: 20, status: 'paused', updatedAt: 2 };
    runtime.storage.set('dayflow.timer.v1', value);
    runtime.wx.removeStorageSync = () => { if (mode === 'throw') throw new Error('private-quota-fixture'); };
    assert.throws(() => runtime.load('miniprogram/services/timer').clearTimer(value), error =>
      /未能确认计时已结束/.test(error.message) && !error.message.includes('private-quota'));
    assert.deepEqual(runtime.storage.get('dayflow.timer.v1'), value);
  }
});

test('恢复中重新打开App只导航到我的一次，普通启动和已在我的不改变路由', () => {
  const runtime = createRuntime(), guard = runtime.load('miniprogram/services/local-backup-guard');
  const file = path.resolve(__dirname, '../miniprogram/app.ts');
  const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018 } }).outputText;
  let app, pages = [], initialized = 0; const switches = [], pending = [];
  vm.runInNewContext(source, {
    exports: {}, App: config => { app = config; }, getCurrentPages: () => pages,
    setTimeout: (callback, delay) => { pending.push({ callback, delay }); },
    wx: { switchTab: value => switches.push(value), showToast() {} },
    require: name => name.includes('local-backup-guard') ? guard : { initializeRuntimeSettings() { initialized++; } }
  });
  app.onLaunch(); app.onShow(); assert.equal(initialized, 1); assert.equal(switches.length, 0); assert.equal(pending.length, 0);
  runtime.storage.set(KEY, point('recovery-required')); pages = [{ route: 'pages/today/index' }];
  app.onShow(); assert.equal(switches.length, 1); assert.equal(switches[0].url, '/pages/profile/index');
  pages = [{ route: 'pages/profile/index' }]; app.onShow(); assert.equal(switches.length, 1);
  pages = []; app.onShow(); assert.equal(pending.length, 1); assert.equal(pending[0].delay, 150);
  pending[0].callback(); assert.equal(pending.length, 1); assert.equal(switches.length, 1, 'empty startup does not start a retry loop');
  app.onShow(); pages = [{ route: 'pages/training/index' }]; pending[1].callback(); assert.equal(switches.length, 2);
  runtime.storage.set(KEY, { damaged: true }); app.onShow(); assert.equal(switches.length, 3);
  for (const value of [undefined, '', null]) { runtime.storage.set(KEY, value); app.onShow(); }
  assert.equal(switches.length, 6, 'present empty markers also lead to recovery instead of permitting normal use');
});
