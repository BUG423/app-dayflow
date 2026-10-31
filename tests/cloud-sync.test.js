const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntime, clone } = require('./helpers/miniprogram');
const accountA = 'a'.repeat(64);
const accountB = 'b'.repeat(64);
function cloudRuntime(handler) {
  const runtime = createRuntime();
  runtime.wx.removeStorageSync = key => runtime.storage.delete(key);
  const calls = [];
  runtime.wx.cloud = {
    init() {},
    callFunction(options) {
      calls.push(clone(options.data));
      const result = handler(options.data, options);
      if (result === 'defer') return;
      if (result && typeof result.then === 'function') { result.then(value => options.success({ result: value }), options.fail); return; }
      if (result === 'offline') options.fail({}); else options.success({ result });
    }
  };
  return { ...runtime, calls, sync: runtime.load('miniprogram/services/sync.ts') };
}
const identity = accountId => ({ ok: true, accountId, uploadPrefix: 'dayflow-photos/' + accountId + '/' });

test('云同步默认关闭，必须显式开启，严格读取失败不能上传空记录', async () => {
  const runtime = cloudRuntime(data => data.action === 'identity' ? identity(accountA) : { ok: true, version: 1 });
  assert.equal((await runtime.sync.syncNow()).status, 'unconfigured');
  runtime.sync.configureSync({ envId: 'fixture-env', enabled: false });
  assert.equal((await runtime.sync.syncNow()).status, 'disabled');
  assert.equal(runtime.calls.length, 0);
  runtime.sync.configureSync({ envId: 'fixture-env', enabled: true });
  runtime.storage.set('dayflow.records.v2', 'damaged');
  await assert.rejects(runtime.sync.syncNow());
  assert.equal(runtime.calls.length, 0);
  assert.equal(runtime.storage.get('dayflow.records.v2'), 'damaged');
});

test('离线保留待同步快照，重试成功后确认版本并清队列', async () => {
  let offline = true;
  const runtime = cloudRuntime(data => offline ? 'offline' : data.action === 'identity' ? identity(accountA) : { ok: true, version: 1 });
  runtime.sync.configureSync({ envId: 'fixture-env', enabled: true });
  assert.equal((await runtime.sync.syncNow()).status, 'offline');
  assert.equal(runtime.sync.getSyncState().queued, true);
  assert.equal(runtime.sync.getSyncState().pending, false);
  assert.equal(runtime.storage.get('dayflow.sync.queue.v1').schemaVersion, 1);
  offline = false;
  assert.equal((await runtime.sync.syncNow()).status, 'synced');
  assert.equal(runtime.sync.getSyncState().version, 1);
  assert.equal(runtime.storage.get('dayflow.sync.queue.v1'), null);
});

test('可信账户变化拒绝把前一账户本机历史上传到新账户', async () => {
  let accountId = accountA;
  let pushes = 0;
  const runtime = cloudRuntime(data => data.action === 'identity' ? identity(accountId) : (pushes++, { ok: true, version: pushes }));
  runtime.sync.configureSync({ envId: 'fixture-env', enabled: true });
  await runtime.sync.syncNow();
  accountId = accountB;
  assert.equal((await runtime.sync.syncNow()).status, 'account-mismatch');
  assert.equal(pushes, 1);
  assert.equal(runtime.sync.getSyncState().accountId, accountA);
  runtime.sync.configureSync({ envId: 'different-env', enabled: true });
  assert.equal(runtime.sync.getSyncState().enabled, false);
  assert.equal(runtime.sync.getSyncState().version, 0);
});

test('版本冲突保留两份，选择远端后跨key写入失败会回滚并保留备份', async () => {
  let remote;
  const runtime = cloudRuntime(data => {
    if (data.action === 'identity') return identity(accountA);
    remote = clone(data.payload); remote.plans.name = '云端计划';
    return { ok: true, conflict: true, version: 5, payload: remote };
  });
  runtime.sync.configureSync({ envId: 'fixture-env', enabled: true });
  assert.equal((await runtime.sync.syncNow()).status, 'conflict');
  assert.equal(runtime.storage.get('dayflow.sync.conflicts.v1').remote.plans.name, '云端计划');
  const originalWrite = runtime.wx.setStorageSync;
  let failed = false;
  runtime.wx.setStorageSync = (key, value) => {
    if (key === 'dayflow.instances.v1' && !failed) { failed = true; throw new Error('quota'); }
    originalWrite(key, value);
  };
  await assert.rejects(runtime.sync.resolveSyncConflict('remote'));
  assert.equal(runtime.storage.has('dayflow.plans.v1'), false);
  assert.ok(runtime.storage.get('dayflow.sync.restoreBackup.v1'));
  assert.equal(runtime.sync.getSyncState().conflict, true);
  await runtime.sync.resolveSyncConflict('remote');
  assert.equal(runtime.storage.get('dayflow.plans.v1').name, '云端计划');
  assert.equal(runtime.sync.getSyncState().version, 5);
});

