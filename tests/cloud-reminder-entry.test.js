const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const templates = { task: { id: 'fixture-template-task', titleField: 'thing1', timeField: 'time2' } };
const token = 'f'.repeat(64);
const privateName = 'dayflow_' + 'a'.repeat(32);
function createEntry(options = {}) {
  const sent = []; const docs = new Map(); let writes = 0; let chain = Promise.resolve(); let dbOptions;
  const db = {
    command: { lte: value => value },
    collection(name) {
      assert.equal(name, 'dayflow_reminder_jobs');
      return { where(condition) { return { orderBy() { return { limit() { return { async get() {
        return { data: [...docs].filter(([, doc]) => doc.nextDueAt <= condition.nextDueAt).map(([id, doc]) => ({ ...clone(doc), _id: id })) };
      } }; } }; } }; } };
    },
    runTransaction(callback) {
      const result = chain.then(async () => {
        const value = await callback({ collection() { return { doc(id) { return {
          async get() { return { data: options.arrayData ? (docs.has(id) ? [clone(docs.get(id))] : []) : clone(docs.get(id)) }; },
          async set({ data }) { docs.set(id, clone(data)); writes++; }
        }; } }; } });
        return options.wrapped ? { result: value } : value;
      });
      chain = result.catch(() => {}); return result;
    }
  };
  const sdk = { DYNAMIC_CURRENT_ENV: 'fixture-env', init() {}, database(value) { dbOptions = value; return db; },
    getWXContext: () => options.context || {}, openapi: { subscribeMessage: { async send(payload) { sent.push(payload); if (options.sendError) throw new Error('private-fixture-openid'); return { errCode: 0 }; } } } };
  const env = { DAYFLOW_REMINDER_TEMPLATES: JSON.stringify(templates), DAYFLOW_MESSAGE_STATE: 'developer', ...options.env };
  const directory = options.client ? 'dayflowReminders' : 'dayflowReminderTick';
  const file = path.resolve(__dirname, '../cloudfunctions', directory, 'index.js');
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module, exports: module.exports, process: { env }, Buffer,
    require(name) { if (name === 'wx-server-sdk') return sdk; if (name === 'node:crypto') return crypto; return require(path.resolve(path.dirname(file), name)); } });
  return { main: module.exports.main, docs, sent, get writes() { return writes; }, get dbOptions() { return dbOptions; } };
}
function seed(entry) {
  const owner = 'a'.repeat(64); const now = Date.now();
  entry.docs.set(owner, { owner, nextDueAt: now - 1000, jobs: [{ id: 'b'.repeat(64), owner, openid: 'private-fixture-openid', kind: 'task', targetId: 'training', targetDate: '2026-10-31', dateKey: '2026-10-31', time: '18:00', timezoneOffset: -480, title: '训练示例', dueAt: now - 1000, createdAt: now - 60000, updatedAt: now - 60000, status: 'pending', template: templates.task }] });
}
const enabled = { DAYFLOW_REMINDERS_READY: 'true', DAYFLOW_TIMER_READY: 'true', DAYFLOW_TIMER_AUTH_MODE: 'token', DAYFLOW_TIMER_TOKEN: token };
test('真实Timer入口默认、伪Timer、缺凭据、不匹配凭据均拒绝且不领取任务', async () => {
  for (const [env, event] of [[{}, { Type: 'Timer' }], [enabled, { Type: 'Timer' }], [enabled, { timerToken: 'a'.repeat(64) }], [{ ...enabled, DAYFLOW_TIMER_AUTH_MODE: '' }, { timerToken: token }]]) {
    const entry = createEntry({ env }); seed(entry);
    const result = await entry.main(event); assert.equal(result.ok, false); assert.equal(entry.writes, 0); assert.equal(entry.sent.length, 0);
    assert.doesNotMatch(JSON.stringify(result), /private-fixture|ffff/);
  }
});
test('可信token入口通过真实repository适配器领取并调用微信API，支持事务包装形状', async () => {
  for (const wrapped of [false, true]) for (const arrayData of [false, true]) {
    const entry = createEntry({ env: enabled, wrapped, arrayData }); seed(entry);
    assert.equal(entry.dbOptions.throwOnNotFound, false);
    const result = await entry.main({ timerToken: token }); assert.equal(result.ok, true); assert.equal(entry.sent.length, 1);
    const message = entry.sent[0]; assert.equal(message.touser, 'private-fixture-openid'); assert.equal(message.templateId, templates.task.id);
    assert.equal(message.miniprogramState, 'developer'); assert.equal(message.page, 'pages/today/index');
    assert.equal(message.data.thing1.value, '训练示例'); assert.equal(message.data.time2.value, '2026-10-31 18:00');
    assert.equal([...entry.docs.values()][0].jobs[0].status, 'sent');
    await entry.main({ Message: JSON.stringify({ timerToken: token }) }); assert.equal(entry.sent.length, 1);
  }
});
test('IDE私有触发器入口必须联合匹配服务端SOURCE、随机名字及无客户端身份', async () => {
  const env = { ...enabled, DAYFLOW_TIMER_AUTH_MODE: 'private-trigger', DAYFLOW_TIMER_TRIGGER_NAME: privateName, DAYFLOW_TIMER_SOURCE: 'fixture-verified-timer-source' };
  for (const [context, event, allowed] of [
    [{ SOURCE: env.DAYFLOW_TIMER_SOURCE }, { Type: 'Timer', TriggerName: privateName }, true],
    [{ SOURCE: 'client' }, { Type: 'Timer', TriggerName: privateName }, false],
    [{ SOURCE: env.DAYFLOW_TIMER_SOURCE, OPENID: 'client-user' }, { Type: 'Timer', TriggerName: privateName }, false],
    [{ SOURCE: env.DAYFLOW_TIMER_SOURCE }, { Type: 'Timer', TriggerName: 'public-name' }, false],
    [{}, { Type: 'Timer', TriggerName: privateName, SOURCE: env.DAYFLOW_TIMER_SOURCE }, false]
  ]) {
    const entry = createEntry({ env, context }); seed(entry);
    assert.equal((await entry.main(event)).ok, allowed); assert.equal(entry.sent.length, allowed ? 1 : 0);
  }
});
test('供应商异常不泄露身份，任务留未知且不自动重发', async () => {
  const entry = createEntry({ env: enabled, sendError: true }); seed(entry);
  const result = await entry.main({ timerToken: token }); assert.equal(result.ok, true);
  assert.equal([...entry.docs.values()][0].jobs[0].status, 'unknown');
  await entry.main({ timerToken: token }); assert.equal(entry.sent.length, 1);
});
test('客户端能力只有完整后台守卫就绪才可用，源码打包产物不允许漂移', async () => {
  for (const [env, available] of [[{}, false], [{ DAYFLOW_REMINDERS_READY: 'true' }, false], [enabled, true]]) {
    const entry = createEntry({ client: true, env, context: { OPENID: 'user', APPID: 'app' } });
    assert.equal((await entry.main({ action: 'capability', kind: 'task' })).available, available);
  }
  const contents = require('../cloudfunctions/dayflowReminders/build-tick').buildContents();
  for (const [name, source] of Object.entries(contents)) assert.equal(fs.readFileSync(path.resolve(__dirname, '../cloudfunctions/dayflowReminderTick/shared', name), 'utf8'), source, 'Run node cloudfunctions/dayflowReminders/build-tick.js');
  const rules = require('../cloudfunctions/functions.rules.json'); assert.equal(rules.dayflowReminderTick.invoke, false);
});
