const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntime, clone } = require('./helpers/miniprogram');

function record(date, targetId, status = 'done', extra = {}) { return { date, targetId, taskId: targetId, status, updatedAt: 1, events: [], ...extra }; }

test('周统计以本地周一开始，只计算截至今天的叶子任务，固定占用和跳过不算完成', () => {
  const runtime = createRuntime();
  runtime.storage.set('dayflow.records.v2', { schemaVersion: 2, byDate: {
    '2026-10-26': { 'music-guitar': record('2026-10-26', 'music-guitar') },
    '2026-10-31': { 'd6-step-0': record('2026-10-31', 'd6-step-0', 'done', { taskId: 'training-task', actionId: 'd6-step-0' }), 'music-vocal': record('2026-10-31', 'music-vocal', 'skipped') }
  } });
  const summary = runtime.load('miniprogram/services/insights.ts').getWeeklySummary('2026-10-31');
  assert.equal(summary.days.length, 6);
  assert.equal(summary.days[0].date, '2026-10-26');
  assert.equal(summary.completed, 2); assert.equal(summary.total, 39);
  assert.equal(summary.trainingCompleted, 1); assert.equal(summary.trainingTotal, 27);
  assert.equal(summary.percent, 5);
});

test('连续执行按自然日至少一项完成，跳过不记连续，区间筛选不伪造当前连续值', () => {
  const runtime = createRuntime();
  runtime.storage.set('dayflow.records.v2', { schemaVersion: 2, byDate: {
    '2026-10-29': { 'music-guitar': record('2026-10-29', 'music-guitar', 'skipped') },
    '2026-10-30': { 'music-guitar': record('2026-10-30', 'music-guitar') },
    '2026-10-31': { 'music-guitar': record('2026-10-31', 'music-guitar') },
    '2026-11-01': { 'music-guitar': record('2026-11-01', 'music-guitar') }
  } });
  const insights = runtime.load('miniprogram/services/insights.ts');
  const all = insights.getHistorySummary(); assert.equal(all.streak, 2); assert.equal(all.activeDays, 2);
  assert.equal(all.days.some(day => day.date === '2026-11-01'), false);
  const range = insights.getHistorySummary('2026-10-30', '2026-10-30');
  assert.equal(range.activeDays, 1); assert.equal(range.streak, 2); assert.equal(range.days.length, 1);
  assert.throws(() => insights.getHistorySummary('2026-10-31', '2026-10-30'), /不能晚于/);
});

test('模板修改后历史统计的分母和原任务名称来自已锁定快照', () => {
  const runtime = createRuntime();
  runtime.storage.set('dayflow.records.v1', { '2026-10-30': { 'music-guitar': 'done' } });
  const plans = runtime.load('miniprogram/services/plans.ts');
  const next = clone(plans.getTemplate()); next.schedules = []; plans.saveTemplate(next, 1);
  const insights = runtime.load('miniprogram/services/insights.ts');
  const day = insights.getHistorySummary('2026-10-30', '2026-10-30').days[0];
  assert.equal(day.completed, 1); assert.equal(day.total, 9);
  assert.equal(plans.getDayBlocks(day.date).find(b => b.id === 'music').actions[0].title, '练吉他');
});

test('训练延期安排保留训练统计分类，未来整周不提前计入总数', () => {
  const runtime = createRuntime();
  const source = record('2026-10-30', 'd5-step-1', 'deferred', { taskId: 'training-task', actionId: 'd5-step-1', deferredTo: '2026-10-31' });
  runtime.storage.set('dayflow.records.v2', { schemaVersion: 2, byDate: { '2026-10-30': { 'd5-step-1': source } } });
  const plans = runtime.load('miniprogram/services/plans.ts'), records = runtime.load('miniprogram/services/records.ts');
  const placed = plans.scheduleDeferredTarget(source.date, source.targetId, source.deferredTo);
  records.setStatus(placed.date, placed.targetId, 'done');
  const insights = runtime.load('miniprogram/services/insights.ts');
  const summary = insights.getWeeklySummary('2026-10-31');
  assert.equal(summary.trainingCompleted, 1); assert.equal(summary.trainingTotal, 28);
  assert.equal(insights.getWeeklySummary('2026-11-03').total, 0);
});

test('统计页展示真实时刻和状态事件，未记录的开始时间不使用计划开始时刻填充', () => {
  const runtime = createRuntime();
  const records = runtime.load('miniprogram/services/records.ts');
  records.setStatus('2026-10-31', 'music-guitar', 'done');
  records.saveFeedback('2026-10-31', 'music-guitar', { effort: 2, discomfort: true, note: '决定休息' });
  const page = runtime.page('stats'); page.onShow();
  const row = page.data.historyRecords.find(item => item.title === '练吉他');
  assert.equal(row.actualStartLabel, '未记录');
  assert.match(row.actualFinishLabel, /2026-10-31 12:04/);
  assert.equal(row.statusLabel, '完成'); assert.match(row.feedbackLabel, /决定休息/); assert.ok(row.eventCount > 0);
  page.onToggleHistoryRecord({ currentTarget: { dataset: { id: row.recordKey } } });
  assert.equal(page.data.historyRecords.find(item => item.recordKey === row.recordKey).expanded, true);
});

test('仅浏览计划和周统计不会被误称为已经产生执行历史', () => {
  const runtime = createRuntime(), plans = runtime.load('miniprogram/services/plans.ts'), insights = runtime.load('miniprogram/services/insights.ts');
  plans.getDailyInstance('2026-10-30'); insights.getWeeklySummary('2026-10-31');
  const history = insights.getHistorySummary();
  assert.equal(history.days.length, 0); assert.equal(history.activeDays, 0); assert.equal(history.streak, 0);
  const page = runtime.page('stats'); page.onShow();
  assert.equal(page.data.historyCount, 0); assert.equal(page.data.historyRecords.length, 0);
});
