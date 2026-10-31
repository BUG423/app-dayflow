const test = require('node:test');
const assert = require('node:assert/strict');
const {createRuntime, clone} = require('./helpers/miniprogram');
const block = (id,start='09:00',end='12:00',patch={}) => ({id,title:id,start,end,kind:'fixed',category:'工作',tasks:[],...patch});
const rule = (id,blocks,patch={}) => ({id,title:id,weekdays:[1,2,3,4,5],effectiveFrom:'2026-01-01',exceptions:[],blocks,...patch});
const plan = schedules => ({schemaVersion:1,id:'plan',name:'合成覆盖测试',version:1,updatedAt:0,schedules});
function engine(){const r=createRuntime();return {...r.load('miniprogram/utils/plan-overwrite.ts'),...r.load('miniprogram/utils/plan-validation.ts'),...r.load('miniprogram/utils/planning-availability.ts'),...r.load('miniprogram/utils/schedule-occurrences.ts'),...r.load('miniprogram/utils/calendar.js')};}
const plain = value => JSON.parse(JSON.stringify(value));
const ids = blocks => Array.from(blocks,x=>x.id).sort();
const frozen = value => {if(value&&typeof value==='object'){Object.values(value).forEach(frozen);Object.freeze(value);}return value;};

test('周日新增每天8至12一次覆盖全部工作日上午，下午和日期范围外保持',()=>{
  const e=engine(),input=plan([rule('weekdays',[block('morning'),block('afternoon','13:00','17:00')]),rule('sunday',[block('sun','09:00','11:00')],{weekdays:[0]})]);
  const draft=rule('new',[block('new-work','08:00','12:00')],{weekdays:[0,1,2,3,4,5,6],effectiveFrom:'2026-11-01'});
  const before=JSON.stringify({input,draft});frozen(input);frozen(draft);
  const preview=e.prepareScheduleOverwrite(input,draft,{notBefore:'2026-10-31'});
  assert.equal(JSON.stringify({input,draft}),before);assert.equal(e.validatePlan(preview.template).ok,true);
  assert.deepEqual(ids(e.resolveBlocks(preview.template,'2026-11-02')),['afternoon','new-work']);
  assert.deepEqual(ids(e.resolveBlocks(preview.template,'2026-11-01')),['new-work']);
  assert.deepEqual(ids(e.resolveBlocks(preview.template,'2026-10-30')),['afternoon','morning']);
  assert.deepEqual(ids(e.resolveBlocks(preview.template,'2026-11-07')),['new-work']);
  assert.equal(e.findScheduleConflicts(preview.template,draft,{notBefore:'2026-10-31'}).length,0);
  assert.equal(preview.removed.some(x=>x.blockId==='morning'&&x.weekdays.length===5&&x.start==='09:00'&&x.end==='12:00'),true);
  assert.deepEqual(plain(e.prepareScheduleOverwrite(input,draft,{notBefore:'2026-10-31'})),plain(preview));
});

test('覆盖仅限共同星期和生效交集，截止后恢复原块且其他旧规则不拆分',()=>{
  const e=engine(),old=rule('old',[block('a'),block('b','15:00','16:00')],{effectiveTo:'2027-01-31'}),other=rule('other',[block('early','06:00','07:00')]);
  const draft=rule('new',[block('new','10:00','11:00')],{weekdays:[1],effectiveFrom:'2026-11-09',effectiveTo:'2026-11-23'});
  const p=e.prepareScheduleOverwrite(plan([old,other]),draft);
  assert.equal(e.validatePlan(p.template).ok,true);assert.deepEqual(plain(p.template.schedules.find(s=>s.id==='other')),other);
  for(const date of ['2026-11-02','2026-11-10','2026-11-30'])assert.deepEqual(ids(e.resolveBlocks(p.template,date)),['a','b','early']);
  for(const date of ['2026-11-09','2026-11-16','2026-11-23'])assert.deepEqual(ids(e.resolveBlocks(p.template,date)),['b','early','new']);
  assert.deepEqual(ids(e.resolveBlocks(p.template,'2027-02-01')),['early']);
});

test('普通周与双方有限skip和replace精确组合，覆盖不误删被新计划跳过的日子',()=>{
  const e=engine(),old=rule('old',[block('a'),block('pm','14:00','15:00')],{exceptions:[{date:'2026-11-03',kind:'skip'},{date:'2026-11-04',kind:'replace',blocks:[block('special','11:00','13:00'),block('keep','16:00','17:00')]}]});
  const draft=rule('new',[block('new','10:00','11:30')],{weekdays:[1,2,3,4,5],effectiveFrom:'2026-11-01',exceptions:[{date:'2026-11-02',kind:'skip'},{date:'2026-11-05',kind:'replace',blocks:[block('late-new','14:30','15:30')]}]});
  const p=e.prepareScheduleOverwrite(plan([old]),draft);
  assert.equal(e.validatePlan(p.template).ok,true);
  assert.deepEqual(ids(e.resolveBlocks(p.template,'2026-11-02')),['a','pm']);
  assert.deepEqual(ids(e.resolveBlocks(p.template,'2026-11-03')),['new']);
  assert.deepEqual(ids(e.resolveBlocks(p.template,'2026-11-04')),['keep','new']);
  assert.deepEqual(ids(e.resolveBlocks(p.template,'2026-11-05')),['a','late-new']);
  assert.deepEqual(ids(e.resolveBlocks(p.template,'2026-11-06')),['new','pm']);
  assert.equal(p.removed.some(r=>r.date==='2026-11-04'&&r.blockId==='special'&&r.end==='13:00'),true);
  assert.equal(p.removed.some(r=>r.date==='2026-11-05'&&r.blockId==='pm'),true);
});

