// Synthetic plans only. The caller must back up every dayflow.* key first.
const KEYS = ['dayflow.plans.v1', 'dayflow.records.v2', 'dayflow.instances.v1'];
function wizardPayload(dateKey, at, scenario = 'basic') {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) throw new Error('Invalid fixture date');
  const [year, month, day] = dateKey.split('-').map(Number);
  const anchor = new Date(year, month - 1, day);
  if (anchor.getFullYear() !== year || anchor.getMonth() !== month - 1 || anchor.getDate() !== day) throw new Error('Invalid fixture date');
  if (!Number.isFinite(at) || at < 60000) throw new Error('Invalid fixture timestamp');
  if (!['basic', 'full', 'identity', 'rest', 'overwrite', 'siblings'].includes(scenario)) throw new Error('Invalid fixture scenario');
  function plus(days) { const d = new Date(year, month - 1, day + days); return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-'); }
  const weekdays = [0, 1, 2, 3, 4, 5, 6];
  const fixed = (id, title, start, end) => ({ id, title, start, end, kind: 'fixed', category: '工作', tasks: [] });
  const schedule = (id, title, blocks, from = dateKey) => ({ id, title, weekdays: [...weekdays], effectiveFrom: from, exceptions: [], blocks });
  const historyTask = { id: 'wizard-history-task', title: '合成历史事项', start: '18:00', end: '18:30', actions: [] };
  const historyBlock = { id: 'wizard-history-block', title: '合成历史事项', start: '18:00', end: '18:30', kind: 'parallel', category: '生活', tasks: [historyTask] };
  const historyDate = plus(-7), historicalAt = new Date(year, month - 1, day - 7, 18, 30).getTime();
  const complex = schedule('wizard-complex', '包含步骤与来源的合成安排', [
    { id: 'wizard-sequence', title: '晚间整理', start: '20:00', end: '20:30', kind: 'sequence', category: '生活', tasks: [
      { id: 'wizard-sequence-task', title: '分步骤整理', start: '20:00', end: '20:30', actions: [
        { id: 'wizard-action-a', title: '整理桌面', start: '20:00', end: '20:15', dosage: '按需', description: '合成步骤说明', equipment: '收纳盒', searchKeyword: '桌面整理', safety: '按需暂停' },
        { id: 'wizard-action-b', title: '收好物品', start: '20:15', end: '20:30' }
      ], origin: { date: historyDate, targetId: historyTask.id }, description: '保留任务补充说明' }
    ] },
    { id: 'wizard-sibling', title: '睡前阅读', start: '20:30', end: '21:00', kind: 'parallel', category: '兴趣', tasks: [
      { id: 'wizard-read-task', title: '阅读', start: '20:30', end: '21:00', actions: [] }
    ] }
  ]);
  complex.exceptions = [{ date: plus(61), kind: 'skip' }, { date: plus(62), kind: 'replace', blocks: JSON.parse(JSON.stringify(complex.blocks)) }];
  let schedules;
  if (scenario === 'full') schedules = [schedule('wizard-full', '全天工作', [fixed('wizard-full-block', '全天工作', '00:00', '23:59')])];
  else if (scenario === 'siblings') schedules = [schedule('wizard-full', '同组已有重叠安排', [fixed('wizard-selected', '需要调整的事项', '09:00', '10:00'), fixed('wizard-full-block', '同组全天安排', '00:00', '23:59')])];
  else if (scenario === 'overwrite') {
    const work = schedule('wizard-weekday-work', '工作日安排', [fixed('wizard-weekday-am', '上午工作', '09:00', '12:00'), fixed('wizard-weekday-pm', '下午工作', '14:00', '18:00')]);
    work.weekdays = [1, 2, 3, 4, 5];
    schedules = [work, schedule('wizard-unrelated', '晚间阅读', [{ id: 'wizard-unrelated-block', title: '阅读', start: '19:00', end: '19:30', kind: 'parallel', category: '兴趣', tasks: [{ id: 'wizard-unrelated-task', title: '阅读', start: '19:00', end: '19:30', actions: [] }] }])];
  }
  else if (scenario === 'identity') {
    const a = schedule('wizard-identity-a', '第一天阅读', [JSON.parse(JSON.stringify(historyBlock))]);
    const b = schedule('wizard-identity-b', '第二天阅读', [{ ...JSON.parse(JSON.stringify(historyBlock)), title: '第二天阅读', start: '18:30', end: '19:00', tasks: [{ ...historyTask, title: '第二天阅读', start: '18:30', end: '19:00' }] }]);
    a.weekdays = [anchor.getDay()]; b.weekdays = [(anchor.getDay() + 1) % 7]; schedules = [a, b];
  } else schedules = [
    schedule('wizard-work-am', '上午工作', [fixed('wizard-work-am-block', '上午工作', '08:00', '12:00')]),
    schedule('wizard-lunch', '午休', [fixed('wizard-lunch-block', '午休', '13:00', '13:30')]),
    schedule('wizard-work-pm', '下午工作', [fixed('wizard-work-pm-block', '下午工作', '14:00', '18:00')]),
    schedule('wizard-future', '两个月后会议', [fixed('wizard-future-block', '两个月后会议', '12:00', '13:00')], plus(60)), complex
  ];
  const template = { schemaVersion: 1, id: 'wizard-acceptance-template', name: '合成向导验收计划', version: 1, updatedAt: at, schedules };
  const records = { schemaVersion: 2, byDate: { [historyDate]: { [historyTask.id]: {
    date: historyDate, targetId: historyTask.id, taskId: historyTask.id, status: 'done', actualStartedAt: historicalAt - 1800000,
    finishedAt: historicalAt, updatedAt: historicalAt, feedback: { note: '合成历史记录，不是用户数据。' },
    events: [{ id: 'wizard-history-event', from: 'todo', to: 'done', at: historicalAt }]
  } } } };
  const instances = { [historyDate]: { date: historyDate, templateId: template.id, templateVersion: 1, blocks: [historyBlock], locked: true, mode: 'standard', createdAt: historicalAt } };
  const values = { [KEYS[0]]: template, [KEYS[1]]: records, [KEYS[2]]: instances };
  if (scenario === 'rest') {
    const task = complex.blocks[0].tasks[0];
    task.actions[1].end = '20:20';
    task.actions.push({ id: 'wizard-action-c', title: '准备明天用品', start: '20:20', end: '20:30' });
    records.byDate[dateKey] = {
      'wizard-action-a': { date: dateKey, targetId: 'wizard-action-a', taskId: task.id, actionId: 'wizard-action-a', status: 'done', actualStartedAt: at - 180000, finishedAt: at - 120000, updatedAt: at - 120000, events: [{ id: 'wizard-rest-done', from: 'todo', to: 'done', at: at - 120000 }] },
      'wizard-action-b': { date: dateKey, targetId: 'wizard-action-b', taskId: task.id, actionId: 'wizard-action-b', status: 'doing', actualStartedAt: at - 60000, updatedAt: at - 60000, events: [{ id: 'wizard-rest-doing', from: 'todo', to: 'doing', at: at - 60000 }] }
    };
    instances[dateKey] = { date: dateKey, templateId: template.id, templateVersion: 1, blocks: schedules.flatMap(item => item.effectiveFrom <= dateKey ? item.blocks : []).sort((a, b) => a.start.localeCompare(b.start)), locked: true, mode: 'standard', createdAt: at - 180000 };
    values['dayflow.timer.v1'] = { schemaVersion: 1, dateKey, targetId: 'wizard-action-b', durationSeconds: 10800, remainingSeconds: 10800, status: 'running', endsAt: at + 10800000, updatedAt: at };
  }
  return { date: dateKey, futureDate: plus(60), sundayDate: plus((7 - anchor.getDay()) % 7 || 7), historyDate, scenario, values };
}
// Keep the injected source ASCII. Chinese data travels only in a UTF-8 args file.
function seedWizard(payload) {
  var keys = ['dayflow.plans.v1', 'dayflow.records.v2', 'dayflow.instances.v1'];
  if (payload && payload.scenario === 'rest') keys.push('dayflow.timer.v1');
  if (!payload || !payload.values || !/^\d{4}-\d{2}-\d{2}$/.test(payload.date) || Object.keys(payload.values).length !== keys.length || keys.some(function(k) { return !Object.prototype.hasOwnProperty.call(payload.values, k); })) throw new Error('Invalid wizard payload');
  keys.forEach(function(k) { if (!payload.values[k] || typeof payload.values[k] !== 'object') throw new Error('Invalid wizard value'); });
  wx.getStorageInfoSync().keys.filter(function(k) { return k.indexOf('dayflow.') === 0; }).forEach(function(k) { wx.removeStorageSync(k); });
  keys.forEach(function(k) { wx.setStorageSync(k, payload.values[k]); });
  return { dayflowSmoke: true, seeded: true, scenario: payload.scenario };
}
module.exports = { KEYS, wizardPayload, seedWizard };
if (require.main === module) {
  const now = new Date(), dateKey = process.argv[2] || [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
  process.stdout.write(JSON.stringify({ basic: wizardPayload(dateKey, Date.now()), full: wizardPayload(dateKey, Date.now(), 'full'), identity: wizardPayload(dateKey, Date.now(), 'identity'), rest: wizardPayload(dateKey, Date.now(), 'rest'), overwrite: wizardPayload(dateKey, Date.now(), 'overwrite'), siblings: wizardPayload(dateKey, Date.now(), 'siblings'), seedWizard: seedWizard.toString() }));
}
