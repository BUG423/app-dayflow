const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRuntime, clone } = require('./helpers/miniprogram');

const date = '2026-10-31';
const event = id => ({ currentTarget: { dataset: { id } } });
function loadPage(runtime) {
  const page = runtime.page('training');
  page.onLoad({ date, blockId: 'training' });
  return page;
}
const action = (page, id) => page.data.actions.find(item => item.id === id);

// Inspect ancestor guards only; this is not a simulator or a WXML rendering test.
function guardedElements(source) {
  const stack = [], elements = [];
  for (const match of source.matchAll(/<(\/?)([\w-]+)\b([^>]*?)>/g)) {
    if (match[1]) { assert.equal(stack.pop()?.tag, match[2]); continue; }
    const element = { tag: match[2], attrs: match[3], ancestors: [...stack] };
    elements.push(element);
    if (!match[3].trimEnd().endsWith('/')) stack.push(element);
  }
  assert.equal(stack.length, 0);
  return elements;
}

test('LEAN-08 详情默认收起，独立展开并在刷新后保留，不写执行或剂量', () => {
  const runtime = createRuntime(), page = loadPage(runtime);
  const before = clone(page.data.actions), storageBefore = clone([...runtime.storage]);
  assert.ok(before.length > 1);
  assert.ok(before.every(item => item.expanded === false));
  assert.equal(page.data.showTrainingInfo, false);
  const [first, second] = before;
  page.onToggleActionDetails(event(first.id));
  assert.equal(action(page, first.id).expanded, true);
  assert.equal(action(page, second.id).expanded, false);
  page.onToggleActionDetails(event(second.id));
  page.loadBlock();
  assert.equal(action(page, first.id).expanded, true);
  assert.equal(action(page, second.id).expanded, true);
  page.onToggleActionDetails(event(first.id));
  assert.equal(action(page, first.id).expanded, false);
  assert.equal(action(page, second.id).expanded, true);
  page.onToggleTrainingInfo();
  assert.equal(page.data.showTrainingInfo, true);
  page.onToggleTrainingInfo();
  assert.equal(page.data.showTrainingInfo, false);
  assert.deepEqual(clone(page.data.actions.map(({ expanded, ...item }) => item)), before.map(({ expanded, ...item }) => item));
  assert.deepEqual(clone([...runtime.storage]), storageBefore);
});

test('LEAN-08 正在填写的感受保持展开，刷新和保存保留上下文，不适不自动完成', () => {
  const runtime = createRuntime(), page = loadPage(runtime), id = page.data.actions[0].id;
  page.onOpenFeedback(event(id));
  page.onFeedbackNoteInput({ detail: { value: '合成回归：选择休息' } });
  page.onFeedbackDiscomfortChange({ detail: { value: true } });
  page.onToggleActionDetails(event(id));
  page.loadBlock();
  assert.equal(action(page, id).expanded, true);
  assert.equal(page.data.showFeedbackEditor, true);
  assert.equal(page.data.feedbackNote, '合成回归：选择休息');
  assert.equal(page.data.feedbackDiscomfort, true);
  assert.equal(runtime.storage.has('dayflow.records.v2'), false);
  page.onSaveFeedback();
  assert.equal(action(page, id).expanded, true);
  assert.equal(action(page, id).feedback.discomfort, true);
  assert.equal(action(page, id).done, false);
  assert.equal(action(page, id).status, 'todo');
  page.onToggleActionDetails(event(id));
  assert.equal(action(page, id).expanded, false);
  assert.equal(action(page, id).feedback.discomfort, true);
});

test('LEAN-08 照片保存与页面重返保持动作详情和反馈草稿，不写完成状态', async () => {
  const photos = [];
  const runtime = createRuntime(undefined, { modules: {
    'miniprogram/services/media.ts': {
      getPhotos: () => photos,
      chooseAndSavePhoto: async (dateKey, targetId) => photos.push({ id: 'synthetic-photo', dateKey, targetId, localPath: '/synthetic/photo.jpg', createdAt: 1 })
    }
  } });
  const page = loadPage(runtime), id = page.data.actions[0].id;
  page.onOpenFeedback(event(id));
  page.onFeedbackNoteInput({ detail: { value: '未保存的合成草稿' } });
  await page.onChoosePhoto(event(id));
  page.onHide(); page.onShow();
  assert.equal(action(page, id).expanded, true);
  assert.equal(action(page, id).photos.length, 1);
  assert.equal(page.data.showFeedbackEditor, true);
  assert.equal(page.data.feedbackNote, '未保存的合成草稿');
  assert.equal(action(page, id).status, 'todo');
  assert.equal(runtime.storage.has('dayflow.records.v2'), false);
  page.onUnload();
});

test('LEAN-08 收起动作仍显示运行计时，暂停和休息 guard 保留，计时不完成任务', () => {
  const runtime = createRuntime(), page = loadPage(runtime), id = page.data.actions[0].id;
  page.onSelectTimerTarget(event(id)); page.onStartTimer(); page.onCloseTimerPanel();
  assert.equal(action(page, id).expanded, false);
  assert.equal(page.data.timerState.status, 'running');
  page.onPauseTimer();
  assert.equal(page.data.timerState.status, 'paused');
  page.onResumeTimer();
  assert.equal(page.data.timerState.status, 'running');
  runtime.load('miniprogram/services/rest-days.ts').startRestToday('合成休息原因');
  page.loadBlock();
  assert.equal(page.data.restActive, true);
  assert.equal(page.data.timerState.status, 'paused');
  const before = clone([...runtime.storage]);
  page.onResumeTimer(); page.onToggleAction(event(id));
  assert.deepEqual(clone([...runtime.storage]), before);
  assert.equal(action(page, id).done, false);
});

test('LEAN-08 模板仅折叠说明与辅助操作，安全、不适、计时和中止均在详情外', () => {
  const source = fs.readFileSync(path.join(__dirname, '../miniprogram/pages/training/index.wxml'), 'utf8');
  const elements = guardedElements(source);
  const folded = item => item.ancestors.some(parent => parent.attrs.includes('wx:if="{{action.expanded}}"'));
  for (const marker of ['class="description"', 'class="search"', 'class="exercise-actions"', 'class="photo-list"', 'class="feedback-editor"']) {
    assert.ok(folded(elements.find(item => item.attrs.includes(marker))), marker);
  }
  for (const marker of ['wx:if="{{action.safety}}"', 'class="action-safety discomfort-notice"', 'class="card active-timer"', 'bindtap="onStop"']) {
    const element = elements.find(item => item.attrs.includes(marker));
    assert.ok(element, marker);
    assert.equal(folded(element), false, marker);
  }
  assert.match(source, /catchtap="onPauseTimer"/);
  assert.match(source, /catchtap="onResumeTimer"/);
  assert.ok(source.indexOf('class="card training-info"') > source.indexOf('class="action-details"'));
  assert.match(source, /改用15分钟简化计划/);
});
