const test = require('node:test');
const assert = require('node:assert/strict');
const { createHandler, runDueJobs } = require('../cloudfunctions/dayflowReminders/jobs');
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const NOW = Date.UTC(2026, 9, 31, 10);
const config = { enabled: true, miniprogramState: 'developer', templates: {
  task: { id: 'fixture-template-task', titleField: 'thing1', timeField: 'time2' },
  sleep: { id: 'fixture-template-sleep', titleField: 'thing1', timeField: 'time2' }
} };
const alice = { OPENID: 'fixture-a', APPID: 'fixture-app' };
const bob = { OPENID: 'fixture-b', APPID: 'fixture-app' };
function repository() {
  const docs = new Map(); let chain = Promise.resolve();
  return { docs,
    async transact(id, update) {
      const operation = chain.then(async () => {
        const result = await update(clone(docs.get(id)));
        if (result.document) docs.set(id, clone(result.document));
        return clone(result.result);
      });
      chain = operation.catch(() => {}); return operation;
    },
    async findDue(now) { return [...docs].filter(([, doc]) => doc.nextDueAt <= now).map(([id]) => id); }
  };
}
const candidate = () => ({ kind: 'task', targetDate: '2026-10-31', targetId: 'training', title: '训练示例', dateKey: '2026-10-31', time: '18:02', timezoneOffset: -480, dueAt: NOW + 120000 });
async function register(handler, context = alice, item = candidate()) {
  const capability = await handler({ action: 'capability', kind: 'task' }, context);
  return handler({ action: 'register', candidate: item, expectedAccountId: capability.accountId, templateId: config.templates.task.id }, context);
}
test('有限提醒按可信账户隔离、模板/本地时区/七天约束、稳定去重与取消', async () => {
  const repo = repository(); const handler = createHandler(repo, config, () => NOW);
  const first = await register(handler); const duplicate = await register(handler);
  assert.equal(first.ok, true); assert.equal(first.job.id, duplicate.job.id);
  assert.equal(first.job.time, '18:02'); assert.equal('openid' in first.job, false);
  assert.equal((await handler({ action: 'list', owner: first.accountId }, bob)).jobs.length, 0);
  assert.equal((await handler({ action: 'cancel', id: first.job.id }, bob)).ok, false);
  for (const patch of [{ dueAt: NOW + 8 * 86400000 }, { dateKey: '2026-02-30' }, { time: '24:00' }, { timezoneOffset: 0 }, { owner: first.accountId }, { title: '' }]) {
    assert.equal((await register(handler, alice, { ...candidate(), ...patch })).ok, false);
  }
  const cancelled = await handler({ action: 'cancel', id: first.job.id }, alice);
  assert.equal(cancelled.job.status, 'cancelled');
  assert.equal((await register(handler)).job.status, 'cancelled');
  assert.equal((await handler({ action: 'tick', Type: 'Timer' }, alice)).ok, false);
});
test('未配置默认拒绝登记；伪造accepted/owner/模板不能建立可信授权或跨用户记录', async () => {
  const repo = repository(); const disabled = createHandler(repo, {}, () => NOW);
  assert.equal((await register(disabled)).ok, false);
  const handler = createHandler(repo, config, () => NOW);
  const result = await handler({ action: 'register', candidate: candidate(), expectedAccountId: 'a'.repeat(64), templateId: 'attacker-template', accepted: true }, alice);
  assert.equal(result.ok, false); assert.equal(repo.docs.size, 0);
  assert.equal((await handler({ action: 'list' }, { OPENID: '', APPID: 'app' })).ok, false);
});
test('原子领取后并发定时只发送一次，成功只标记已提交微信', async () => {
  const repo = repository(); const handler = createHandler(repo, config, () => NOW);
  await register(handler); let sends = 0;
  const sender = async () => { sends++; await Promise.resolve(); return { errCode: 0 }; };
  await Promise.all([runDueJobs(repo, sender, NOW + 120000), runDueJobs(repo, sender, NOW + 120000)]);
  assert.equal(sends, 1); assert.equal((await handler({ action: 'list' }, alice)).jobs[0].status, 'sent');
  await runDueJobs(repo, sender, NOW + 180000); assert.equal(sends, 1);
});
test('超时未知/业务失败/过期均不自动重试，sending崩溃也不重领', async () => {
  for (const expected of ['unknown', 'failed', 'expired']) {
    const repo = repository(); const handler = createHandler(repo, config, () => NOW);
    await register(handler); let sends = 0;
    const sender = async () => { sends++; if (expected === 'unknown') throw new Error('network private payload'); return { errCode: 43101 }; };
    const now = NOW + (expected === 'expired' ? 13 : 2) * 60000;
    await runDueJobs(repo, sender, now); await runDueJobs(repo, sender, now + 60000);
    assert.equal((await handler({ action: 'list' }, alice)).jobs[0].status, expected);
    assert.equal(sends, expected === 'expired' ? 0 : 1);
  }
  const repo = repository(); const handler = createHandler(repo, config, () => NOW); const first = await register(handler);
  const doc = repo.docs.get(first.accountId); doc.jobs[0].status = 'sending';
  let sends = 0; await runDueJobs(repo, async () => { sends++; }, NOW + 120000); assert.equal(sends, 0);
});
test('损坏聚合归属不会被返回、覆盖或作为收件人发送', async () => {
  const repo = repository(); const handler = createHandler(repo, config, () => NOW); const first = await register(handler);
  const doc = repo.docs.get(first.accountId); doc.jobs[0].owner = 'b'.repeat(64);
  const before = JSON.stringify([...repo.docs]);
  assert.equal((await handler({ action: 'list' }, alice)).ok, false);
  assert.equal((await handler({ action: 'cancel', id: first.job.id }, alice)).ok, false);
  assert.equal((await register(handler)).ok, false);
  let sends = 0; await runDueJobs(repo, async () => { sends++; }, NOW + 120000);
  assert.equal(sends, 0); assert.equal(JSON.stringify([...repo.docs]), before);
});
