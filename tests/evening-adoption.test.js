const test = require('node:test');
const assert = require('node:assert/strict');
const {createRuntime,clone}=require('./helpers/miniprogram');
const {shiftDays}=require('../miniprogram/utils/calendar');

function setup() {
  const runtime=createRuntime(),plans=runtime.load('miniprogram/services/plans');
  const template=JSON.parse(plans.exportDefaultTemplate(2));template.version=4;template.name='保存过的个人安排';
  for(const rule of template.schedules){
    const morning=rule.blocks.find(block=>block.id==='work-morning');morning.start='08:00';morning.end='12:00';
    // This old Tuesday overtime is wholly inside the new swimming-day free evening.
    if(rule.weekdays[0]===2){const overtime=rule.blocks.find(block=>block.id==='overtime');overtime.start='20:00';overtime.end='21:00';}
  }
  template.schedules.push({id:'private-reading',title:'自己的阅读',weekdays:[0,1,2,3,4,5,6],effectiveFrom:'2026-01-01',exceptions:[],
    blocks:[{id:'reading',title:'阅读',start:'12:40',end:'12:55',kind:'parallel',category:'兴趣',tasks:[{id:'reading-task',title:'阅读',start:'12:40',end:'12:55',actions:[],description:'自己的内容保留'}]}]});
  runtime.storage.set('dayflow.plans.v1',template);
  return {runtime,plans,template};
}
const snap=runtime=>clone([...runtime.storage]);

test('仅更新晨睡和晚间，保已改8至12白天与私人兴趣，泳日非重叠旧加班也移除',()=>{
  const {runtime,plans,template}=setup(),before=snap(runtime),preview=plans.previewEveningRoutineUpdate(4);
  assert.equal(preview.ok,true,preview.errors.join(';'));assert.equal(preview.routines.length,7);
  assert.deepEqual(snap(runtime),before);assert.deepEqual(clone(plans.previewEveningRoutineUpdate(4)),clone(preview));
  assert.ok(preview.removed.some(row=>row.title==='加班'&&row.start==='20:00'&&row.end==='21:00'&&row.weekdays.includes(2)));
  const saved=plans.saveEveningRoutineUpdate(4,preview.lease);
  assert.equal(saved.version,5);assert.equal(plans.getTemplateVersions().filter(item=>item.version===5).length,1);
  for(let day=0;day<7;day++){
    const date=shiftDays('2026-11-01',day),blocks=plans.getDayBlocks(date),swimming=[2,4,6].includes(day);
    const morning=blocks.find(block=>block.id==='work-morning');assert.deepEqual([morning.start,morning.end],['08:00','12:00']);
    const reading=blocks.find(block=>block.id==='reading');assert.equal(reading.actions[0].description,'自己的内容保留');
    const training=blocks.filter(block=>block.category==='训练');assert.equal(training.length,1);
    assert.deepEqual([training[0].start,training[0].end],swimming?['17:30','19:00']:['20:30','22:00']);
    assert.equal(blocks.filter(block=>block.category==='加班').length,swimming?0:1);
    assert.ok(blocks.some(block=>block.start==='00:00'&&block.end==='08:00'&&block.kind==='fixed'));
    assert.ok(blocks.some(block=>block.start==='23:00'&&block.end==='24:00'&&block.kind==='fixed'));
  }
  assert.deepEqual(clone(saved.schedules.find(rule=>rule.id==='private-reading')),template.schedules.find(rule=>rule.id==='private-reading'));
});

test('锁定今天和旧历史及记录保留，未来晚间更新，不回填新晨睡',()=>{
  const {runtime,plans}=setup();
  const record={date:'2026-10-30',targetId:'music-guitar',taskId:'music-guitar',status:'done',updatedAt:1,events:[]};
  runtime.storage.set('dayflow.records.v2',{schemaVersion:2,byDate:{[record.date]:{[record.targetId]:record}}});
  const history=clone(plans.lockDailyInstance('2026-10-30')),today=clone(plans.lockDailyInstance('2026-10-31'));
  const records=clone(runtime.storage.get('dayflow.records.v2')),preview=plans.previewEveningRoutineUpdate(4);
  assert.equal(preview.ok,true);assert.equal(preview.summary.keepsToday,true);
  plans.saveEveningRoutineUpdate(4,preview.lease);
  assert.deepEqual(clone(plans.getDailyInstance(today.date)),today);assert.deepEqual(clone(plans.getDailyInstance(history.date)),history);
  assert.deepEqual(runtime.storage.get('dayflow.records.v2'),records);
  assert.equal(plans.getDayBlocks('2026-11-02').find(block=>block.category==='训练').start,'20:30');
});

