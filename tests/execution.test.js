const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntime, clone } = require('./helpers/miniprogram');
const date = '2026-10-31';

test('六种执行状态记录真实事件，重复状态幂等，固定块不可打卡', () => {
  const runtime = createRuntime();
  const records = runtime.load('miniprogram/services/records.ts');
  const started = records.setStatus(date, 'music-guitar', 'doing');
  assert.equal(started.actualStartedAt, new Date(2026, 9, 31, 12, 4).getTime());
  assert.equal(started.events.length, 1);
  runtime.setNow(new Date(2026, 9, 31, 12, 6));
  assert.equal(records.setStatus(date, 'music-guitar', 'doing').events.length, 1);
  const done = records.setStatus(date, 'music-guitar', 'done');
  assert.equal(done.events.length, 2);
  assert.equal(done.events[1].from, 'doing');
  assert.equal(done.finishedAt, new Date(2026, 9, 31, 12, 6).getTime());
  records.setStatus(date, 'music-guitar', 'skipped');
  records.setStatus(date, 'music-guitar', 'deferred', { deferredTo: '2026-11-02' });
  records.setStatus(date, 'music-guitar', 'aborted');
  const todo = records.setStatus(date, 'music-guitar', 'todo');
  assert.equal(todo.events.length, 6);
  assert.equal(todo.actualStartedAt, undefined);
  assert.equal(todo.finishedAt, undefined);
  assert.equal(todo.deferredTo, undefined);
  assert.throws(() => records.setStatus(date, 'work-morning', 'done'), /没有这项任务/);
  assert.throws(() => records.setStatus(date, 'missing', 'done'), /没有这项任务/);
});

test('直接勾选与旧版迁移不伪造开始时刻，旧版数据保留且v2空状态不会复活旧记录', () => {
  const runtime = createRuntime();
  const legacy = { '2026-10-30': { 'music-guitar': 'done', 'd5-step-0': 'todo' } };
  runtime.storage.set('dayflow.records.v1', legacy);
  const records = runtime.load('miniprogram/services/records.ts');
  const migrated = records.recordDetailsForDate('2026-10-30')['music-guitar'];
  assert.equal(migrated.status, 'done');
  assert.equal(migrated.actualStartedAt, undefined);
  assert.equal(migrated.finishedAt, undefined);
  assert.equal(migrated.events.length, 0);
  const direct = records.setStatus(date, 'music-vocal', 'done');
  assert.equal(direct.actualStartedAt, undefined);
  assert.equal(direct.finishedAt, new Date(2026, 9, 31, 12, 4).getTime());
  assert.deepEqual(runtime.storage.get('dayflow.records.v1'), legacy);
  records.replaceEnvelope({ schemaVersion: 2, byDate: {} });
  assert.deepEqual(clone(records.forDate('2026-10-30')), {});
});

test('严格拒绝非法延期、损坏远端事件和读取故障，不覆盖原始记录', () => {
  const runtime = createRuntime();
  const records = runtime.load('miniprogram/services/records.ts');
  records.setStatus(date, 'music-guitar', 'done');
  const before = clone(runtime.storage.get('dayflow.records.v2'));
  assert.throws(() => records.setStatus(date, 'music-guitar', 'deferred'), /延期目标/);
  assert.throws(() => records.setStatus(date, 'music-guitar', 'deferred', { deferredTo: date }), /晚于/);
  const corrupt = clone(before);
  corrupt.byDate[date]['music-guitar'].events[0].at = 'pretend';
  assert.throws(() => records.replaceEnvelope(corrupt), /事件/);
  const inconsistent = clone(before);
  inconsistent.byDate[date]['music-guitar'].status = 'doing';
  assert.throws(() => records.replaceEnvelope(inconsistent), /状态不一致/);
  assert.deepEqual(runtime.storage.get('dayflow.records.v2'), before);
  runtime.wx.getStorageSync = () => { throw new Error('read failed'); };
  assert.throws(() => records.setStatus(date, 'music-vocal', 'doing'), /read failed/);
  assert.deepEqual(runtime.storage.get('dayflow.records.v2'), before);
});

