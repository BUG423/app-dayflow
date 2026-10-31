const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntime, clone } = require('./helpers/miniprogram');

const block = (id, title, start, end, kind='fixed') => ({id,title,start,end,kind,category:'工作',tasks:kind==='fixed'?[]:[{id:id+'-task',title,start,end,actions:[]}]});
const schedule = (id, blocks, patch={}) => ({id,title:id==='work'?'工作安排':id,weekdays:[1],effectiveFrom:'2026-11-02',exceptions:[],blocks,...patch});
const plan = schedules => ({schemaVersion:1,id:'plan',name:'合成测试计划',version:1,updatedAt:0,schedules});
function engine() { const runtime=createRuntime(); return {...runtime.load('miniprogram/utils/planning-availability.ts'), ...runtime.load('miniprogram/utils/schedule-occurrences.ts'),calendar:runtime.load('miniprogram/utils/calendar.js')}; }
const plain = value => JSON.parse(JSON.stringify(value));

test('选择器只提供真实可用分钟，工作结束12点可选且结束不能跨过下午占用',()=>{
  const e=engine();
  const existing=plan([schedule('work',[block('morning','工作','08:00','12:00'),block('afternoon','下午工作','14:00','18:00')])]);
  const draft=schedule('new',[block('new-block','练习','09:00','09:30')]);
  const result=e.getBlockAvailability(existing,draft,'new-block');
  assert.deepEqual(plain(result.freeWindows),[{start:'00:00',end:'08:00'},{start:'12:00',end:'14:00'},{start:'18:00',end:'23:59'}]);
  assert.equal(result.allowedStarts.includes('08:00'),false);
  assert.equal(result.allowedStarts.includes('11:59'),false);
  assert.equal(result.allowedStarts.includes('12:00'),true);
  assert.equal(result.allowedStarts.includes('07:59'),true);
  assert.equal(result.allowedStarts.includes('23:59'),false);
  assert.equal(result.suggestedStart,'12:00');assert.equal(result.suggestedEnd,'12:30');
  const ends=e.allowedEnds(result,'12:00');
  assert.equal(ends[0],'12:01');assert.equal(ends.at(-1),'14:00');assert.equal(ends.includes('14:01'),false);
  assert.deepEqual(plain(e.allowedEnds(result,'13:59')),['14:00']);
  assert.deepEqual(plain(e.allowedEnds(result,'08:00')),[]);
  assert.match(result.conflicts[0].message,/2026-11-02/);assert.match(result.conflicts[0].message,/工作安排/);assert.match(result.conflicts[0].message,/08:00–12:00/);
});

test('半开区间衔接与分钟边界有效，内部并行任务不互相禁止',()=>{
  const e=engine(),existing=plan([schedule('work',[block('m','工作','08:00','12:00'),block('a','下午工作','14:00','18:00')])]);
  const draft=schedule('new',[block('new-block','并行练习','12:00','14:00','parallel')]);
  draft.blocks[0].tasks.push({...draft.blocks[0].tasks[0],id:'second-task',title:'第二项'});
  assert.equal(e.getBlockAvailability(existing,draft,'new-block').proposedValid,true);
  assert.equal(e.findScheduleConflicts(existing,draft).length,0);
  draft.blocks[0].end='14:01';
  assert.equal(e.getBlockAvailability(existing,draft,'new-block').proposedValid,false);
  assert.match(e.findScheduleConflicts(existing,draft)[0].message,/下午工作/);
  const late=e.getBlockAvailability(plan([]),schedule('late',[block('b','晚间','23:58','23:59')]),'b');
  assert.deepEqual(plain(e.allowedEndMinutes(late,'23:58')),[1439]);
  assert.deepEqual(plain(e.allowedEndMinutes(late,'23:59')),[]);
});

test('编辑只排除原规则并保留当前草稿兄弟块，分析不改动或重新排序输入',()=>{
  const e=engine();
  const original=schedule('edit',[block('selected','原安排','08:00','12:00'),block('sibling','下午工作','14:00','18:00')]);
  const existing=plan([original]);const draft=clone(original);draft.blocks[0].start='11:00';draft.blocks[0].end='12:00';
  const before=JSON.stringify({existing,draft});
  const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}};
  freeze(existing);freeze(draft);
  const result=e.getBlockAvailability(existing,draft,'selected');
  assert.equal(result.proposedValid,true);assert.equal(result.allowedStarts.includes('08:00'),true);
  assert.equal(result.allowedStarts.includes('14:00'),false);
  assert.equal(result.busy.some(item=>item.blockId==='selected'),false);
  assert.equal(result.busy.some(item=>item.blockId==='sibling'),true);
  assert.equal(JSON.stringify({existing,draft}),before);
});

test('现存重叠计划仍可分析，编辑其他空档不被无关旧冲突阻挡',()=>{
  const e=engine(),existing=plan([schedule('work',[block('a','工作','08:00','12:00')]),schedule('old',[block('b','旧安排','10:00','11:00')])]);
  assert.equal(e.findPlanConflicts(existing).length,1);
  const draft=schedule('new',[block('c','新安排','06:00','07:00')]);
  assert.equal(e.findScheduleConflicts(existing,draft).length,0);
  assert.equal(e.getBlockAvailability(existing,draft,'c').proposedValid,true);
});

