import { DailyInstance, PlanTemplate, RecordEnvelope, TimeBlock } from '../types/domain';
import { localDateKey, parseLocalDate } from '../utils/calendar';
import { validatePlan } from '../utils/plan-validation';
import { validateEnvelope, validateLegacyRecords } from '../utils/record-validation';
import { exportInstancesForBackup, getTemplate, getTemplateVersions, validateInstances } from './plans';
import { exportEnvelope } from './records';
import { getPreferences, Preferences, validatePreferences } from './preferences';
import { readRestDays, RestDays, validateRestDays } from './rest-day-store';
import { getPhotos, PhotoRecord, validatePhotos } from './media';
import { getSyncState } from './sync';
import { getTimer } from './timer';
import { advanceLocalBackupEpoch, assertNoPendingLocalBackup } from './local-backup-guard';

export const LOCAL_BACKUP_RESTORE_POINT_KEY = 'dayflow.localBackup.restorePoint.v1';
export const MAX_LOCAL_BACKUP_BYTES = 4 * 1024 * 1024;
const MAX_JOURNAL_BYTES = 24 * 1024 * 1024;
const KIND = 'dayflow-local-record-backup';
const POINT_KIND = 'dayflow-local-record-restore-point';
const MANIFEST_KIND = 'dayflow-local-record-restore-manifest';
const KEYS = ['dayflow.plans.v1', 'dayflow.planVersions.v1', 'dayflow.instances.v1', 'dayflow.records.v2',
  'dayflow.records.v1', 'dayflow.preferences.v1', 'dayflow.restDays.v1'];
const MEDIA = 'dayflow.media.v1', SYNC_RESTORE = 'dayflow.sync.restoreBackup.v1';
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const object = (value: any) => !!value && typeof value === 'object' && !Array.isArray(value);
const absent = (value: any) => value === undefined || value === null || value === '';
const same = (left: any, right: any) => JSON.stringify(left) === JSON.stringify(right);
const exact = (value: any, fields: string[]) => object(value) && Object.keys(value).length === fields.length && fields.every(key => Object.prototype.hasOwnProperty.call(value, key));
const dateNow = () => localDateKey(new Date());

export interface LocalBackupData {
  plans: PlanTemplate; planVersions: PlanTemplate[]; instances: Record<string, DailyInstance>;
  records: RecordEnvelope; preferences: Preferences; restDays: RestDays;
}
export interface LocalBackupPackage { schemaVersion: 1; kind: 'dayflow-local-record-backup'; exportedAt: number; sourceDate: string; data: LocalBackupData; }
export interface LocalBackupSummary {
  exportedAt: number; sourceDate: string; planName: string; planVersion: number; scheduleCount: number;
  planVersionCount: number; snapshotCount: number; recordDateCount: number; recordCount: number;
  restDayCount: number; rangeStart: string; rangeEnd: string;
}
export interface LocalBackupPreview { ok: boolean; errors: string[]; warnings: string[]; summary: LocalBackupSummary | null; lease?: string; }
export interface LocalBackupFile { filePath: string; fileName: string; summary: LocalBackupSummary; }
export interface LocalBackupState {
  canUndo: boolean; reason: string; recoveryRequired: boolean; restoredAt?: number;
  blockingTimer?: { dateKey: string; targetId: string; updatedAt: number; status: 'running' | 'paused' };
}
interface RawSlot { present: boolean; value: any; }
type RawGroups = Record<string, RawSlot>;
interface ProtectedPhotos { media: RawSlot; syncRestore: RawSlot; }
interface PointManifest {
  schemaVersion: 1; kind: 'dayflow-local-record-restore-manifest'; state: 'writing' | 'restored' | 'recovery-required';
  filePath: string; fileName: string; nonce: string; createdAt: number;
  journalByteLength: number; journalChecksum: string;
}
interface Journal {
  schemaVersion: 1; kind: 'dayflow-local-record-restore-point'; nonce: string; createdAt: number;
  operation: 'restore' | 'undo'; before: RawGroups; after: RawGroups; previousPoint: RawSlot;
  protected: ProtectedPhotos; beforeSummary: LocalBackupSummary; afterSummary: LocalBackupSummary;
}
const warnings = ['照片原文件、云账户、订阅授权及运行计时不在备份中；本机照片保留。', '恢复后提醒默认关闭，需要你重新开启。'];

