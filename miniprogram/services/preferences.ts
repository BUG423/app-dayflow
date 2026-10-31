import { minutesOf, parseLocalDate, shiftDays } from '../utils/calendar';

export interface PhaseRule { id: string; name: string; minSessions: number; description: string }
export interface Preferences {
  sleepReminderEnabled: boolean;
  sleepTime: string;
  taskReminderEnabled: boolean;
  leadMinutes: number;
  subscriptionTemplateIds: string[];
  trainingPhase: string;
  phaseRules: PhaseRule[];
}
const KEY = 'dayflow.preferences.v1';
const defaults: Preferences = {
  sleepReminderEnabled: false, sleepTime: '23:00', taskReminderEnabled: false,
  leadMinutes: 10, subscriptionTemplateIds: [], trainingPhase: '基础',
  phaseRules: [
    { id: 'basic', name: '基础', minSessions: 0, description: '选择熟悉且适合自己的示例动作，按状态调整。' },
    { id: 'steady', name: '巩固', minSessions: 6, description: '参考执行次数后自主选择，不代表医学上的进阶建议。' },
    { id: 'custom', name: '自主调整', minSessions: 12, description: '自行调整动作和时长，需要时请专业人员审核。' }
  ]
};
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
function invalid(): never { throw new Error('设置格式无效，请检查输入'); }
export function validatePreferences(value: any): Preferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const allowed = Object.keys(defaults);
  if (Object.keys(value).some(key => allowed.indexOf(key) < 0)) invalid();
  if (typeof value.sleepReminderEnabled !== 'boolean' || typeof value.taskReminderEnabled !== 'boolean') invalid();
  try { minutesOf(value.sleepTime); } catch (_err) { invalid(); }
  if (!Number.isInteger(value.leadMinutes) || value.leadMinutes < 0 || value.leadMinutes > 120) invalid();
  if (!Array.isArray(value.subscriptionTemplateIds) || value.subscriptionTemplateIds.length > 3 ||
      value.subscriptionTemplateIds.some((id: any) => typeof id !== 'string' || (id !== '' && !/^[A-Za-z0-9_-]{10,128}$/.test(id)))) invalid();
  if (!Array.isArray(value.phaseRules) || value.phaseRules.length < 1 || value.phaseRules.length > 6) invalid();
  const ids = new Set<string>();
  const names = new Set<string>();
  value.phaseRules.forEach((rule: any) => {
    if (!rule || typeof rule.id !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(rule.id) || ids.has(rule.id) ||
        typeof rule.name !== 'string' || !rule.name.trim() || rule.name.length > 24 || names.has(rule.name) ||
        !Number.isInteger(rule.minSessions) || rule.minSessions < 0 || rule.minSessions > 10000 ||
        typeof rule.description !== 'string' || rule.description.length > 240) invalid();
    ids.add(rule.id); names.add(rule.name);
  });
  if (['基础', '巩固', '自主调整'].indexOf(value.trainingPhase) < 0 || !names.has(value.trainingPhase)) invalid();
  return copy(value as Preferences);
}
export function getPreferences(): Preferences {
  const raw = wx.getStorageSync(KEY);
  return raw === '' || raw === undefined || raw === null ? copy(defaults) : validatePreferences(raw);
}
export function savePreferences(patch: Partial<Preferences>): Preferences {
  const next = validatePreferences({ ...getPreferences(), ...patch });
  wx.setStorageSync(KEY, next);
  return copy(next);
}
export async function requestReminderSubscription(kind: 'task' | 'sleep' = 'task'): Promise<{ status: string; accepted: number; rejected: number }> {
  if (kind !== 'task' && kind !== 'sleep') throw new Error('提醒类型无效');
  const configured = getPreferences().subscriptionTemplateIds;
  const template = configured[kind === 'task' ? 0 : 1];
  if (!template) return { status: 'unconfigured', accepted: 0, rejected: 0 };
  const ids = [template];
  if (typeof wx.requestSubscribeMessage !== 'function') return { status: 'unavailable', accepted: 0, rejected: 0 };
  return new Promise((resolve, reject) => wx.requestSubscribeMessage({
    tmplIds: ids,
    success: (result) => {
      const accepted = ids.filter(id => result[id] === 'accept').length;
      resolve({ status: accepted ? 'accepted' : 'rejected', accepted, rejected: ids.length - accepted });
    },
    fail: () => reject(new Error('未完成订阅授权，你仍可使用本地日程'))
  }));
}

