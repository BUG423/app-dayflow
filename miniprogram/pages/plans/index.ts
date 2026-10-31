import { getBlocksForDate, getWeekdayName } from '../../data/template';
import { localDateKey, weekDays } from '../../utils/calendar';

Page({
  data: {
    days: [] as any[],
    today: '',
    showNotice: true
  },
  onShow() {
    const today = localDateKey(new Date());
    const days = weekDays(today).map((day: any) => {
      const blocks = getBlocksForDate(day.date);
      const training = blocks.find(block => block.id === 'training');
      return {
        date: day.date,
        weekday: getWeekdayName(day.date),
        title: training ? training.title : '自由安排',
        minutes: training ? training.start + '–' + training.end : '',
        actionCount: training ? training.actions.length : 0,
        selected: today === day.date
      };
    });
    this.setData({ days, today });
  },
  onViewToday() {
    wx.switchTab({ url: '/pages/today/index' });
  }
});
