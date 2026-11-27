const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntime, clone } = require('./helpers/miniprogram');

const POINT = 'dayflow.localBackup.restorePoint.v1';
const KEYS = ['dayflow.plans.v1','dayflow.planVersions.v1','dayflow.instances.v1','dayflow.records.v2','dayflow.records.v1','dayflow.preferences.v1','dayflow.restDays.v1'];
const storageImage = run => JSON.stringify([...run.storage].sort(([a],[b]) => a.localeCompare(b)));
function setup() {
  const run = createRuntime(new Date(2026, 10, 2, 12));
  const files = new Map(), dirs = new Set(['wxfile://usr']);
  const fs = {
    mkdirSync(path) { dirs.add(path); },
    readdirSync(path) { return [...files.keys()].filter(file => file.startsWith(path + '/') && !file.slice(path.length + 1).includes('/')).map(file => file.slice(path.length + 1)); },
    statSync(path) {
      if (files.has(path)) return { size: Buffer.byteLength(files.get(path)), isFile: () => true, isDirectory: () => false };
      if (dirs.has(path)) return { size: 0, isFile: () => false, isDirectory: () => true };
      throw new Error('not found');
    },
    readFileSync(path) { if (!files.has(path)) throw new Error('not found'); return files.get(path); },
    writeFileSync(path, text) { files.set(path, text); },
    unlinkSync(path) { files.delete(path); }
  };
  run.wx.env = { USER_DATA_PATH: 'wxfile://usr' };
  run.wx.getFileSystemManager = () => fs;
  const backup = run.load('miniprogram/services/local-backup');
  const plans = run.load('miniprogram/services/plans');
  return { run, backup, plans, files, fs };
}
function incoming(backup, patch = {}) {
  const value = clone(backup.createLocalBackup());
  value.data.plans.name = '合成导入计划';
  Object.assign(value, patch);
  return value;
}
function restore(backup, pack) {
  const text = JSON.stringify(pack), preview = backup.previewLocalBackup(text);
  assert.equal(preview.ok, true, preview.errors.join(';'));
  backup.restoreLocalBackup(text, preview.lease);
  return text;
}

test('只读导出包含旧记录和对应旧日程，未知旧目标保留，不导出照片及订阅身份', () => {
  const { run, backup } = setup();
  run.storage.set('dayflow.records.v1', { '2026-10-31': { 'unknown-old': 'done', 'music-guitar': 'done' } });
  const prefs = run.load('miniprogram/services/preferences').getPreferences();
  prefs.subscriptionTemplateIds = ['synthetic_template'];
  run.storage.set('dayflow.preferences.v1', prefs);
  const before = storageImage(run), pack = clone(backup.createLocalBackup());
  assert.equal(storageImage(run), before);
  assert.equal(pack.kind, 'dayflow-local-record-backup');
  assert.equal(pack.data.records.byDate['2026-10-31']['unknown-old'].taskId, 'unknown-old');
  assert.equal(pack.data.records.byDate['2026-10-31']['unknown-old'].updatedAt, 0);
  assert.equal(pack.data.instances['2026-10-31'].templateVersion, 1);
  assert.equal(pack.data.instances['2026-10-31'].locked, true);
  assert.equal(pack.data.instances['2026-10-31'].blocks.some(block => block.id === 'sleep-morning'), false);
  assert.deepEqual(pack.data.preferences.subscriptionTemplateIds, []);
  assert.deepEqual(Object.keys(pack.data).sort(), ['instances','planVersions','plans','preferences','records','restDays']);
  assert.equal(backup.previewLocalBackup(JSON.stringify(pack)).summary.rangeStart, '2026-10-31');
});

