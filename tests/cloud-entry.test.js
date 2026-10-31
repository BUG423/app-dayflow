const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { createHandler } = require('../cloudfunctions/dayflowSync/handler');

function makeEntry({ wrapped = false, arrayData = false, fail = false, failIdentity = false } = {}) {
  const documents = new Map(); let revision = 0; let commits = 0; let databaseOptions;
  const sdk = {
    DYNAMIC_CURRENT_ENV: 'dynamic-fixture', init() {},
    getWXContext() { if (failIdentity) throw new Error('private-fixture-identity'); return { OPENID: 'fixture-user', APPID: 'fixture-app' }; },
    database(options) {
      databaseOptions = options;
      return { async runTransaction(callback) {
        for (let attempt = 0; attempt < 3; attempt++) {
          if (fail) throw new Error('private-fixture-record-and-identity');
          const originalRevision = revision;
          const pending = new Map();
          const value = await callback({ collection(name) {
            assert.equal(name, 'dayflow_private_state');
            return { doc(id) { return {
              async get() {
                const item = documents.get(id);
                if (!item && databaseOptions.throwOnNotFound !== false) throw new Error('document missing');
                return { data: arrayData ? (item ? [item] : []) : item };
              },
              async set({ data }) { pending.set(id, data); }
            }; } };
          } });
          // Match SDK transaction retry semantics: discard stale writes, reread.
          await Promise.resolve();
          if (pending.size && originalRevision !== revision) continue;
          for (const [id, data] of pending) documents.set(id, data);
          if (pending.size) { revision++; commits++; }
          return wrapped ? { result: value, errMsg: 'runTransaction:ok' } : value;
        }
        throw new Error('private-fixture-transaction-conflict');
      } };
    }
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../cloudfunctions/dayflowSync/index.js'), 'utf8'), {
    module, exports: module.exports, process: { env: { TCB_ENV: 'fixture-env' } },
    require(name) { if (name === 'wx-server-sdk') return sdk; if (name === './handler') return { createHandler }; throw new Error('Unexpected module'); }
  });
  return { main: module.exports.main, documents, get options() { return databaseOptions; }, get commits() { return commits; } };
}
function payload() {
  return { schemaVersion: 1,
    plans: { schemaVersion: 1, id: 'plan', name: '计划', version: 1, updatedAt: 0, schedules: [] }, planVersions: [], instances: {}, records: { schemaVersion: 2, byDate: {} },
    preferences: { sleepReminderEnabled: false, sleepTime: '23:00', taskReminderEnabled: false, leadMinutes: 10, subscriptionTemplateIds: [], trainingPhase: '基础', phaseRules: [{ id: 'basic', name: '基础', minSessions: 0, description: '' }] }, media: [] };
}
test('SDK入口首写缺文档、数据库选项与两种事务返回shape均正确适配', async () => {
  for (const wrapped of [false, true]) for (const arrayData of [false, true]) {
    const entry = makeEntry({ wrapped, arrayData });
    assert.equal(entry.options.throwOnNotFound, false);
    const result = await entry.main({ action: 'push', expectedVersion: 0, payload: payload() });
    assert.equal(result.ok, true); assert.equal(result.version, 1);
    assert.equal(entry.documents.size, 1);
  }
});
test('SDK入口并发事务重新读取后返回版本冲突，不覆盖已提交内容', async () => {
  const entry = makeEntry({ wrapped: true });
  const result = await Promise.all([1, 2].map(() => entry.main({ action: 'push', expectedVersion: 0, payload: payload() })));
  assert.equal(entry.commits, 1);
  assert.equal(result.filter(value => value.conflict).length, 1);
});
test('SDK及身份入口异常只返回通用码，不泄露用户事件或身份', async () => {
  for (const options of [{ fail: true }, { failIdentity: true }]) {
    const entry = makeEntry(options);
    const result = await entry.main({ action: 'push', expectedVersion: 0, payload: payload(), note: 'private-user-note' });
    assert.equal(result.ok, false); assert.equal(result.code, 'SYNC_UNAVAILABLE');
    assert.doesNotMatch(JSON.stringify(result), /private|fixture-user/);
  }
});
