import { minutesOf } from './calendar';

export interface TimeColumns { range: string[][]; indices: number[]; }

/** Project permitted minutes into native multiSelector columns; occupied minutes never enter a column. */
export function timeColumns(values: string[], selected: string, selectedHour?: string): TimeColumns {
  const ordered = [...new Set(values)].sort();
  const hours = [...new Set(ordered.map(value => value.slice(0, 2)))];
  if (!hours.length) return { range: [[], []], indices: [0, 0] };
  const hour = selectedHour && hours.includes(selectedHour) ? selectedHour : hours.includes(selected.slice(0, 2)) ? selected.slice(0, 2) : hours[0];
  const minutes = ordered.filter(value => value.slice(0, 2) === hour).map(value => value.slice(3));
  const minuteIndex = Math.max(0, minutes.indexOf(selected.slice(3)));
  return { range: [hours, minutes], indices: [hours.indexOf(hour), minuteIndex] };
}

export function selectedClock(range: string[][], indices: number[]): string {
  if (!Array.isArray(indices) || indices.length !== 2 || indices.some(index => !Number.isInteger(index) || index < 0)) throw new Error('请重新选择可用时间');
  const hour = range[0]?.[indices[0]], minute = range[1]?.[indices[1]];
  if (hour === undefined || minute === undefined) throw new Error('请重新选择可用时间');
  const clock = hour + ':' + minute; minutesOf(clock); return clock;
}

export function clockFromMinute(value: number): string {
  if (!Number.isInteger(value) || value < 0 || value > 1439) throw new Error('时间必须在当天范围内');
  return String(Math.floor(value / 60)).padStart(2, '0') + ':' + String(value % 60).padStart(2, '0');
}

/** Moving a whole block preserves step duration. Shortening a full-span parallel task is explicit. */
export function moveActionRows(rows: any[], oldStart: string, oldEnd: string, start: string, end: string, parallel: boolean): any[] {
  const delta = minutesOf(start) - minutesOf(oldStart);
  return rows.map(row => {
    if (parallel && row.start === oldStart && row.end === oldEnd) return { ...row, start, end };
    return { ...row, start: clockFromMinute(minutesOf(row.start) + delta), end: clockFromMinute(minutesOf(row.end) + delta) };
  });
}
