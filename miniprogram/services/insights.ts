import { getDayBlocks } from './plans';
import { forDate, getHistory } from './records';
import { getWeekdayName } from '../data/template';
import { localDateKey, parseLocalDate, weekDays, shiftDays } from '../utils/calendar';
import { progress } from '../utils/progress';
import { DaySummary } from '../types/domain';

function daySummary(date: string): DaySummary {
  const blocks = getDayBlocks(date), records = forDate(date);
  const all = progress(blocks, records);
  const training = progress(blocks.filter(block => block.category === '训练' || block.id === 'training'), records);
  return { date, label: getWeekdayName(date), ...all, trainingCompleted: training.completed, trainingTotal: training.total };
}
export function getWeeklySummary(anchorDate: string): { days: DaySummary[]; completed: number; total: number; percent: number; trainingCompleted: number; trainingTotal: number } {
  parseLocalDate(anchorDate);
  const today = localDateKey(new Date());
  const days = weekDays(anchorDate).filter((day: any) => day.date <= today).map((day: any) => daySummary(day.date));
  const completed = days.reduce((sum, day) => sum + day.completed, 0), total = days.reduce((sum, day) => sum + day.total, 0);
  return { days, completed, total, percent: total ? Math.round(completed * 100 / total) : 0,
    trainingCompleted: days.reduce((sum, day) => sum + day.trainingCompleted, 0), trainingTotal: days.reduce((sum, day) => sum + day.trainingTotal, 0) };
}
export function getHistorySummary(fromDate?: string, toDate?: string): { days: DaySummary[]; streak: number; activeDays: number } {
  if (fromDate) parseLocalDate(fromDate); if (toDate) parseLocalDate(toDate);
  if (fromDate && toDate && fromDate > toDate) throw new Error('历史开始日期不能晚于结束日期');
  const today = localDateKey(new Date());
  // Viewing a plan creates a derived daily snapshot, not an execution fact.
  // Only dates with real record entries belong in the execution history list.
  const dates = new Set<string>(getHistory().map(record => record.date));
  const allDays = [...dates].filter(date => date <= today).sort().map(daySummary);
  const completedDates = new Set(allDays.filter(day => day.completed > 0).map(day => day.date));
  let cursor = completedDates.has(today) ? today : shiftDays(today, -1), streak = 0;
  while (completedDates.has(cursor)) { streak++; cursor = shiftDays(cursor, -1); }
  const days = allDays.filter(day => (!fromDate || day.date >= fromDate) && (!toDate || day.date <= toDate)).reverse();
  return { days, streak, activeDays: days.filter(day => day.completed > 0).length };
}
