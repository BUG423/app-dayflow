const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRuntime, clone } = require('./helpers/miniprogram');

const today = '2026-10-31', yesterday = '2026-10-30', reviewKey = 'dayflow.review.v1';
const event = id => ({ currentTarget: { dataset: { id } } });
const input = value => ({ detail: { value } });
function withRecap() {
  const runtime = createRuntime();
  const records = runtime.load('miniprogram/services/records.ts');
  records.setStatus(yesterday, 'music-guitar', 'done');
  const page = runtime.page('today');
  page.onLoad(); page.onShow();
  return { runtime, records, page };
}

test('LEAN-03 entering today never opens a recap; the footer opens it and confirmation marks it read', () => {
  const { runtime, records, page } = withRecap();
  assert.equal(runtime.calls.modals.length, 0);
  assert.equal(page.data.recapAvailable, true);
  assert.equal(runtime.storage.has(reviewKey), false);
  const before = clone(records.exportEnvelope());
  page.onOpenRecap();
  assert.equal(runtime.calls.modals.length, 1);
  assert.match(runtime.calls.modals[0].content, /1\/9/);
  assert.equal(runtime.storage.has(reviewKey), false);
  page.onOpenRecap();
  assert.equal(runtime.calls.modals.length, 1, 'duplicate taps do not open another modal');
  runtime.calls.modals[0].success({ confirm: true });
  assert.equal(runtime.storage.get(reviewKey), today);
  assert.equal(page.data.recapAvailable, false);
  assert.deepEqual(clone(records.exportEnvelope()), before);
  page.onShow(); runtime.tick(); page.onOpenRecap();
  assert.equal(runtime.calls.modals.length, 1);
  page.onHide();
});

test('LEAN-03 no records means no recap, and the same minute does not repaint the page', () => {
  const runtime = createRuntime(), page = runtime.page('today');
  page.onLoad(); page.onShow();
  assert.equal(page.data.recapAvailable, false);
  page.onOpenRecap();
  assert.equal(runtime.calls.modals.length, 0);
  const updates = page.updates;
  for (let i = 0; i < 12; i++) runtime.tick();
  assert.equal(page.updates, updates);
  page.onHide();
});

test('LEAN-03 modal failure, cancellation and failed read persistence keep the recap unread and retryable', () => {
  const { runtime, page } = withRecap();
  page.onOpenRecap(); runtime.calls.modals[0].fail({ errMsg: 'showModal:fail' });
  assert.equal(runtime.storage.has(reviewKey), false);
  assert.equal(page.data.recapAvailable, true);
  assert.match(page.data.recapError, /未能打开/);
  page.onOpenRecap(); runtime.calls.modals[1].success({ confirm: false, cancel: true });
  assert.equal(runtime.storage.has(reviewKey), false);
  const set = runtime.wx.setStorageSync;
  runtime.wx.setStorageSync = (key, value) => { if (key === reviewKey) throw new Error('full'); set(key, value); };
  page.onOpenRecap(); runtime.calls.modals[2].success({ confirm: true });
  assert.equal(runtime.storage.has(reviewKey), false);
  assert.equal(page.reviewShownInSession, '');
  assert.equal(page.data.recapAvailable, true);
  assert.match(page.data.recapError, /已读状态未能保存/);
  runtime.wx.setStorageSync = set;
  page.onOpenRecap(); runtime.calls.modals[3].success({ confirm: true });
  assert.equal(runtime.storage.get(reviewKey), today);
  page.onHide();
});

test('LEAN-03 unreadable recap has a visible error, preserves records, and can retry after recovery', () => {
  const { runtime, page } = withRecap();
  const valid = clone(runtime.storage.get('dayflow.records.v2'));
  runtime.storage.set('dayflow.records.v2', { broken: true });
  const damaged = clone([...runtime.storage]);
  assert.doesNotThrow(() => page.onShow());
  assert.match(page.data.recapError, /无法读取/);
  assert.equal(page.data.recapAvailable, false);
  page.onOpenRecap();
  assert.equal(runtime.calls.modals.length, 0);
  assert.equal(runtime.storage.has(reviewKey), false);
  assert.deepEqual(clone([...runtime.storage]), damaged);
  runtime.storage.set('dayflow.records.v2', valid);
  page.onOpenRecap();
  assert.equal(runtime.calls.modals.length, 1);
  assert.equal(page.data.recapError, '');
  page.onHide();
});

