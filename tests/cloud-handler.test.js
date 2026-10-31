const test = require('node:test');
const assert = require('node:assert/strict');
const { createHandler, account, validateFileID } = require('../cloudfunctions/dayflowSync/handler');
const context = { OPENID: 'fixture-user-a', APPID: 'fixture-app', environmentId: 'fixture-env', privateStorageReady: true };
const other = { ...context, OPENID: 'fixture-user-b' };
function payload() {
  const plan = { schemaVersion: 1, id: 'plan', name: '示例计划', version: 1, updatedAt: 0, schedules: [] };
  return { schemaVersion: 1, plans: plan, planVersions: [], instances: {}, records: { schemaVersion: 2, byDate: {} },
    preferences: { sleepReminderEnabled: false, sleepTime: '23:00', taskReminderEnabled: false, leadMinutes: 10,
      subscriptionTemplateIds: [], trainingPhase: '基础', phaseRules: [{ id: 'basic', name: '基础', minSessions: 0, description: '' }] }, media: [] };
}
function repository() {
  const data = new Map(); let tail = Promise.resolve();
  return { data, transact(id, update) {
    const next = tail.then(async () => { const op = await update(data.get(id)); if (op.write) data.set(id, op.document); return op.result; });
    tail = next.catch(() => {}); return next;
  } };
}
test('服务端只信任调用上下文，伪造owner不能跨账户读写', async () => {
  const repo = repository(); const handler = createHandler(repo);
  assert.equal((await handler({ action: 'identity' }, {})).code, 'AUTH_REQUIRED');
  const a = await handler({ action: 'identity', owner: other.OPENID }, context);
  assert.equal(a.accountId, account(context));
  await handler({ action: 'push', owner: other.OPENID, expectedVersion: 0, payload: payload() }, context);
  const b = await handler({ action: 'push', owner: context.OPENID, expectedVersion: 0, payload: payload() }, other);
  assert.equal(b.version, 1);
  assert.equal(repo.data.size, 2);
  assert.equal(repo.data.get(account(context)).owner, context.OPENID);
});
test('同一版本的并发写入只能成功一次，另一份返回版本冲突', async () => {
  const handler = createHandler(repository());
  const result = await Promise.all([1, 2].map(() => handler({ action: 'push', expectedVersion: 0, payload: payload() }, context)));
  assert.equal(result.filter(value => value.version === 1 && !value.conflict).length, 1);
  assert.equal(result.filter(value => value.conflict).length, 1);
});
test('云照片必须属于当前环境及账户路径，拒绝本地路径和他人文件', async () => {
  const own = 'cloud://fixture-env.bucket/dayflow-photos/' + account(context) + '/photo.jpg';
  assert.doesNotThrow(() => validateFileID(own, context, account(context)));
  for (const fileID of [own.replace(account(context), account(other)), own.replace('fixture-env.', 'other-env.'), own.replace('photo.jpg', '../photo.jpg')]) {
    assert.throws(() => validateFileID(fileID, context, account(context)));
  }
  const handler = createHandler(repository()); const data = payload();
  data.media = [{ id: 'photo', dateKey: '2026-10-31', targetId: 'x', createdAt: 1, cloudFileID: own, localPath: 'private-device-path' }];
  assert.equal((await handler({ action: 'push', expectedVersion: 0, payload: data }, context)).code, 'INVALID_MEDIA');
});

test('未确认私有存储部署时默认不开放云端照片，标记不是ACL探测证明', async () => {
  const handler = createHandler(repository()); const unready = { ...context, privateStorageReady: false };
  assert.equal((await handler({ action: 'identity' }, unready)).mediaEnabled, false);
  const fileID = 'cloud://fixture-env.bucket/dayflow-photos/' + account(context) + '/photo.jpg';
  assert.equal((await handler({ action: 'validateMedia', fileID }, unready)).code, 'MEDIA_NOT_CONFIGURED');
});
test('超限快照与保留键拒绝写入，不截断历史', async () => {
  const repo = repository(); const handler = createHandler(repo); const data = payload();
  data.plans.name = '大'.repeat(400000);
  assert.equal((await handler({ action: 'push', expectedVersion: 0, payload: data }, context)).code, 'PAYLOAD_TOO_LARGE');
  assert.equal(repo.data.size, 0);
  const injection = payload(); injection.records.byDate = JSON.parse('{"__proto__":{}}');
  assert.equal((await handler({ action: 'push', expectedVersion: 0, payload: injection }, context)).code, 'INVALID_KEY');
});

test('绕过客户端的坏钟点、日程、事件和偏好均在服务端拒绝', async () => {
  const handler = createHandler(repository());
  const time = payload();
  time.plans.schedules = [{ id: 'bad-time', title: '安排', weekdays: [1], effectiveFrom: '2026-01-01', exceptions: [], blocks: [
    { id: 'work', title: '工作', start: '25:00', end: '26:00', kind: 'fixed', category: '工作', tasks: [] }
  ] }];
  assert.equal((await handler({ action: 'push', expectedVersion: 0, payload: time }, context)).code, 'INVALID_PLANS');
  const event = payload();
  event.records.byDate['2026-10-31'] = { target: { date: '2026-10-31', targetId: 'target', taskId: 'target', status: 'done', updatedAt: 1, events: [{ id: 'event', from: 'todo', to: 'done' }] } };
  assert.equal((await handler({ action: 'push', expectedVersion: 0, payload: event }, context)).code, 'INVALID_RECORDS');
  const preferences = payload(); preferences.preferences.leadMinutes = -1;
  assert.equal((await handler({ action: 'push', expectedVersion: 0, payload: preferences }, context)).code, 'INVALID_PREFERENCES');
  const emergency = payload();
  emergency.instances['2026-10-31'] = { date: '2026-10-31', templateId: 'plan', templateVersion: 1, createdAt: 0, locked: true, mode: 'emergency', blocks: [
    { id: 'training', title: '训练', category: '训练', kind: 'sequence', start: '17:30', end: '18:00', tasks: [
      { id: 'training-task', title: '训练', start: '17:30', end: '18:00', actions: [] }
    ] }
  ] };
  assert.equal((await handler({ action: 'push', expectedVersion: 0, payload: emergency }, context)).code, 'INVALID_INSTANCES');
});
