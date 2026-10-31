type Status = 'done' | 'todo';
type DateRecords = Record<string, Status>;
type AllRecords = Record<string, DateRecords>;

const STORE = 'dayflow.records.v1';
const REVIEW = 'dayflow.review.v1';

function isRecordMap(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function readRecords(): AllRecords {
  const value = wx.getStorageSync(STORE);
  if (value === '' || value === undefined || value === null) return {};
  if (!isRecordMap(value)) throw new Error('Invalid records storage');
  return value as AllRecords;
}
export function allRecords(): AllRecords {
  try { return readRecords(); } catch (_err) { return {}; }
}
export function forDate(dateKey: string): DateRecords {
  const value = allRecords()[dateKey];
  return isRecordMap(value) ? { ...value } : {};
}
export function toggleDone(dateKey: string, actionId: string): DateRecords {
  let all: AllRecords;
  try {
    all = readRecords();
    if (all[dateKey] !== undefined && !isRecordMap(all[dateKey])) throw new Error('Invalid date records');
  } catch (_err) {
    wx.showToast({ title: '读取失败，请稍后再试', icon: 'none' });
    return {};
  }
  const previous = { ...(all[dateKey] || {}) };
  const next = { ...previous };
  next[actionId] = next[actionId] === 'done' ? 'todo' : 'done';
  all[dateKey] = next;
  try { wx.setStorageSync(STORE, all); } catch (_err) {
    wx.showToast({ title: '保存失败，请检查存储空间', icon: 'none' });
    return previous;
  }
  return next;
}
export function hasAnyRecord(dateKey: string): boolean {
  return Object.keys(forDate(dateKey)).length > 0;
}
export function lastReviewKey(): string {
  try { return wx.getStorageSync(REVIEW) || ''; } catch (_err) { return ''; }
}
export function setLastReviewKey(value: string): void {
  try { wx.setStorageSync(REVIEW, value); } catch (_err) {}
}