test('恢复只替换约定七组，提醒关闭、订阅配置和照片保留，普通撤销精确还原原值与存在性', () => {
  const { run, backup } = setup();
  const prefs = run.load('miniprogram/services/preferences').getPreferences();
  prefs.subscriptionTemplateIds = ['current_template']; prefs.sleepReminderEnabled = true;
  run.storage.set('dayflow.preferences.v1', prefs);
  run.storage.set('dayflow.records.v1', {});
  run.storage.set('dayflow.review.v1', '2026-11-01');
  run.storage.set('unrelated.key', { untouched: true });
  const original = storageImage(run), pack = incoming(backup);
  pack.data.preferences.taskReminderEnabled = true;
  const text = JSON.stringify(pack), beforePreview = storageImage(run), preview = backup.previewLocalBackup(text);
  assert.equal(preview.ok, true);
  assert.equal(storageImage(run), beforePreview);
  backup.restoreLocalBackup(text, preview.lease);
  assert.equal(run.storage.get('dayflow.plans.v1').name, '合成导入计划');
  assert.equal(run.storage.has('dayflow.records.v1'), false);
  assert.equal(run.storage.get('dayflow.preferences.v1').sleepReminderEnabled, false);
  assert.equal(run.storage.get('dayflow.preferences.v1').taskReminderEnabled, false);
  assert.deepEqual(run.storage.get('dayflow.preferences.v1').subscriptionTemplateIds, ['current_template']);
  assert.equal(run.storage.get('dayflow.review.v1'), '2026-11-01');
  assert.equal(backup.getLocalBackupState().canUndo, true);
  const undo = backup.previewUndoLocalBackup();
  assert.equal(undo.ok, true);
  backup.undoLocalBackup(undo.lease);
  assert.equal(storageImage(run), original);
});

test('损坏、未知格式、超限、缺历史快照和含订阅配置的包预览零写', () => {
  const { run, backup } = setup();
  const base = incoming(backup), missing = clone(base);
  missing.data.records.byDate['2026-11-01'] = { old: { date:'2026-11-01',targetId:'old',taskId:'old',status:'done',updatedAt:0,events:[] } };
  const identity = clone(base); identity.data.preferences.subscriptionTemplateIds = ['remote_template'];
  for (const text of ['not-json', JSON.stringify({ ...base, kind:'dayflow-local-record-restore-point' }), JSON.stringify({ ...base, exportedAt:1e300 }), JSON.stringify({ ...base, secret:'unexpected' }), JSON.stringify(missing), JSON.stringify(identity), ' '.repeat(4*1024*1024+1)]) {
    const before = storageImage(run);
    assert.equal(backup.previewLocalBackup(text).ok, false);
    assert.equal(storageImage(run), before);
  }
});

test('进行中包、当前执行、暂停计时、云开关和队列保护，不伪造结束', () => {
  const record = { date:'2026-11-02',targetId:'music-guitar',taskId:'music-guitar',status:'doing',updatedAt:1,actualStartedAt:1,events:[] };
  for (const mode of ['package-doing','current-doing','paused','sync','queued','conflict']) {
    const { run, backup, plans } = setup();
    const pack = incoming(backup);
    if (mode === 'package-doing') {
      pack.data.records.byDate[record.date] = { [record.targetId]: record };
      pack.data.instances = clone(plans.exportInstancesForBackup([record.date]));
    }
    if (mode === 'current-doing') run.storage.set('dayflow.records.v2', { schemaVersion:2,byDate:{ [record.date]:{[record.targetId]:record} } });
    if (mode === 'paused') run.storage.set('dayflow.timer.v1',{schemaVersion:1,dateKey:record.date,targetId:record.targetId,durationSeconds:60,remainingSeconds:20,status:'paused',updatedAt:1});
    if (mode === 'sync' || mode === 'conflict') run.storage.set('dayflow.sync.v1',{enabled:mode==='sync',envId:'',version:0,accountId:'',queued:false,conflict:mode==='conflict'});
    if (mode === 'queued') run.storage.set('dayflow.sync.queue.v1', { retained:true });
    const before=storageImage(run);
    assert.equal(backup.previewLocalBackup(JSON.stringify(pack)).ok, false, mode);
    assert.equal(storageImage(run),before);
  }
});

test('确认租约绑定内容、照片及本地日期；后续修改使撤销失效', () => {
  const { run, backup } = setup();
  const text = JSON.stringify(incoming(backup)), preview=backup.previewLocalBackup(text);
  const prefs=run.load('miniprogram/services/preferences').getPreferences();prefs.leadMinutes=7;
  run.storage.set('dayflow.preferences.v1',prefs);
  const before=storageImage(run);
  assert.throws(()=>backup.restoreLocalBackup(text,preview.lease),/变化/);
  assert.equal(storageImage(run),before);
  const again=backup.previewLocalBackup(text);
  run.setNow(new Date(2026,10,3,0,1));
  assert.throws(()=>backup.restoreLocalBackup(text,again.lease),/变化/);
  restore(backup,JSON.parse(text));
  run.storage.set('dayflow.preferences.v1',{...run.storage.get('dayflow.preferences.v1'),leadMinutes:4});
  assert.equal(backup.getLocalBackupState().canUndo,false);
  assert.match(backup.previewUndoLocalBackup().errors[0],/已变化/);
});

