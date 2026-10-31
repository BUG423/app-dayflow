const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntime, clone } = require('./helpers/miniprogram');

test('读取存储失败时不得用空记录覆盖已有历史', () => {
  const runtime = createRuntime();
  runtime.storage.set('dayflow.records.v1', { '2026-10-30': { 'music-guitar': 'done' } });
  const before = clone(runtime.storage.get('dayflow.records.v1'));
  runtime.wx.getStorageSync = () => { throw new Error('storage unavailable'); };
  const records = runtime.load('miniprogram/services/records.ts');
  const result = records.toggleDone('2026-10-31', 'music-guitar');
  assert.equal(result['music-guitar'], undefined);
  assert.deepEqual(runtime.storage.get('dayflow.records.v1'), before);
  assert.equal(runtime.calls.toasts[0].title, '读取失败，请稍后再试');
});

test('损坏的根存储或当天记录不得在打卡时被覆盖', () => {
  for (const value of ['damaged', [], { '2026-10-31': 'damaged', '2026-10-30': { x: 'done' } }]) {
    const runtime = createRuntime();
    runtime.storage.set('dayflow.records.v1', value);
    const records = runtime.load('miniprogram/services/records.ts');
    records.toggleDone('2026-10-31', 'music-guitar');
    assert.deepEqual(runtime.storage.get('dayflow.records.v1'), value);
    assert.equal(runtime.calls.toasts[0].title, '读取失败，请稍后再试');
  }
});

test('写入存储失败时提示并保留历史，不在重读时显示伪完成', () => {
  const runtime = createRuntime();
  runtime.storage.set('dayflow.records.v1', { '2026-10-30': { 'music-guitar': 'done' } });
  runtime.wx.setStorageSync = () => { throw new Error('quota exceeded'); };
  const records = runtime.load('miniprogram/services/records.ts');
  const result = records.toggleDone('2026-10-31', 'music-guitar');
  assert.equal(result['music-guitar'], undefined);
  assert.equal(records.forDate('2026-10-30')['music-guitar'], 'done');
  assert.equal(records.forDate('2026-10-31')['music-guitar'], undefined);
  assert.equal(runtime.calls.toasts[0].title, '保存失败，请检查存储空间');
});
