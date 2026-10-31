// Synthetic acceptance data only. Call after backing up all Dayflow keys.
function layoutPayload(dateKey, at) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) throw new Error('Invalid fixture date');
  var parts = dateKey.split('-').map(Number), date = new Date(parts[0], parts[1] - 1, parts[2]);
  if (date.getFullYear() !== parts[0] || date.getMonth() !== parts[1] - 1 || date.getDate() !== parts[2]) throw new Error('Invalid fixture date');
  var title = '验收合成的较长中文行动名称：整理本周执行记录并检查下一周的工作安排';
  var fixed = { id:'ux-fixed', title:'加班', start:'18:30', end:'23:00', kind:'fixed', category:'工作', tasks:[] };
  var task = { id:'ux-task', title:title, start:'07:00', end:'07:30', actions:[] };
  var parallel = { id:'ux-parallel', title:title, start:'07:00', end:'07:30', kind:'parallel', category:'兴趣', tasks:[task] };
  if(typeof at!=='number'||!Number.isFinite(at)||at<60000)throw new Error('Invalid fixture timestamp');
  var blocks = [parallel, fixed];
  var template = { schemaVersion:1, id:'ux-layout-template', name:'合成布局验收计划', version:1, updatedAt:at,
    schedules:[{id:'ux-schedule',title:'布局验收安排',weekdays:[date.getDay()],effectiveFrom:dateKey,effectiveTo:dateKey,exceptions:[],blocks:blocks}] };
  var record = { date:dateKey,targetId:'ux-task',taskId:'ux-task',status:'done',actualStartedAt:at-60000,finishedAt:at,updatedAt:at,
    feedback:{note:'仅为布局验收生成的长文本，检查状态和实际时间在窄屏中换行，不包含个人执行数据。'},
    events:[{id:'ux-event',from:'todo',to:'done',at:at}] };
  var records={schemaVersion:2,byDate:{}};records.byDate[dateKey]={'ux-task':record};
  var instances={};instances[dateKey]={date:dateKey,templateId:template.id,templateVersion:1,blocks:blocks,locked:true,mode:'standard',createdAt:at};
  var values={};values['dayflow.plans.v1']=template;values['dayflow.records.v2']=records;values['dayflow.instances.v1']=instances;
  return {date:dateKey,values:values};
}
function seedLayout(payload) {
  if(!payload||!payload.values||typeof payload.date!=='string')throw new Error('Invalid layout fixture payload');
  var keys=Object.keys(payload.values);
  if(keys.length!==3||keys.some(function(key){return ['dayflow.plans.v1','dayflow.records.v2','dayflow.instances.v1'].indexOf(key)<0;}))throw new Error('Invalid layout fixture keys');
  wx.getStorageInfoSync().keys.filter(function(key){return key.indexOf('dayflow.')===0;}).forEach(function(key){wx.removeStorageSync(key);});
  keys.forEach(function(key){wx.setStorageSync(key,payload.values[key]);});
  return {dayflowSmoke:true,seeded:true,date:payload.date};
}
function installTouchProbe() {
  var p=getCurrentPages().slice(-1)[0],key='__dayflowUxQaTouchProbe';
  if(!p||p[key])throw new Error('Touch probe page is unavailable or already instrumented');
  var names=['onCalendarTouchStart','onCalendarTouchMove','onCalendarTouchEnd','onCalendarTouchCancel'];
  var state={originals:{},descriptors:{},logs:[],gesture:p.calendarGesture,suppress:p.suppressDayTapUntil};
  function points(value){return {array:Array.isArray(value),kind:Object.prototype.toString.call(value),length:value&&value.length,
    values:Array.isArray(value)?value.map(function(t){return {identifier:t.identifier,clientX:t.clientX,clientY:t.clientY,pageX:t.pageX,pageY:t.pageY,xType:typeof t.clientX,yType:typeof t.clientY};}):[]};}
  p[key]=state;
  try{
    names.forEach(function(name){
      var original=p[name];if(typeof original!=='function')throw new Error('Calendar event handler unavailable');
      state.originals[name]=original;state.descriptors[name]=Object.getOwnPropertyDescriptor(p,name);
      p[name]=function(event){
        var at=Date.now(),before=this.calendarGesture?Object.assign({},this.calendarGesture):null;
        var entry={method:name,at:at,eventTime:event&&event.timeStamp,eventType:event&&event.type,touches:points(event&&event.touches),changedTouches:points(event&&event.changedTouches),gestureBefore:before,selectedBefore:this.data.selectedDate};
        if(state.logs.length<100)state.logs.push(entry);
        try{return original.apply(this,arguments);}finally{entry.gestureAfter=this.calendarGesture?Object.assign({},this.calendarGesture):null;entry.selectedAfter=this.data.selectedDate;entry.duration=before?at-before.at:null;}
      };
    });
  }catch(error){
    Object.keys(state.originals).forEach(function(name){if(state.descriptors[name])Object.defineProperty(p,name,state.descriptors[name]);else delete p[name];});delete p[key];throw error;
  }
  return {dayflowSmoke:true,installed:true};
}
function readTouchProbe() {
  var p=getCurrentPages().slice(-1)[0],state=p&&p.__dayflowUxQaTouchProbe;
  return {dayflowSmoke:true,found:!!state,logs:state?state.logs:[],selectedDate:p&&p.data.selectedDate};
}
function restoreTouchProbe() {
  var p=getCurrentPages().slice(-1)[0],key='__dayflowUxQaTouchProbe',state=p&&p[key];
  if(!state)return {dayflowSmoke:true,restored:true,alreadyAbsent:true};
  var logs=state.logs;
  Object.keys(state.originals).forEach(function(name){if(state.descriptors[name])Object.defineProperty(p,name,state.descriptors[name]);else delete p[name];});
  p.calendarGesture=state.gesture;p.suppressDayTapUntil=state.suppress;delete p[key];
  var equal=Object.keys(state.originals).every(function(name){return p[name]===state.originals[name];});
  return {dayflowSmoke:true,restored:equal,logs:logs};
}
module.exports={layoutPayload,seedLayout,installTouchProbe,readTouchProbe,restoreTouchProbe};
if(require.main===module){
  var now=new Date(),dateKey=process.argv[2]||[now.getFullYear(),String(now.getMonth()+1).padStart(2,'0'),String(now.getDate()).padStart(2,'0')].join('-');
  process.stdout.write(JSON.stringify({layout:layoutPayload(dateKey,Date.now()),seedLayout:seedLayout.toString(),installTouchProbe:installTouchProbe.toString(),readTouchProbe:readTouchProbe.toString(),restoreTouchProbe:restoreTouchProbe.toString()}));
}