test('普通写失败精确回滚七组和原恢复点，恢复点写失败不动业务', () => {
  for(const mode of ['records','manifest']) {
    const {run,backup}=setup();
    restore(backup,incoming(backup));
    const pack=incoming(backup);pack.data.plans.name='再次导入';
    const text=JSON.stringify(pack),preview=backup.previewLocalBackup(text),before=storageImage(run),write=run.wx.setStorageSync;
    let failed=false;
    run.wx.setStorageSync=(key,value)=>{if(!failed&&key===(mode==='records'?'dayflow.records.v2':POINT)){failed=true;throw new Error('quota');}write(key,value);};
    assert.throws(()=>backup.restoreLocalBackup(text,preview.lease),mode==='records'?/回滚/:/没有改变/);
    assert.equal(storageImage(run),before);
  }
});

test('写入和回滚同时失败保留小manifest与不可变原值，解除故障后可从混合状态继续恢复', () => {
  const {run,backup,files}=setup();
  run.storage.set('dayflow.plans.v1',clone(run.load('miniprogram/services/plans').getTemplate()));
  const pack=incoming(backup),text=JSON.stringify(pack),preview=backup.previewLocalBackup(text),before=storageImage(run),write=run.wx.setStorageSync;
  let planWrites=0,recordFailed=false;
  run.wx.setStorageSync=(key,value)=>{
    if(key==='dayflow.plans.v1'&&++planWrites===2)throw new Error('rollback unavailable');
    if(key==='dayflow.records.v2'&&!recordFailed){recordFailed=true;throw new Error('first write unavailable');}
    write(key,value);
  };
  assert.throws(()=>backup.restoreLocalBackup(text,preview.lease),/尚未完成/);
  assert.equal(backup.getLocalBackupState().recoveryRequired,true);
  const point=run.storage.get(POINT);
  assert.equal(point.state,'recovery-required');
  assert.ok(files.has(point.filePath));
  assert.ok(Buffer.byteLength(JSON.stringify(point))<2048);
  assert.throws(()=>run.load('miniprogram/services/preferences').savePreferences({leadMinutes:2}),/恢复/);
  run.wx.setStorageSync=write;
  const undo=backup.previewUndoLocalBackup();assert.equal(undo.ok,true,undo.errors.join(';'));
  backup.undoLocalBackup(undo.lease);
  assert.equal(storageImage(run),before);
});

test('照片兼容要求完整锁定块；同ID换内容或可重建旧缓存不能覆盖关联', () => {
  const {run,backup,plans}=setup();
  const date='2026-11-03',item=plans.lockDailyInstance(date);
  run.storage.set('dayflow.media.v1',[{id:'photo',dateKey:date,targetId:'music-guitar',localPath:'saved-photo',createdAt:1}]);
  const pack=incoming(backup),before=storageImage(run);
  const changed=clone(pack);changed.data.instances[date].blocks.find(block=>block.id==='music').title='换过内容';
  assert.equal(backup.previewLocalBackup(JSON.stringify(changed)).ok,false);
  const stale=clone(pack);stale.data.instances[date].locked=false;stale.data.instances[date].templateVersion=1;
  assert.equal(backup.previewLocalBackup(JSON.stringify(stale)).ok,false);
  assert.equal(storageImage(run),before);
  restore(backup,pack);
  assert.deepEqual(run.storage.get('dayflow.media.v1'),[{id:'photo',dateKey:date,targetId:'music-guitar',localPath:'saved-photo',createdAt:1}]);
  assert.deepEqual(clone(run.storage.get('dayflow.instances.v1')[date].blocks),clone(item.blocks));
});

test('超过一兆的事务前后像写入文件，manifest保持小型，不占单key大值', () => {
  const {run,backup,files}=setup();
  const plans=run.load('miniprogram/services/plans');
  const versions=[];
  while(Buffer.byteLength(JSON.stringify(versions))<600*1024){const plan=clone(plans.getTemplate());plan.version=versions.length+1;versions.push(plan);}
  run.storage.set('dayflow.planVersions.v1',versions);
  const pack=incoming(backup),text=JSON.stringify(pack),preview=backup.previewLocalBackup(text);
  assert.equal(preview.ok,true);
  const write=run.wx.setStorageSync;
  run.wx.setStorageSync=(key,value)=>{if(Buffer.byteLength(JSON.stringify(value))>1024*1024)throw new Error('per-key cap');write(key,value);};
  backup.restoreLocalBackup(text,preview.lease);
  const manifest=run.storage.get(POINT),journal=files.get(manifest.filePath);
  assert.ok(Buffer.byteLength(journal)>1024*1024);
  assert.ok(Buffer.byteLength(JSON.stringify(manifest))<2048);
  assert.equal(manifest.journalByteLength,Buffer.byteLength(journal,'utf8'));
  let checksum=2166136261;for(const byte of Buffer.from(journal,'utf16le'))checksum=Math.imul(checksum^byte,16777619)>>>0;
  assert.equal(manifest.journalChecksum,'fnv1a32-utf16le:'+checksum.toString(16).padStart(8,'0'));
  assert.equal(backup.getLocalBackupState().canUndo,true);
});