test('照片同步只带云文件元数据，不传本地路径，也不伪造未上传照片', async () => {
  let payload;
  const runtime = cloudRuntime(data => data.action === 'identity' ? identity(accountA) : (payload = data.payload, { ok: true, version: 1 }));
  runtime.storage.set('dayflow.media.v1', [
    { id: 'local-only', dateKey: '2026-10-31', targetId: 'music-guitar', localPath: 'private-device-path', createdAt: 1 },
    { id: 'uploaded', dateKey: '2026-10-31', targetId: 'music-guitar', localPath: 'also-private', cloudFileID: 'cloud://fixture-env.bucket/dayflow-photos/' + accountA + '/uploaded.jpg', createdAt: 1 }
  ]);
  runtime.sync.configureSync({ envId: 'fixture-env', enabled: true });
  await runtime.sync.syncNow();
  assert.equal(payload.media.length, 1);
  assert.equal(payload.media[0].id, 'uploaded');
  assert.equal(Object.hasOwn(payload.media[0], 'localPath'), false);
});

test('损坏照片内容在任何云请求前拒绝上传，原始元数据不被覆盖', async () => {
  const invalidPhotos = [
    { id: 'photo', dateKey: '2026-02-30', targetId: 'x', localPath: 'saved', createdAt: 1 },
    { id: 'photo', dateKey: '2026-10-31', targetId: 'x', localPath: 7, createdAt: 1 },
    { id: 'photo', dateKey: '2026-10-31', targetId: 'x', cloudFileID: 7, createdAt: 1 }
  ];
  for (const photo of invalidPhotos) {
    const runtime = cloudRuntime(() => { throw new Error('must not request'); });
    runtime.sync.configureSync({ envId: 'fixture-env', enabled: true });
    runtime.storage.set('dayflow.media.v1', [photo]);
    await assert.rejects(runtime.sync.syncNow());
    assert.equal(runtime.calls.length, 0);
    assert.deepEqual(runtime.storage.get('dayflow.media.v1'), [photo]);
  }
});

test('冲突处理期间阻止并发恢复，身份等待期间的新修改不会被远端覆盖', async () => {
  let hold = false, release;
  const runtime = cloudRuntime((data, options) => {
    if (data.action === 'identity') {
      if (hold) { release = () => options.success({ result: identity(accountA) }); return 'defer'; }
      return identity(accountA);
    }
    return { ok: true, conflict: true, version: 5, payload: clone(data.payload) };
  });
  runtime.sync.configureSync({ envId: 'fixture-env', enabled: true });
  await runtime.sync.syncNow();
  hold = true;
  const pending = runtime.sync.resolveSyncConflict('remote');
  assert.equal(runtime.sync.getSyncState().pending, true);
  await assert.rejects(runtime.sync.resolveSyncConflict('remote'));
  runtime.load('miniprogram/services/preferences.ts').savePreferences({ sleepTime: '21:00' });
  release();
  await assert.rejects(pending, /发生变化/);
  assert.equal(runtime.sync.getSyncState().pending, false);
  assert.equal(runtime.sync.getSyncState().conflict, true);
  assert.equal(runtime.load('miniprogram/services/preferences.ts').getPreferences().sleepTime, '21:00');
});

test('远端同id不同云文件不能借用旧本地照片路径', async () => {
  const ownPrefix = 'cloud://fixture-env.bucket/dayflow-photos/' + accountA + '/';
  const runtime = cloudRuntime(data => {
    if (data.action === 'identity') return identity(accountA);
    const remote = clone(data.payload); remote.media[0].cloudFileID = ownPrefix + 'new-photo.jpg';
    return { ok: true, conflict: true, version: 2, payload: remote };
  });
  runtime.storage.set('dayflow.media.v1', [{ id: 'shared', dateKey: '2026-10-31', targetId: 'music-guitar', createdAt: 1, localPath: 'old-local-photo', cloudFileID: ownPrefix + 'old-photo.jpg' }]);
  runtime.sync.configureSync({ envId: 'fixture-env', enabled: true });
  await runtime.sync.syncNow(); await runtime.sync.resolveSyncConflict('remote');
  assert.equal(runtime.storage.get('dayflow.media.v1')[0].localPath, undefined);
  assert.equal(runtime.storage.get('dayflow.media.v1')[0].cloudFileID, ownPrefix + 'new-photo.jpg');
});

