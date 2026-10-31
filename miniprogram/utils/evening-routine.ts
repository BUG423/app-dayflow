import { PlanTemplate, Schedule, TimeBlock } from '../types/domain';
import { parseLocalDate, shiftDays } from './calendar';
import { blocksOnDate, representativeDates } from './schedule-occurrences';
import { OverwriteRemoval } from './plan-overwrite';

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const overtime = (block: TimeBlock) => block.category === '加班' || block.id === 'overtime' || block.title === '加班';

/** Remove old overtime from the mutable future, including time not occupied by new swimming. */
export function removeFutureOvertime(template: PlanTemplate, from: string, excludedDates: string[]): { template: PlanTemplate; removed: OverwriteRemoval[] } {
  parseLocalDate(from);
  const excluded = new Set(excludedDates), removed: OverwriteRemoval[] = [], schedules: Schedule[] = [];
  const used = new Set(template.schedules.map(schedule => schedule.id));
  for (const source of template.schedules) {
    const old = copy(source);
    if (old.effectiveTo && old.effectiveTo < from) { schedules.push(old); continue; }
    const start = old.effectiveFrom > from ? old.effectiveFrom : from;
    const future: Schedule = { ...old, effectiveFrom: start, exceptions: old.exceptions.filter(item => item.date >= start) };
    const dates = representativeDates([future], from, excludedDates);
    if (!dates.some(date => blocksOnDate(future, date).some(overtime))) { schedules.push(old); continue; }
    const list = (block: TimeBlock, weekdays: number[], date?: string) => removed.push({
      scheduleId: old.id, scheduleTitle: old.title, blockId: block.id, title: block.title,
      start: block.start, end: block.end, weekdays, effectiveFrom: date || start,
      ...(date || old.effectiveTo ? { effectiveTo: date || old.effectiveTo } : {}), ...(date ? { date } : {})
    });
    old.blocks.filter(overtime).forEach(block => {
      const days = future.weekdays.filter(day => dates.some(date => parseLocalDate(date).getDay() === day
        && !future.exceptions.some(item => item.date === date) && blocksOnDate(future, date).some(item => item.id === block.id)));
      if (days.length) list(block, days);
    });
    future.exceptions.forEach(exception => {
      if (exception.kind === 'replace' && !excluded.has(exception.date)) exception.blocks!.filter(overtime).forEach(block => list(block, [], exception.date));
    });
    if (old.effectiveFrom < start) {
      const before = shiftDays(start, -1);
      schedules.push({ ...copy(old), effectiveTo: before, exceptions: old.exceptions.filter(item => item.date < start) });
      const base = old.id.slice(0, 85) + '-evening-' + start.replace(/-/g, '');
      let id = base, index = 0; while (used.has(id)) id = base + '-' + (++index);
      future.id = id; used.add(id);
    }
    future.blocks = future.blocks.filter(block => !overtime(block));
    future.exceptions = future.exceptions.map(exception => {
      if (exception.kind === 'skip') return exception;
      const blocks = exception.blocks!.filter(block => !overtime(block));
      return blocks.length ? { ...exception, blocks } : { date: exception.date, kind: 'skip' as const };
    });
    if (future.blocks.length && future.weekdays.length || future.exceptions.some(item => item.kind === 'replace' && item.blocks!.length)) schedules.push(future);
  }
  return { template: { ...copy(template), schedules }, removed };
}
