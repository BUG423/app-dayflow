const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntime, clone } = require('./helpers/miniprogram');
const { shiftDays, minutesOf, endMinutesOf } = require('../miniprogram/utils/calendar');

test('新示例二四六直接游泳，其余先加班回家，90分钟运动与一小时睡前准备互不重叠', () => {
  const runtime = createRuntime(), { getBlocksForDate } = runtime.load('miniprogram/data/template.ts');
  const progress = runtime.load('miniprogram/utils/progress');
  for (let day = 0; day < 7; day++) {
    const date = shiftDays('2026-11-01', day), blocks = clone(getBlocksForDate(date));
    const training = blocks.find(b => b.id === 'training'), overtime = blocks.find(b => b.id === 'overtime');
    const swimming = [2,4,6].includes(day);
    assert.equal(training.start, swimming ? '17:30' : '20:30');
    assert.equal(training.end, swimming ? '19:00' : '22:00');
    assert.equal(endMinutesOf(training.end) - minutesOf(training.start), 90);
    if (swimming) {
      assert.equal(overtime, undefined);
      assert.equal(blocks.find(b => b.id === 'swim-commute').start, '17:00');
      assert.equal(blocks.find(b => b.id === 'swim-commute').end, training.start);
    } else {
      assert.deepEqual([overtime.start,overtime.end], ['17:00','20:00']);
      assert.deepEqual([blocks.find(b => b.id === 'commute-home').start,blocks.find(b => b.id === 'commute-home').end], ['20:00','20:30']);
    }
    assert.deepEqual([blocks.find(b => b.id === 'wind-down').start,blocks.find(b => b.id === 'wind-down').end], ['22:00','23:00']);
    let last = 0;
    for (const block of blocks) { assert.ok(minutesOf(block.start) >= last); last = endMinutesOf(block.end); }
    assert.equal(last, 1440);
    assert.equal(progress.progress(blocks, {}).total, training.actions.length + 2);
  }
});

test('23点至次日08点以两个完整固定区间精确覆盖，最后一分钟不遗漏且不计入完成率', () => {
  const runtime = createRuntime(), { getBlocksForDate } = runtime.load('miniprogram/data/template.ts');
  const { getBlockAvailability } = runtime.load('miniprogram/utils/planning-availability');
  const plans = runtime.load('miniprogram/services/plans'), template = plans.getTemplate();
  for (const date of ['2026-12-31', '2027-01-01']) {
    const blocks = clone(getBlocksForDate(date)), sleeps = blocks.filter(b => b.id.startsWith('sleep'));
    assert.deepEqual(sleeps.map(b => [b.start,b.end]), [['00:00','08:00'],['23:00','24:00']]);
    assert.equal(sleeps.reduce((sum,b) => sum + endMinutesOf(b.end) - minutesOf(b.start),0), 9*60);
    assert.ok(sleeps.every(b => b.kind === 'fixed' && !b.actions.length));
  }
  const draft = { id:'late',title:'边界测试',weekdays:[6],effectiveFrom:'2026-10-31',effectiveTo:'2026-10-31',exceptions:[],
    blocks:[{id:'late-block',title:'深夜事项',start:'23:59',end:'24:00',kind:'fixed',category:'生活',tasks:[]}] };
  const availability = getBlockAvailability(template,draft,'late-block',{date:'2026-10-31'});
  assert.equal(availability.proposedValid,false);
  assert.equal(availability.allowedStarts.includes('23:59'),false);
});

test('90分钟预留保留全部旧动作剂量和时长，仅平移并增自主准备休息记录', () => {
  const runtime = createRuntime(), {getBlocksForDate} = runtime.load('miniprogram/data/template');
  const {getLegacyBlocksForDate} = runtime.load('miniprogram/data/legacy-template');
  for (let day=0; day<7; day++) {
    const date=shiftDays('2026-11-01',day), old=getLegacyBlocksForDate(date,1).find(b=>b.id==='training');
    const current=getBlocksForDate(date).find(b=>b.id==='training');
    assert.equal(current.actions.length,old.actions.length+2);
    for (const action of old.actions) {
      const next=current.actions.find(a=>a.id===action.id);
      assert.deepEqual([next.title,next.dosage,next.description,next.searchKeyword,next.equipment,next.safety],
        [action.title,action.dosage,action.description,action.searchKeyword,action.equipment,action.safety]);
      assert.equal(endMinutesOf(next.end)-minutesOf(next.start),endMinutesOf(action.end)-minutesOf(action.start));
    }
    assert.equal(current.actions[0].id,'d'+day+'-prepare');
    assert.equal(current.actions.at(-1).id,'d'+day+'-record');
  }
});

