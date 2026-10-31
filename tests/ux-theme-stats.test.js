const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRuntime } = require('./helpers/miniprogram');

function contrast(left, right) {
  const luminance = hex => {
    const channels = hex.replace('#', '').match(/../g).map(value => parseInt(value, 16) / 255)
      .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  };
  const values = [luminance(left), luminance(right)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

test('主题普通文字与语义标签的实际色值具有至少4.5对比度', () => {
  const source = fs.readFileSync(path.join(__dirname, '../miniprogram/app.wxss'), 'utf8');
  const tokens = Object.fromEntries([...source.matchAll(/--color-([a-z-]+):\s*(#[0-9A-Fa-f]{6})/g)]
    .map(match => [match[1], match[2]]));
  for (const [text, surface] of [['text', 'surface'], ['muted', 'surface'], ['muted', 'bg'],
    ['primary', 'surface'], ['primary', 'primary-soft'], ['success', 'success-soft'],
    ['warning', 'warning-soft'], ['danger', 'danger-soft'], ['training', 'training-soft'],
    ['sky', 'sky-soft'], ['interest', 'interest-soft'], ['text', 'sun'], ['text', 'sun-soft'],
    ['muted', 'primary-soft'], ['muted', 'training-soft'], ['muted', 'sky-soft'],
    ['muted', 'interest-soft'], ['muted', 'success-soft'], ['muted', 'warning-soft'], ['muted', 'danger-soft']]) {
    assert.ok(tokens[text] && tokens[surface], text + '/' + surface + ' token missing');
    assert.ok(contrast(tokens[text], tokens[surface]) >= 4.5, text + '/' + surface + ' contrast too low');
  }
  assert.ok(contrast('#FFFFFF', tokens.primary) >= 4.5, 'primary action white text');
});

test('统计记录同时提供状态代码与中文，切换周导航不改变执行记录', () => {
  const runtime = createRuntime();
  const records = runtime.load('miniprogram/services/records.ts');
  const page = runtime.page('stats');
  const labels = { todo: '待开始', doing: '进行中', done: '完成', skipped: '跳过', deferred: '延期', aborted: '中止' };
  for (const status of Object.keys(labels)) {
    records.setStatus('2026-10-31', 'music-guitar', status, status === 'deferred' ? { deferredTo: '2026-11-01' } : undefined);
    page.onShow();
    const row = page.data.historyRecords.find(item => item.recordKey === '2026-10-31:music-guitar');
    assert.equal(row.status, status);
    assert.equal(row.statusLabel, labels[status]);
  }
  const before = JSON.stringify(runtime.storage.get('dayflow.records.v2'));
  page.onPreviousWeek();
  assert.equal(page.data.anchorDate, '2026-10-24');
  page.onNextWeek();
  assert.equal(page.data.anchorDate, '2026-10-31');
  page.onCurrentWeek();
  assert.equal(page.data.anchorDate, '2026-10-31');
  assert.equal(JSON.stringify(runtime.storage.get('dayflow.records.v2')), before);
});
