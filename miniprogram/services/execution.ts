import { ExecutionRecord, TaskStatus } from '../types/domain';

export const STATUS_LABELS: Record<TaskStatus, string> = {
  todo: '待开始', doing: '进行中', done: '已完成', skipped: '已跳过', deferred: '已延期', aborted: '已中止'
};
/** Sum actual active intervals; background pages need no running counter. */
export function elapsedSeconds(record: ExecutionRecord | undefined, now = Date.now()): number {
  if (!record) return 0;
  let started: number | undefined; let total = 0;
  for (const event of record.events) {
    if (event.to === 'doing' && event.from !== 'doing') started = event.at;
    else if (event.to !== 'doing' && started !== undefined) { total += Math.max(0, event.at - started); started = undefined; }
  }
  if (record.status === 'doing' && started !== undefined) total += Math.max(0, now - started);
  return Math.floor(total / 1000);
}
export function durationText(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  return String(Math.floor(safe / 60)).padStart(2, '0') + ':' + String(safe % 60).padStart(2, '0');
}
export function errorText(error: unknown): string {
  const message = error && typeof (error as Error).message === 'string' ? (error as Error).message : '';
  return message && !/[A-Za-z]/.test(message) ? message : '操作未能完成，请稍后重试';
}
