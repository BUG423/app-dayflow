const KNOWN_KEYS = ['dayflow.plans.v1','dayflow.planVersions.v1','dayflow.instances.v1','dayflow.records.v1','dayflow.records.v2','dayflow.review.v1','dayflow.preferences.v1','dayflow.remindersShown.v1','dayflow.timer.v1','dayflow.media.v1','dayflow.sync.v1','dayflow.sync.queue.v1','dayflow.sync.conflicts.v1','dayflow.sync.restoreBackup.v1','dayflow.sync.previousBinding.v1'];

function backup(keys) {
  var present = wx.getStorageInfoSync().keys.filter(function(key) { return key.indexOf('dayflow.') === 0; });
  var all = Array.from(new Set(present.concat(keys))), values = {};
  all.forEach(function(key) { values[key] = {present: present.indexOf(key) >= 0, value: present.indexOf(key) >= 0 ? wx.getStorageSync(key) : null}; });
  return {dayflowSmoke:true, schemaVersion:1, initialKeys:present.sort(), keys:values};
}
function restore(snapshot) {
  if (!snapshot || snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.initialKeys) || !snapshot.keys || typeof snapshot.keys !== 'object' || Array.isArray(snapshot.keys)) throw new Error('Invalid acceptance backup');
  var savedKeys = Object.keys(snapshot.keys);
  savedKeys.forEach(function(key) { if (key.indexOf('dayflow.') !== 0 || !snapshot.keys[key] || typeof snapshot.keys[key].present !== 'boolean') throw new Error('Invalid acceptance backup key'); });
  var declared = savedKeys.filter(function(key) { return snapshot.keys[key].present; }).sort();
  if (JSON.stringify(declared) !== JSON.stringify(snapshot.initialKeys.slice().sort())) throw new Error('Invalid acceptance backup existence');
  var current = wx.getStorageInfoSync().keys.filter(function(key) { return key.indexOf('dayflow.') === 0; });
  var all = Array.from(new Set(current.concat(Object.keys(snapshot.keys))));
  all.forEach(function(key) { var entry = snapshot.keys[key]; if (entry && entry.present) wx.setStorageSync(key, entry.value); else wx.removeStorageSync(key); });
  var after = wx.getStorageInfoSync().keys.filter(function(key) { return key.indexOf('dayflow.') === 0; }).sort();
  var equal = JSON.stringify(after) === JSON.stringify(snapshot.initialKeys);
  Object.keys(snapshot.keys).forEach(function(key) { var entry = snapshot.keys[key]; if (entry.present && JSON.stringify(wx.getStorageSync(key)) !== JSON.stringify(entry.value)) equal = false; });
  return {dayflowSmoke:true, equal:equal, restoredKeys:after.length};
}
function seed() {
  wx.getStorageInfoSync().keys.filter(function(key) { return key.indexOf('dayflow.') === 0; }).forEach(function(key) { wx.removeStorageSync(key); });
  return {dayflowSmoke:true, seeded:true};
}
function inspect() {
  var records = wx.getStorageSync('dayflow.records.v2');
  return {dayflowSmoke:true, dates:records && records.byDate ? Object.keys(records.byDate).length : 0, hasTimer:!!wx.getStorageSync('dayflow.timer.v1')};
}
function timeProbe() {
  var p=getCurrentPages().slice(-1)[0], Original=Date, selected=p.data.selectedDate, oldToday=p.lastToday, now=new Original(2026,9,31,12,4).getTime();
  var Fake=function(y,m,d,h,min,s,ms){if(!arguments.length)return new Original(now);if(arguments.length===1)return new Original(y);return new Original(y,m,d,h||0,min||0,s||0,ms||0);};
  Fake.prototype=Original.prototype;Fake.now=function(){return now;};Fake.parse=Original.parse;Fake.UTC=Original.UTC;
  try {
    Date=Fake;p.lastToday='2026-10-31';p.lastClockMinute='';p.choose('2026-10-31');p.updateClock();var before=p.data.heroCaption==='接下来';
    now=new Original(2026,9,31,12,5).getTime();p.updateClock();var start=p.data.heroCaption==='此刻正在进行';
    now=new Original(2026,9,31,12,35).getTime();p.updateClock();var end=p.data.heroCaption==='接下来';
    now=new Original(2026,9,31,23,59).getTime();p.updateClock();now=new Original(2026,10,1,0,0).getTime();p.updateClock();var midnight=p.data.selectedDate==='2026-11-01';
    p.choose('2026-10-29');now=new Original(2026,10,2,0,0).getTime();p.updateClock();var preserve=p.data.selectedDate==='2026-10-29';
    return {dayflowSmoke:true,before:before,start:start,end:end,midnight:midnight,preserve:preserve};
  } finally {Date=Original;p.lastToday=oldToday;p.lastClockMinute='';p.choose(selected);p.updateClock();}
}
function storageProbe() {
  var p=getCurrentPages().slice(-1)[0], read=wx.getStorageSync, write=wx.setStorageSync, writes=0;
  try {wx.getStorageSync=function(){throw new Error('Synthetic read failure');};wx.setStorageSync=function(){writes++;};p.refresh();var shown=!!p.data.loadError;p.onToggleTask({currentTarget:{dataset:{id:'music-guitar'}}});return {dayflowSmoke:true,errorShown:shown,writes:writes};}
  finally {wx.getStorageSync=read;wx.setStorageSync=write;p.refresh();}
}
module.exports = {KNOWN_KEYS,backup,restore,seed,inspect,timeProbe,storageProbe};
if (require.main === module) console.log(JSON.stringify({keys:KNOWN_KEYS,backup:backup.toString(),restore:restore.toString(),seed:seed.toString(),inspect:inspect.toString(),timeProbe:timeProbe.toString(),storageProbe:storageProbe.toString()}));
