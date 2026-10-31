import { PlanTemplate, Schedule, TimeBlock } from '../types/domain';
import { parseLocalDate, shiftDays } from './calendar';

export interface BlockOccurrence {
  date: string; scheduleId: string; scheduleTitle: string; block: TimeBlock;
  blockIndex: number; source: 'base' | 'exception';
}

/** Reads the effective blocks without changing the template or its ordering. */
export function blocksOnDate(schedule: Schedule, date: string): TimeBlock[] {
  const weekday = parseLocalDate(date).getDay();
  if (date < schedule.effectiveFrom || (schedule.effectiveTo && date > schedule.effectiveTo)) return [];
  const exception = schedule.exceptions.find(item => item.date === date);
  if (exception) return exception.kind === 'replace' ? (exception.blocks || []).slice() : [];
  return schedule.weekdays.includes(weekday) ? schedule.blocks.slice() : [];
}

export function occurrencesOnDate(template: PlanTemplate, date: string): BlockOccurrence[] {
  parseLocalDate(date);
  const occurrences: BlockOccurrence[] = [];
  template.schedules.forEach(schedule => {
    const exception = schedule.exceptions.find(item => item.date === date);
    blocksOnDate(schedule, date).forEach((block, blockIndex) => occurrences.push({
      date, scheduleId: schedule.id, scheduleTitle: schedule.title, block, blockIndex,
      source: exception ? 'exception' : 'base'
    }));
  });
  return occurrences.sort((a, b) => a.block.start.localeCompare(b.block.start) || a.block.end.localeCompare(b.block.end));
}

function ordinaryWitness(from: string, until: string | undefined, weekday: number, excluded: Set<string>): string | undefined {
  try {
    let date = shiftDays(from, (weekday - parseLocalDate(from).getDay() + 7) % 7);
    // Each rejected date consumes a distinct finite exception. The first other
    // occurrence represents every ordinary occurrence of this repeating pair.
    for (let attempt = 0; attempt <= excluded.size; attempt++) {
      parseLocalDate(date);
      if (until && date > until) return undefined;
      if (!excluded.has(date)) return date;
      date = shiftDays(date, 7);
    }
  } catch (_error) { /* Calendar upper bound has no further valid occurrence. */ }
  return undefined;
}

/**
 * Complete finite witnesses for weekly rules with finite date exceptions.
 * Includes individual ordinary weekdays, every exception, and an ordinary
 * weekday in each pair's actual effective-period intersection. It never uses
 * a seven-day preview as a substitute for checking the full recurrence.
 * Retained snapshot dates are skipped while choosing ordinary witnesses, so
 * skipping the first week still checks the next mutable ordinary occurrence.
 */
export function representativeDates(schedules: Schedule[], notBefore?: string, excludedDates: string[] = []): string[] {
  if (notBefore) parseLocalDate(notBefore);
  excludedDates.forEach(parseLocalDate);
  const retainedDates = new Set(excludedDates);
  const dates = new Set<string>();
  const add = (date: string | undefined) => {
    if (date && !retainedDates.has(date) && (!notBefore || date >= notBefore)) dates.add(date);
  };
  schedules.forEach(schedule => {
    const from = notBefore && notBefore > schedule.effectiveFrom ? notBefore : schedule.effectiveFrom;
    const excluded = new Set(excludedDates.concat(schedule.exceptions.map(item => item.date)));
    schedule.exceptions.forEach(item => add(item.date));
    schedule.weekdays.forEach(day => add(ordinaryWitness(from, schedule.effectiveTo, day, excluded)));
  });
  for (let i = 0; i < schedules.length; i++) for (let j = i + 1; j < schedules.length; j++) {
    const a = schedules[i], b = schedules[j];
    const from = [a.effectiveFrom, b.effectiveFrom, ...(notBefore ? [notBefore] : [])].sort().slice(-1)[0];
    const until = [a.effectiveTo, b.effectiveTo].filter(Boolean).sort()[0];
    if (until && until < from) continue;
    const excluded = new Set(excludedDates.concat(a.exceptions.concat(b.exceptions).map(item => item.date)));
    a.weekdays.filter(day => b.weekdays.includes(day)).forEach(day => add(ordinaryWitness(from, until, day, excluded)));
  }
  return [...dates].sort();
}