export interface Reminder { key: string; kind: 'task' | 'sleep'; title: string }
interface ReminderBlock { id: string; title: string; start: string; kind: string }
const SHOWN_KEY = 'dayflow.remindersShown.v1';
function readShown(): Record<string, boolean> {
  const raw = wx.getStorageSync(SHOWN_KEY);
  if (raw === '' || raw === undefined || raw === null) return {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => raw[key] !== true)) {
    throw new Error('提醒记录无法读取，请稍后再试');
  }
  return { ...raw };
}
export function computeDueReminders(dateKey: string, nowMinute: number, blocks: ReminderBlock[],
  preferences: Preferences, shown: Record<string, boolean> = {}, nextDayBlocks: ReminderBlock[] = []): Reminder[] {
  parseLocalDate(dateKey);
  if (!Number.isInteger(nowMinute) || nowMinute < 0 || nowMinute > 1439) throw new Error('当前时间无效');
  const prefs = validatePreferences(preferences);
  const reminders: Reminder[] = [];
  if (prefs.taskReminderEnabled) blocks.filter(block => block.kind !== 'fixed').forEach(block => {
    const start = minutesOf(block.start);
    const key = dateKey + ':task:' + block.id + ':' + block.start;
    if (!shown[key] && nowMinute >= Math.max(0, start - prefs.leadMinutes) && nowMinute <= start) {
      reminders.push({ key, kind: 'task', title: block.title + (nowMinute === start ? '现在开始' : '即将开始') });
    }
  });
  if (prefs.taskReminderEnabled) nextDayBlocks.filter(block => block.kind !== 'fixed').forEach(block => {
    const start = minutesOf(block.start);
    const due = 1440 + start - prefs.leadMinutes;
    const key = shiftDays(dateKey, 1) + ':task:' + block.id + ':' + block.start;
    if (!shown[key] && due < 1440 && nowMinute >= due) reminders.push({ key, kind: 'task', title: '明天的' + block.title + '即将开始' });
  });
  if (prefs.sleepReminderEnabled) {
    const sleep = minutesOf(prefs.sleepTime);
    const key = dateKey + ':sleep:' + prefs.sleepTime;
    if (!shown[key] && nowMinute >= sleep && nowMinute <= Math.min(1439, sleep + 5)) {
      reminders.push({ key, kind: 'sleep', title: '到设定的休息时间了，准备放松入睡' });
    }
  }
  return reminders;
}
export function getDueReminders(dateKey: string, nowMinute: number, blocks: ReminderBlock[], nextDayBlocks: ReminderBlock[] = []): Reminder[] {
  return computeDueReminders(dateKey, nowMinute, blocks, getPreferences(), readShown(), nextDayBlocks);
}
export function markReminderShown(key: string): void {
  if (typeof key !== 'string' || key.length > 240 || !/^\d{4}-\d{2}-\d{2}:(task|sleep):/.test(key)) throw new Error('提醒标识无效');
  const date = key.slice(0, 10);
  parseLocalDate(date);
  const from = shiftDays(date, -30);
  const shown = readShown();
  const next: Record<string, boolean> = {};
  Object.keys(shown).filter(item => item.slice(0, 10) >= from).slice(-499).forEach(item => { next[item] = true; });
  next[key] = true;
  wx.setStorageSync(SHOWN_KEY, next);
}