test('浏览历史时前台提醒仍读取真实今天，标记失败也不重复弹出同一提醒', () => {
  const calls = [];
  const runtime = createRuntime(undefined, { modules: { 'miniprogram/services/preferences.ts': {
    getDueReminders: (dateKey, minute, blocks, nextDayBlocks) => { calls.push({ dateKey, minute, blocks: blocks.length, nextDayBlocks: nextDayBlocks.length }); return [{ key: '2026-10-31:music', kind: 'task', title: '吉他与声乐即将开始' }]; },
    markReminderShown: () => { throw new Error('full'); }
  } } });
  const page = runtime.page('today'); page.onLoad(); page.choose('2026-10-29'); page.onShow();
  assert.equal(calls[0].dateKey, '2026-10-31');
  assert.equal(page.data.selectedDate, '2026-10-29');
  assert.ok(calls[0].nextDayBlocks > 0);
  const toasts = runtime.calls.toasts.length;
  runtime.setNow(new Date(2026, 9, 31, 12, 5)); runtime.tick();
  assert.equal(runtime.calls.toasts.length, toasts);
  page.onHide(); runtime.setNow(new Date(2026, 9, 31, 12, 6)); runtime.tick();
  assert.equal(runtime.calls.toasts.length, toasts);
});

test('反馈独立保存且不自动完成、不自动中止，写失败不返回伪成功', () => {
  const runtime = createRuntime();
  const records = runtime.load('miniprogram/services/records.ts');
  const feedback = records.saveFeedback(date, 'd6-step-0', { effort: 2, discomfort: true, note: '  已自行停止并准备咨询  ' });
  assert.equal(feedback.status, 'todo');
  assert.equal(feedback.feedback.note, '已自行停止并准备咨询');
  assert.equal(feedback.actualStartedAt, undefined);
  assert.equal(feedback.events.length, 0);
  assert.throws(() => records.saveFeedback(date, 'd6-step-0', { effort: 6 }), /一至五级/);
  const before = clone(runtime.storage.get('dayflow.records.v2'));
  runtime.wx.setStorageSync = () => { throw new Error('full'); };
  assert.throws(() => records.setStatus(date, 'd6-step-0', 'done'), /full/);
  assert.deepEqual(runtime.storage.get('dayflow.records.v2'), before);
});

test('实际执行时间从持久化事件恢复，后台间隔计入进行中的时段，中止间隔不累计', () => {
  const runtime = createRuntime();
  const records = runtime.load('miniprogram/services/records.ts');
  const { elapsedSeconds, durationText } = runtime.load('miniprogram/services/execution.ts');
  records.setStatus(date, 'd6-step-0', 'doing');
  runtime.setNow(new Date(2026, 9, 31, 12, 5));
  records.setStatus(date, 'd6-step-0', 'aborted');
  runtime.setNow(new Date(2026, 9, 31, 12, 10));
  records.setStatus(date, 'd6-step-0', 'doing');
  runtime.setNow(new Date(2026, 9, 31, 12, 12));
  const record = records.recordDetailsForDate(date)['d6-step-0'];
  assert.equal(elapsedSeconds(record), 180);
  assert.equal(durationText(elapsedSeconds(record)), '03:00');
  assert.equal(durationText(-3), '00:00');
  assert.throws(() => records.setStatus(date, 'd6-step-1', 'doing'), /先中止/);
  records.setStatus(date, 'music-guitar', 'doing');
  assert.equal(records.forDate(date)['music-guitar'], 'doing');
});

test('真实进行中的任务优先于时段卡片，训练中止保留已完成动作并可恢复', () => {
  const runtime = createRuntime(new Date(2026, 9, 31, 16, 0));
  const records = runtime.load('miniprogram/services/records.ts');
  records.setStatus(date, 'music-guitar', 'doing');
  const today = runtime.page('today'); today.onLoad();
  assert.equal(today.data.heroTitle, '练吉他');
  assert.equal(today.data.heroCaption, '正在执行');
  assert.equal(today.data.blocks.find(block => block.id === 'music').actions[0].statusText, '进行中');
  const training = runtime.page('training'); training.onLoad({ date, blockId: 'training' });
  training.onToggleAction({ currentTarget: { dataset: { id: 'd6-prepare' } } });
  training.onToggleAction({ currentTarget: { dataset: { id: 'd6-step-0' } } });
  training.onStop();
  runtime.calls.modals.at(-1).success({ confirm: true });
  assert.equal(records.forDate(date)['d6-step-0'], 'done');
  assert.equal(records.forDate(date)['d6-step-1'], 'aborted');
  training.onStart();
  assert.equal(records.forDate(date)['d6-step-1'], 'doing');
  training.onShow(); training.onHide();
  const before = training.data.sessionElapsedText;
  runtime.setNow(new Date(2026, 9, 31, 16, 2));
  training.onShow();
  assert.notEqual(training.data.sessionElapsedText, before);
  assert.equal(training.data.sessionElapsedText, '02:00');
  training.onUnload();
});