test('仅例外日期执行且无共同星期也能覆盖，未冲突的日期调整保持来源和可选字段',()=>{
  const e=engine(),complex=block('complex','10:00','11:00',{kind:'sequence',tasks:[{id:'task',title:'训练',start:'10:00',end:'11:00',origin:{date:'2026-10-01',targetId:'origin'},description:'原说明',actions:[{id:'action',title:'步骤',start:'10:00',end:'11:00',safety:'示例安全提示'}]}]});
  const old=rule('old',[],{weekdays:[],exceptions:[{date:'2026-11-07',kind:'replace',blocks:[complex]},{date:'2026-11-14',kind:'replace',blocks:[clone(complex)]}]});
  const draft=rule('new',[],{weekdays:[],effectiveFrom:'2026-11-07',effectiveTo:'2026-11-07',exceptions:[{date:'2026-11-07',kind:'replace',blocks:[block('new','10:30','10:45')]}]});
  const p=e.prepareScheduleOverwrite(plan([old]),draft);
  assert.equal(e.validatePlan(p.template).ok,true);
  assert.deepEqual(ids(e.resolveBlocks(p.template,'2026-11-07')),['new']);
  assert.deepEqual(plain(e.resolveBlocks(p.template,'2026-11-14')),[complex]);
  const removed=p.removed.find(x=>x.blockId==='complex');assert.equal(removed.start,'10:00');assert.equal(removed.end,'11:00');
});

test('排除已锁日期的唯一冲突不改旧规则，跳过首个锁日仍覆盖之后真正重复碰撞',()=>{
  const e=engine(),single=rule('single',[block('single')],{effectiveFrom:'2026-11-02',effectiveTo:'2026-11-02'}),draft=rule('new',[block('new','08:00','12:00')],{effectiveFrom:'2026-11-02'});
  const p=e.prepareScheduleOverwrite(plan([single]),draft,{excludedDates:['2026-11-02']});
  assert.deepEqual(plain(p.template.schedules.find(x=>x.id==='single')),single);assert.equal(p.removed.length,0);
  const repeated=rule('repeat',[block('a')],{weekdays:[1],effectiveFrom:'2026-11-02'});
  const next=e.prepareScheduleOverwrite(plan([repeated]),draft,{notBefore:'2026-11-02',excludedDates:['2026-11-02']});
  assert.deepEqual(ids(e.resolveBlocks(next.template,'2026-11-09')),['new']);assert.equal(next.removed.length,1);
});

test('编辑排除旧同id且不删除草稿内部兄弟冲突，保留无关存量重叠',()=>{
  const e=engine(),old=rule('edit',[block('self')]),a=rule('a',[block('a','18:00','19:00')]),b=rule('b',[block('b','18:30','19:30')]);
  const draft=clone(old);draft.blocks.push(block('sibling','10:00','11:00'));
  const p=e.prepareScheduleOverwrite(plan([old,a,b]),draft);
  assert.equal(p.removed.length,0);assert.equal(p.template.schedules.filter(x=>x.id==='edit').length,1);
  assert.equal(e.findScheduleConflicts(p.template,draft).some(c=>c.scheduleId==='edit'),true);
  assert.deepEqual(plain(p.template.schedules.find(x=>x.id==='a')),a);assert.deepEqual(plain(p.template.schedules.find(x=>x.id==='b')),b);
});

test('多月普通周期和有限例外的候选逐日等同精确删块语义，输入和target标识保持',()=>{
  const e=engine(),old=rule('old',[block('a'),block('pm','14:00','16:00')],{effectiveTo:'2027-05-31',exceptions:[{date:'2027-01-04',kind:'skip'},{date:'2027-02-06',kind:'replace',blocks:[block('extra','10:00','11:00')]}]});
  const draft=rule('new',[block('new','11:00','12:00')],{weekdays:[1,3,5],effectiveFrom:'2026-12-01',effectiveTo:'2027-04-30',exceptions:[{date:'2027-01-06',kind:'skip'},{date:'2027-02-06',kind:'replace',blocks:[block('special-new','10:30','11:30')]}]});
  const p=e.prepareScheduleOverwrite(plan([old]),draft,{notBefore:'2026-12-10'});
  assert.equal(e.validatePlan(p.template).ok,true);
  for(let date='2026-11-01';date<'2027-07-01';date=e.shiftDays(date,1)){
    const next=e.blocksOnDate(draft,date),prior=e.blocksOnDate(old,date);
    const expected=(date<'2026-12-10'?prior:prior.filter(a=>!next.some(b=>a.start<b.end&&b.start<a.end))).concat(next).sort((a,b)=>a.start.localeCompare(b.start));
    assert.deepEqual(plain(e.resolveBlocks(p.template,date)),plain(expected),date);
  }
});