function utf8Bytes(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code < 128) bytes++; else if (code < 2048) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length && text.charCodeAt(index + 1) >= 0xdc00 && text.charCodeAt(index + 1) <= 0xdfff) { bytes += 4; index++; }
    else bytes += 3;
  }
  return bytes;
}
/** Corruption detection only: FNV-1a over the low then high byte of each UTF-16 code unit. */
function journalChecksum(text: string): string {
  let result = 2166136261;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    result = Math.imul(result ^ (code & 255), 16777619) >>> 0;
    result = Math.imul(result ^ (code >>> 8), 16777619) >>> 0;
  }
  return 'fnv1a32-utf16le:' + result.toString(16).padStart(8, '0');
}
function userMessage(error: any, fallback: string): string {
  const message = error && typeof error.message === 'string' ? error.message : '';
  return /^[\u3400-\u9fff]/.test(message) && message.length <= 240 && !/[\\/]|wxfile:|https?:|USER_DATA_PATH/i.test(message) ? message : fallback;
}
function bounded(text: string, limit = MAX_LOCAL_BACKUP_BYTES): void {
  if (typeof text !== 'string' || !text.length || text.length > limit || utf8Bytes(text) > limit) throw new Error('备份文件为空或超过四兆，请使用较小的有效备份');
}
function storageKeys(): string[] {
  const result = wx.getStorageInfoSync();
  if (!result || !Array.isArray(result.keys) || result.keys.some(key => typeof key !== 'string')) throw new Error('本机存储暂时无法读取，未修改数据');
  return result.keys;
}
function slot(key: string, keys = storageKeys()): RawSlot {
  if (!keys.includes(key)) return { present: false, value: null };
  const value = wx.getStorageSync(key);
  if (value === undefined) throw new Error('本机存储读取不完整，未修改数据');
  return { present: true, value: clone(value) };
}
function rawGroups(): RawGroups {
  const keys = storageKeys(), result: RawGroups = {};
  KEYS.forEach(key => { result[key] = slot(key, keys); });
  return result;
}
function validSlot(value: any): value is RawSlot { return exact(value, ['present', 'value']) && typeof value.present === 'boolean' && (value.present || value.value === null); }
function validGroups(value: any): value is RawGroups { return exact(value, KEYS) && KEYS.every(key => validSlot(value[key])); }
function validateRawValues(value: RawGroups): void {
  if (!validGroups(value)) throw new Error('恢复前副本格式无效，请保留本机文件');
  const read = (key: string) => value[key].present && !absent(value[key].value) ? value[key].value : undefined;
  const plan = read(KEYS[0]), versions = read(KEYS[1]), instances = read(KEYS[2]), records = read(KEYS[3]), legacy = read(KEYS[4]), preferences = read(KEYS[5]), rest = read(KEYS[6]);
  if (plan !== undefined && !validatePlan(plan).ok || versions !== undefined && (!Array.isArray(versions) || versions.some(item => !validatePlan(item).ok))) throw new Error('恢复前计划副本格式无效');
  if (instances !== undefined) validateInstances(instances);
  if (records !== undefined) validateEnvelope(records); else if (legacy !== undefined) validateLegacyRecords(legacy);
  if (preferences !== undefined) validatePreferences(preferences);
  if (rest !== undefined) validateRestDays(rest);
}
function protectedPhotos(): ProtectedPhotos { const keys = storageKeys(); return { media: slot(MEDIA, keys), syncRestore: slot(SYNC_RESTORE, keys) }; }
function hasDoing(records: RecordEnvelope): boolean { return Object.keys(records.byDate).some(date => Object.keys(records.byDate[date]).some(id => records.byDate[date][id].status === 'doing')); }
function assertIdle(checkRecords = true): void {
  const sync = getSyncState();
  if (sync.enabled) throw new Error('请先关闭云同步，再恢复本机备份');
  const queue = wx.getStorageSync('dayflow.sync.queue.v1');
  if (sync.pending || sync.queued || sync.conflict || sync.accountMismatch || !absent(queue)) throw new Error('请先处理待同步内容或同步冲突，再恢复备份');
  const timer = getTimer();
  if (timer && (timer.status === 'running' || timer.status === 'paused')) throw new Error('请先结束当前计时，再恢复备份');
  if (checkRecords && hasDoing(exportEnvelope())) throw new Error('请先结束正在执行的任务，再恢复备份');
}
function validatePackage(value: any): LocalBackupPackage {
  if (!exact(value, ['schemaVersion', 'kind', 'exportedAt', 'sourceDate', 'data']) || value.schemaVersion !== 1 || value.kind !== KIND ||
      !Number.isInteger(value.exportedAt) || value.exportedAt < 0 || !Number.isFinite(new Date(value.exportedAt).getTime()) || !exact(value.data, ['plans', 'planVersions', 'instances', 'records', 'preferences', 'restDays'])) throw new Error('这不是有效的本机记录备份，请选择导出的备份文件');
  parseLocalDate(value.sourceDate);
  const data = value.data;
  if (!validatePlan(data.plans).ok || !Array.isArray(data.planVersions) || data.planVersions.length > 2000 || data.planVersions.some((plan: any) => !validatePlan(plan).ok)) throw new Error('备份中的计划或历史版本无效');
  validateInstances(data.instances); validateEnvelope(data.records); validatePreferences(data.preferences); validateRestDays(data.restDays);
  if (data.preferences.subscriptionTemplateIds.length) throw new Error('备份不能包含订阅模板或授权配置，请重新导出本机记录备份');
  for (const date of Object.keys(data.records.byDate)) {
    if (Object.keys(data.records.byDate[date]).length && (!data.instances[date] || !data.instances[date].locked)) throw new Error('备份缺少执行记录对应的锁定日程，不能安全恢复');
  }
  return clone(value);
}
function parsePackage(text: string): LocalBackupPackage {
  bounded(text);
  let value: any;
  try { value = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text); }
  catch (_error) { throw new Error('备份内容无法解析，请重新选择有效的备份文件'); }
  return validatePackage(value);
}
function summarize(pack: LocalBackupPackage): LocalBackupSummary {
  const data = pack.data, recordDates = Object.keys(data.records.byDate).filter(date => Object.keys(data.records.byDate[date]).length);
  const dates = [...new Set(Object.keys(data.instances).concat(recordDates, Object.keys(data.restDays.byDate)))].sort();
  return { exportedAt: pack.exportedAt, sourceDate: pack.sourceDate, planName: data.plans.name, planVersion: data.plans.version,
    scheduleCount: data.plans.schedules.length, planVersionCount: data.planVersions.length, snapshotCount: Object.keys(data.instances).length,
    recordDateCount: recordDates.length, recordCount: recordDates.reduce((count, date) => count + Object.keys(data.records.byDate[date]).length, 0),
    restDayCount: Object.keys(data.restDays.byDate).length, rangeStart: dates[0] || '', rangeEnd: dates[dates.length - 1] || '' };
}
function targetBlock(blocks: TimeBlock[], id: string): TimeBlock | undefined {
  return blocks.find(block => block.kind !== 'fixed' && block.tasks.some(task => task.actions.length ? task.actions.some(action => action.id === id) : task.id === id));
}
function photoContexts(current: LocalBackupData): Array<{ photo: PhotoRecord; block: TimeBlock }> {
  const result: Array<{ photo: PhotoRecord; block: TimeBlock }> = [];
  const add = (photo: PhotoRecord, snapshots: Record<string, DailyInstance>) => {
    const snapshot = snapshots[photo.dateKey];
    // A stale unlocked cache cannot prove which task survives the next page read.
    const block = snapshot && snapshot.locked && targetBlock(snapshot.blocks, photo.targetId);
    if (!block) throw new Error('本机照片对应的历史日程不完整，无法安全恢复；照片已保留');
    result.push({ photo, block });
  };
  getPhotos().forEach(photo => add(photo, current.instances));
  const old = wx.getStorageSync(SYNC_RESTORE);
  if (!absent(old)) {
    if (!object(old) || !object(old.original) || !object(old.original.media) || typeof old.original.media.present !== 'boolean') throw new Error('同步恢复副本无法核对，未修改本机内容');
    if (old.original.media.present) {
      validatePhotos(old.original.media.value);
      const localPhotos: PhotoRecord[] = old.original.media.value.filter((photo: PhotoRecord) => !!photo.localPath);
      if (localPhotos.length) {
        const saved = old.original.instances;
        if (!object(saved) || saved.present !== true) throw new Error('同步副本中的照片日程缺失，无法安全恢复');
        validateInstances(saved.value);
        localPhotos.forEach((photo: PhotoRecord) => add(photo, saved.value));
      }
    }
  }
  return result;
}
function assertPhotoCompatibility(current: LocalBackupData, incoming: LocalBackupData): void {
  photoContexts(current).forEach(({ photo, block }) => {
    const snapshot = incoming.instances[photo.dateKey];
    const candidate = snapshot && snapshot.locked && targetBlock(snapshot.blocks, photo.targetId);
    if (!candidate || !same(candidate, block)) throw new Error('备份与本机照片对应的日程不一致，不能恢复；现有照片和记录已保留');
  });
}
export function createLocalBackup(): LocalBackupPackage {
  try {
  assertNoPendingLocalBackup();
  const photos = getPhotos();
  const pack = validatePackage({ schemaVersion: 1, kind: KIND, exportedAt: Date.now(), sourceDate: dateNow(), data: {
    plans: getTemplate(), planVersions: getTemplateVersions(), instances: exportInstancesForBackup(photos.map(photo => photo.dateKey)),
    records: exportEnvelope(), preferences: { ...getPreferences(), subscriptionTemplateIds: [] }, restDays: readRestDays()
  } });
  bounded(JSON.stringify(pack));
  return pack;
  } catch (error) { throw new Error(userMessage(error, '本机记录暂时无法读取，未修改原内容')); }
}
function context(): any {
  const keys = storageKeys();
  return { date: dateNow(), groups: rawGroups(), protected: protectedPhotos(), sync: getSyncState(),
    queue: slot('dayflow.sync.queue.v1', keys), conflict: slot('dayflow.sync.conflicts.v1', keys), timer: slot('dayflow.timer.v1', keys),
    point: slot(LOCAL_BACKUP_RESTORE_POINT_KEY, keys) };
}
function leaseFor(text: string): string { return JSON.stringify({ text, current: context() }); }
function failed(error: any): LocalBackupPreview { return { ok: false, errors: [userMessage(error, '备份暂时无法读取，原内容已保留')], warnings: warnings.slice(), summary: null }; }
export function previewLocalBackup(text: string): LocalBackupPreview {
  try {
    assertNoPendingLocalBackup(); assertIdle();
    const pack = parsePackage(text);
    if (hasDoing(pack.data.records)) throw new Error('备份中有进行中的任务，请先在原设备结束任务后重新备份');
    const current = createLocalBackup();
    assertPhotoCompatibility(current.data, pack.data);
    return { ok: true, errors: [], warnings: warnings.slice(), summary: summarize(pack), lease: leaseFor(text) };
  } catch (error) { return failed(error); }
}
function desiredGroups(data: LocalBackupData): RawGroups {
  const preferences = validatePreferences({ ...data.preferences, sleepReminderEnabled: false, taskReminderEnabled: false,
    subscriptionTemplateIds: getPreferences().subscriptionTemplateIds });
  return {
    [KEYS[0]]: { present: true, value: clone(data.plans) }, [KEYS[1]]: { present: true, value: clone(data.planVersions) },
    [KEYS[2]]: { present: true, value: clone(data.instances) }, [KEYS[3]]: { present: true, value: clone(data.records) },
    [KEYS[4]]: { present: false, value: null }, [KEYS[5]]: { present: true, value: preferences }, [KEYS[6]]: { present: true, value: clone(data.restDays) }
  };
}
function fsApi(): WechatMiniprogram.FileSystemManager {
  if (typeof wx.getFileSystemManager !== 'function' || !wx.env || typeof wx.env.USER_DATA_PATH !== 'string' || !wx.env.USER_DATA_PATH) throw new Error('当前微信暂不支持本机备份文件');
  try { return wx.getFileSystemManager(); } catch (_error) { throw new Error('本机文件暂时无法读取，请稍后重试'); }
}
function folder(): string { fsApi(); return wx.env.USER_DATA_PATH.replace(/\/$/, '') + '/dayflow-backups'; }
function safePath(path: string, fileName: string): boolean { return typeof path === 'string' && path.length <= 2048 && path === folder() + '/' + fileName && !/(^|\/)\.\.(\/|$)/.test(path) && path.indexOf('\0') < 0; }
function readFile(path: string, limit: number): string {
  const files = fsApi(); let stats: any;
  try { stats = files.statSync(path); } catch (_error) { throw new Error('备份文件暂时无法读取，请重新选择'); }
  if (!stats || Array.isArray(stats) || !Number.isFinite(stats.size) || stats.size < 1 || stats.size > limit || (typeof stats.isFile === 'function' && !stats.isFile())) throw new Error('备份文件大小或类型无效');
  let text: string | ArrayBuffer;
  try { text = files.readFileSync(path, 'utf8'); } catch (_error) { throw new Error('备份文件未能读取，请重新选择'); }
  if (typeof text !== 'string' || utf8Bytes(text) > limit) throw new Error('备份文件未能完整读取');
  return text;
}
function directoryFiles(files: WechatMiniprogram.FileSystemManager, dir: string): string[] {
  try { files.mkdirSync(dir, true); }
  catch (_error) {
    let stats: any;
    try { stats = files.statSync(dir); } catch (_statError) { throw new Error('备份目录暂不可用，请检查空间后重试'); }
    if (!stats || typeof stats.isDirectory !== 'function' || !stats.isDirectory()) throw new Error('备份目录暂不可用，请检查空间后重试');
  }
  try {
    const names = files.readdirSync(dir);
    if (!Array.isArray(names) || names.some(name => typeof name !== 'string')) throw new Error();
    return names;
  } catch (_error) { throw new Error('备份目录暂时无法读取，请稍后重试'); }
}
function newFile(prefix: 'records' | 'restore', text: string): { filePath: string; fileName: string; nonce: string } {
  const files = fsApi(), dir = folder();
  const names = directoryFiles(files, dir);
  const nonce = Date.now().toString(36) + '-' + (Math.random().toString(36).slice(2, 12) || '0');
  const fileName = 'dayflow-' + prefix + '-' + (prefix === 'records' ? dateNow() + '-' : '') + Date.now() + '-' + nonce + '.json';
  const filePath = dir + '/' + fileName;
  if (names.includes(fileName)) throw new Error('备份文件名已存在，请重新尝试，原文件未覆盖');
  try {
    files.writeFileSync(filePath, text, 'utf8');
    if (readFile(filePath, prefix === 'records' ? MAX_LOCAL_BACKUP_BYTES : MAX_JOURNAL_BYTES) !== text) throw new Error('文件读回不一致');
  } catch (_error) {
    try { files.unlinkSync(filePath); } catch (_cleanupError) { /* Only this newly created file is eligible. */ }
    throw new Error('备份文件未能完整保存，请检查空间后重试，原记录未修改');
  }
  return { filePath, fileName, nonce };
}
const exportedFiles = new Map<string, { fileName: string; text: string }>();
export async function exportLocalBackupFile(): Promise<LocalBackupFile> {
  try {
  const pack = createLocalBackup(), text = JSON.stringify(pack);
  const file = newFile('records', text); exportedFiles.clear(); exportedFiles.set(file.filePath, { fileName: file.fileName, text });
  return { filePath: file.filePath, fileName: file.fileName, summary: summarize(pack) };
  } catch (error) { throw new Error(userMessage(error, '备份文件未能导出，原记录已保留')); }
}
export async function chooseLocalBackupFile(): Promise<{ text: string; fileName: string; preview: LocalBackupPreview }> {
  try {
  if (typeof wx.chooseMessageFile !== 'function') throw new Error('当前微信暂不支持选择备份文件');
  const result = await new Promise<WechatMiniprogram.ChooseMessageFileSuccessCallbackResult>((resolve, reject) => wx.chooseMessageFile({
    count: 1, type: 'file', extension: ['json'], success: resolve,
    fail: error => reject(new Error(/cancel/i.test(error.errMsg || '') ? '已取消选择备份，当前内容没有改变' : '未能选择备份文件，请稍后重试'))
  }));
  const file = result.tempFiles && result.tempFiles[0];
  if (!file || typeof file.path !== 'string' || !file.path || typeof file.name !== 'string' || !/\.json$/i.test(file.name) || !Number.isFinite(file.size) || file.size < 1 || file.size > MAX_LOCAL_BACKUP_BYTES) throw new Error('请选择不超过四兆的JSON备份文件');
  const text = readFile(file.path, MAX_LOCAL_BACKUP_BYTES);
  return { text, fileName: file.name.slice(0, 160), preview: previewLocalBackup(text) };
  } catch (error) { throw new Error(userMessage(error, '备份文件暂时无法读取，请重新选择')); }
}
export function shareLocalBackupFile(file: LocalBackupFile): Promise<void> {
  const known = file && exportedFiles.get(file.filePath);
  if (!file || !known || known.fileName !== file.fileName || !/^dayflow-records-\d{4}-\d{2}-\d{2}-\d{1,16}-[a-z0-9]+-[a-z0-9]{1,12}\.json$/.test(file.fileName) || !safePath(file.filePath, file.fileName)) return Promise.reject(new Error('请先重新导出备份文件'));
  try { const text = readFile(file.filePath, MAX_LOCAL_BACKUP_BYTES); parsePackage(text); if (text !== known.text) throw new Error('导出文件已变化'); }
  catch (_error) { return Promise.reject(new Error('导出文件已变化或无法读取，请重新导出后发送')); }
  if (typeof wx.shareFileMessage !== 'function') return Promise.reject(new Error('当前微信暂不支持发送备份，导出文件仍保留在本机'));
  return new Promise((resolve, reject) => wx.shareFileMessage({ filePath: file.filePath, fileName: file.fileName,
    success: () => resolve(), fail: error => reject(new Error(/cancel/i.test(error.errMsg || '') ? '已取消发送，导出文件仍保留在本机' : '文件未能发送，导出文件仍保留在本机')) }));
}
function validateManifest(value: any): PointManifest {
  if (!exact(value, ['schemaVersion', 'kind', 'state', 'filePath', 'fileName', 'nonce', 'createdAt', 'journalByteLength', 'journalChecksum']) || value.schemaVersion !== 1 || value.kind !== MANIFEST_KIND ||
      !['writing', 'restored', 'recovery-required'].includes(value.state) || !Number.isInteger(value.createdAt) || value.createdAt < 0 || !Number.isFinite(new Date(value.createdAt).getTime()) ||
      typeof value.nonce !== 'string' || !/^[a-z0-9]+-[a-z0-9]{1,12}$/.test(value.nonce) || typeof value.fileName !== 'string' ||
      !/^dayflow-restore-\d{1,16}-[a-z0-9]+-[a-z0-9]{1,12}\.json$/.test(value.fileName) || !value.fileName.endsWith('-' + value.nonce + '.json') || !safePath(value.filePath, value.fileName) ||
      !Number.isInteger(value.journalByteLength) || value.journalByteLength < 1 || value.journalByteLength > MAX_JOURNAL_BYTES ||
      typeof value.journalChecksum !== 'string' || !/^fnv1a32-utf16le:[a-f0-9]{8}$/.test(value.journalChecksum)) throw new Error('恢复前副本索引无法读取，请保留本机文件');
  return clone(value);
}
function pointValue(): RawSlot {
  const present = storageKeys().includes(LOCAL_BACKUP_RESTORE_POINT_KEY), value = wx.getStorageSync(LOCAL_BACKUP_RESTORE_POINT_KEY);
  if (!present) {
    if (value !== undefined && value !== '') throw new Error('恢复前副本索引读取不一致，请保留本机内容');
    return { present: false, value: null };
  }
  return { present: true, value };
}
function readPoint(): { manifest: PointManifest; journal: Journal } | null {
  const raw = pointValue();
  if (!raw.present) return null;
  const manifest = validateManifest(raw.value);
  let journal: any;
  try {
    const text = readFile(manifest.filePath, MAX_JOURNAL_BYTES);
    if (utf8Bytes(text) !== manifest.journalByteLength || journalChecksum(text) !== manifest.journalChecksum) throw new Error('副本校验不一致');
    journal = JSON.parse(text);
  } catch (_error) { throw new Error('恢复前副本文件无法读取或校验不一致，请保留本机文件'); }
  if (!exact(journal, ['schemaVersion', 'kind', 'nonce', 'createdAt', 'operation', 'before', 'after', 'previousPoint', 'protected', 'beforeSummary', 'afterSummary']) ||
      journal.schemaVersion !== 1 || journal.kind !== POINT_KIND || journal.nonce !== manifest.nonce || journal.createdAt !== manifest.createdAt ||
      !['restore', 'undo'].includes(journal.operation) || !validSlot(journal.previousPoint) || !exact(journal.protected, ['media', 'syncRestore']) ||
      !validSlot(journal.protected.media) || !validSlot(journal.protected.syncRestore)) throw new Error('恢复前副本内容无效，请保留本机文件');
  validateRawValues(journal.before); validateRawValues(journal.after);
  if (!object(journal.beforeSummary) || !object(journal.afterSummary)) throw new Error('恢复前副本摘要无效');
  return { manifest, journal };
}
function writeSlot(key: string, value: RawSlot): void { if (value.present) wx.setStorageSync(key, clone(value.value)); else wx.removeStorageSync(key); }
function restoreGroups(target: RawGroups): boolean {
  for (const key of KEYS.slice().reverse()) {
    try { if (!same(slot(key), target[key])) writeSlot(key, target[key]); } catch (_error) { /* Read back every key before claiming rollback. */ }
  }
  try { return same(rawGroups(), target); } catch (_error) { return false; }
}
function writeManifest(value: PointManifest): void {
  wx.setStorageSync(LOCAL_BACKUP_RESTORE_POINT_KEY, clone(value));
  if (!same(wx.getStorageSync(LOCAL_BACKUP_RESTORE_POINT_KEY), value)) throw new Error('恢复前副本索引未能保存');
}
function restorePointSlot(value: RawSlot): boolean {
  try { if (!same(slot(LOCAL_BACKUP_RESTORE_POINT_KEY), value)) writeSlot(LOCAL_BACKUP_RESTORE_POINT_KEY, value); return same(slot(LOCAL_BACKUP_RESTORE_POINT_KEY), value); }
  catch (_error) { return false; }
}
function transaction(target: RawGroups, beforeSummary: LocalBackupSummary, afterSummary: LocalBackupSummary, operation: 'restore' | 'undo'): void {
  advanceLocalBackupEpoch();
  const before = rawGroups(), previousPoint = slot(LOCAL_BACKUP_RESTORE_POINT_KEY), protectedValue = protectedPhotos();
  validateRawValues(before); validateRawValues(target);
  const createdAt = Date.now();
  // A journal is immutable once persisted. Only its small manifest changes state.
  const nonce = createdAt.toString(36) + '-' + (Math.random().toString(36).slice(2, 12) || '0');
  const journal: Journal = { schemaVersion: 1, kind: POINT_KIND, nonce, createdAt, operation, before, after: clone(target), previousPoint,
    protected: protectedValue, beforeSummary, afterSummary };
  let text = JSON.stringify(journal);
  if (utf8Bytes(text) > MAX_JOURNAL_BYTES) throw new Error('恢复前副本过大，未修改本机内容');
  // newFile creates the name nonce. Embed that actual nonce before a single final write.
  const files = fsApi(), dir = folder();
  const names = directoryFiles(files, dir);
  const fileName = 'dayflow-restore-' + createdAt + '-' + nonce + '.json', filePath = dir + '/' + fileName;
  if (names.includes(fileName)) throw new Error('恢复前副本文件已存在，未修改数据');
  try { files.writeFileSync(filePath, text, 'utf8'); if (readFile(filePath, MAX_JOURNAL_BYTES) !== text) throw new Error('恢复前副本读回不一致'); }
  catch (_error) { try { files.unlinkSync(filePath); } catch (_cleanupError) {} throw new Error('恢复前副本未能保存，计划和记录没有改变'); }
  const manifest: PointManifest = { schemaVersion: 1, kind: MANIFEST_KIND, state: 'writing', filePath, fileName, nonce, createdAt,
    journalByteLength: utf8Bytes(text), journalChecksum: journalChecksum(text) };
  try { writeManifest(manifest); }
  catch (_error) {
    restorePointSlot(previousPoint);
    throw new Error('恢复前副本索引未能保存，计划和记录没有改变');
  }
  try {
    for (const key of KEYS) writeSlot(key, target[key]);
    if (!same(rawGroups(), target)) throw new Error('恢复内容读回不一致');
  } catch (_error) {
    if (restoreGroups(before) && restorePointSlot(previousPoint)) throw new Error('恢复未完成，操作前的内容已精确回滚');
    try { writeManifest({ ...manifest, state: 'recovery-required' }); } catch (_pointError) { /* The original writing manifest still retains the journal. */ }
    throw new Error('恢复尚未完成，请先继续恢复操作前的数据，暂勿执行其他任务');
  }
  // The complete target has been verified. An uncertain commit-marker result must
  // never turn it into a mixed business image through a second rollback attempt.
  try {
    if (operation === 'restore') writeManifest({ ...manifest, state: 'restored' });
    else { wx.removeStorageSync(LOCAL_BACKUP_RESTORE_POINT_KEY); if (slot(LOCAL_BACKUP_RESTORE_POINT_KEY).present) throw new Error('撤销索引未能清除'); }
  } catch (_error) {
    throw new Error(operation === 'restore'
      ? '备份内容已写入，请重新检查恢复状态；恢复前副本仍保留'
      : '原内容已恢复，请重新检查恢复状态；恢复前副本仍保留');
  }
}
export function restoreLocalBackup(text: string, lease: string): void {
  try {
  const preview = previewLocalBackup(text);
  if (!preview.ok) throw new Error(preview.errors[0]);
  if (!lease || preview.lease !== lease) throw new Error('本机内容或日期已变化，请重新选择并预览备份');
  const pack = parsePackage(text), current = createLocalBackup();
  transaction(desiredGroups(pack.data), summarize(current), summarize(pack), 'restore');
  } catch (error) { throw new Error(userMessage(error, '恢复未完成，请保留本机内容与备份后重试')); }
}
function recoveryAllowed(journal: Journal, current: RawGroups): boolean {
  return KEYS.every(key => same(current[key], journal.before[key]) || same(current[key], journal.after[key]));
}
function undoLease(point: { manifest: PointManifest; journal: Journal }): string { return JSON.stringify({ manifest: point.manifest, current: context() }); }
function undoCheck(point: { manifest: PointManifest; journal: Journal }): void {
  const recovering = point.manifest.state !== 'restored';
  assertIdle(!recovering);
  if (!same(protectedPhotos(), point.journal.protected)) throw new Error('本机照片或其保留副本已变化，不能直接覆盖；恢复前副本仍保留');
  const current = rawGroups();
  if (recovering ? !recoveryAllowed(point.journal, current) : !same(current, point.journal.after)) throw new Error('恢复后本机内容已变化，不能直接撤销；恢复前副本仍保留');
}
export function getLocalBackupState(): LocalBackupState {
  let recovering = true;
  let blockingTimer: LocalBackupState['blockingTimer'];
  try {
    const raw = pointValue();
    recovering = raw.present;
    if (raw.present) recovering = validateManifest(raw.value).state !== 'restored';
    if (!recovering) {
      const timer = getTimer();
      if (timer && (timer.status === 'running' || timer.status === 'paused')) blockingTimer = { dateKey: timer.dateKey, targetId: timer.targetId, updatedAt: timer.updatedAt, status: timer.status };
    }
    if (!raw.present) return { canUndo: false, recoveryRequired: false, reason: blockingTimer ? '请先结束当前计时，再恢复备份' : '尚无可撤销的恢复', ...(blockingTimer ? { blockingTimer } : {}) };
    const point = readPoint()!; undoCheck(point);
    return { canUndo: point.manifest.state === 'restored', recoveryRequired: recovering, restoredAt: point.manifest.createdAt,
      reason: recovering ? '上次恢复未完成，请继续恢复操作前的数据' : '' };
  } catch (error) { return { canUndo: false, recoveryRequired: recovering, reason: userMessage(error, '恢复前副本暂不可读取'), ...(blockingTimer ? { blockingTimer } : {}) }; }
}
export function previewUndoLocalBackup(): LocalBackupPreview {
  try {
    const point = readPoint(); if (!point) throw new Error('尚无可撤销的恢复');
    undoCheck(point);
    return { ok: true, errors: [], warnings: ['将恢复上次操作前的本机内容；照片、云账户和订阅授权不变。'],
      summary: clone(point.journal.beforeSummary), lease: undoLease(point) };
  } catch (error) { return failed(error); }
}
export function undoLocalBackup(lease: string): void {
  try {
  const point = readPoint(); if (!point) throw new Error('尚无可撤销的恢复');
  undoCheck(point);
  if (!lease || lease !== undoLease(point)) throw new Error('本机内容或日期已变化，请重新确认');
  if (point.manifest.state !== 'restored') {
    advanceLocalBackupEpoch();
    if (!restoreGroups(point.journal.before)) throw new Error('操作前的数据仍未完全恢复，请保留副本后重试');
    if (!restorePointSlot(point.journal.previousPoint)) throw new Error('原内容已恢复，恢复前副本索引仍需重试');
    return;
  }
  transaction(point.journal.before, point.journal.afterSummary, point.journal.beforeSummary, 'undo');
  } catch (error) { throw new Error(userMessage(error, '撤销未完成，请保留本机内容与恢复前副本')); }
}