test('已到期计时只读视为结束，不持久改写旧运行态；有效暂停计时向UI暴露可明确结束的标识', () => {
  const {run,backup}=setup();
  const expired={schemaVersion:1,dateKey:'2026-11-02',targetId:'music-guitar',durationSeconds:60,remainingSeconds:60,status:'running',endsAt:1,updatedAt:1};
  run.storage.set('dayflow.timer.v1',expired);
  const text=JSON.stringify(incoming(backup));
  assert.equal(backup.previewLocalBackup(text).ok,true);
  assert.deepEqual(run.storage.get('dayflow.timer.v1'),expired);
  run.storage.set('dayflow.timer.v1',{...expired,status:'paused',remainingSeconds:10});
  assert.equal(backup.previewLocalBackup(text).ok,false);
  assert.deepEqual(clone(backup.getLocalBackupState().blockingTimer),{dateKey:'2026-11-02',targetId:'music-guitar',updatedAt:1,status:'paused'});
});

test('文件导出不发送、取消选择零写，分享拒绝journal/伪造路径及导出后换内容', async () => {
  const {run,backup,files}=setup();
  let shares=0;run.wx.shareFileMessage=options=>{shares++;options.success({});};
  const before=storageImage(run),file=await backup.exportLocalBackupFile();
  assert.equal(storageImage(run),before);assert.equal(shares,0);
  assert.match(file.fileName,/^dayflow-records-/);
  await backup.shareLocalBackupFile(file);assert.equal(shares,1);
  const journalPath='wxfile://usr/dayflow-backups/dayflow-restore-1-x-y.json';
  files.set(journalPath,JSON.stringify({kind:'dayflow-local-record-restore-point'}));
  await assert.rejects(backup.shareLocalBackupFile({...file,filePath:journalPath,fileName:'dayflow-restore-1-x-y.json'}));
  await assert.rejects(backup.shareLocalBackupFile({...file,filePath:'wxfile://usr/other.json'}));
  files.set(file.filePath,JSON.stringify({kind:'dayflow-local-record-restore-point'}));
  await assert.rejects(backup.shareLocalBackupFile(file));assert.equal(shares,1);
  run.wx.chooseMessageFile=options=>options.fail({errMsg:'chooseMessageFile:fail cancel'});
  await assert.rejects(backup.chooseLocalBackupFile(),/已取消/);
  assert.equal(storageImage(run),before);
});

test('合法JSON与合法业务字段被改动仍因journal字节校验失败拒绝撤销，业务零写', () => {
  const {run,backup,files}=setup();
  run.storage.set('dayflow.records.v2',{schemaVersion:2,byDate:{'2026-11-01':{old:{date:'2026-11-01',targetId:'old',taskId:'old',status:'done',updatedAt:1,events:[]}}}});
  restore(backup,incoming(backup));
  const point=run.storage.get(POINT),journal=JSON.parse(files.get(point.filePath));
  journal.before['dayflow.records.v2'].value.byDate['2026-11-01'].old.status='todo';
  files.set(point.filePath,JSON.stringify(journal));
  const before=storageImage(run);
  assert.equal(backup.getLocalBackupState().canUndo,false);
  const preview=backup.previewUndoLocalBackup();assert.equal(preview.ok,false);assert.match(preview.errors[0],/校验/);
  assert.throws(()=>backup.undoLocalBackup('stale'),/校验/);
  assert.equal(storageImage(run),before);
});

