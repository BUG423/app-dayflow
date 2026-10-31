import { getTemplate, getTemplateVersions, getSnapshotDates, validateInstances } from './plans';
import { exportEnvelope, replaceEnvelope, validateEnvelope } from './records';
import { getPreferences, validatePreferences } from './preferences';
import { getPhotos, markPhotoUploaded, PhotoRecord, validatePhotos } from './media';
import { validatePlan } from '../utils/plan-validation';

export interface SyncState {
  enabled: boolean; envId: string; version: number; accountId: string;
  queued: boolean; conflict: boolean; lastSyncedAt?: number; lastError?: string;
  configured: boolean; pending: boolean; accountMismatch?: boolean;
}
export interface SyncPayload { schemaVersion: 1; plans: any; planVersions: any[]; instances: any; records: any; preferences: any; media: any[] }
export interface SyncResult { status: 'disabled' | 'unconfigured' | 'synced' | 'queued' | 'conflict' | 'offline' | 'account-mismatch'; message: string }
const STATE = 'dayflow.sync.v1';
const QUEUE = 'dayflow.sync.queue.v1';
const CONFLICT = 'dayflow.sync.conflicts.v1';
const RESTORE_BACKUP = 'dayflow.sync.restoreBackup.v1';
const keys = {
  plans: 'dayflow.plans.v1', planVersions: 'dayflow.planVersions.v1', instances: 'dayflow.instances.v1',
  records: 'dayflow.records.v2', preferences: 'dayflow.preferences.v1', media: 'dayflow.media.v1'
};
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const absent = (value: any) => value === '' || value === undefined || value === null;
const object = (value: any) => !!value && typeof value === 'object' && !Array.isArray(value);
let busy = false;
let initializedEnv = '';
function storedState(): any {
  const raw = wx.getStorageSync(STATE);
  if (absent(raw)) return { enabled: false, envId: '', version: 0, accountId: '', queued: false, conflict: false };
  if (!object(raw) || typeof raw.enabled !== 'boolean' || typeof raw.envId !== 'string' ||
      !Number.isInteger(raw.version) || raw.version < 0 || typeof raw.accountId !== 'string' ||
      typeof raw.queued !== 'boolean' || typeof raw.conflict !== 'boolean') throw new Error('同步设置无法读取，原数据已保留');
  return clone(raw);
}
function saveState(value: any): void { wx.setStorageSync(STATE, value); }
export function getSyncState(): SyncState {
  const state = storedState();
  return { ...state, configured: !!state.envId && !!wx.cloud, pending: busy };
}
export function configureSync(config: { enabled: boolean; envId: string }): SyncState {
  if (!config || typeof config.enabled !== 'boolean' || typeof config.envId !== 'string' ||
      (config.envId !== '' && !/^[A-Za-z0-9_-]{1,128}$/.test(config.envId))) throw new Error('云端配置无效');
  if (config.enabled && !config.envId) throw new Error('云服务尚未连接，可以继续使用本机记录');
  const previous = storedState();
  const changed = previous.envId && previous.envId !== config.envId;
  if (changed) {
    // Switching a deployment must not silently reuse an old account's version.
    wx.setStorageSync('dayflow.sync.previousBinding.v1', previous);
    saveState({ enabled: false, envId: config.envId, version: 0, accountId: '', queued: false, conflict: false });
  } else saveState({ ...previous, enabled: config.enabled, envId: config.envId });
  return getSyncState();
}
function initialize(state: any): void {
  if (!state.enabled || !state.envId || !wx.cloud) throw new Error('请先选择开启已连接的云同步');
  if (initializedEnv !== state.envId) { wx.cloud.init({ env: state.envId, traceUser: false }); initializedEnv = state.envId; }
}
async function cloudCall(action: string, data: any, state: any): Promise<any> {
  initialize(state);
  const response: any = await new Promise((resolve, reject) => wx.cloud.callFunction({
    name: 'dayflowSync', data: { action, ...data }, config: { env: state.envId },
    success: resolve, fail: () => reject(new Error('云端暂时无法连接，本机记录仍然保留'))
  }));
  const result = response && response.result;
  if (!object(result) || result.ok !== true) throw new Error('云端未完成操作，本机记录仍然保留');
  return result;
}
function validatePayload(payload: any): SyncPayload {
  if (!object(payload) || payload.schemaVersion !== 1 ||
      Object.keys(payload).some(key => ['schemaVersion', ...Object.keys(keys)].indexOf(key) < 0)) throw new Error('同步内容格式无效');
  if (!validatePlan(payload.plans).ok || !Array.isArray(payload.planVersions) || payload.planVersions.some((plan: any) => !validatePlan(plan).ok)) throw new Error('同步计划格式无效');
  validateInstances(payload.instances); validateEnvelope(payload.records); validatePreferences(payload.preferences);
  validatePhotos(payload.media);
  if (payload.media.some((photo: any) => typeof photo.cloudFileID !== 'string' || Object.prototype.hasOwnProperty.call(photo, 'localPath'))) throw new Error('云端照片记录格式无效');
  return clone(payload);
}
function capture(): SyncPayload {
  // These APIs perform strict reads, including legacy migration validation.
  const records = exportEnvelope();
  const plans = getTemplate();
  const planVersions = getTemplateVersions();
  getSnapshotDates();
  const instances = wx.getStorageSync(keys.instances);
  const preferences = getPreferences();
  const media = getPhotos().filter(photo => !!photo.cloudFileID).map(photo => ({
    id: photo.id, dateKey: photo.dateKey, targetId: photo.targetId, createdAt: photo.createdAt, cloudFileID: photo.cloudFileID
  }));
  return validatePayload({ schemaVersion: 1, plans, planVersions, instances: absent(instances) ? {} : instances, records, preferences, media });
}
async function identity(state: any, allowManagementWhenDisabled = false): Promise<any> {
  const result = await cloudCall('identity', {}, allowManagementWhenDisabled ? { ...state, enabled: true } : state);
  if (typeof result.accountId !== 'string' || !/^[a-f0-9]{64}$/.test(result.accountId) ||
      result.uploadPrefix !== 'dayflow-photos/' + result.accountId + '/') throw new Error('未能确认当前云端账户');
  if (state.accountId && state.accountId !== result.accountId) {
    saveState({ ...state, accountMismatch: true, lastError: '账户已变化，请切回原账户后同步' });
    return null;
  }
  if (!state.accountId) { state.accountId = result.accountId; saveState(state); }
  return result;
}
// Other optional cloud features share the same explicit consent and account boundary.
export async function getTrustedCloudContext(options: { allowReminderManagementWhenDisabled?: boolean } = {}): Promise<{ envId: string; accountId: string }> {
  const state = storedState();
  // Explicit list/cancel remains available after sync was disabled. It neither
  // uploads historical data nor reenables sync; an existing binding is required.
  const managementOnly = options.allowReminderManagementWhenDisabled && !state.enabled && !!state.accountId;
  const trusted = await identity(state, managementOnly);
  if (!trusted) throw new Error('账户已变化，请切回原账户后操作');
  return { envId: state.envId, accountId: trusted.accountId };
}
export async function syncNow(): Promise<SyncResult> {
  const state = storedState();
  if (!state.envId || !wx.cloud) return { status: 'unconfigured', message: '云服务尚未连接，可以继续使用本机记录' };
  if (!state.enabled) return { status: 'disabled', message: '云同步尚未开启' };
  if (busy) return { status: 'queued', message: '正在同步，请稍候' };
  if (state.conflict) return { status: 'conflict', message: '两份内容都已保留，请先选择要使用的内容' };
  const payload = capture();
  wx.setStorageSync(QUEUE, payload);
  state.queued = true; saveState(state);
  busy = true;
  try {
    if (!await identity(state)) return { status: 'account-mismatch', message: '账户已变化，请切回原账户后同步' };
    const result = await cloudCall('push', { expectedVersion: state.version, payload }, state);
    if (result.conflict === true) {
      if (!Number.isInteger(result.version) || result.version < 0) throw new Error('云端版本信息无效');
      const remote = validatePayload(result.payload);
      wx.setStorageSync(CONFLICT, { local: payload, remote, remoteVersion: result.version, accountId: state.accountId, envId: state.envId, at: Date.now() });
      saveState({ ...state, conflict: true, queued: true, lastError: '' });
      return { status: 'conflict', message: '发现两份不同内容，均已保留，请自行选择' };
    }
    if (!Number.isInteger(result.version) || result.version !== state.version + 1) throw new Error('云端版本确认失败');
    const changedDuringSync = JSON.stringify(capture()) !== JSON.stringify(payload);
    if (!changedDuringSync) wx.setStorageSync(QUEUE, null);
    else wx.setStorageSync(QUEUE, capture());
    saveState({ ...state, version: result.version, queued: changedDuringSync, conflict: false, accountMismatch: false, lastSyncedAt: Date.now(), lastError: '' });
    return { status: changedDuringSync ? 'queued' : 'synced', message: changedDuringSync ? '本次已同步，新修改将在下次继续同步' : '同步完成，本机记录继续保留' };
  } catch (_err) {
    saveState({ ...storedState(), queued: true, lastError: '连接暂不可用，待同步内容已保存在本机' });
    return { status: 'offline', message: '连接暂不可用，待同步内容已保存在本机' };
  } finally { busy = false; }
}
function restorePayload(remote: SyncPayload): void {
  validatePayload(remote);
  const original: Record<string, any> = {};
  Object.keys(keys).forEach(name => {
    const value = wx.getStorageSync(keys[name]);
    original[name] = { present: !absent(value), value: absent(value) ? null : clone(value) };
  });
  wx.setStorageSync(RESTORE_BACKUP, { original, remote, at: Date.now() });
  const written: string[] = [];
  try {
    Object.keys(keys).forEach(name => {
      const value = name === 'media'
        ? [...getPhotos().filter(photo => !photo.cloudFileID && !remote.media.some(item => item.id === photo.id)), ...remote.media.map(photo => {
          const local = getPhotos().find(item => item.id === photo.id);
          return { ...photo, ...(local && local.localPath && local.cloudFileID === photo.cloudFileID ? { localPath: local.localPath } : {}) };
        })] : remote[name];
      if (name === 'media') validatePhotos(value);
      written.push(name);
      if (name === 'records') replaceEnvelope(value);
      else wx.setStorageSync(keys[name], value);
    });
  } catch (_err) {
    let rollbackFailed = false;
    written.reverse().forEach(name => {
      try { if (original[name].present) wx.setStorageSync(keys[name], original[name].value); else wx.removeStorageSync(keys[name]); }
      catch (_rollbackError) { rollbackFailed = true; }
    });
    throw new Error(rollbackFailed ? '恢复未完成，请保留本机备份并停止继续同步' : '恢复未完成，原始内容已回滚并保留备份');
  }
}
export async function resolveSyncConflict(choice: 'local' | 'remote'): Promise<SyncResult> {
  if (choice !== 'local' && choice !== 'remote') throw new Error('请选择要使用的内容');
  if (busy) throw new Error('正在处理同步，请稍候');
  const state = storedState();
  const conflict = wx.getStorageSync(CONFLICT);
  if (!state.conflict || !object(conflict) || conflict.accountId !== state.accountId || conflict.envId !== state.envId) throw new Error('未找到可处理的同步冲突');
  const before = JSON.stringify(capture());
  busy = true;
  try {
    if (!await identity(state)) return { status: 'account-mismatch', message: '账户已变化，请切回原账户后同步' };
    validatePayload(conflict.local); validatePayload(conflict.remote);
    if (choice === 'remote') {
      if (JSON.stringify(capture()) !== before) throw new Error('本机内容刚刚发生变化，请重新查看两份内容后再选择');
      restorePayload(conflict.remote);
      saveState({ ...state, version: conflict.remoteVersion, conflict: false, queued: false, lastSyncedAt: Date.now(), lastError: '' });
      return { status: 'synced', message: '已使用云端内容，原始本机副本仍保留在恢复备份中' };
    }
    saveState({ ...state, version: conflict.remoteVersion, conflict: false, queued: true });
  } finally { busy = false; }
  return syncNow();
}
export async function uploadPhoto(id: string): Promise<PhotoRecord> {
  const state = storedState();
  initialize(state);
  const current = await identity(state);
  if (!current) throw new Error('账户已变化，请切回原账户后上传');
  if (current.mediaEnabled !== true) throw new Error('云端照片暂不可用，本机照片仍保留');
  const photo = getPhotos().find(item => item.id === id);
  if (!photo || !photo.localPath) throw new Error('未找到本机保存的照片');
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(photo.id)) throw new Error('照片标识无效');
  const uploaded: any = await new Promise((resolve, reject) => wx.cloud.uploadFile({
    cloudPath: current.uploadPrefix + photo.id + '.jpg', filePath: photo.localPath,
    success: resolve, fail: () => reject(new Error('上传未完成，本机照片已保留'))
  }));
  await cloudCall('validateMedia', { fileID: uploaded.fileID }, state);
  const result = markPhotoUploaded(id, uploaded.fileID);
  wx.setStorageSync(QUEUE, capture());
  saveState({ ...storedState(), queued: true });
  return result;
}
export async function getPhotoPreviewPath(photo: PhotoRecord): Promise<string> {
  if (photo.localPath) return photo.localPath;
  if (!photo.cloudFileID) throw new Error('照片暂时不可用');
  const state = storedState(); initialize(state);
  const current = await identity(state);
  if (!current) throw new Error('账户已变化，请切回原账户后查看');
  if (current.mediaEnabled !== true) throw new Error('云端照片暂不可用，本机照片仍保留');
  await cloudCall('validateMedia', { fileID: photo.cloudFileID }, state);
  const result: any = await new Promise((resolve, reject) => wx.cloud.getTempFileURL({
    fileList: [photo.cloudFileID], success: resolve, fail: () => reject(new Error('暂时无法读取云端照片'))
  }));
  const item = result.fileList && result.fileList[0];
  if (!item || !item.tempFileURL || item.status !== 0) throw new Error('暂时无法读取云端照片');
  return item.tempFileURL;
}
