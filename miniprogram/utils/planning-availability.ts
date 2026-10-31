import { PlanTemplate, Schedule, TimeBlock } from '../types/domain';
import { minutesOf, endMinutesOf, parseLocalDate } from './calendar';
import { BlockOccurrence, blocksOnDate, occurrencesOnDate, representativeDates } from './schedule-occurrences';

export interface TimeWindow { start: string; end: string; }
export interface BusyPeriod extends TimeWindow {
  date: string; dates: string[]; scheduleId: string; scheduleTitle: string; blockId: string; title: string;
}
export interface PlanningConflict extends TimeWindow {
  date: string; scheduleId: string; scheduleTitle: string; blockId: string; title: string;
  proposedScheduleId: string; proposedScheduleTitle: string; proposedBlockId: string; proposedTitle: string;
  proposedStart: string; proposedEnd: string; reason: 'overlap'; message: string;
  suggestedStart?: string; suggestedEnd?: string;
}
export interface AvailabilityResult {
  freeWindows: TimeWindow[]; busy: BusyPeriod[]; conflicts: PlanningConflict[];
  allowedStarts: string[]; allowedStartMinutes: number[]; proposedValid: boolean;
  suggestedStart: string; suggestedEnd: string; message: string; scopeDates: string[];
  scope: 'base' | 'exception' | 'none';
}
export interface AvailabilityOptions { date?: string; exceptionDate?: string; notBefore?: string; excludedDates?: string[]; }
export interface ConflictOptions { notBefore?: string; excludedDates?: string[]; }
const DAY_END = 1440; // 24:00 closes this local date; it is never a start candidate.
const hhmm = (minute: number) => String(Math.floor(minute / 60)).padStart(2, '0') + ':' + String(minute % 60).padStart(2, '0');
const overlap = (a: TimeBlock, b: TimeBlock) => minutesOf(a.start) < endMinutesOf(b.end) && minutesOf(b.start) < endMinutesOf(a.end);

function candidate(template: PlanTemplate, draft: Schedule): PlanTemplate {
  return { ...template, schedules: template.schedules.filter(item => item.id !== draft.id).concat(draft) };
}
function messageFor(date: string, occupied: BlockOccurrence, proposed: BlockOccurrence): string {
  return date + '：' + proposed.block.title + ' ' + proposed.block.start + '–' + proposed.block.end
    + ' 与“' + occupied.scheduleTitle + '”的“' + occupied.block.title + '” '
    + occupied.block.start + '–' + occupied.block.end + ' 重叠，请选择其他空档。';
}
function conflictFor(date: string, occupied: BlockOccurrence, proposed: BlockOccurrence): PlanningConflict {
  return { date, scheduleId: occupied.scheduleId, scheduleTitle: occupied.scheduleTitle,
    blockId: occupied.block.id, title: occupied.block.title, start: occupied.block.start, end: occupied.block.end,
    proposedScheduleId: proposed.scheduleId, proposedScheduleTitle: proposed.scheduleTitle,
    proposedBlockId: proposed.block.id, proposedTitle: proposed.block.title,
    proposedStart: proposed.block.start, proposedEnd: proposed.block.end, reason: 'overlap',
    message: messageFor(date, occupied, proposed) };
}
function allConflicts(template: PlanTemplate, scheduleId: string | undefined, options: ConflictOptions): PlanningConflict[] {
  const result: PlanningConflict[] = [], seen = new Set<string>();
  for (const date of representativeDates(template.schedules, options.notBefore, options.excludedDates)) {
    const occurrences = occurrencesOnDate(template, date);
    for (let i = 0; i < occurrences.length; i++) for (let j = i + 1; j < occurrences.length; j++) {
      const a = occurrences[i], b = occurrences[j];
      if (scheduleId && a.scheduleId !== scheduleId && b.scheduleId !== scheduleId) continue;
      if (!overlap(a.block, b.block)) continue;
      const proposed = scheduleId && a.scheduleId === scheduleId && b.scheduleId !== scheduleId ? a : b;
      const occupied = proposed === a ? b : a;
      const key = JSON.stringify([occupied.scheduleId, occupied.source, occupied.blockIndex, occupied.block.id, occupied.block.title,
        occupied.block.start, occupied.block.end, proposed.scheduleId, proposed.source, proposed.blockIndex,
        proposed.block.id, proposed.block.title, proposed.block.start, proposed.block.end]);
      if (seen.has(key)) continue;
      seen.add(key); result.push(conflictFor(date, occupied, proposed));
    }
  }
  return result;
}
export function findPlanConflicts(template: PlanTemplate, options: ConflictOptions = {}): PlanningConflict[] {
  return allConflicts(template, undefined, options);
}
export function findScheduleConflicts(template: PlanTemplate, draft: Schedule, options: ConflictOptions = {}): PlanningConflict[] {
  return allConflicts(candidate(template, draft), draft.id, options);
}