test('同步恢复副本仅本地照片引用需要上下文兼容；云端归档照片与原副本保留', () => {
  const {run,backup,plans}=setup();
  const old=plans.exportInstancesForBackup(['2026-11-03']);
  const photo={id:'retained',dateKey:'2026-11-03',targetId:'music-guitar',localPath:'saved-copy',createdAt:1};
  const source={original:{media:{present:true,value:[photo]},instances:{present:true,value:old}},remote:{retained:true},at:1};
  run.storage.set('dayflow.sync.restoreBackup.v1',source);
  const pack=incoming(backup);
  assert.equal(backup.previewLocalBackup(JSON.stringify(pack)).ok,false,'package omits a required photo-day snapshot');
  pack.data.instances=clone(old);
  assert.equal(backup.previewLocalBackup(JSON.stringify(pack)).ok,true);
  const before=clone(source);restore(backup,pack);
  assert.deepEqual(clone(run.storage.get('dayflow.sync.restoreBackup.v1')),before);
  const other=setup(), cloudOnly={...photo,localPath:undefined,cloudFileID:'cloud://synthetic/private/photo'};
  other.run.storage.set('dayflow.sync.restoreBackup.v1',{original:{media:{present:true,value:[cloudOnly]}},at:1});
  assert.equal(other.backup.previewLocalBackup(JSON.stringify(incoming(other.backup))).ok,true);
});

test('选择和目录IO失败仅给固定中文，错误与预览中不泄露私有路径', async () => {
  const {run,backup,fs}=setup();
  run.wx.chooseMessageFile=options=>options.success({tempFiles:[{path:'wxfile://usr/private-file.json',name:'example.json',size:100}]});
  fs.statSync=()=>{throw new Error('stat:fail wxfile://usr/private-file.json');};
  await assert.rejects(backup.chooseLocalBackupFile(), error=>!/wxfile:|private-file|stat:/.test(error.message));
  fs.mkdirSync=()=>{throw new Error('mkdir:fail wxfile://usr/private-dir');};
  await assert.rejects(backup.exportLocalBackupFile(),error=>!/wxfile:|private-dir|mkdir:/.test(error.message));
});

test('恢复最终标记已写入但读回失败时保留完整目标，不再进入可能失败的业务回滚', () => {
  const {run,backup,files}=setup();
  run.storage.set('dayflow.plans.v1',clone(run.load('miniprogram/services/plans').getTemplate()));
  const before=storageImage(run),pack=incoming(backup),text=JSON.stringify(pack),preview=backup.previewLocalBackup(text);
  const read=run.wx.getStorageSync,write=run.wx.setStorageSync;
  let finalMarkerWritten=false,finalReadFailed=false,writesAfterFault=0;
  run.wx.setStorageSync=(key,value)=>{
    if(finalReadFailed){writesAfterFault++;throw new Error('subsequent writes unavailable');}
    write(key,value);
    if(key===POINT&&value.state==='restored')finalMarkerWritten=true;
  };
  run.wx.getStorageSync=key=>{
    if(key===POINT&&finalMarkerWritten&&!finalReadFailed){finalReadFailed=true;throw new Error('final marker read unavailable');}
    return read(key);
  };
  assert.throws(()=>backup.restoreLocalBackup(text,preview.lease),/内容已写入.*重新检查恢复状态/);
  assert.equal(finalReadFailed,true);
  assert.equal(writesAfterFault,0,'a completed target must not be rolled back after uncertain final-marker read-back');
  const manifest=run.storage.get(POINT),journal=JSON.parse(files.get(manifest.filePath));
  assert.equal(manifest.state,'restored');
  for(const key of KEYS){assert.equal(run.storage.has(key),journal.after[key].present);if(journal.after[key].present)assert.deepEqual(clone(run.storage.get(key)),journal.after[key].value);}
  assert.equal(backup.getLocalBackupState().recoveryRequired,false);
  assert.equal(backup.getLocalBackupState().canUndo,true);
  assert.doesNotThrow(()=>run.load('miniprogram/services/local-backup-guard').assertNoPendingLocalBackup());
  run.wx.getStorageSync=read;run.wx.setStorageSync=write;
  const undo=backup.previewUndoLocalBackup();assert.equal(undo.ok,true);
  backup.undoLocalBackup(undo.lease);
  assert.equal(storageImage(run),before);
});