test('实际客户端导出的完整计划、历史记录和偏好可通过服务端严格校验往返', async () => {
  const { createHandler } = require('../cloudfunctions/dayflowSync/handler');
  let document;
  const handler = createHandler({ transact: async (_id, update) => { const op = await update(document); if (op.write) document = op.document; return op.result; } });
  const context = { OPENID: 'fixture-user', APPID: 'fixture-app', environmentId: 'fixture-env' };
  const runtime = cloudRuntime(data => handler(data, context));
  runtime.load('miniprogram/services/plans.ts').setEmergencyPlan('2026-10-31', true);
  runtime.load('miniprogram/services/records.ts').setStatus('2026-10-31', 'music-guitar', 'done');
  runtime.sync.configureSync({ envId: 'fixture-env', enabled: true });
  assert.equal((await runtime.sync.syncNow()).status, 'synced');
  assert.equal(document.payload.records.byDate['2026-10-31']['music-guitar'].status, 'done');
  assert.equal(document.payload.instances['2026-10-31'].locked, true);
  assert.equal(document.payload.instances['2026-10-31'].mode, 'emergency');
});

test('云照片能力未就绪时在调用上传前拒绝，保留本机副本', async () => {
  const runtime = cloudRuntime(data => data.action === 'identity' ? { ...identity(accountA), mediaEnabled: false } : { ok: true });
  let uploads = 0; runtime.wx.cloud.uploadFile = () => { uploads++; };
  runtime.storage.set('dayflow.media.v1', [{ id: 'photo', dateKey: '2026-10-31', targetId: 'music-guitar', localPath: 'saved-copy', createdAt: 1 }]);
  runtime.sync.configureSync({ envId: 'fixture-env', enabled: true });
  await assert.rejects(runtime.sync.uploadPhoto('photo'), /云端照片暂不可用/);
  assert.equal(uploads, 0); assert.equal(runtime.storage.get('dayflow.media.v1')[0].localPath, 'saved-copy');
});

test('用户主动上传使用服务端专属路径，跨设备预览换取临时地址而不持久化地址', async () => {
  const { createHandler } = require('../cloudfunctions/dayflowSync/handler');
  const handler = createHandler({ transact() { throw new Error('not expected'); } });
  const context = { OPENID: 'fixture-user', APPID: 'fixture-app', environmentId: 'fixture-env', privateStorageReady: true };
  const runtime = cloudRuntime(data => handler(data, context));
  runtime.wx.chooseMedia = options => options.success({ tempFiles: [{ tempFilePath: 'temporary-photo', size: 100 }] });
  runtime.wx.getFileSystemManager = () => ({ saveFile: options => options.success({ savedFilePath: 'saved-photo' }), removeSavedFile: options => options.success({}) });
  const photo = await runtime.load('miniprogram/services/media.ts').chooseAndSavePhoto('2026-10-31', 'music-guitar');
  runtime.sync.configureSync({ envId: 'fixture-env', enabled: true });
  let uploads = 0;
  runtime.wx.cloud.uploadFile = options => { uploads++; options.success({ fileID: 'cloud://fixture-env.bucket/' + options.cloudPath }); };
  const uploaded = await runtime.sync.uploadPhoto(photo.id);
  assert.equal(uploads, 1); assert.equal(uploaded.localPath, 'saved-photo');
  assert.match(uploaded.cloudFileID, /dayflow-photos\/[a-f0-9]{64}\//);
  assert.equal(runtime.sync.getSyncState().queued, true);
  const metadata = runtime.storage.get('dayflow.media.v1'); delete metadata[0].localPath;
  runtime.storage.set('dayflow.media.v1', metadata);
  runtime.wx.cloud.getTempFileURL = options => options.success({ fileList: [{ status: 0, tempFileURL: 'https://example.invalid/photo' }] });
  assert.equal(await runtime.sync.getPhotoPreviewPath(metadata[0]), 'https://example.invalid/photo');
  assert.equal(runtime.storage.get('dayflow.media.v1')[0].tempFileURL, undefined);
});