test('v1和v2旧快照与无快照旧记录不会被新示例改写，未执行v2缓存才更新', () => {
  const runtime=createRuntime(),plans=runtime.load('miniprogram/services/plans');
  const snapshot=(version,date,locked)=>{
    const old=JSON.parse(plans.exportDefaultTemplate(version)), weekday=new Date(date+'T12:00:00').getDay();
    return {date,templateId:old.id,templateVersion:version,blocks:old.schedules.find(s=>s.weekdays.includes(weekday)).blocks,locked,mode:'standard',createdAt:1};
  };
  const v1=snapshot(1,'2026-10-30',true),v2=snapshot(2,'2026-11-02',true),cache=snapshot(2,'2026-11-03',false);
  runtime.storage.set('dayflow.instances.v1',{[v1.date]:v1,[v2.date]:v2,[cache.date]:cache});
  runtime.storage.set('dayflow.records.v1',{'2026-11-04':{'d3-step-0':'done'}});
  assert.deepEqual(clone(plans.getDailyInstance(v1.date)),v1);
  assert.deepEqual(clone(plans.getDailyInstance(v2.date)),v2);
  const missing=plans.getDailyInstance('2026-11-04');
  assert.equal(missing.templateVersion,1);assert.equal(missing.locked,true);
  assert.equal(missing.blocks.find(b=>b.id==='training').start,'17:30');
  assert.equal(missing.blocks.some(b=>b.id==='sleep-morning'),false);
  const updated=plans.getDailyInstance(cache.date);assert.equal(updated.templateVersion,3);
  assert.equal(updated.blocks.find(b=>b.id==='training').end,'19:00');
  assert.equal(updated.blocks.some(b=>b.id==='overtime'),false);
  const migrated=runtime.load('miniprogram/services/records').recordDetailsForDate('2026-11-04')['d3-step-0'];
  assert.equal(migrated.actionId,'d3-step-0');assert.equal(migrated.taskId,'training-task');
});

test('自定义计划只读保留，v3示例预览零写，显式采用后历史仍使用旧快照', () => {
  const runtime=createRuntime(),plans=runtime.load('miniprogram/services/plans');
  const custom=JSON.parse(plans.exportDefaultTemplate(2));custom.name='用户保存的安排';
  runtime.storage.set('dayflow.plans.v1',custom);
  runtime.storage.set('dayflow.records.v1',{'2026-10-30':{'d5-step-0':'done'}});
  const before=clone([...runtime.storage]);
  assert.deepEqual(clone(plans.getTemplate()),custom);
  const preview=plans.previewImport(plans.exportDefaultTemplate());
  assert.equal(preview.ok,true);assert.equal(preview.template.version,3);
  assert.deepEqual(clone([...runtime.storage]),before);
  plans.importTemplate(plans.exportDefaultTemplate(),2);
  const history=plans.getDailyInstance('2026-10-30');
  assert.equal(history.templateVersion,2);assert.equal(history.blocks.find(b=>b.id==='training').start,'17:30');
  assert.equal(plans.getDayBlocks('2026-11-01').find(b=>b.id==='training').start,'20:30');
});

test('旧加班日十五分钟简化与新加班冲突时保留原方案，主动恢复标准才切到新版', () => {
  const runtime=createRuntime(),plans=runtime.load('miniprogram/services/plans');
  runtime.storage.set('dayflow.plans.v1',JSON.parse(plans.exportDefaultTemplate(2)));
  const original=clone(plans.setEmergencyPlan('2026-11-02',true));
  assert.equal(original.blocks.find(b=>b.id==='training').start,'17:30');
  runtime.storage.delete('dayflow.plans.v1');
  const before=clone([...runtime.storage]),write=runtime.wx.setStorageSync;
  runtime.wx.setStorageSync=()=>{throw new Error('Retained simplification must be read-only');};
  assert.deepEqual(clone(plans.getDailyInstance('2026-11-02')),original);
  assert.deepEqual(clone([...runtime.storage]),before);
  runtime.wx.setStorageSync=write;
  const standard=plans.setEmergencyPlan('2026-11-02',false);
  assert.equal(standard.templateVersion,3);assert.equal(standard.mode,'standard');
  assert.deepEqual([standard.blocks.find(b=>b.id==='training').start,standard.blocks.find(b=>b.id==='training').end],['20:30','22:00']);
  assert.deepEqual([standard.blocks.find(b=>b.id==='overtime').start,standard.blocks.find(b=>b.id==='overtime').end],['17:00','20:00']);
});