function freeFromBusy(busy: BusyPeriod[]): TimeWindow[] {
  const ranges = busy.map(item => ({ left: minutesOf(item.start), right: endMinutesOf(item.end) })).sort((a, b) => a.left - b.left || a.right - b.right);
  const free: TimeWindow[] = []; let cursor = 0;
  ranges.forEach(range => { if (range.left > cursor) free.push({ start: hhmm(cursor), end: hhmm(range.left) }); cursor = Math.max(cursor, range.right); });
  if (cursor < DAY_END) free.push({ start: hhmm(cursor), end: hhmm(DAY_END) });
  return free;
}
export function allowedEndMinutes(availability: Pick<AvailabilityResult, 'freeWindows'>, start: string | number): number[] {
  const minute = typeof start === 'number' ? start : minutesOf(start);
  if (!Number.isInteger(minute) || minute < 0 || minute >= DAY_END) return [];
  const gap = availability.freeWindows.find(item => minute >= minutesOf(item.start) && minute < endMinutesOf(item.end));
  if (!gap) return [];
  const end = endMinutesOf(gap.end), values: number[] = [];
  for (let value = minute + 1; value <= end; value++) values.push(value);
  return values;
}
export function allowedEnds(availability: Pick<AvailabilityResult, 'freeWindows'>, start: string): string[] {
  return allowedEndMinutes(availability, start).map(hhmm);
}
function empty(message: string): AvailabilityResult {
  return { freeWindows: [], busy: [], conflicts: [], allowedStarts: [], allowedStartMinutes: [], proposedValid: false,
    suggestedStart: '', suggestedEnd: '', message, scopeDates: [], scope: 'none' };
}

