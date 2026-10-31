import { getDayBlocks, lockDailyInstance } from './plans';
import { assertExecutionAllowed } from './rest-day-store';
import { getLegacyBlocksForDate } from '../data/legacy-template';
import { validId, checkDate, checkStatus, checkFeedback, validateEnvelope, validateLegacyRecords } from '../utils/record-validation';
export { validateEnvelope } from '../utils/record-validation';
import { ExecutionRecord, RecordEnvelope, TaskStatus, TrainingFeedback } from '../types/domain';

export type Status = TaskStatus;
type DateRecords = Record<string, TaskStatus>;
type AllRecords = Record<string, DateRecords>;
const LEGACY = 'dayflow.records.v1', STORE = 'dayflow.records.v2', REVIEW = 'dayflow.review.v1';
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const isMap = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const absent = (value: unknown) => value === '' || value === undefined || value === null;
function locateTarget(date: string, targetId: string) {
  if (!validId(targetId)) throw new Error('任务标识无效');
  const target = targetsForDate(date).find(action => action.id === targetId);
  if (!target) throw new Error('当天计划中没有这项任务');
  return target;
}
function targetsForDate(date: string) {
  return getDayBlocks(date).filter(block => block.kind !== 'fixed')
    .reduce((items, block) => items.concat(block.actions), [] as ReturnType<typeof getDayBlocks>[number]['actions']);
}
function migrateLegacy(): RecordEnvelope {
  const legacy = wx.getStorageSync(LEGACY);
  const envelope: RecordEnvelope = { schemaVersion: 2, byDate: {} };
  if (absent(legacy)) return envelope;
  validateLegacyRecords(legacy);
  for (const date of Object.keys(legacy)) {
    checkDate(date); if (!isMap(legacy[date])) throw new Error('旧版当天记录数据损坏');
    const targets = getLegacyBlocksForDate(date, 1).reduce((items: any[], block) => items.concat(block.actions.map(action => ({
      id: action.id, taskId: block.kind === 'sequence' ? 'training-task' : action.id,
      actionId: block.kind === 'sequence' ? action.id : undefined
    }))), []);
    const entries: Record<string, ExecutionRecord> = {};
    for (const id of Object.keys(legacy[date])) {
      if (!validId(id)) throw new Error('旧版任务标识无效');
      const status = legacy[date][id]; if (!['todo', 'done'].includes(status)) throw new Error('旧版任务状态无效');
      const target = targets.find(action => action.id === id);
      // Preserve unknown legacy targets; migration cannot invent actual execution times.
      entries[id] = { date, targetId: id, taskId: target ? target.taskId : id,
        ...(target && target.actionId ? { actionId: target.actionId } : {}), status, updatedAt: 0, events: [] };
    }
    envelope.byDate[date] = entries;
  }
  return envelope;
}
function readEnvelope(): RecordEnvelope {
  const value = wx.getStorageSync(STORE);
  if (absent(value)) return migrateLegacy();
  validateEnvelope(value); return copy(value);
}
function persist(envelope: RecordEnvelope): void { validateEnvelope(envelope); wx.setStorageSync(STORE, copy(envelope)); }
export function exportEnvelope(): RecordEnvelope { return copy(readEnvelope()); }
export function replaceEnvelope(value: RecordEnvelope): void { validateEnvelope(value); persist(value); }
export function recordDetailsForDate(date: string): Record<string, ExecutionRecord> {
  checkDate(date); return Object.assign(Object.create(null), copy(readEnvelope().byDate[date] || {}));
}
function ownRecord(envelope: RecordEnvelope, date: string, targetId: string): ExecutionRecord | undefined {
  const entries = envelope.byDate[date];
  return entries && Object.prototype.hasOwnProperty.call(entries, targetId) ? entries[targetId] : undefined;
}
export function allRecords(): AllRecords {
  try {
    const envelope = readEnvelope(), result: AllRecords = {};
    for (const date of Object.keys(envelope.byDate)) {
      result[date] = {};
      for (const id of Object.keys(envelope.byDate[date])) result[date][id] = envelope.byDate[date][id].status;
    }
    return result;
  } catch (_err) { return {}; }
}
export function forDate(date: string): DateRecords {
  try {
    const records = recordDetailsForDate(date), result: DateRecords = Object.create(null);
    for (const id of Object.keys(records)) result[id] = records[id].status;
    return result;
  } catch (_err) { return {}; }
}
export function setStatus(date: string, targetId: string, status: TaskStatus, options: { deferredTo?: string; reason?: string } = {}): ExecutionRecord {
  checkDate(date); checkStatus(status);
  if (status === 'doing' || status === 'done') assertExecutionAllowed(date);
  if (options.reason !== undefined && (typeof options.reason !== 'string' || options.reason.length > 200)) throw new Error('状态说明不能超过两百字');
  if (status === 'deferred') {
    if (!options.deferredTo) throw new Error('请选择延期目标日期');
    checkDate(options.deferredTo); if (options.deferredTo <= date) throw new Error('延期目标必须晚于原计划日期');
  } else if (options.deferredTo !== undefined) throw new Error('只有延期状态可以设置延期目标');
  const envelope = readEnvelope(), target = locateTarget(date, targetId), previous = ownRecord(envelope, date, targetId);
  if (previous && previous.status === status && previous.deferredTo === options.deferredTo) return copy(previous);
  if (status === 'doing' && Object.keys(envelope.byDate[date] || {}).some(id => id !== targetId &&
      envelope.byDate[date][id].taskId === target.taskId && envelope.byDate[date][id].status === 'doing')) {
    throw new Error('请先中止当前动作，再开始同一任务的其他动作');
  }
  const now = Date.now();
  const result: ExecutionRecord = previous ? copy(previous) : { date, targetId, taskId: target.taskId,
    ...(target.actionId ? { actionId: target.actionId } : {}), status: 'todo', updatedAt: now, events: [] };
  const from = result.status; result.status = status; result.updatedAt = now; delete result.deferredTo;
  if (status === 'doing') { result.actualStartedAt = now; delete result.finishedAt; }
  if (status === 'todo') { delete result.actualStartedAt; delete result.finishedAt; }
  if (status === 'done' || status === 'aborted' || status === 'skipped') result.finishedAt = now;
  if (status === 'deferred') { result.deferredTo = options.deferredTo; delete result.finishedAt; }
  if (from !== status || (status === 'deferred' && previous?.deferredTo !== options.deferredTo)) {
    result.events.push({ id: 'e-' + now + '-' + result.events.length, from, to: status, at: now, ...(options.reason ? { reason: options.reason } : {}) });
  }
  lockDailyInstance(date);
  envelope.byDate[date] = envelope.byDate[date] || {}; envelope.byDate[date][targetId] = result;
  persist(envelope); return copy(result);
}
export function saveFeedback(date: string, targetId: string, feedback: TrainingFeedback): ExecutionRecord {
  checkDate(date); checkFeedback(feedback);
  const envelope = readEnvelope(), target = locateTarget(date, targetId), previous = ownRecord(envelope, date, targetId);
  const cleaned: TrainingFeedback = { ...feedback, ...(feedback.note !== undefined ? { note: feedback.note.trim() } : {}) };
  if (previous && JSON.stringify(previous.feedback) === JSON.stringify(cleaned)) return copy(previous);
  const now = Date.now();
  const result: ExecutionRecord = previous ? copy(previous) : { date, targetId, taskId: target.taskId,
    ...(target.actionId ? { actionId: target.actionId } : {}), status: 'todo', updatedAt: now, events: [] };
  result.feedback = cleaned; result.updatedAt = now;
  lockDailyInstance(date);
  envelope.byDate[date] = envelope.byDate[date] || {}; envelope.byDate[date][targetId] = result;
  persist(envelope); return copy(result);
}
export function toggleDone(date: string, targetId: string): DateRecords {
  let before: DateRecords;
  try {
    const entries = recordDetailsForDate(date); before = {};
    for (const id of Object.keys(entries)) before[id] = entries[id].status;
  } catch (_err) { wx.showToast({ title: '读取失败，请稍后再试', icon: 'none' }); return {}; }
  try { setStatus(date, targetId, before[targetId] === 'done' ? 'todo' : 'done'); }
  catch (_err) { wx.showToast({ title: '保存失败，请检查存储空间', icon: 'none' }); return before; }
  return forDate(date);
}
export function getHistory(fromDate?: string, toDate?: string): ExecutionRecord[] {
  if (fromDate) checkDate(fromDate); if (toDate) checkDate(toDate);
  if (fromDate && toDate && fromDate > toDate) throw new Error('历史起止日期顺序无效');
  const envelope = readEnvelope();
  return Object.keys(envelope.byDate).filter(date => (!fromDate || date >= fromDate) && (!toDate || date <= toDate))
    .reduce((items, date) => items.concat(Object.values(envelope.byDate[date])), [] as ExecutionRecord[])
    .sort((left, right) => right.updatedAt - left.updatedAt || right.date.localeCompare(left.date) || left.targetId.localeCompare(right.targetId)).map(copy);
}
export function hasAnyRecord(date: string): boolean { return Object.keys(forDate(date)).length > 0; }
export function lastReviewKey(): string {
  try { const value = wx.getStorageSync(REVIEW); return typeof value === 'string' ? value : ''; } catch (_err) { return ''; }
}
export function setLastReviewKey(date: string): void { checkDate(date); wx.setStorageSync(REVIEW, date); }
export function clearRecords(): void {
  wx.setStorageSync(STORE, { schemaVersion: 2, byDate: {} });
  wx.removeStorageSync(LEGACY); wx.removeStorageSync(REVIEW);
}


