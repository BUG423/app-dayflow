// Synthetic local-backup acceptance only. No personal storage or files are read.
const { createRuntime, clone } = require('../tests/helpers/miniprogram');
const { wizardPayload } = require('./wizard-acceptance-fixtures');
const { PNG_BASE64 } = require('./acceptance-fixtures');

const VALUE_KEYS = ['dayflow.plans.v1', 'dayflow.planVersions.v1', 'dayflow.instances.v1', 'dayflow.records.v2', 'dayflow.preferences.v1', 'dayflow.restDays.v1', 'dayflow.media.v1', 'dayflow.acceptanceSentinel.v1'];
function payload(date, at, nonce) {
  if (!/^[a-f0-9]{32}$/.test(nonce)) throw new Error('Invalid acceptance nonce');
  const base = wizardPayload(date, at), run = createRuntime(new Date(at));
  const preferences = run.load('miniprogram/services/preferences').getPreferences();
  const template = clone(base.values['dayflow.plans.v1']);
  template.id = 'local-backup-acceptance-' + nonce;
  template.name = '本机备份验收计划：认真记录每一天，给喜欢的事情留一点时间';
  const instances = clone(base.values['dayflow.instances.v1']);
  Object.values(instances).forEach(instance => { instance.templateId = template.id; });
  const restDays = { schemaVersion: 1, byDate: { [base.historyDate]: { date: base.historyDate, reason: '合成验收：这一天安排休息，不是个人记录。', startedAt: at - 7 * 86400000, updatedAt: at - 7 * 86400000, active: true } } };
  const values = {
    'dayflow.plans.v1': template,
    'dayflow.planVersions.v1': [clone(template)],
    'dayflow.instances.v1': instances,
    'dayflow.records.v2': clone(base.values['dayflow.records.v2']),
    'dayflow.preferences.v1': preferences,
    'dayflow.restDays.v1': restDays,
    'dayflow.media.v1': [{ id: 'acceptance-photo', dateKey: base.historyDate, targetId: 'wizard-history-task', localPath: '@fixture/synthetic-photo.png', createdAt: at - 1000 }],
    'dayflow.acceptanceSentinel.v1': { synthetic: true, nonce }
  };
  Object.entries(values).forEach(([key, value]) => run.storage.set(key, clone(value)));
  const incoming = clone(values);
  incoming['dayflow.plans.v1'].version = 7;
  incoming['dayflow.plans.v1'].name = '从文件恢复的合成计划：运动、兴趣与工作都按自己的节奏安排';
  incoming['dayflow.plans.v1'].updatedAt = at - 1000;
  incoming['dayflow.preferences.v1'].sleepTime = '22:45';
  incoming['dayflow.preferences.v1'].leadMinutes = 15;
  incoming['dayflow.preferences.v1'].sleepReminderEnabled = true;
  incoming['dayflow.preferences.v1'].taskReminderEnabled = true;
  incoming['dayflow.preferences.v1'].subscriptionTemplateIds = ['SYNTHETIC_BACKUP_TEMPLATE_ID'];
  const calendar = run.load('miniprogram/utils/calendar');
  const otherDate = calendar.shiftDays(base.historyDate, 1);
  incoming['dayflow.instances.v1'][otherDate] = { ...clone(instances[base.historyDate]), date: otherDate, createdAt: at - 6 * 86400000 };
  const otherRecord = clone(incoming['dayflow.records.v2'].byDate[base.historyDate]['wizard-history-task']);
  otherRecord.date = otherDate; otherRecord.feedback.note = '另一条合成历史反馈，用于检查完整记录恢复。';
  incoming['dayflow.records.v2'].byDate[otherDate] = { 'wizard-history-task': otherRecord };
  const source = createRuntime(new Date(at));
  Object.entries(incoming).forEach(([key, value]) => source.storage.set(key, clone(value)));
  const backup = source.load('miniprogram/services/local-backup').createLocalBackup();
  const incompatible = clone(backup);
  delete incompatible.data.instances[base.historyDate];
  delete incompatible.data.records.byDate[base.historyDate];
  const doing = clone(values);
  doing['dayflow.records.v2'].byDate[date] = { 'wizard-action-a': { date, targetId: 'wizard-action-a', taskId: 'wizard-sequence-task', actionId: 'wizard-action-a', status: 'doing', actualStartedAt: at - 1000, updatedAt: at - 1000, events: [{ id: 'backup-doing-event', from: 'todo', to: 'doing', at: at - 1000 }] } };
  const doingRun = createRuntime(new Date(at));
  Object.entries(doing).forEach(([key, value]) => doingRun.storage.set(key, clone(value)));
  doingRun.load('miniprogram/services/plans').lockDailyInstance(date);
  doing['dayflow.instances.v1'] = clone(doingRun.storage.get('dayflow.instances.v1'));
  const activeBackup = doingRun.load('miniprogram/services/local-backup').createLocalBackup();
  const paused = clone(values);
  paused['dayflow.timer.v1'] = { schemaVersion: 1, dateKey: date, targetId: 'wizard-action-a', durationSeconds: 60, remainingSeconds: 30, status: 'paused', updatedAt: at };
  return {
    date, at, nonce, templateId: template.id, historyDate: base.historyDate,
    original: { values }, doing: { values: doing }, paused: { values: paused },
    files: [
      { name: 'incoming.json', encoding: 'utf8', text: JSON.stringify(backup) },
      { name: 'damaged.json', encoding: 'utf8', text: '{"schemaVersion":1,"kind":"dayflow-local-record-backup",' },
      { name: 'photo-incompatible.json', encoding: 'utf8', text: JSON.stringify(incompatible) },
      { name: 'incoming-doing.json', encoding: 'utf8', text: JSON.stringify(activeBackup) },
      { name: 'synthetic-photo.png', encoding: 'base64', text: PNG_BASE64 }
    ]
  };
}

