import { getWeeklySummary, getHistorySummary } from '../../services/insights';
import { getDayBlocks } from '../../services/plans';
import { getHistory } from '../../services/records';
import { localDateKey, shiftDays, weekDays } from '../../utils/calendar';

const statusNames: Record<string, string> = { todo: '待开始', doing: '进行中', done: '完成', skipped: '跳过', deferred: '延期', aborted: '中止' };
function timeLabel(value?: number) { if (value === undefined) return '未记录'; const d = new Date(value); return localDateKey(d) + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); }
Page({
  data: { weeklyDone: 0, weeklyTotal: 0, percent: 0, days: [] as any[], anchorDate: '', weekLabel: '', trainingCompleted: 0, trainingTotal: 0, streak: 0, activeDays: 0, historyDays: [] as any[], historyRecords: [] as any[], historyCount: 0, fromDate: '', toDate: '', errorMessage: '' },
  onShow() { const today = localDateKey(new Date()); if (!this.data.anchorDate) this.setData({ anchorDate: today, fromDate: shiftDays(today, -29), toDate: today }); this.refresh(); },
  refresh() {
    try {
      const weekly = getWeeklySummary(this.data.anchorDate), history = getHistorySummary(this.data.fromDate || undefined, this.data.toDate || undefined), week = weekDays(this.data.anchorDate);
      const historyRecords = getHistory(this.data.fromDate || undefined, this.data.toDate || undefined).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 50).map(record => {
        const action = getDayBlocks(record.date).reduce((all: any[], block) => all.concat(block.actions), []).find(item => item.id === record.targetId);
        const feedback = record.feedback;
        const feedbackLabel = feedback ? [feedback.effort ? '自选强度 ' + feedback.effort + '级' : '', feedback.discomfort === true ? '有不适反馈' : feedback.discomfort === false ? '用户未报告不适' : '', feedback.note || ''].filter(Boolean).join('；') : '';
        return { recordKey: record.date + ':' + record.targetId, date: record.date, title: action ? action.title : '原计划事项', status: record.status, statusLabel: statusNames[record.status],
          actualStartLabel: timeLabel(record.actualStartedAt), actualFinishLabel: timeLabel(record.finishedAt), feedbackLabel, deferredTo: record.deferredTo || '',
          eventCount: record.events.length, events: record.events.map(event => ({ id: event.id, fromLabel: statusNames[event.from], toLabel: statusNames[event.to], atLabel: timeLabel(event.at), reason: event.reason || '' })), expanded: false };
      });
      this.setData({ weeklyDone: weekly.completed, weeklyTotal: weekly.total, percent: weekly.percent, days: weekly.days, trainingCompleted: weekly.trainingCompleted, trainingTotal: weekly.trainingTotal,
        weekLabel: week[0].date + ' 至 ' + week[6].date, streak: history.streak, activeDays: history.activeDays, historyDays: history.days, historyRecords, historyCount: history.days.length, errorMessage: '' });
    } catch (error) { const message = error && error.message || '统计读取失败'; this.setData({ errorMessage: message }); wx.showToast({ title: message, icon: 'none' }); }
  },
  onPreviousWeek() { this.setData({ anchorDate: shiftDays(this.data.anchorDate, -7) }); this.refresh(); },
  onNextWeek() { this.setData({ anchorDate: shiftDays(this.data.anchorDate, 7) }); this.refresh(); },
  onCurrentWeek() { this.setData({ anchorDate: localDateKey(new Date()) }); this.refresh(); },
  onHistoryFromChange(e: any) { this.setData({ fromDate: String(e.detail.value) }); },
  onHistoryToChange(e: any) { this.setData({ toDate: String(e.detail.value) }); },
  onApplyHistoryRange() { this.refresh(); },
  onToggleHistoryRecord(e: any) { const key = String(e.currentTarget.dataset.id); this.setData({ historyRecords: this.data.historyRecords.map((record: any) => record.recordKey === key ? { ...record, expanded: !record.expanded } : record) }); },
  onOpenHistoryDay(e: any) {
    try {
      const date = String(e.currentTarget.dataset.date), actions = getDayBlocks(date).reduce((all: any[], block) => all.concat(block.actions), []), records = getHistory(date, date);
      const lines = records.map(record => {
        const action = actions.find(item => item.id === record.targetId);
        return (action ? action.title : '原计划事项') + '：' + statusNames[record.status] + '\n实际开始 ' + timeLabel(record.actualStartedAt) + '；结束 ' + timeLabel(record.finishedAt) + (record.deferredTo ? '\n延期到 ' + record.deferredTo : '') + (record.feedback && record.feedback.note ? '\n反馈：' + record.feedback.note : '');
      });
      wx.showModal({ title: date + ' 执行记录', content: lines.join('\n\n').slice(0, 1500) || '这一天尚无执行记录。', showCancel: false, confirmText: '知道了' });
    } catch (error) { wx.showToast({ title: error.message || '历史读取失败', icon: 'none' }); }
  }
});