test('LEAN-03 a recap confirmed across midnight only marks the captured day; selected history stays selected', () => {
  const { runtime, records, page } = withRecap();
  records.setStatus(today, 'music-guitar', 'done');
  page.choose('2026-10-29'); page.onOpenRecap();
  runtime.setNow(new Date(2026, 10, 1, 0, 1)); runtime.tick();
  assert.equal(page.data.selectedDate, '2026-10-29');
  assert.equal(page.data.recapToday, '2026-11-01');
  runtime.calls.modals[0].success({ confirm: true });
  assert.equal(runtime.storage.get(reviewKey), today);
  assert.equal(page.data.recapAvailable, true, 'the new day recap remains unread');
  page.onOpenRecap();
  assert.equal(runtime.calls.modals.length, 2);
  runtime.calls.modals[1].success({ confirm: true });
  assert.equal(runtime.storage.get(reviewKey), '2026-11-01');
  page.onHide();
});

test('LEAN-02 rest cancel, pause and resume remain reachable and preserve completed and historical facts', () => {
  const runtime = createRuntime(), records = runtime.load('miniprogram/services/records.ts');
  records.setStatus(yesterday, 'music-guitar', 'done');
  records.setStatus(today, 'music-guitar', 'done');
  records.setStatus(today, 'music-vocal', 'doing');
  const page = runtime.page('today'); page.onLoad();
  const beforeCancel = clone([...runtime.storage]);
  page.onOpenRest(); assert.equal(page.data.restEditorVisible, true);
  page.onCancelRest(); assert.equal(page.data.restEditorVisible, false);
  assert.deepEqual(clone([...runtime.storage]), beforeCancel);
  const history = clone(records.recordDetailsForDate(yesterday));
  const done = clone(records.recordDetailsForDate(today)['music-guitar']);
  page.onOpenRest(); page.onRestReasonInput(input('今天慢一点')); page.onConfirmRest();
  assert.equal(page.data.restActive, true);
  assert.equal(page.data.heroTitle, '今天休息');
  assert.equal(page.data.restEditorVisible, false);
  const paused = clone(records.exportEnvelope());
  page.onToggleTask(event('music-guitar'));
  assert.deepEqual(clone(records.exportEnvelope()), paused);
  page.onResumeRest(); assert.equal(page.data.restActive, false);
  assert.deepEqual(clone(records.exportEnvelope()), paused);
  assert.deepEqual(clone(records.recordDetailsForDate(yesterday)), history);
  assert.deepEqual(clone(records.recordDetailsForDate(today)['music-guitar']), done);
  assert.equal(records.recordDetailsForDate(today)['music-vocal'].status, 'aborted');
  page.choose(yesterday);
  assert.equal(page.data.isToday, false);
  page.onToday();
  assert.equal(page.data.blocks.find(block => block.id === 'music').doneCount, 1);
});

test('LEAN-02 compact fixed rows cannot expand; task checking still belongs to the selected day', () => {
  const runtime = createRuntime(), page = runtime.page('today'); page.onLoad();
  const fixed = page.data.blocks.find(block => block.kind === 'fixed');
  page.onToggleBlock(event(fixed.id)); assert.equal(page.data.expandedBlock, '');
  page.onToggleBlock(event('music'));
  assert.equal(page.data.blocks.find(block => block.id === 'music').expanded, true);
  page.onToggleTask(event('music-guitar'));
  assert.equal(page.data.doneLabel, '1 / 6');
  page.choose(yesterday);
  assert.equal(page.data.blocks.find(block => block.id === 'music').doneCount, 0);
  page.onToggleBlock(event('music')); page.onToggleTask(event('music-vocal'));
  page.onToday();
  const music = page.data.blocks.find(block => block.id === 'music');
  assert.equal(music.actions.find(action => action.id === 'music-guitar').done, true);
  assert.equal(music.actions.find(action => action.id === 'music-vocal').done, false);
  assert.equal(music.expanded, false);
});

test('LEAN-02 markup keeps a single completion summary, footer entries and explicit 44px task controls', () => {
  const markup = fs.readFileSync(path.join(__dirname, '../miniprogram/pages/today/index.wxml'), 'utf8');
  const style = fs.readFileSync(path.join(__dirname, '../miniprogram/pages/today/index.wxss'), 'utf8');
  assert.doesNotMatch(markup, /block-meta|fixed-badge|稍后安排|progress-track|\{\{percent\}\}/);
  assert.equal((markup.match(/\{\{doneLabel\}\}/g) || []).length, 1);
  assert.ok(markup.indexOf('class="day-footer"') > markup.indexOf('class="timeline"'));
  assert.match(markup, /block\.expanded && block\.kind !== 'fixed'/);
  assert.match(markup, /restActive \|\| restEditorVisible/);
  assert.match(style, /button\.task-menu\s*\{[^}]*min-width: 44px[^}]*min-height: 44px/);
  assert.match(style, /\.weekday\s*\{[^}]*min-width: 44px/);
});
