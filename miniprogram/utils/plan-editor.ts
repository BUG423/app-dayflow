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
  if (schedule.weekdays.length === 2 && [0,6].every(day => schedule.weekdays.includes(day))) return 5;
  if (schedule.weekdays.length === 1) return 4;
  return 3;
}

export function repeatWeekdays(mode: number, date: string, custom: number[]): number[] {
  if (mode === 0 || mode === 4) return [parseLocalDate(date).getDay()];
  if (mode === 1) return [1,2,3,4,5,6,0];
  if (mode === 2) return [1,2,3,4,5];
  if (mode === 5) return [6,0];
  return custom.slice();
}

/** Indices remain stable for existing handlers and saved editor drafts. */
export function repeatOptionLabels(date: string, weeklyDay?: number): string[] {
  const day = weeklyDay === undefined ? parseLocalDate(date).getDay() : weeklyDay;
  if (!Number.isInteger(day) || day < 0 || day > 6) throw new Error('请选择有效的星期');
  return ['不重复', '每天', '工作日', '自选星期', '每周' + ['日','一','二','三','四','五','六'][day], '非工作日'];
}

export function repeatDescription(mode: number, date: string, selected: number[]): string {
  if (mode !== 3) return repeatOptionLabels(date, mode === 4 && selected.length === 1 ? selected[0] : undefined)[mode] || '请选择星期';
  const names = ['周日','周一','周二','周三','周四','周五','周六'];
  return [1,2,3,4,5,6,0].filter(day => selected.includes(day)).map(day => names[day]).join('、') || '请选择星期';
}

export function simpleBlock(block: TimeBlock, values: { title: string; start: string; end: string; category: string; checkable: boolean }, taskId: string): TimeBlock {
  if (!isSimpleBlock(block)) throw new Error('这项安排包含详细步骤，请在完整设置中编辑');
  const title = values.title.trim();
  const result: TimeBlock = { ...block, title, start: values.start, end: values.end, category: values.category.trim() || '自定义', kind: values.checkable ? 'parallel' : 'fixed', tasks: [] };
  if (values.checkable) result.tasks = [{ ...(block.tasks[0] || { id: taskId }), title, start: values.start, end: values.end, actions: [] }];
  return result;
}
