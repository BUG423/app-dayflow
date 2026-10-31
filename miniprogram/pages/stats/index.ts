import { getBlocksForDate, getWeekdayName } from '../../data/template';
import { forDate } from '../../services/records';
import { localDateKey, weekDays } from '../../utils/calendar';
import { progress } from '../../utils/progress';

Page({
  data: { weeklyDone: 0, weeklyTotal: 0, percent: 0, days: [] as any[] },
  onShow() {
    const today = localDateKey(new Date());
    let weeklyDone = 0;
    let weeklyTotal = 0;
    const days = weekDays(today).filter((day: any) => day.date <= today).map((day: any) => {
      const result = progress(getBlocksForDate(day.date), forDate(day.date));
      weeklyDone += result.completed;
      weeklyTotal += result.total;
      return { date: day.date, label: getWeekdayName(day.date), ...result };
    });
    const percent = weeklyTotal ? Math.round(weeklyDone * 100 / weeklyTotal) : 0;
    this.setData({ days, weeklyDone, weeklyTotal, percent });
  }
});
