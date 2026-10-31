import { getBlocksForDate, getWeekdayName, DEMO_NOTICE, PlanBlock } from '../../data/template';
import { forDate, toggleDone, hasAnyRecord, lastReviewKey, setLastReviewKey } from '../../services/records';
import { localDateKey, weekDays, shiftDays, minuteOfDate, timeState } from '../../utils/calendar';
import { progress, blockProgress } from '../../utils/progress';

type UIBlock = PlanBlock & { expanded: boolean; stateText: string; doneCount: number; totalCount: number; actions: any[] };
Page({
  clockTimer: null as ReturnType<typeof setInterval> | null,
  lastToday: '',
  lastClockMinute: '',
  data: {
    selectedDate: '',
    dayTitle: '',
    week: [] as any[],
    blocks: [] as UIBlock[],
    expandedBlock: '',
    isToday: true,
    heroCaption: '此刻的安排',
    heroTitle: '加载中',
    heroTime: '',
    doneLabel: '0 / 0',
    percent: 0,
    notice: DEMO_NOTICE
  },
  onLoad() {
    this.lastToday = localDateKey(new Date());
    this.choose(this.lastToday);
  },
  onShow() {
    const today = localDateKey(new Date());
    this.lastClockMinute = '';
    if (!this.data.selectedDate) this.choose(today);
    else this.updateClock();
    this.showYesterdayRecap(today);
    this.stopClock();
    this.clockTimer = setInterval(() => this.updateClock(), 1000);
  },
  onHide() { this.stopClock(); },
  onUnload() { this.stopClock(); },
  stopClock() {
    if (this.clockTimer !== null) clearInterval(this.clockTimer);
    this.clockTimer = null;
  },
  updateClock() {
    const now = new Date();
    const today = localDateKey(now);
    const clockMinute = today + ':' + minuteOfDate(now);
    if (this.lastClockMinute === clockMinute) return;
    this.lastClockMinute = clockMinute;
    // Follow midnight only while viewing today; preserve dates chosen by the user.
    if (this.lastToday && this.lastToday !== today && this.data.selectedDate === this.lastToday) {
      this.choose(today);
    } else {
      this.refresh();
    }
    this.lastToday = today;
    this.showYesterdayRecap(today);
  },
  onPullDownRefresh() {
    this.refresh();
    wx.stopPullDownRefresh();
  },
  choose(dateKey: string) {
    this.setData({ selectedDate: dateKey, expandedBlock: '' });
    this.refresh();
  },
  refresh() {
    const dateKey = this.data.selectedDate || localDateKey(new Date());
    const today = localDateKey(new Date());
    const now = minuteOfDate(new Date());
    const records = forDate(dateKey);
    const raw = getBlocksForDate(dateKey);
    const total = progress(raw, records);
    const blocks: UIBlock[] = raw.map(block => {
      const count = blockProgress(block, records);
      const state = dateKey === today ? timeState(block.start, block.end, now) : '';
      return {
        ...block,
        actions: block.actions.map(action => ({ ...action, done: records[action.id] === 'done' })),
        expanded: block.id === this.data.expandedBlock,
        stateText: state === 'current' ? '进行中' : state === 'upcoming' ? '待开始' : '',
        doneCount: count.completed,
        totalCount: count.total
      };
    });
    const current = dateKey === today ? blocks.find(block => timeState(block.start, block.end, now) === 'current') : undefined;
    const next = dateKey === today ? blocks.find(block => timeState(block.start, block.end, now) === 'upcoming') : undefined;
    const focus = current || next;
    this.setData({
      selectedDate: dateKey,
      isToday: dateKey === today,
      dayTitle: dateKey.slice(5).replace('-', '月') + '日 · ' + getWeekdayName(dateKey),
      week: weekDays(dateKey).map((item: any) => ({
        ...item, selected: item.date === dateKey, isToday: item.date === today
      })),
      blocks,
      doneLabel: total.completed + ' / ' + total.total,
      percent: total.percent,
      heroCaption: current ? '此刻正在进行' : next ? '接下来' : dateKey !== today ? '查看这一天' : '今天的日程已结束',
      heroTitle: focus ? focus.title : dateKey !== today ? '按时间完成每项计划' : '好好休息',
      heroTime: focus ? focus.start + '–' + focus.end : dateKey !== today ? '切回今天查看当前任务' : '明天继续加油'
    });
  },
  onChooseDay(e: any) {
    this.choose(String(e.currentTarget.dataset.date));
  },
  onShiftWeek(e: any) {
    this.choose(shiftDays(this.data.selectedDate, Number(e.currentTarget.dataset.delta) * 7));
  },
  onToday() { this.choose(localDateKey(new Date())); },
  onToggleBlock(e: any) {
    const id = String(e.currentTarget.dataset.id);
    this.setData({ expandedBlock: this.data.expandedBlock === id ? '' : id });
    this.refresh();
  },
  onToggleTask(e: any) {
    toggleDone(this.data.selectedDate, String(e.currentTarget.dataset.id));
    this.refresh();
  },
  onOpenTraining(e: any) {
    wx.navigateTo({ url: '/pages/training/index?date=' +
      encodeURIComponent(this.data.selectedDate) + '&blockId=' + encodeURIComponent(String(e.currentTarget.dataset.id)) });
  },
  showYesterdayRecap(today: string) {
    if (lastReviewKey() === today) return;
    const yesterday = shiftDays(today, -1);
    if (!hasAnyRecord(yesterday)) return;
    const result = progress(getBlocksForDate(yesterday), forDate(yesterday));
    setLastReviewKey(today);
    wx.showModal({
      title: '昨日回顾',
      content: '昨天完成 ' + result.completed + '/' + result.total +
        ' 项（' + result.percent + '%）。' +
        (result.percent >= 80 ? '保持节奏，今天也很棒！' : '每次行动都是进步，今天继续按自己的节奏来。'),
      showCancel: false,
      confirmText: '开始今天'
    });
  }
});