test('撤销最终删除标记已生效但读回失败时保留完整原内容，不制造无标记的混合数据', () => {
  const {run,backup}=setup();
  run.storage.set('dayflow.plans.v1',clone(run.load('miniprogram/services/plans').getTemplate()));
  const before=storageImage(run);restore(backup,incoming(backup));
  const preview=backup.previewUndoLocalBackup(),remove=run.wx.removeStorageSync,info=run.wx.getStorageInfoSync,write=run.wx.setStorageSync;
  let finalMarkerDeleted=false,finalReadFailed=false,writesAfterFault=0;
  run.wx.removeStorageSync=key=>{remove(key);if(key===POINT)finalMarkerDeleted=true;};
  run.wx.getStorageInfoSync=()=>{
    if(finalMarkerDeleted&&!finalReadFailed){finalReadFailed=true;throw new Error('final deletion read unavailable');}
    return info();
  };
  run.wx.setStorageSync=(key,value)=>{if(finalReadFailed){writesAfterFault++;throw new Error('subsequent writes unavailable');}write(key,value);};
  assert.throws(()=>backup.undoLocalBackup(preview.lease),/原内容已恢复.*重新检查恢复状态/);
  assert.equal(finalReadFailed,true);
  assert.equal(writesAfterFault,0);
  assert.equal(run.storage.has(POINT),false);
  assert.equal(storageImage(run),before);
  assert.equal(backup.getLocalBackupState().recoveryRequired,false);
  assert.equal(backup.getLocalBackupState().canUndo,false);
  assert.doesNotThrow(()=>run.load('miniprogram/services/local-backup-guard').assertNoPendingLocalBackup());
  run.wx.removeStorageSync=remove;run.wx.getStorageInfoSync=info;run.wx.setStorageSync=write;
  assert.equal(backup.previewLocalBackup(JSON.stringify(incoming(backup))).ok,true);
});

test('最终标记尚未生效时完整目标保留在writing门禁下，可明确回退该次操作前内容', () => {
  for(const operation of ['restore','undo']){
    const {run,backup,files}=setup();
    run.storage.set('dayflow.plans.v1',clone(run.load('miniprogram/services/plans').getTemplate()));
    if(operation==='undo')restore(backup,incoming(backup));
    const starting=storageImage(run),text=JSON.stringify(incoming(backup));
    const preview=operation==='restore'?backup.previewLocalBackup(text):backup.previewUndoLocalBackup();
    const write=run.wx.setStorageSync,remove=run.wx.removeStorageSync;
    run.wx.setStorageSync=(key,value)=>{if(operation==='restore'&&key===POINT&&value.state==='restored')throw new Error('final write unavailable');write(key,value);};
    run.wx.removeStorageSync=key=>{if(operation==='undo'&&key===POINT)throw new Error('final remove unavailable');remove(key);};
    assert.throws(()=>operation==='restore'?backup.restoreLocalBackup(text,preview.lease):backup.undoLocalBackup(preview.lease),/重新检查恢复状态/);
    const manifest=run.storage.get(POINT),journal=JSON.parse(files.get(manifest.filePath));
    assert.equal(manifest.state,'writing');
    for(const key of KEYS){assert.equal(run.storage.has(key),journal.after[key].present);if(journal.after[key].present)assert.deepEqual(clone(run.storage.get(key)),journal.after[key].value);}
    assert.equal(backup.getLocalBackupState().recoveryRequired,true);
    assert.throws(()=>run.load('miniprogram/services/local-backup-guard').assertNoPendingLocalBackup(),/恢复/);
    run.wx.setStorageSync=write;run.wx.removeStorageSync=remove;
    const retry=backup.previewUndoLocalBackup();assert.equal(retry.ok,true,retry.errors.join(';'));
    backup.undoLocalBackup(retry.lease);
    assert.equal(storageImage(run),starting);
  }
});

test('恢复点键存在但为空值是损坏状态，不能伪称无副本；真正不存在可正常只读导出', () => {
  for(const value of [null,'',undefined]){
    const {run,backup}=setup();
    const text=JSON.stringify(incoming(backup));
    run.storage.set(POINT,value);
    const before=storageImage(run),state=backup.getLocalBackupState();
    assert.equal(state.recoveryRequired,true);
    assert.equal(state.canUndo,false);
    assert.notEqual(state.reason,'尚无可撤销的恢复');
    assert.equal(backup.previewLocalBackup(text).ok,false);
    assert.equal(backup.previewUndoLocalBackup().ok,false);
    assert.throws(()=>backup.createLocalBackup(),/恢复/);
    assert.equal(storageImage(run),before);
    assert.equal(run.storage.has(POINT),true);
    assert.equal(run.storage.get(POINT),value);
  }
  const {run,backup}=setup(),before=storageImage(run);
  assert.equal(backup.getLocalBackupState().recoveryRequired,false);
  assert.equal(backup.getLocalBackupState().canUndo,false);
  assert.doesNotThrow(()=>backup.createLocalBackup());
  assert.equal(storageImage(run),before);
});
