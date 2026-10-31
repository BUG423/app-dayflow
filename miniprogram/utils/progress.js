/** Fixed blocks are informational and must not be included in completion rate. */
function actionableIds(blocks) {
  return blocks.filter(block => block.kind !== 'fixed')
    .flatMap(block => (block.actions || []).map(action => action.id));
}
function progress(blocks, records) {
  const ids = actionableIds(blocks);
  const completed = ids.filter(id => records[id] === 'done').length;
  return { completed, total: ids.length, percent: ids.length ? Math.round(completed * 100 / ids.length) : 0 };
}
function blockProgress(block, records) {
  return progress([block], records);
}
module.exports = { actionableIds, progress, blockProgress };