function textHash(text) {
  var hash = 2166136261;
  for (var i = 0; i < text.length; i++) { hash = Math.imul(hash ^ text.charCodeAt(i), 16777619) >>> 0; }
  return ('00000000' + hash.toString(16)).slice(-8);
}
function setupFiles(input) {
  if (!input || !/^[a-f0-9]{32}$/.test(input.nonce) || !Array.isArray(input.files)) throw new Error('Invalid acceptance files');
  var fs = wx.getFileSystemManager(), root = wx.env.USER_DATA_PATH.replace(/\/$/, ''), directory = root + '/dayflow-local-backup-fixture-' + input.nonce;
  var marker = { schemaVersion: 1, kind: 'dayflow-local-backup-acceptance', nonce: input.nonce, files: [] };
  input.files.forEach(function(file) {
    if (!file || !/^[a-z][a-z0-9-]*\.(json|png)$/.test(file.name) || ['utf8','base64'].indexOf(file.encoding) < 0 || typeof file.text !== 'string') throw new Error('Invalid acceptance file');
    marker.files.push({ name: file.name, encoding: file.encoding, hash: textHash(file.text), chars: file.text.length });
  });
  var exists = false;
  try { fs.accessSync(directory); exists = true; } catch (error) { if (!/no such|not exist|ENOENT/i.test(String(error && (error.errMsg || error.message) || error))) throw error; }
  if (exists) throw new Error('The unique acceptance directory already exists');
  fs.mkdirSync(directory, false);
  fs.writeFileSync(directory + '/owner.json', JSON.stringify(marker), 'utf8');
  input.files.forEach(function(file) { fs.writeFileSync(directory + '/' + file.name, file.text, file.encoding); });
  marker.files.forEach(function(file) { var data = fs.readFileSync(directory + '/' + file.name, file.encoding); if (typeof data !== 'string' || data.length !== file.chars || textHash(data) !== file.hash) throw new Error('Acceptance file read-back failed'); });
  return { dayflowSmoke: true, prepared: true, directory: directory, files: marker.files.length };
}
function listBackupFiles() {
  var fs = wx.getFileSystemManager(), directory = wx.env.USER_DATA_PATH.replace(/\/$/, '') + '/dayflow-backups', names = [];
  try { names = fs.readdirSync(directory).slice().sort(); } catch (error) { if (!/no such|not exist|ENOENT/i.test(String(error && (error.errMsg || error.message) || error))) throw error; }
  return { dayflowSmoke: true, directory: directory, names: names };
}
function preflightOriginal() {
  var pages = getCurrentPages(), draft = false, busy = false, recoveryBlocked = false;
  (pages || []).forEach(function(page) {
    var data = page.data || {};
    draft = draft || !!(data.editorVisible || data.draftResumeAvailable || page.draftSchedule || data.phaseRulesDirty || data.restEditorVisible || data.showFeedbackEditor || data.showDeferEditor || data.backupPreviewSummary || data.backupExportReady || page.localBackupCandidate || data.reminderPreview || (data.importVisible && (data.importText || data.eveningPreview)));
    busy = busy || !!(data.backupBusy || data.reminderBusy || data.restSaving || data.sync && data.sync.pending);
    recoveryBlocked = recoveryBlocked || !!(data.backupRecoveryRequired || data.backupStateFailed);
  });
  var key = 'dayflow.localBackup.restorePoint.v1', keys = wx.getStorageInfoSync().keys;
  if (keys.indexOf(key) >= 0) {
    try {
      var point = wx.getStorageSync(key), fields = ['schemaVersion','kind','state','filePath','fileName','nonce','createdAt','journalByteLength','journalChecksum'];
      if (!point || typeof point !== 'object' || Array.isArray(point) || Object.keys(point).length !== fields.length || fields.some(function(field) { return !Object.prototype.hasOwnProperty.call(point, field); }) || point.schemaVersion !== 1 || point.kind !== 'dayflow-local-record-restore-manifest' || point.state !== 'restored' || !/^[a-z0-9]+-[a-z0-9]{1,12}$/.test(point.nonce) || !/^dayflow-restore-\d{1,16}-[a-z0-9]+-[a-z0-9]{1,12}\.json$/.test(point.fileName) || point.fileName.indexOf(point.nonce) < 0 || !Number.isInteger(point.createdAt) || point.createdAt < 0 || !Number.isInteger(point.journalByteLength) || point.journalByteLength < 1 || point.journalByteLength > 24 * 1024 * 1024 || !/^fnv1a32-utf16le:[0-9a-f]{8}$/.test(point.journalChecksum)) throw new Error('Invalid existing restore point');
      var root = wx.env.USER_DATA_PATH.replace(/\/$/, '');
      if (point.filePath !== root + '/dayflow-backups/' + point.fileName) throw new Error('Unsafe existing journal path');
      var fs = wx.getFileSystemManager(), stats = fs.statSync(point.filePath);
      if (!stats || stats.size !== point.journalByteLength || typeof stats.isFile === 'function' && !stats.isFile()) throw new Error('Existing journal size mismatch');
      var text = fs.readFileSync(point.filePath, 'utf8');
      if (typeof text !== 'string' || 'fnv1a32-utf16le:' + textHash(text) !== point.journalChecksum) throw new Error('Existing journal read-back mismatch');
      var journal = JSON.parse(text), rawKeys = ['dayflow.plans.v1','dayflow.planVersions.v1','dayflow.instances.v1','dayflow.records.v2','dayflow.records.v1','dayflow.preferences.v1','dayflow.restDays.v1'];
      var validRaw = function(raw) { return raw && typeof raw === 'object' && !Array.isArray(raw) && Object.keys(raw).length === rawKeys.length && rawKeys.every(function(name) { var slot = raw[name]; return slot && typeof slot === 'object' && !Array.isArray(slot) && Object.keys(slot).length === 2 && typeof slot.present === 'boolean' && Object.prototype.hasOwnProperty.call(slot, 'value') && (slot.present || slot.value === null); }); };
      if (!journal || journal.schemaVersion !== 1 || journal.kind !== 'dayflow-local-record-restore-point' || journal.nonce !== point.nonce || journal.createdAt !== point.createdAt || ['restore','undo'].indexOf(journal.operation) < 0 || !validRaw(journal.before) || !validRaw(journal.after)) throw new Error('Existing journal format mismatch');
    } catch (_) { recoveryBlocked = true; }
  }
  return { dayflowSmoke: true, ready: !!(pages && pages.length) && !draft && !busy && !recoveryBlocked, pageReady: !!(pages && pages.length), draftDetected: draft, busyDetected: busy, recoveryBlocked: recoveryBlocked };
}
function seedValues(input) {
  var allowed = ['dayflow.plans.v1','dayflow.planVersions.v1','dayflow.instances.v1','dayflow.records.v2','dayflow.preferences.v1','dayflow.restDays.v1','dayflow.media.v1','dayflow.acceptanceSentinel.v1','dayflow.timer.v1'];
  if (!input || !/^[a-f0-9]{32}$/.test(input.nonce) || !input.values || !input.values['dayflow.plans.v1'] || input.values['dayflow.plans.v1'].id !== 'local-backup-acceptance-' + input.nonce || Object.keys(input.values).some(function(key) { return allowed.indexOf(key) < 0; })) throw new Error('Invalid synthetic backup values');
  var root = wx.env.USER_DATA_PATH.replace(/\/$/, ''), directory = root + '/dayflow-local-backup-fixture-' + input.nonce;
  var marker = JSON.parse(wx.getFileSystemManager().readFileSync(directory + '/owner.json', 'utf8'));
  if (marker.nonce !== input.nonce || marker.kind !== 'dayflow-local-backup-acceptance') throw new Error('Missing acceptance file ownership');
  var values = JSON.parse(JSON.stringify(input.values));
  (values['dayflow.media.v1'] || []).forEach(function(photo) { if (photo.localPath !== '@fixture/synthetic-photo.png') throw new Error('Invalid synthetic photo path'); photo.localPath = directory + '/synthetic-photo.png'; });
  wx.getStorageInfoSync().keys.filter(function(key) { return key.indexOf('dayflow.') === 0; }).forEach(function(key) { wx.removeStorageSync(key); });
  Object.keys(values).forEach(function(key) { wx.setStorageSync(key, values[key]); });
  return { dayflowSmoke: true, seeded: true, keys: Object.keys(values).length };
}
function installHarness(input) {
  if (!input || !/^[a-f0-9]{32}$/.test(input.nonce)) throw new Error('Invalid harness nonce');
  var app = getApp(), slot = '__dayflowLocalBackupAcceptanceV1';
  if (app[slot]) throw new Error('An acceptance harness is already present');
  var state = { nonce: input.nonce, originals: {}, installed: {}, choice: 'cancel', confirm: false, shares: 0, choices: 0, modals: 0, fault: '', forwardFailed: false };
  app[slot] = state;
  ['chooseMessageFile','shareFileMessage','showModal','setStorageSync'].forEach(function(method) { state.originals[method] = { own: Object.prototype.hasOwnProperty.call(wx, method), fn: wx[method] }; });
  state.installed.chooseMessageFile = function(options) {
    state.choices++;
    if (state.choice === 'cancel') { if (options.fail) options.fail({ errMsg: 'chooseMessageFile:fail cancel' }); return; }
    var directory = wx.env.USER_DATA_PATH.replace(/\/$/, '') + '/dayflow-local-backup-fixture-' + state.nonce;
    if (['incoming.json','damaged.json','photo-incompatible.json','incoming-doing.json'].indexOf(state.choice) < 0) throw new Error('Invalid fixture selection');
    var filePath = directory + '/' + state.choice, info = wx.getFileSystemManager().statSync(filePath);
    options.success({ tempFiles: [{ name: state.choice, path: filePath, size: info.size }], type: 'file' });
  };
  state.installed.shareFileMessage = function(options) { state.shares++; state.lastSharedPath = options.filePath; if (options.success) options.success({}); };
  state.installed.showModal = function(options) { state.modals++; state.lastModalTitle = options.title; if (options.success) options.success({ confirm: state.confirm, cancel: !state.confirm }); };
  state.installed.setStorageSync = function(key, value) {
    if ((state.fault === 'once' || state.fault === 'incomplete') && !state.forwardFailed && key === 'dayflow.records.v2') { state.forwardFailed = true; throw new Error('Synthetic forward storage failure'); }
    if (state.fault === 'incomplete' && state.forwardFailed && key === 'dayflow.plans.v1') throw new Error('Synthetic rollback storage failure');
    return state.originals.setStorageSync.fn.call(wx, key, value);
  };
  Object.keys(state.installed).forEach(function(method) { wx[method] = state.installed[method]; });
  return { dayflowSmoke: true, installed: true, nonce: state.nonce };
}
function setHarness(input) {
  var state = getApp().__dayflowLocalBackupAcceptanceV1;
  if (!state || !input || state.nonce !== input.nonce) throw new Error('Acceptance harness mismatch');
  if (input.choice !== undefined) state.choice = input.choice;
  if (input.confirm !== undefined) state.confirm = input.confirm === true;
  if (input.fault !== undefined) { state.fault = input.fault; state.forwardFailed = false; }
  return { dayflowSmoke: true, configured: true };
}
function inspectHarness(nonce) {
  var state = getApp().__dayflowLocalBackupAcceptanceV1;
  if (!state || state.nonce !== nonce) throw new Error('Acceptance harness mismatch');
  return { dayflowSmoke: true, shares: state.shares, choices: state.choices, modals: state.modals, lastModalTitle: state.lastModalTitle || '', forwardFailed: state.forwardFailed };
}
function restoreHarness(nonce) {
  var app = getApp(), state = app.__dayflowLocalBackupAcceptanceV1;
  if (!state) return { dayflowSmoke: true, restored: true, absent: true };
  if (state.nonce !== nonce) throw new Error('Acceptance harness mismatch');
  Object.keys(state.originals).forEach(function(method) { if (wx[method] !== state.installed[method] && wx[method] !== state.originals[method].fn) throw new Error('The controlled API changed unexpectedly'); });
  Object.keys(state.originals).forEach(function(method) { if (state.originals[method].own) wx[method] = state.originals[method].fn; else delete wx[method]; });
  var exact = Object.keys(state.originals).every(function(method) { return wx[method] === state.originals[method].fn && Object.prototype.hasOwnProperty.call(wx, method) === state.originals[method].own; });
  if (!exact) throw new Error('Controlled APIs were not restored exactly');
  delete app.__dayflowLocalBackupAcceptanceV1;
  return { dayflowSmoke: true, restored: true };
}
function sdkContext() {
  var app = null, pages = [];
  try { app = getApp(); pages = getCurrentPages(); } catch (_) {}
  return { dayflowSmoke: true, appReady: !!app, pageReady: !!(pages && pages.length), harnessAbsent: !!app && !Object.prototype.hasOwnProperty.call(app, '__dayflowLocalBackupAcceptanceV1'), apisReady: ['chooseMessageFile','shareFileMessage','showModal','setStorageSync'].every(function(name) { return typeof wx[name] === 'function'; }) };
}
function storageComparison() {
  function stable(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
    return '{' + Object.keys(value).filter(function(key) { return value[key] !== undefined; }).sort().map(function(key) { return JSON.stringify(key) + ':' + stable(value[key]); }).join(',') + '}';
  }
  var keys = wx.getStorageInfoSync().keys.filter(function(key) { return key.indexOf('dayflow.') === 0; }).sort(), values = {};
  keys.forEach(function(key) { values[key] = { present: true, value: wx.getStorageSync(key) }; });
  return { dayflowSmoke: true, text: stable({ initialKeys: keys, keys: values }) };
}
function originalInterfaceReady() {
  var pages = getCurrentPages(), page = pages && pages[pages.length - 1], date = new Date();
  var today = [date.getFullYear(), String(date.getMonth()+1).padStart(2,'0'), String(date.getDate()).padStart(2,'0')].join('-');
  return { dayflowSmoke: true, ready: !!(page && page.route === 'pages/today/index' && page.data && page.data.selectedDate === today) };
}
function snapshotStorage() {
  var result = {}, keys = wx.getStorageInfoSync().keys.filter(function(key) { return key.indexOf('dayflow.') === 0; }).sort();
  keys.forEach(function(key) { result[key] = wx.getStorageSync(key); });
  return { dayflowSmoke: true, text: JSON.stringify(result), values: result };
}
function mutatePlan(nonce) {
  var template = wx.getStorageSync('dayflow.plans.v1');
  if (!template || template.id !== 'local-backup-acceptance-' + nonce) throw new Error('Synthetic plan mismatch');
  template.updatedAt += 1; wx.setStorageSync('dayflow.plans.v1', template);
  return { dayflowSmoke: true, changed: true };
}
function discoverFiles(input) {
  if (!input || !/^[a-f0-9]{32}$/.test(input.nonce) || !Array.isArray(input.before)) throw new Error('Invalid file manifest');
  var fs = wx.getFileSystemManager(), root = wx.env.USER_DATA_PATH.replace(/\/$/, ''), directory = root + '/dayflow-backups';
  var names = [];
  try { names = fs.readdirSync(directory).slice().sort(); } catch (error) { if (!/no such|not exist|ENOENT/i.test(String(error && (error.errMsg || error.message) || error))) throw error; }
  var files = Array.isArray(input.known) ? JSON.parse(JSON.stringify(input.known)) : [], expectedId = 'local-backup-acceptance-' + input.nonce;
  names.filter(function(name) { return input.before.indexOf(name) < 0; }).forEach(function(name) {
    if (!/^dayflow-(records|restore)-[A-Za-z0-9_-]+\.json$/.test(name)) throw new Error('Unexpected new file in the backup directory');
    var filePath = directory + '/' + name, text = fs.readFileSync(filePath, 'utf8'), data = JSON.parse(text);
    if (name.indexOf('dayflow-records-') === 0) { if (data.kind !== 'dayflow-local-record-backup' || !data.data || !data.data.plans || data.data.plans.id !== expectedId) throw new Error('The export is not owned by this acceptance run'); }
    else {
      var before = data.before && data.before['dayflow.plans.v1'], after = data.after && data.after['dayflow.plans.v1'];
      if (data.kind !== 'dayflow-local-record-restore-point' || typeof data.nonce !== 'string' || name.indexOf(data.nonce) < 0 || !before || !after || !before.present || !after.present || before.value.id !== expectedId || after.value.id !== expectedId) throw new Error('The journal is not owned by this acceptance run');
    }
    var known = files.filter(function(file) { return file.filePath === filePath; })[0];
    if (known) { if (known.fileName !== name || known.hash !== textHash(text) || known.chars !== text.length || known.kind !== data.kind) throw new Error('An already recorded acceptance file changed'); }
    else files.push({ filePath: filePath, fileName: name, hash: textHash(text), chars: text.length, kind: data.kind });
  });
  return { dayflowSmoke: true, files: files };
}
function cleanupAbsent(input) {
  if (!input || !/^[a-f0-9]{32}$/.test(input.nonce) || !Array.isArray(input.files)) throw new Error('Invalid cleanup verification');
  var fs = wx.getFileSystemManager(), root = wx.env.USER_DATA_PATH.replace(/\/$/, ''), absent = true;
  var missing = function(path) { try { fs.accessSync(path); return false; } catch (error) { if (/no such|not exist|ENOENT/i.test(String(error && (error.errMsg || error.message) || error))) return true; throw error; } };
  input.files.forEach(function(file) { if (!file || file.filePath !== root + '/dayflow-backups/' + file.fileName || !/^dayflow-(records|restore)-[A-Za-z0-9_-]+\.json$/.test(file.fileName)) throw new Error('Unsafe cleanup verification path'); if (!missing(file.filePath)) absent = false; });
  if (!missing(root + '/dayflow-local-backup-fixture-' + input.nonce)) absent = false;
  return { dayflowSmoke: true, absent: absent };
}
function cleanupFiles(input) {
  if (!input || !/^[a-f0-9]{32}$/.test(input.nonce) || !Array.isArray(input.before) || !Array.isArray(input.files)) throw new Error('Invalid cleanup manifest');
  var fs = wx.getFileSystemManager(), root = wx.env.USER_DATA_PATH.replace(/\/$/, ''), directory = root + '/dayflow-local-backup-fixture-' + input.nonce, backups = root + '/dayflow-backups';
  input.files.forEach(function(file) {
    if (!file || input.before.indexOf(file.fileName) >= 0 || !/^dayflow-(records|restore)-[A-Za-z0-9_-]+\.json$/.test(file.fileName) || file.filePath !== backups + '/' + file.fileName) throw new Error('Unsafe acceptance cleanup path');
    var text;
    try { text = fs.readFileSync(file.filePath, 'utf8'); } catch (error) { if (/no such|not exist|ENOENT/i.test(String(error && (error.errMsg || error.message) || error))) return; throw error; }
    if (typeof text !== 'string' || text.length !== file.chars || textHash(text) !== file.hash) throw new Error('Acceptance file changed after it was recorded');
    fs.unlinkSync(file.filePath);
  });
  var marker;
  try { marker = JSON.parse(fs.readFileSync(directory + '/owner.json', 'utf8')); } catch (error) {
    try { fs.accessSync(directory); } catch (missing) { if (/no such|not exist|ENOENT/i.test(String(missing && (missing.errMsg || missing.message) || missing))) return { dayflowSmoke: true, cleaned: true, absent: true }; }
    throw error;
  }
  if (marker.kind !== 'dayflow-local-backup-acceptance' || marker.nonce !== input.nonce || !Array.isArray(marker.files)) throw new Error('Acceptance directory ownership cannot be confirmed');
  var allowed = marker.files.map(function(file) { return file.name; }).concat(['owner.json']);
  if (fs.readdirSync(directory).some(function(name) { return allowed.indexOf(name) < 0; })) throw new Error('Unexpected files must not be removed');
  marker.files.forEach(function(file) {
    if (!/^[a-z][a-z0-9-]*\.(json|png)$/.test(file.name) || ['utf8','base64'].indexOf(file.encoding) < 0) throw new Error('Unsafe fixture cleanup name');
    var text;
    try { text = fs.readFileSync(directory + '/' + file.name, file.encoding); } catch (error) { if (/no such|not exist|ENOENT/i.test(String(error && (error.errMsg || error.message) || error))) return; throw error; }
    if (typeof text !== 'string' || text.length !== file.chars || textHash(text) !== file.hash) throw new Error('Fixture file changed after creation');
    fs.unlinkSync(directory + '/' + file.name);
  });
  fs.unlinkSync(directory + '/owner.json');
  if (fs.readdirSync(directory).length) throw new Error('Acceptance directory is not empty');
  fs.rmdirSync(directory, false);
  return { dayflowSmoke: true, cleaned: true, files: input.files.length + marker.files.length + 1 };
}
const inject = fn => fn.toString().replace(/\{/,'{ var textHash = ' + textHash.toString() + ';');
module.exports = { VALUE_KEYS, payload, textHash, setupFiles, listBackupFiles, preflightOriginal, seedValues, installHarness, setHarness, inspectHarness, restoreHarness, sdkContext, storageComparison, originalInterfaceReady, snapshotStorage, mutatePlan, discoverFiles, cleanupAbsent, cleanupFiles };
if (require.main === module) {
  if (process.argv[2] === '--comparison') {
    try {
      const saved = JSON.parse(require('node:fs').readFileSync(process.argv[3], 'utf8'));
      if (saved.schemaVersion !== 1 || !Array.isArray(saved.initialKeys) || !saved.keys || saved.initialKeys.some(key => !key.startsWith('dayflow.') || !saved.keys[key] || saved.keys[key].present !== true)) throw new Error('Invalid snapshot');
      const wx = { getStorageInfoSync: () => ({ keys: saved.initialKeys }), getStorageSync: key => saved.keys[key].value };
      process.stdout.write(JSON.stringify(new Function('wx', 'return (' + storageComparison.toString() + ')();')(wx)));
    } catch (_) { process.stderr.write('Acceptance snapshot comparison could not be prepared.'); process.exitCode = 1; }
  } else {
  const now = new Date(), date = process.argv[2] || [now.getFullYear(), String(now.getMonth()+1).padStart(2,'0'), String(now.getDate()).padStart(2,'0')].join('-'), nonce = process.argv[3];
  process.stdout.write(JSON.stringify({ payload: process.argv[4] === '--sources-only' ? null : payload(date, Date.now(), nonce), setupFiles: inject(setupFiles), listBackupFiles: listBackupFiles.toString(), preflightOriginal: inject(preflightOriginal), seedValues: seedValues.toString(), installHarness: installHarness.toString(), setHarness: setHarness.toString(), inspectHarness: inspectHarness.toString(), restoreHarness: restoreHarness.toString(), sdkContext: sdkContext.toString(), storageComparison: storageComparison.toString(), originalInterfaceReady: originalInterfaceReady.toString(), snapshotStorage: snapshotStorage.toString(), mutatePlan: mutatePlan.toString(), discoverFiles: inject(discoverFiles), cleanupAbsent: cleanupAbsent.toString(), cleanupFiles: inject(cleanupFiles) }));
  }
}
