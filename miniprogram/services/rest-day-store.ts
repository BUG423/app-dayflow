import { localDateKey, parseLocalDate } from '../utils/calendar';

export interface RestDay {
  date: string; reason: string; startedAt: number; updatedAt: number; active: boolean; resumedAt?: number;
}
export interface RestDays { schemaVersion: 1; byDate: Record<string, RestDay>; }
export const REST_KEY = 'dayflow.restDays.v1';
const object = (value: any) => value && typeof value === 'object' && !Array.isArray(value);
export function validateRestDays(value: any): asserts value is RestDays {
  if (!object(value) || value.schemaVersion !== 1 || !object(value.byDate) || Object.keys(value).some(k => !['schemaVersion','byDate'].includes(k))) throw new Error('休息记录损坏，请先检查本机数据');
  for (const date of Object.keys(value.byDate)) {
    parseLocalDate(date); const item = value.byDate[date];
    if (!object(item) || item.date !== date || typeof item.reason !== 'string' || item.reason.length > 200 || typeof item.active !== 'boolean' ||
        !Number.isFinite(item.startedAt) || item.startedAt < 0 || !Number.isFinite(item.updatedAt) || item.updatedAt < item.startedAt ||
        (item.resumedAt !== undefined && (!Number.isFinite(item.resumedAt) || item.resumedAt < item.startedAt || item.resumedAt > item.updatedAt)) ||
        (item.active && item.resumedAt !== undefined) || (!item.active && item.resumedAt === undefined) ||
        Object.keys(item).some(k => !['date','reason','startedAt','updatedAt','active','resumedAt'].includes(k))) throw new Error('休息记录损坏，请先检查本机数据');
  }
}
export function readRestDays(): RestDays {
  const value = wx.getStorageSync(REST_KEY);
  if (value === '' || value === null || value === undefined) return { schemaVersion: 1, byDate: {} };
  validateRestDays(value); return JSON.parse(JSON.stringify(value));
}
export function getDayRest(date: string): RestDay | undefined {
  parseLocalDate(date); const data = readRestDays();
  return Object.prototype.hasOwnProperty.call(data.byDate, date) ? data.byDate[date] : undefined;
}
export function isRestingToday(): boolean { return !!getDayRest(localDateKey(new Date()))?.active; }
export function assertExecutionAllowed(date: string): void {
  if (date === localDateKey(new Date()) && isRestingToday()) throw new Error('今天正在休息，请先恢复今日安排再执行任务');
}
