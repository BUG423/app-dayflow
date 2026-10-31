const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {KNOWN_KEYS,backup,restore,seed,timeProbe,storageProbe} = require('../scripts/acceptance-fixtures');
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
function run(fn, store, args=[]) {
  const wx = {getStorageInfoSync:()=>({keys:[...store.keys()]}),getStorageSync:key=>clone(store.get(key)),setStorageSync:(key,value)=>store.set(key,clone(value)),removeStorageSync:key=>store.delete(key)};
  return vm.runInNewContext('('+fn.toString()+')',{wx})(...args);
}
test('验收备份恢复全部日程流key及存在性，不触碰其他应用key',()=>{
  const original = {'dayflow.records.v1':{'2026-10-30':{a:'done'}},'dayflow.future-key.v9':{private:'exact'},unrelated:{value:7}};
  const store = new Map(Object.entries(clone(original)));
  const snapshot=run(backup,store,[KNOWN_KEYS]);
  assert.equal(snapshot.keys['dayflow.timer.v1'].present,false);
  assert.equal(snapshot.keys['dayflow.future-key.v9'].present,true);
  run(seed,store);
  store.set('dayflow.new-test-key.v1',{test:true}); store.set('dayflow.records.v2',{schemaVersion:2,byDate:{}});
  const result=run(restore,store,[snapshot]);
  assert.equal(result.equal,true);
  assert.deepEqual(Object.fromEntries(store),original);
});
test('验收恢复读回不同值时拒绝宣称恢复成功',()=>{
  const store=new Map([['dayflow.records.v1',{original:true}]]);
  const snapshot=run(backup,store,[KNOWN_KEYS]);
  const wx={getStorageInfoSync:()=>({keys:[...store.keys()]}),getStorageSync:()=>({damaged:true}),setStorageSync(){},removeStorageSync:key=>store.delete(key)};
  assert.equal(vm.runInNewContext('('+restore.toString()+')',{wx})(snapshot).equal,false);
});
test('验收拒绝损坏或越界备份，恢复前不写任何key',()=>{
  for(const snapshot of [{schemaVersion:1,initialKeys:['unrelated'],keys:{unrelated:{present:true,value:1}}},{schemaVersion:1,initialKeys:[],keys:{'dayflow.records.v1':{present:true,value:1}}},null]){
    const store=new Map([['unrelated',7],['dayflow.records.v1',{keep:true}]]);
    assert.throws(()=>run(restore,store,[snapshot]),/Invalid acceptance backup/);
    assert.deepEqual(Object.fromEntries(store),{unrelated:7,'dayflow.records.v1':{keep:true}});
  }
});
test('验收时间与存储注入出现异常时仍恢复原始运行时对象',()=>{
  let calls=0;
  const page={data:{selectedDate:'2026-10-31'},lastToday:'2026-10-31',choose(){if(++calls===1)throw new Error('synthetic page failure');},updateClock(){}};
  const context=vm.createContext({Date,getCurrentPages:()=>[page]});
  assert.throws(()=>vm.runInContext('('+timeProbe.toString()+')()',context),/synthetic page failure/);
  assert.equal(context.Date,Date);
  const read=()=>1, write=()=>{};const wx={getStorageSync:read,setStorageSync:write};
  calls=0;
  const failurePage={data:{},refresh(){if(++calls===1)throw new Error('synthetic refresh failure');},onToggleTask(){}};
  assert.throws(()=>vm.runInNewContext('('+storageProbe.toString()+')()',{wx,getCurrentPages:()=>[failurePage]}),/synthetic refresh failure/);
  assert.equal(wx.getStorageSync,read);assert.equal(wx.setStorageSync,write);
});