test('合法的继承名称任务标识只读写自有记录，不把原型函数当作执行事实', () => {
  const runtime = createRuntime();
  const plans = runtime.load('miniprogram/services/plans.ts');
  const template = clone(plans.getTemplate());
  template.schedules.find(schedule => schedule.weekdays.includes(6)).blocks.find(block => block.id === 'music').tasks[0].id = 'toString';
  plans.saveTemplate(template, template.version);
  const records = runtime.load('miniprogram/services/records.ts');
  assert.equal(records.recordDetailsForDate(date).toString, undefined);
  assert.equal(records.forDate(date).toString, undefined);
  const record = records.setStatus(date, 'toString', 'done');
  assert.equal(record.targetId, 'toString');
  assert.equal(record.taskId, 'toString');
  assert.equal(records.forDate(date).toString, 'done');
  const page = runtime.page('today'); page.onLoad();
  assert.equal(page.data.blocks.find(block => block.id === 'music').actions[0].statusText, '已完成');
});

test('训练页保存主观反馈，不适不会自动解锁或完成，延期日期需另行安排', () => {
  const runtime = createRuntime();
  const page = runtime.page('training'); page.onLoad({ date, blockId: 'training' });
  const event = { currentTarget: { dataset: { id: 'd6-step-0' } } };
  page.onOpenFeedback(event);
  page.onFeedbackNoteInput({ detail: { value: '我选择停止并咨询' } });
  page.onFeedbackEffortChange({ detail: { value: 2 } });
  page.onFeedbackDiscomfortChange({ detail: { value: true } });
  page.onSaveFeedback();
  const records = runtime.load('miniprogram/services/records.ts');
  assert.equal(records.recordDetailsForDate(date)['d6-step-0'].feedback.note, '我选择停止并咨询');
  assert.equal(records.forDate(date)['d6-step-0'], 'todo');
  assert.equal(page.data.trainingPhase, '基础');
  assert.match(runtime.calls.modals.at(-1).content, /专业人员审核/);
  page.onActionMenu(event); runtime.calls.actionSheets.at(-1).success({ tapIndex: 3 });
  assert.equal(page.data.showDeferEditor, true);
  page.onDeferDateChange({ detail: { value: '2026-11-02' } }); page.onConfirmDefer();
  assert.equal(records.recordDetailsForDate(date)['d6-step-0'].deferredTo, '2026-11-02');
  assert.match(runtime.calls.toasts.at(-1).title, /计划页一键安排/);
  assert.equal(records.forDate('2026-11-02')['d6-step-0'], undefined);
});

test('训练页照片动作调用持久化与上传服务，取消移除保留关联', async () => {
  const calls = [];
  const photos = [];
  const media = {
    getPhotos: () => photos,
    chooseAndSavePhoto: async (dateKey, targetId) => { calls.push(['choose', dateKey, targetId]); const photo = { id: 'photo-1', dateKey, targetId, localPath: '/saved/photo.jpg', createdAt: 1 }; photos.push(photo); return photo; },
    removePhoto: id => { calls.push(['remove', id]); photos.splice(0); }
  };
  const sync = {
    getSyncState: () => ({ enabled: true, envId: 'local-test-env' }),
    uploadPhoto: async id => { calls.push(['upload', id]); photos[0].cloudFileID = 'cloud://photo'; return photos[0]; },
    getPhotoPreviewPath: async photo => { calls.push(['preview', photo.id]); return photo.localPath; }
  };
  const runtime = createRuntime(undefined, { modules: { 'miniprogram/services/media.ts': media, 'miniprogram/services/sync.ts': sync } });
  const page = runtime.page('training'); page.onLoad({ date, blockId: 'training' });
  await page.onChoosePhoto({ currentTarget: { dataset: { id: 'd6-step-0' } } });
  assert.deepEqual(calls[0], ['choose', date, 'd6-step-0']);
  assert.equal(page.data.actions.find(action => action.id === 'd6-step-0').photos.length, 1);
  assert.equal(page.data.actions.find(action => action.id === 'd6-step-0').done, false);
  await page.onUploadPhoto({ currentTarget: { dataset: { photoId: 'photo-1' } } });
  await page.onPreviewPhoto({ currentTarget: { dataset: { path: '/saved/photo.jpg' } } });
  assert.equal(runtime.calls.previews[0].current, '/saved/photo.jpg');
  page.onRemovePhoto({ currentTarget: { dataset: { photoId: 'photo-1' } } });
  runtime.calls.modals.at(-1).success({ confirm: false });
  assert.equal(photos.length, 1);
  page.onRemovePhoto({ currentTarget: { dataset: { photoId: 'photo-1' } } });
  runtime.calls.modals.at(-1).success({ confirm: true });
  assert.equal(photos.length, 0);
});
