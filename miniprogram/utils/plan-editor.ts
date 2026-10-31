import { Schedule, TimeBlock } from '../types/domain';
import { parseLocalDate } from './calendar';

/** The compact form is only used where one task represents the whole block. */
export function isSimpleBlock(block: TimeBlock): boolean {
  if (block.kind === 'fixed') return block.tasks.length === 0;
  if (block.kind !== 'parallel' || block.tasks.length > 1) return false;
  const task = block.tasks[0];
  return !task || (!task.origin && task.actions.length === 0 && task.title === block.title && task.start === block.start && task.end === block.end);
}

export function repeatMode(schedule: Schedule): number {
  if (schedule.effectiveTo === schedule.effectiveFrom && schedule.weekdays.length === 1 && schedule.weekdays[0] === parseLocalDate(schedule.effectiveFrom).getDay()) return 0;
  if (schedule.weekdays.length === 7) return 1;
  if (schedule.weekdays.length === 5 && [1,2,3,4,5].every(day => schedule.weekdays.includes(day))) return 2;
  return 3;
}

export function repeatWeekdays(mode: number, date: string, custom: number[]): number[] {
  if (mode === 0) return [parseLocalDate(date).getDay()];
  if (mode === 1) return [1,2,3,4,5,6,0];
  if (mode === 2) return [1,2,3,4,5];
  return custom.slice();
}

export function simpleBlock(block: TimeBlock, values: { title: string; start: string; end: string; category: string; checkable: boolean }, taskId: string): TimeBlock {
  if (!isSimpleBlock(block)) throw new Error('这项安排包含详细步骤，请在完整设置中编辑');
  const title = values.title.trim();
  const result: TimeBlock = { ...block, title, start: values.start, end: values.end, category: values.category.trim() || '自定义', kind: values.checkable ? 'parallel' : 'fixed', tasks: [] };
  if (values.checkable) result.tasks = [{ ...(block.tasks[0] || { id: taskId }), title, start: values.start, end: values.end, actions: [] }];
  return result;
}
