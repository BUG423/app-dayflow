const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntime, clone } = require('./helpers/miniprogram');
const block = (id, title, start, end, fixed = false) => ({ id, title, start, end, kind: fixed ? 'fixed' : 'parallel', category: '工作', tasks: fixed ? [] : [{ id: id+'-task', title, start, end, actions: [] }] });
const rule = (id, title, weekdays, blocks, extra = {}) => ({ id, title, weekdays, blocks, effectiveFrom: '2026-11-02', exceptions: [], ...extra });
function setup() {
  const runtime = createRuntime(), plans = runtime.load('miniprogram/services/plans.ts');
  const previous = rule('old', '工作安排', [1,2], [block('morning','上午工作','08:00','12:00'), block('afternoon','下午工作','14:00','18:00',true)]);
  plans.saveTemplate({ ...plans.getTemplate(), schedules: [previous] });
  const draft = rule('new','新课程',[1],[block('lesson','课程','09:00','10:00')]);
  return { runtime, plans, previous, draft };
}
const stored = runtime => clone([...runtime.storage]);
const titles = (runtime, plans, date) => Array.from(runtime.load('miniprogram/utils/plan-validation.ts').resolveBlocks(plans.getTemplate(), date), item => item.title);

test('替换预览零写且一次确认覆盖全部未来周一，只删冲突整块保留周二和下午', () => {
  const { runtime, plans, draft } = setup(), version = plans.getTemplate().version, before = stored(runtime);
  const preview = plans.previewScheduleOverwrite(draft, version);
  assert.equal(preview.ok, true); assert.ok(preview.lease); assert.ok(preview.removed.some(row => row.title === '上午工作'));
  assert.deepEqual(stored(runtime), before);
  assert.equal(plans.previewScheduleOverwrite(draft, version).lease, preview.lease);
  assert.equal(plans.getOverwriteScheduleConflicts(draft).length, 0);
  const saved = plans.saveScheduleOverwrite(draft, version, preview.lease);
  assert.equal(saved.version, version + 1);
  assert.deepEqual(titles(runtime, plans, '2026-11-02'), ['课程','下午工作']);
  assert.deepEqual(titles(runtime, plans, '2027-03-01'), ['课程','下午工作']);
  assert.deepEqual(titles(runtime, plans, '2026-11-03'), ['上午工作','下午工作']);
});

test('选择阶段许可外部占用分钟但保留草稿兄弟块，候选与最终服务一致', () => {
  const { plans, draft } = setup();
  draft.blocks.push(block('other','同组午间','12:00','13:00'));
  const selection = plans.getOverwriteSelectionAvailability(draft,'lesson');
  assert.ok(selection.allowedStarts.includes('08:00')); assert.ok(!selection.allowedStarts.includes('12:00'));
  const prepared = plans.getOverwriteScheduleAvailability(draft,'lesson');
  assert.equal(prepared.proposedValid,true); assert.equal(prepared.conflicts.length,0);
});

test('替换确认后内容、范围或模板版本变化使确认失效，零写保留草稿', () => {
  const { runtime, plans, draft } = setup(), version = plans.getTemplate().version;
  const preview = plans.previewScheduleOverwrite(draft,version), changed = clone(draft); changed.blocks[0].title = '改名';
  let before = stored(runtime);
  assert.throws(() => plans.saveScheduleOverwrite(changed,version,preview.lease), /重新确认/);
  assert.throws(() => plans.saveScheduleOverwrite(draft,version,''), /重新确认/);
  assert.deepEqual(stored(runtime),before);
  plans.saveTemplate(plans.getTemplate(), version); before = stored(runtime);
  assert.throws(() => plans.saveScheduleOverwrite(draft,version,preview.lease), /计划已更新/);
  assert.deepEqual(stored(runtime),before);
});

test('锁定和有记录的原日快照、执行记录保持原值，替换只影响可变未来', () => {
  const { runtime, plans, draft } = setup();
  const records = runtime.load('miniprogram/services/records.ts');
  records.setStatus('2026-11-02','morning-task','done');
  const snapshots = clone(runtime.storage.get('dayflow.instances.v1')), envelope = clone(runtime.storage.get('dayflow.records.v2'));
  const preview = plans.previewScheduleOverwrite(draft,plans.getTemplate().version); assert.equal(preview.ok,true);
  plans.saveScheduleOverwrite(draft,plans.getTemplate().version,preview.lease);
  assert.deepEqual(runtime.storage.get('dayflow.instances.v1'),snapshots);
  assert.deepEqual(runtime.storage.get('dayflow.records.v2'),envelope);
  assert.deepEqual(Array.from(plans.getDayBlocks('2026-11-02'), item=>item.title),['上午工作','下午工作']);
  assert.deepEqual(titles(runtime,plans,'2026-11-09'),['课程','下午工作']);
});

test('覆盖其他规则也保护未结束计时目标，明确拒绝而不遗留孤立计时', () => {
  const { runtime, plans, draft } = setup();
  const timer = runtime.load('miniprogram/services/timer.ts'); timer.startTimer('2026-11-02','morning-task',60);
  let before = stored(runtime), preview = plans.previewScheduleOverwrite(draft);
  assert.equal(preview.ok,false); assert.match(preview.errors.join(' '),/未结束的计时/); assert.deepEqual(stored(runtime),before);
  timer.pauseTimer(); before = stored(runtime); preview = plans.previewScheduleOverwrite(draft);
  assert.equal(preview.ok,false); assert.deepEqual(stored(runtime),before);
  timer.startTimer('2026-11-02','unrelated',60); assert.equal(plans.previewScheduleOverwrite(draft).ok,true);
});

test('替换提交写实例、版本或当前计划失败时恢复原存在性和值，不误报成功', () => {
  for (const failingKey of ['dayflow.instances.v1','dayflow.planVersions.v1','dayflow.plans.v1']) {
    const { runtime, plans, draft } = setup();
    plans.getDayBlocks('2026-11-09'); // unexecuted cache is invalidated by actual save
    runtime.storage.set('other.app','keep');
    const version = plans.getTemplate().version, preview = plans.previewScheduleOverwrite(draft,version); assert.equal(preview.ok,true);
    const before = stored(runtime), set = runtime.wx.setStorageSync; let failed=false;
    runtime.wx.setStorageSync=(key,value)=>{set(key,value);if(key===failingKey&&!failed){failed=true;throw new Error('full');}};
    assert.throws(()=>plans.saveScheduleOverwrite(draft,version,preview.lease),/未能保存/);
    assert.deepEqual(stored(runtime),before);
  }
});

test('精确替换展开超出模板容量时明确拒绝且不截断、不写入', () => {
  const runtime = createRuntime(), plans = runtime.load('miniprogram/services/plans.ts');
  const schedules = Array.from({length:100},(_,index)=>rule('old-'+index,'既有安排'+index,[1,2],
    [block('old-block-'+index,'旧事项'+index,'08:00','12:00',true)],{effectiveFrom:'2026-10-01'}));
  plans.saveTemplate({...plans.getTemplate(),schedules});
  const draft = rule('new','新安排',[1],[block('new-block','新事项','09:00','10:00')]);
  const before=stored(runtime),preview=plans.previewScheduleOverwrite(draft);
  assert.equal(preview.ok,false); assert.ok(preview.errors.length); assert.deepEqual(stored(runtime),before);
  assert.throws(()=>plans.saveScheduleOverwrite(draft,plans.getTemplate().version,preview.lease));
  assert.deepEqual(stored(runtime),before);
});
