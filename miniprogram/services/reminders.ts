import { getDayBlocks } from './plans';
import { getPreferences } from './preferences';
import { getTrustedCloudContext } from './sync';
import { localDateKey, shiftDays } from '../utils/calendar';

export type ReminderKind = 'task' | 'sleep';
export type ReminderStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'unknown' | 'expired' | 'cancelled';
export interface ReminderCandidate {
  kind: ReminderKind; targetDate: string; targetId: string; title: string;
  dateKey: string; time: string; dueAt: number; timezoneOffset: number;
}
export interface ReminderPreview extends ReminderCandidate { templateId: string; accountId: string; preparedAt: number }
export interface ReminderJob extends ReminderCandidate { id: string; status: ReminderStatus; createdAt: number; updatedAt: number }
const CACHE = 'dayflow.reminderJobs.v1';
const pad = (value: number) => String(value).padStart(2, '0');
export function getNextReminderCandidate(kind: ReminderKind, now = new Date()): ReminderCandidate | null {
  if (kind !== 'task' && kind !== 'sleep') throw new Error('提醒类型无效');
  const prefs = getPreferences();
  const today = localDateKey(now);
  const candidates: ReminderCandidate[] = [];
  for (let offset = 0; offset <= 7; offset++) {
    const targetDate = shiftDays(today, offset);
    const targets = kind === 'sleep' ? [{ id: 'sleep', title: '准备睡觉', start: prefs.sleepTime }]
      : getDayBlocks(targetDate).filter(block => block.kind !== 'fixed');
    targets.forEach(target => {
      const parts = targetDate.split('-').map(Number); const clock = target.start.split(':').map(Number);
      const time = new Date(parts[0], parts[1] - 1, parts[2], clock[0], clock[1]);
      if (kind === 'task') time.setMinutes(time.getMinutes() - prefs.leadMinutes);
      if (time.getTime() <= now.getTime() + 60000 || time.getTime() > now.getTime() + 7 * 86400000) return;
      // Match the provider's thing field before asking for a one-time grant.
      // The source plan title remains intact, including supplementary characters.
      candidates.push({ kind, targetDate, targetId: target.id, title: Array.from(target.title).slice(0, 20).join(''),
        dateKey: localDateKey(time), time: pad(time.getHours()) + ':' + pad(time.getMinutes()),
        dueAt: time.getTime(), timezoneOffset: time.getTimezoneOffset() });
    });
  }
  return candidates.sort((a, b) => a.dueAt - b.dueAt)[0] || null;
}
async function call(action: string, data: any = {}): Promise<any> {
  const context = await getTrustedCloudContext({ allowReminderManagementWhenDisabled: action === 'list' || action === 'cancel' });
  const response: any = await new Promise((resolve, reject) => wx.cloud.callFunction({
    name: 'dayflowReminders', config: { env: context.envId }, data: { action, ...data },
    success: resolve, fail: () => reject(new Error('后台提醒暂不可用，本地日程仍可使用'))
  }));
  const result = response && response.result;
  if (!result || result.ok !== true || result.accountId !== context.accountId) throw new Error('后台提醒暂不可用，请稍后重新预览');
  return result;
}
export async function prepareReminder(kind: ReminderKind): Promise<ReminderPreview | null> {
  const candidate = getNextReminderCandidate(kind);
  if (!candidate) return null;
  const capability = await call('capability', { kind });
  const expected = getPreferences().subscriptionTemplateIds[kind === 'task' ? 0 : 1];
  if (!capability.available || typeof capability.templateId !== 'string' || capability.templateId !== expected) throw new Error('后台提醒尚未配置，请继续使用前台提醒');
  if (candidate.dueAt <= Date.now() + 60000) throw new Error('该提醒即将开始，请重新预览');
  return { ...candidate, templateId: capability.templateId, accountId: capability.accountId, preparedAt: Date.now() };
}
export async function registerReminder(preview: ReminderPreview, accepted: boolean): Promise<ReminderJob> {
  if (!accepted || !preview || !Number.isFinite(preview.preparedAt) || preview.preparedAt < 0 || preview.preparedAt > Date.now() || Date.now() - preview.preparedAt > 5 * 60000 || preview.dueAt <= Date.now() + 60000) throw new Error('本次授权或预览已失效，请重新预览');
  const current = getNextReminderCandidate(preview.kind);
  if (!current || ['targetDate','targetId','title','dateKey','time','dueAt','timezoneOffset'].some(key => current[key] !== preview[key])) throw new Error('日程或提醒时间已变化，请重新预览后授权');
  const candidate: ReminderCandidate = { kind: preview.kind, targetDate: preview.targetDate, targetId: preview.targetId,
    title: preview.title, dateKey: preview.dateKey, time: preview.time, dueAt: preview.dueAt, timezoneOffset: preview.timezoneOffset };
  const result = await call('register', { candidate, templateId: preview.templateId, expectedAccountId: preview.accountId });
  return result.job;
}
export async function listReminders(): Promise<ReminderJob[]> {
  const result = await call('list');
  if (!Array.isArray(result.jobs)) throw new Error('提醒记录暂不可用');
  // Cache is display-only; never accepted as registration or authority to send.
  wx.setStorageSync(CACHE, { accountId: result.accountId, jobs: result.jobs });
  return result.jobs;
}
export async function cancelReminder(id: string): Promise<ReminderJob> {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('提醒记录无效');
  return (await call('cancel', { id })).job;
}
export const reminderStatusText: Record<ReminderStatus, string> = {
  pending: '等待发送', sending: '提交中，请勿重复登记', sent: '已提交微信', failed: '未能提交微信',
  unknown: '提交结果待核实，不会自动重发', expired: '已过期', cancelled: '已取消'
};