export function getBlockAvailability(template: PlanTemplate, draft: Schedule, blockId: string, options: AvailabilityOptions = {}): AvailabilityResult {
  if (options.date) parseLocalDate(options.date);
  if (options.notBefore) parseLocalDate(options.notBefore);
  if (options.exceptionDate) parseLocalDate(options.exceptionDate);
  (options.excludedDates || []).forEach(parseLocalDate);
  const retainedDates = new Set(options.excludedDates || []);
  const effective = candidate(template, draft);
  const exception = options.exceptionDate && draft.exceptions.find(item => item.date === options.exceptionDate && item.kind === 'replace');
  if (options.exceptionDate && !exception) return empty('这一天没有可修改的临时安排，请先选择“仅修改某天”。');
  const selected = (exception ? exception.blocks || [] : draft.blocks).find(item => item.id === blockId);
  if (!selected) return empty('没有找到正在编辑的时段，请重新打开安排。');
  const dates = options.exceptionDate ? [options.exceptionDate] : representativeDates(effective.schedules, options.notBefore, options.excludedDates);
  if (options.date && !dates.includes(options.date)) dates.push(options.date);
  const scopeDates = dates.filter(date => !retainedDates.has(date) && (!options.notBefore || date >= options.notBefore)
    && date >= draft.effectiveFrom && (!draft.effectiveTo || date <= draft.effectiveTo)
    && (options.exceptionDate ? date === options.exceptionDate : !draft.exceptions.some(item => item.date === date))
    && blocksOnDate(draft, date).includes(selected)).sort();
  if (!scopeDates.length) return empty('所选日期范围内没有这一项安排，请检查日期和重复星期。');
  const busy: BusyPeriod[] = [], busyByKey = new Map<string, BusyPeriod>();
  const conflicts: PlanningConflict[] = [], conflictKeys = new Set<string>();
  for (const date of scopeDates) {
    const proposed: BlockOccurrence = { date, scheduleId: draft.id, scheduleTitle: draft.title, block: selected,
      blockIndex: (exception ? exception.blocks || [] : draft.blocks).indexOf(selected), source: exception ? 'exception' : 'base' };
    for (const occurrence of occurrencesOnDate(effective, date)) {
      if (occurrence.scheduleId === draft.id && occurrence.block === selected) continue;
      const key = JSON.stringify([occurrence.scheduleId, occurrence.source, occurrence.blockIndex, occurrence.block.id,
        occurrence.block.title, occurrence.block.start, occurrence.block.end]);
      const prior = busyByKey.get(key);
      if (prior) prior.dates.push(date);
      else { const item = { date, dates: [date], scheduleId: occurrence.scheduleId, scheduleTitle: occurrence.scheduleTitle,
        blockId: occurrence.block.id, title: occurrence.block.title, start: occurrence.block.start, end: occurrence.block.end };
        busy.push(item); busyByKey.set(key, item); }
      if (overlap(occurrence.block, selected) && !conflictKeys.has(key)) {
        conflictKeys.add(key); conflicts.push(conflictFor(date, occurrence, proposed));
      }
    }
  }
  busy.sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end) || a.date.localeCompare(b.date));
  const freeWindows = freeFromBusy(busy), allowedStartMinutes: number[] = [];
  freeWindows.forEach(gap => { for (let minute = minutesOf(gap.start); minute < endMinutesOf(gap.end); minute++) allowedStartMinutes.push(minute); });
  const start = minutesOf(selected.start), end = endMinutesOf(selected.end), duration = Math.max(1, end - start);
  const containing = freeWindows.find(gap => start >= minutesOf(gap.start) && end <= endMinutesOf(gap.end) && start < end);
  const suggestions = freeWindows.filter(gap => endMinutesOf(gap.end) - minutesOf(gap.start) >= duration);
  const forward = suggestions.find(gap => Math.max(start, minutesOf(gap.start)) + duration <= endMinutesOf(gap.end));
  const suggested = forward || suggestions[0];
  const suggestedMinute = suggested ? (forward ? Math.max(start, minutesOf(suggested.start)) : minutesOf(suggested.start)) : -1;
  const suggestedStart = suggestedMinute < 0 ? '' : hhmm(suggestedMinute), suggestedEnd = suggestedMinute < 0 ? '' : hhmm(suggestedMinute + duration);
  conflicts.forEach(item => { if (suggestedStart) { item.suggestedStart = suggestedStart; item.suggestedEnd = suggestedEnd;
    item.message += '可改为 ' + suggestedStart + '–' + suggestedEnd + '。'; } });
  const message = !freeWindows.length ? '这些日期没有可用空档，请调整日期、重复范围或已有安排。'
    : conflicts.length ? conflicts[0].message : !suggestedStart ? '空档不足以容纳当前时长，请缩短时长或调整日期。'
    : '已按时间排列空档；已占用分钟不能选择。';
  return { freeWindows, busy, conflicts, allowedStarts: allowedStartMinutes.map(hhmm), allowedStartMinutes,
    proposedValid: !!containing, suggestedStart, suggestedEnd, message, scopeDates,
    scope: exception ? 'exception' : 'base' };
}