test('重复计划检测几个月后才生效的冲突，不以当前七天预览代替完整周期',()=>{
  const e=engine();
  const existing=plan([schedule('work',[block('m','未来工作','08:00','12:00')],{effectiveFrom:'2027-03-01'})]);
  const draft=schedule('new',[block('new-block','长期练习','09:00','10:00')]);
  const conflicts=e.findScheduleConflicts(existing,draft);
  assert.equal(conflicts.length,1);assert.equal(conflicts[0].date,'2027-03-01');
  const result=e.getBlockAvailability(existing,draft,'new-block');
  assert.equal(result.allowedStarts.includes('09:00'),false);assert.match(result.message,/未来工作/);
  existing.schedules[0].effectiveTo='2026-10-31';existing.schedules[0].effectiveFrom='2026-01-01';
  assert.equal(e.findScheduleConflicts(existing,draft).length,0);
});

test('跨过大量跳过例外仍找到第一个普通重复日，代表日期不是固定周数上限',()=>{
  const e=engine(),start='2026-11-02';
  const skipped=Array.from({length:100},(_,i)=>({date:e.calendar.shiftDays(start,i*7),kind:'skip'}));
  const work=schedule('work',[block('m','工作','08:00','12:00')],{exceptions:skipped});
  const draft=schedule('new',[block('b','练习','09:00','10:00')]);
  const conflict=e.findScheduleConflicts(plan([work]),draft)[0];
  assert.equal(conflict.date,e.calendar.shiftDays(start,700));
  assert.equal(e.getBlockAvailability(plan([work]),draft,'b').allowedStarts.includes('09:00'),false);
});

test('无共同星期的单次替换例外仍参与完整周期占用分析',()=>{
  const e=engine();
  const external=schedule('work',[],{weekdays:[],effectiveFrom:'2027-07-14',effectiveTo:'2027-07-14',exceptions:[{date:'2027-07-14',kind:'replace',blocks:[block('special','临时工作','11:00','13:00')]}]});
  const draft=schedule('new',[block('b','每天练习','12:00','12:30')],{weekdays:[0,1,2,3,4,5,6],effectiveTo:'2027-12-31'});
  const conflicts=e.findScheduleConflicts(plan([external]),draft);
  assert.equal(conflicts.length,1);assert.equal(conflicts[0].date,'2027-07-14');
  assert.equal(e.getBlockAvailability(plan([external]),draft,'b').allowedStarts.includes('12:00'),false);
});

test('草稿跳过当天便不占用，替换日期与普通周计划时间分别分析',()=>{
  const e=engine(),external=schedule('work',[block('m','一次工作','11:00','13:00')],{effectiveTo:'2026-11-02'});
  const draft=schedule('new',[block('b','普通练习','11:30','12:30')],{exceptions:[{date:'2026-11-02',kind:'skip'}]});
  assert.equal(e.findScheduleConflicts(plan([external]),draft).length,0);
  assert.equal(e.getBlockAvailability(plan([external]),draft,'b').allowedStarts.includes('11:30'),true);
  draft.exceptions=[{date:'2026-11-02',kind:'replace',blocks:[block('b','当日练习','20:00','21:00')]}];
  assert.equal(e.findScheduleConflicts(plan([external]),draft).length,0);
  const regular=e.getBlockAvailability(plan([external]),draft,'b');
  assert.equal(regular.scopeDates.includes('2026-11-02'),false);assert.equal(regular.allowedStarts.includes('11:30'),true);
  const special=e.getBlockAvailability(plan([external]),draft,'b',{exceptionDate:'2026-11-02'});
  assert.deepEqual(plain(special.scopeDates),['2026-11-02']);assert.equal(special.scope,'exception');
  assert.equal(special.allowedStarts.includes('11:30'),false);assert.equal(special.proposedValid,true);
  draft.exceptions[0].blocks[0].start='11:30';draft.exceptions[0].blocks[0].end='12:30';
  assert.equal(e.findScheduleConflicts(plan([external]),draft)[0].date,'2026-11-02');
});

test('全天无空档时选择器为空且明确解释，不伪造可选开始或建议',()=>{
  const e=engine();
  const result=e.getBlockAvailability(plan([schedule('work',[block('busy','全天占用','00:00','23:59')])]),schedule('new',[block('b','练习','08:00','09:00')]),'b');
  assert.deepEqual(plain(result.freeWindows),[]);assert.deepEqual(plain(result.allowedStarts),[]);
  assert.equal(result.suggestedStart,'');assert.equal(result.proposedValid,false);assert.match(result.message,/没有可用空档/);
});

