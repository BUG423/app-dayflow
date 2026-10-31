import { PlanTemplate, Schedule, ScheduleException, TimeBlock } from '../types/domain';
import { parseLocalDate, shiftDays } from './calendar';
import { blocksOnDate } from './schedule-occurrences';
import { ConflictOptions, findScheduleConflicts } from './planning-availability';

export interface OverwriteRemoval {
  scheduleId: string; scheduleTitle: string; blockId: string; title: string;
  start: string; end: string; weekdays: number[];
  effectiveFrom: string; effectiveTo?: string; date?: string;
}
export interface ScheduleOverwrite {
  template: PlanTemplate; schedule: Schedule; removed: OverwriteRemoval[];
}
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const intersects = (a: TimeBlock, b: TimeBlock) => a.start < b.end && b.start < a.end;
const sameBlocks = (a: TimeBlock[], b: TimeBlock[]) => JSON.stringify(a) === JSON.stringify(b);

function witness(from: string, until: string | undefined, weekday: number, excluded: Set<string>): string | undefined {
  try {
    let date = shiftDays(from, (weekday - parseLocalDate(from).getDay() + 7) % 7);
    for (let attempt = 0; attempt <= excluded.size; attempt++) {
      parseLocalDate(date);
      if (until && date > until) return undefined;
      if (!excluded.has(date)) return date;
      date = shiftDays(date, 7);
    }
  } catch (_error) { /* No ordinary occurrence past the supported calendar. */ }
  return undefined;
}
function hash(value: string): string {
  let result = 2166136261;
  for (let i = 0; i < value.length; i++) { result ^= value.charCodeAt(i); result = Math.imul(result, 16777619); }
  return (result >>> 0).toString(36);
}

/**
 * Builds the whole replacement as a draft. It removes complete conflicting old
 * blocks, never individual steps, and never writes templates or execution facts.
 * Weekly rules are partitioned by finite date boundaries and weekday groups;
 * their finite exceptions are resolved separately rather than enumerating days.
 */
export function prepareScheduleOverwrite(template: PlanTemplate, draft: Schedule, options: ConflictOptions = {}): ScheduleOverwrite {
  if (options.notBefore) parseLocalDate(options.notBefore);
  (options.excludedDates || []).forEach(parseLocalDate);
  const schedule = copy(draft), excluded = new Set(options.excludedDates || []);
  const affected = new Set(findScheduleConflicts(template, schedule, options)
    .filter(item => item.scheduleId !== schedule.id).map(item => item.scheduleId));
  const result: Schedule[] = [], removed: OverwriteRemoval[] = [];
  const usedIds = new Set(template.schedules.map(item => item.id).concat(schedule.id));
  const from = options.notBefore && options.notBefore > schedule.effectiveFrom ? options.notBefore : schedule.effectiveFrom;
  const active = (date: string) => date >= from && (!schedule.effectiveTo || date <= schedule.effectiveTo) && !excluded.has(date);
  const removal = (old: Schedule, block: TimeBlock, weekdays: number[], start: string, end?: string, date?: string) => {
    removed.push({ scheduleId: old.id, scheduleTitle: old.title, blockId: block.id, title: block.title,
      start: block.start, end: block.end, weekdays: weekdays.slice(), effectiveFrom: start,
      ...(end ? { effectiveTo: end } : {}), ...(date ? { date } : {}) });
  };

  for (const oldInput of template.schedules) {
    if (oldInput.id === schedule.id) continue;
    if (!affected.has(oldInput.id)) { result.push(copy(oldInput)); continue; }
    const old = copy(oldInput), cuts = new Set([old.effectiveFrom]);
    if (from > old.effectiveFrom && (!old.effectiveTo || from <= old.effectiveTo)) cuts.add(from);
    if (schedule.effectiveTo && schedule.effectiveTo >= old.effectiveFrom) {
      try {
        const after = shiftDays(schedule.effectiveTo, 1); parseLocalDate(after);
        if ((!old.effectiveTo || after <= old.effectiveTo) && after > old.effectiveFrom) cuts.add(after);
      } catch (_error) { /* Last supported calendar date has no following segment. */ }
    }
    const starts = [...cuts].sort(); let first = true;
    for (let index = 0; index < starts.length; index++) {
      const start = starts[index], end = index + 1 < starts.length ? shiftDays(starts[index + 1], -1) : old.effectiveTo;
      const inRange = start >= from && (!schedule.effectiveTo || start <= schedule.effectiveTo);
      const groups: Array<{ weekdays: number[]; blocks: TimeBlock[]; exceptions: ScheduleException[]; deleted: TimeBlock[] }> = [];
      for (const weekday of old.weekdays) {
        const deleted = inRange && schedule.weekdays.includes(weekday)
          ? old.blocks.filter(block => schedule.blocks.some(next => intersects(block, next))) : [];
        const blocks = old.blocks.filter(block => !deleted.includes(block));
        let group = groups.find(item => sameBlocks(item.blocks, blocks));
        if (!group) { group = { weekdays: [], blocks, exceptions: [], deleted }; groups.push(group); }
        group.weekdays.push(weekday);
      }
      if (!groups.length) groups.push({ weekdays: [], blocks: old.blocks, exceptions: [], deleted: [] });
      const inSegment = (date: string) => date >= start && (!end || date <= end);
      const specialDates = [...new Set(old.exceptions.map(item => item.date)
        .concat(schedule.exceptions.filter(item => active(item.date)).map(item => item.date)))].filter(inSegment).sort();
      const ordinaryExcluded = new Set([...excluded, ...old.exceptions.map(item => item.date), ...schedule.exceptions.map(item => item.date)]);
      for (const group of groups) {
        const days = group.weekdays.filter(weekday => !!witness(start, end, weekday, ordinaryExcluded));
        if (days.length) group.deleted.forEach(block => removal(old, block, days, start, end));
      }
      for (const date of specialDates) {
        const original = blocksOnDate(old, date), next = active(date) ? blocksOnDate(schedule, date) : [];
        const deleted = original.filter(block => next.some(item => intersects(block, item)));
        const blocks = original.filter(block => !deleted.includes(block));
        const owner = groups.find(item => item.weekdays.includes(parseLocalDate(date).getDay())) || groups[0];
        // Preserve old explicit date arrangements even when their content equals
        // the ordinary rule. Draft exceptions only need an override if it differs.
        if (old.exceptions.some(item => item.date === date) || !sameBlocks(blocks, owner.blocks)) {
          owner.exceptions.push(blocks.length ? { date, kind: 'replace', blocks: copy(blocks) } : { date, kind: 'skip' });
        }
        deleted.forEach(block => removal(old, block, [], date, date, date));
      }
      for (const group of groups) {
        if (!group.blocks.length && !group.exceptions.some(item => item.kind === 'replace' && item.blocks.length)) continue;
        let id = old.id;
        if (!first) {
          const suffix = '-ovr-' + hash(JSON.stringify([old.id, schedule.id, start, end, group.weekdays, group.blocks, group.exceptions]));
          const base = old.id.slice(0, 108 - suffix.length) + suffix;
          id = base; let collision = 0; while (usedIds.has(id)) id = base + '-' + (++collision);
        }
        first = false; usedIds.add(id);
        result.push({ ...old, id, effectiveFrom: start, ...(end ? { effectiveTo: end } : {}), weekdays: group.weekdays.slice(), blocks: copy(group.blocks), exceptions: copy(group.exceptions) });
      }
    }
  }
  result.push(schedule);
  return { template: { ...copy(template), schedules: result }, schedule: copy(schedule), removed };
}
