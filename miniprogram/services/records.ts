type Status = 'done' | 'todo';
type DateRecords = Record<string, Status>;
type AllRecords = Record<string, DateRecords>;

const STORE = 'dayflow.records.v1';
const REVIEW = 'dayflow.review.v1';

export function allRecords(): AllRecords {
  try {
    const value = wx.getStorageSync(STORE);
    return value && typeof value === 'object' && !Array.isArray(value) ? value as AllRecords : {};
  } catch (_err) { return {}; }
}
export function forDate(dateKey: string): DateRecords {
  return { ...(allRecords()[dateKey] || {}) };
}
export function toggleDone(dateKey: string, actionId: string): DateRecords {
  const all = allRecords();
  const next = { ...(all[dateKey] || {}) };
  next[actionId] = next[actionId] === 'done' ? 'todo' : 'done';
  all[dateKey] = next;
  try { wx.setStorageSync(STORE, all); } catch (_err) {
    wx.showToast({ title: '保存失败，请检查存储空间', icon: 'none' });
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