test('过时版本、替换范围和新计时变化拒绝保存并保留当前值',()=>{
  const {runtime,plans}=setup(),preview=plans.previewEveningRoutineUpdate(4);
  const current=clone(plans.getTemplate());current.version=5;runtime.storage.set('dayflow.plans.v1',current);
  let before=snap(runtime);assert.throws(()=>plans.saveEveningRoutineUpdate(4,preview.lease),/计划已更新/);assert.deepEqual(snap(runtime),before);
  const fresh=plans.previewEveningRoutineUpdate(5);
  plans.lockDailyInstance('2026-11-02');before=snap(runtime);
  assert.throws(()=>plans.saveEveningRoutineUpdate(5,fresh.lease),/范围已变化/);assert.deepEqual(snap(runtime),before);
  const other=setup();other.runtime.load('miniprogram/services/timer').startTimer('2026-11-03','d2-step-0',60);
  before=snap(other.runtime);const blocked=other.plans.previewEveningRoutineUpdate(4);
  assert.equal(blocked.ok,false);assert.match(blocked.errors.join(''),/未结束的计时/);assert.deepEqual(snap(other.runtime),before);
});

test('晚间更新各阶段写入后抛错也精确回滚三个key及存在性，不改记录',()=>{
  for(const failure of ['dayflow.instances.v1','dayflow.planVersions.v1','dayflow.plans.v1']){
    const {runtime,plans}=setup();plans.getDailyInstance('2026-11-02');
    const preview=plans.previewEveningRoutineUpdate(4),before=snap(runtime),write=runtime.wx.setStorageSync;
    let failed=false;runtime.wx.setStorageSync=(key,value)=>{write(key,value);if(key===failure&&!failed){failed=true;throw Error('quota');}};
    assert.throws(()=>plans.saveEveningRoutineUpdate(4,preview.lease),/原计划和记录已保留/);assert.equal(failed,true);
    assert.deepEqual(snap(runtime),before);
  }
});

test('晚间作息预览与取消零写，确认仅保存新版夜间，旧fullimport入口不误覆盖白天',()=>{
  const {runtime,plans}=setup(),page=runtime.page('plans');page.onShow();
  const before=snap(runtime);page.onPreviewEveningUpdate();
  assert.equal(page.data.eveningPreview,true);assert.equal(page.data.exampleRows.length,7);assert.equal(page.data.importPreview.ok,true);
  assert.ok(page.data.exampleRows.every(row=>row.blocks.every(block=>!['work-morning','music','work-afternoon'].includes(block.id))));
  assert.deepEqual(snap(runtime),before);page.onConfirmEveningUpdate();
  assert.equal(runtime.calls.modals.at(-1).title,'更新晚间作息？');runtime.calls.modals.at(-1).success({confirm:false});assert.deepEqual(snap(runtime),before);
  page.onConfirmImport();runtime.calls.modals.at(-1).success({confirm:true});
  assert.equal(page.data.eveningPreview,false);assert.equal(page.data.importVisible,false);assert.equal(plans.getTemplate().version,5);
  assert.equal(plans.getDayBlocks('2026-11-02').find(block=>block.id==='work-morning').start,'08:00');
  assert.equal(plans.getDayBlocks('2026-11-02').find(block=>block.id==='reading').actions[0].description,'自己的内容保留');
});

test('编辑中不覆盖草稿，晚间预览后的版本变化拒绝且保留预览',()=>{
  const {runtime,plans}=setup(),page=runtime.page('plans');page.onShow();page.onCreateSchedule();
  const draft=page.draftSchedule;page.onPreviewEveningUpdate();assert.equal(page.draftSchedule,draft);assert.equal(page.data.eveningPreview,false);
  page.draftSchedule=null;page.setData({editorVisible:false,draftResumeAvailable:false});page.onPreviewEveningUpdate();page.onConfirmEveningUpdate();
  const changed=clone(plans.getTemplate());changed.version=5;runtime.storage.set('dayflow.plans.v1',changed);const before=snap(runtime);
  runtime.calls.modals.at(-1).success({confirm:true});assert.deepEqual(snap(runtime),before);assert.equal(page.data.eveningPreview,true);assert.match(page.data.errorMessage,/计划已更新/);
});