test('未来编辑可明确排除历史范围，未来例外依然保留，锚点不隐式截断周期',()=>{
  const e=engine();
  const draft=schedule('new',[block('b','每天练习','09:00','10:00')],{effectiveFrom:'2026-01-01',weekdays:[0,1,2,3,4,5,6]});
  const old=schedule('work',[block('m','历史工作','08:00','12:00')],{effectiveFrom:'2026-10-31',effectiveTo:'2026-10-31',weekdays:[6]});
  assert.equal(e.findScheduleConflicts(plan([old]),draft).length,1);
  assert.equal(e.findScheduleConflicts(plan([old]),draft,{notBefore:'2026-11-01'}).length,0);
  assert.equal(e.getBlockAvailability(plan([old]),draft,'b',{notBefore:'2026-11-01'}).allowedStarts.includes('09:00'),true);
  assert.equal(e.getBlockAvailability(plan([old]),draft,'b',{date:'2026-11-01'}).allowedStarts.includes('09:00'),false);
});

test('跨月跨年代表日期按当地日历计算，过期或不执行的范围不给假定空档',()=>{
  const e=engine();
  const existing=plan([schedule('work',[block('m','跨年工作','08:00','12:00')],{effectiveFrom:'2027-01-01',weekdays:[5]})]);
  const draft=schedule('new',[block('b','跨年安排','09:00','10:00')],{effectiveFrom:'2026-12-31',weekdays:[5]});
  assert.equal(e.findScheduleConflicts(existing,draft)[0].date,'2027-01-01');
  draft.effectiveTo='2026-12-31';
  const result=e.getBlockAvailability(existing,draft,'b');
  assert.equal(result.scope,'none');assert.deepEqual(plain(result.allowedStarts),[]);assert.match(result.message,/没有这一项安排/);
  assert.deepEqual(plain(e.representativeDates(existing.schedules,'2027-01-02')),['2027-01-08']);
});

test('锁定日保留原实例，仅该日的一次性冲突不会阻挡未来模板修改',()=>{
  const e=engine();
  const original=schedule('edit',[block('a','每周安排','08:00','09:00')]);
  const once=schedule('work',[block('once','当天已锁定安排','10:00','11:00')],{effectiveTo:'2026-11-02'});
  const existing=plan([original,once]),draft=clone(original);
  draft.blocks[0].start='10:00';draft.blocks[0].end='11:00';
  const options={notBefore:'2026-10-31',excludedDates:['2026-11-02']};
  assert.equal(e.findScheduleConflicts(existing,draft).length,1);
  assert.equal(e.findScheduleConflicts(existing,draft,options).length,0);
  assert.equal(e.findPlanConflicts(plan([draft,once]),options).length,0);
  const result=e.getBlockAvailability(existing,draft,'a',{...options,date:'2026-11-02'});
  assert.equal(result.proposedValid,true);assert.equal(result.allowedStarts.includes('10:00'),true);
  assert.equal(result.scopeDates.includes('2026-11-02'),false);
  assert.equal(result.scopeDates.includes('2026-11-09'),true);
});

test('首个普通周期已锁定仍找到下一可变周期的真实冲突，不在事后仅过滤首日',()=>{
  const e=engine();
  const existing=plan([schedule('work',[block('m','周期工作','08:00','12:00')])]);
  const draft=schedule('new',[block('b','周期练习','09:00','10:00')]);
  const options={excludedDates:['2026-11-02','2026-11-09']};
  const conflict=e.findScheduleConflicts(existing,draft,options)[0];
  assert.equal(conflict.date,'2026-11-16');
  const result=e.getBlockAvailability(existing,draft,'b',options);
  assert.equal(result.proposedValid,false);assert.equal(result.allowedStarts.includes('09:00'),false);
  assert.equal(result.conflicts[0].date,'2026-11-16');
  assert.deepEqual(plain(e.representativeDates([existing.schedules[0],draft],undefined,options.excludedDates)),['2026-11-16']);
});

test('锁定例外日期不参与未来占用分析，未锁定的后续例外仍完整检查',()=>{
  const e=engine();
  const locked='2027-01-01',future='2027-07-14';
  const external=schedule('work',[],{weekdays:[],exceptions:[
    {date:locked,kind:'replace',blocks:[block('locked','旧锁定临时安排','08:00','12:00')]},
    {date:future,kind:'replace',blocks:[block('future','未来临时安排','10:00','13:00')]}
  ]});
  const draft=schedule('new',[block('b','每天练习','09:00','10:30')],{weekdays:[0,1,2,3,4,5,6]});
  const result=e.getBlockAvailability(plan([external]),draft,'b',{excludedDates:[locked],date:locked});
  assert.equal(result.scopeDates.includes(locked),false);
  assert.equal(result.busy.some(item=>item.title==='旧锁定临时安排'),false);
  assert.equal(result.allowedStarts.includes('08:00'),true);
  assert.equal(result.allowedStarts.includes('10:00'),false);
  assert.equal(result.conflicts[0].date,future);
  assert.equal(e.findScheduleConflicts(plan([external]),draft,{excludedDates:[locked]})[0].date,future);
  assert.throws(()=>e.findScheduleConflicts(plan([external]),draft,{excludedDates:['2026-02-30']}));
});
