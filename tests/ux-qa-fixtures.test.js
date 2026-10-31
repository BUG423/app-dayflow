const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const {layoutPayload,seedLayout,installTouchProbe,readTouchProbe,restoreTouchProbe}=require('../scripts/ux-acceptance-fixtures');
const {createRuntime,clone}=require('./helpers/miniprogram');

test('窄屏验收合成夹具符合真实模型，长记录与固定加班不混入完成率',()=>{
  const runtime=createRuntime();
  const seed=vm.runInNewContext('('+seedLayout.toString()+')',{wx:runtime.wx,Date});
  seed(layoutPayload('2026-10-31',Date.now()));
  const plans=runtime.load('miniprogram/services/plans.ts');
  const records=runtime.load('miniprogram/utils/record-validation.ts');
  assert.equal(plans.previewImport(plans.exportTemplate()).ok,true);
  records.validateEnvelope(runtime.wx.getStorageSync('dayflow.records.v2'));
  plans.validateInstances(runtime.wx.getStorageSync('dayflow.instances.v1'));
  const blocks=plans.getDayBlocks('2026-10-31');
  assert.equal(blocks.find(x=>x.title==='加班').actions.length,0);
  const progress=runtime.load('miniprogram/utils/progress.js').progress(blocks,{'ux-task':'done'});
  assert.equal(progress.total,1);assert.equal(progress.completed,1);
  assert.ok(blocks[0].title.length>30);
});

test('布局夹具日期无效时零写入，其他应用key不被移除',()=>{
  const values={'other.app':{untouched:true},'dayflow.original':{keep:true}};
  const wx={getStorageInfoSync:()=>({keys:Object.keys(values)}),getStorageSync:k=>values[k],setStorageSync:(k,v)=>{values[k]=v;},removeStorageSync:k=>{delete values[k];}};
  const seed=vm.runInNewContext('('+seedLayout.toString()+')',{wx,Date});
  const before=clone(values);assert.throws(()=>seed(layoutPayload('2026-02-30',Date.now())));assert.deepEqual(values,before);
  assert.throws(()=>seed({date:'2026-10-31',values:{'other.app':{}}}));assert.deepEqual(values,before);
  seed(layoutPayload('2026-10-31',Date.now()));assert.deepEqual(values['other.app'],{untouched:true});
});

test('触摸诊断只记录真实回调并保持参数、时钟、原处理函数和临时状态',()=>{
  const calls=[];
  const page={data:{selectedDate:'2026-10-31'},calendarGesture:null,suppressDayTapUntil:0};
  const names=['onCalendarTouchStart','onCalendarTouchMove','onCalendarTouchEnd','onCalendarTouchCancel'];
  for(const name of names)page[name]=function(event){calls.push({name,event});this.calendarGesture={x:12,y:13,at:Date.now()};this.suppressDayTapUntil=123;return name;};
  const originals=names.map(name=>page[name]),clock=Date.now;
  const context=vm.createContext({getCurrentPages:()=>[page],Date});
  const install=vm.runInContext('('+installTouchProbe.toString()+')',context);
  const read=vm.runInContext('('+readTouchProbe.toString()+')',context);
  const restore=vm.runInContext('('+restoreTouchProbe.toString()+')',context);
  assert.equal(install().installed,true);assert.equal(read().logs.length,0);assert.equal(calls.length,0);
  const event={type:'touchstart',timeStamp:40,touches:[{identifier:1,clientX:12,clientY:13}]};
  assert.equal(page.onCalendarTouchStart(event),'onCalendarTouchStart');assert.equal(calls[0].event,event);assert.equal(Date.now,clock);
  assert.equal(read().logs.length,1);assert.equal(read().logs[0].eventTime,40);
  const result=restore();assert.equal(result.restored,true);assert.equal(page.calendarGesture,null);assert.equal(page.suppressDayTapUntil,0);
  assert.deepEqual(names.map(name=>page[name]),originals);assert.equal(Object.hasOwn(page,'__dayflowUxQaTouchProbe'),false);
});
