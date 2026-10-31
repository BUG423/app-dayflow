import { parseLocalDate } from '../utils/calendar';

export interface TimerState {
  schemaVersion: 1; dateKey: string; targetId: string; durationSeconds: number;
  remainingSeconds: number; status: 'running' | 'paused' | 'finished'; endsAt?: number; updatedAt: number;
}
const STORE = 'dayflow.timer.v1';
const clone = (value: TimerState): TimerState => JSON.parse(JSON.stringify(value));
function validate(value: any): asserts value is TimerState {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== 1 ||
      typeof value.targetId !== 'string' || !value.targetId || value.targetId.length > 160 ||
      !Number.isInteger(value.durationSeconds) || value.durationSeconds < 5 || value.durationSeconds > 10800 ||
      !Number.isInteger(value.remainingSeconds) || value.remainingSeconds < 0 || value.remainingSeconds > value.durationSeconds ||
      !['running', 'paused', 'finished'].includes(value.status) || !Number.isFinite(value.updatedAt) || value.updatedAt < 0 ||
      (value.status === 'finished' && value.remainingSeconds !== 0) ||
      (value.endsAt !== undefined && (!Number.isFinite(value.endsAt) || value.endsAt < 0)) ||
      (value.status === 'running' && (!Number.isFinite(value.endsAt) || value.endsAt < 0))) throw new Error('计时数据损坏，请先恢复备份');
  try { parseLocalDate(value.dateKey); } catch (_err) { throw new Error('计时日期无效'); }
}
function save(value: TimerState): TimerState { validate(value); wx.setStorageSync(STORE, clone(value)); return clone(value); }
export function getTimer(): TimerState | null {
  const value = wx.getStorageSync(STORE);
  if (value === '' || value === null || value === undefined) return null;
  validate(value);
  const result = clone(value);
  if (result.status === 'running') {
    result.remainingSeconds = Math.min(result.remainingSeconds, Math.max(0, Math.ceil((result.endsAt! - Date.now()) / 1000)));
    if (!result.remainingSeconds) result.status = 'finished';
  }
  return result;
}
export function startTimer(dateKey: string, targetId: string, durationSeconds: number): TimerState {
  try { parseLocalDate(dateKey); } catch (_err) { throw new Error('请选择有效的计时日期'); }
  if (typeof targetId !== 'string' || !targetId || targetId.length > 160) throw new Error('请选择要计时的动作');
  if (!Number.isInteger(durationSeconds) || durationSeconds < 5 || durationSeconds > 10800) throw new Error('计时长度应为五秒至三小时');
  getTimer(); // Strict read: starting cannot silently overwrite a damaged timer.
  const now = Date.now();
  return save({ schemaVersion: 1, dateKey, targetId, durationSeconds, remainingSeconds: durationSeconds, status: 'running', endsAt: now + durationSeconds * 1000, updatedAt: now });
}
export function pauseTimer(): TimerState | null {
  const value = getTimer(); if (!value || value.status !== 'running') return value;
  value.status = 'paused'; value.updatedAt = Date.now(); delete value.endsAt;
  return save(value);
}
export function resumeTimer(): TimerState | null {
  const value = getTimer(); if (!value || value.status !== 'paused') return value;
  value.status = value.remainingSeconds ? 'running' : 'finished'; value.updatedAt = Date.now();
  if (value.remainingSeconds) value.endsAt = Date.now() + value.remainingSeconds * 1000;
  return save(value);
}
export function resetTimer(): TimerState | null {
  const value = getTimer(); if (!value) return null;
  value.remainingSeconds = value.durationSeconds; value.status = 'paused'; value.updatedAt = Date.now(); delete value.endsAt;
  return save(value);
}
