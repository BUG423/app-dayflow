const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntime } = require('./helpers/miniprogram');

test('照片仅在持久保存后登记，并按日期和目标关联', async () => {
  const runtime = createRuntime();
  runtime.wx.chooseMedia = options => options.success({ tempFiles: [{ tempFilePath: 'wxfile://temporary', size: 100 }] });
  runtime.wx.getFileSystemManager = () => ({ saveFile: options => options.success({ savedFilePath: 'wxfile://saved-fixture' }), removeSavedFile: options => options.success({}) });
  const media = runtime.load('miniprogram/services/media.ts');
  const photo = await media.chooseAndSavePhoto('2026-10-31', 'music-guitar');
  assert.equal(photo.localPath, 'wxfile://saved-fixture');
  assert.equal(typeof photo.createdAt, 'number');
  assert.equal(runtime.storage.get('dayflow.instances.v1')['2026-10-31'].locked, true);
  assert.equal(media.getPhotos('2026-10-31', 'music-guitar').length, 1);
  assert.equal(media.getPhotos('2026-11-01').length, 0);
  media.removePhoto(photo.id);
  assert.equal(media.getPhotos().length, 0);
});

test('取消、超限或持久保存失败不产生照片伪记录', async () => {
  for (const mode of ['cancel', 'large', 'save-failed', 'still-temp']) {
    const runtime = createRuntime();
    runtime.wx.chooseMedia = options => mode === 'cancel' ? options.fail({}) : options.success({ tempFiles: [{ tempFilePath: 'wxfile://temporary', size: mode === 'large' ? 6000000 : 100 }] });
    runtime.wx.getFileSystemManager = () => ({ saveFile: options => mode === 'save-failed' ? options.fail({}) : options.success({ savedFilePath: 'wxfile://temporary' }), removeSavedFile: options => options.success({}) });
    const media = runtime.load('miniprogram/services/media.ts');
    await assert.rejects(media.chooseAndSavePhoto('2026-10-31', 'music-guitar'));
    assert.equal(media.getPhotos().length, 0);
  }
});

test('照片关联失败只清理本次小程序保存副本，不删除图库源文件', async () => {
  const runtime = createRuntime();
  const removed = [];
  runtime.wx.chooseMedia = options => options.success({ tempFiles: [{ tempFilePath: 'album-source', size: 100 }] });
  runtime.wx.getFileSystemManager = () => ({ saveFile: options => options.success({ savedFilePath: 'app-saved-copy' }), removeSavedFile: options => { removed.push(options.filePath); options.success({}); } });
  const originalWrite = runtime.wx.setStorageSync;
  runtime.wx.setStorageSync = (key, value) => { if (key === 'dayflow.media.v1') throw new Error('quota'); originalWrite(key, value); };
  const media = runtime.load('miniprogram/services/media.ts');
  await assert.rejects(media.chooseAndSavePhoto('2026-10-31', 'music-guitar'));
  assert.deepEqual(removed, ['app-saved-copy']);
  assert.equal(media.getPhotos().length, 0);
});

test('无效日期、重复标识和非字符串路径视为损坏数据，不能被新照片覆盖', () => {
  const base = { id: 'photo', dateKey: '2026-10-31', targetId: 'music-guitar', localPath: 'saved', createdAt: 1 };
  for (const photos of [[{ ...base, dateKey: '2026-02-30' }], [base, base], [{ ...base, localPath: 123 }]]) {
    const runtime = createRuntime(); runtime.storage.set('dayflow.media.v1', photos);
    const media = runtime.load('miniprogram/services/media.ts');
    assert.throws(() => media.getPhotos());
    assert.deepEqual(runtime.storage.get('dayflow.media.v1'), photos);
  }
});

test('隐私授权拒绝时不进入选择器，也不读取或保存照片', async () => {
  const runtime = createRuntime(); let chose = false, saved = false;
  runtime.wx.requirePrivacyAuthorize = options => options.fail({});
  runtime.wx.chooseMedia = () => { chose = true; };
  runtime.wx.getFileSystemManager = () => ({ saveFile() { saved = true; } });
  const media = runtime.load('miniprogram/services/media.ts');
  await assert.rejects(media.chooseAndSavePhoto('2026-10-31', 'music-guitar'), /未同意/);
  assert.equal(chose, false); assert.equal(saved, false);
  assert.equal(media.getPhotos().length, 0);
});
