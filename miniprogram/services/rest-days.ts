import { localDateKey } from '../utils/calendar';
import { exportEnvelope } from './records';
import { validateEnvelope } from '../utils/record-validation';
import { getTimer } from './timer';
import { REST_KEY, RestDay, readRestDays, validateRestDays } from './rest-day-store';
export { getDayRest, isRestingToday, RestDay } from './rest-day-store';

const RECORDS = 'dayflow.records.v2', TIMER = 'dayflow.timer.v1';
function commit(writes: Array<{ key: string; value: unknown }>): void {
  const keys = wx.getStorageInfoSync().keys;
  const backups = writes.map(item => ({ key: item.key, exists: keys.includes(item.key), value: wx.getStorageSync(item.key) }));
  const attempted: number[] = [];
  try {
    writes.forEach((item, index) => { attempted.push(index); wx.setStorageSync(item.key, item.value); });
  } catch (_error) {
    let recovered = true;
    attempted.reverse().forEach(index => { const item = backups[index]; try {
      if (item.exists) wx.setStorageSync(item.key, item.value); else wx.removeStorageSync(item.key);
    } catch (_rollbackError) { recovered = false; } });
    throw new Error(recovered ? '未能保存休息设置，原有记录已保留，请稍后重试' : '休息设置未完成，部分数据恢复失败，请先检查本机数据');
  }
}
export function startRestToday(reason = ''): RestDay {
  if (typeof reason !== 'string' || reason.length > 200) throw new Error('休息理由不能超过两百字');
  const date = localDateKey(new Date()), rests = readRestDays();
  if (rests.byDate[date]?.active) return rests.byDate[date];
  const envelope = exportEnvelope(), timer = getTimer(), now = Date.now();
  let changed = false;
  for (const entry of Object.values(envelope.byDate[date] || {})) {
    if (entry.status !== 'doing') continue;
    entry.status = 'aborted'; entry.updatedAt = now; entry.finishedAt = now;
    entry.events.push({ id: 'rest-' + now + '-' + entry.events.length, from: 'doing', to: 'aborted', at: now,
      reason: ('今天休息' + (reason.trim() ? '：' + reason.trim() : '')).slice(0, 200) });
    changed = true;
  }
  const item: RestDay = { date, reason: reason.trim(), startedAt: now, updatedAt: now, active: true };
  rests.byDate[date] = item; validateRestDays(rests); validateEnvelope(envelope);
  const writes: Array<{key: string; value: unknown}> = [];
  if (timer && timer.dateKey === date && timer.status === 'running') {
    const paused = { ...timer, status: 'paused', updatedAt: now }; delete paused.endsAt;
    writes.push({ key: TIMER, value: paused });
  }
  if (changed) writes.push({ key: RECORDS, value: envelope });
  writes.push({ key: REST_KEY, value: rests }); commit(writes);
  return { ...item };
}
export function resumeToday(): RestDay | undefined {
  const date = localDateKey(new Date()), rests = readRestDays(), item = rests.byDate[date];
  if (!item || !item.active) return item;
  item.active = false; item.updatedAt = Date.now(); item.resumedAt = item.updatedAt;
  validateRestDays(rests); commit([{ key: REST_KEY, value: rests }]); return { ...item };
}
