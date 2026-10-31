const test = require('node:test');
const assert = require('node:assert/strict');
const { actionableIds, progress, blockProgress } = require('../miniprogram/utils/progress');

const blocks = [
  { id: 'work', kind: 'fixed', actions: [] },
  { id: 'music', kind: 'parallel', actions: [{ id: 'guitar' }, { id: 'vocal' }] },
  { id: 'training', kind: 'sequence', actions: [{ id: 'warmup' }, { id: 'main' }] }
];
test('仅可执行动作参与完成率', () => {
  assert.deepEqual(actionableIds(blocks), ['guitar', 'vocal', 'warmup', 'main']);
  assert.deepEqual(progress(blocks, { guitar: 'done', main: 'done' }), { completed: 2, total: 4, percent: 50 });
});
test('跳过和待办不能算完成', () => {
  assert.deepEqual(blockProgress(blocks[1], { guitar: 'skipped', vocal: 'todo' }), { completed: 0, total: 2, percent: 0 });
});
test('没有任务时不虚构完成率', () => {
  assert.deepEqual(progress([blocks[0]], {}), { completed: 0, total: 0, percent: 0 });
});
