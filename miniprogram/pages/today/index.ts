import { getWeekdayName, DEMO_NOTICE, PlanBlock } from '../../data/template';
import { getDayBlocks } from '../../services/plans';
import { forDate, recordDetailsForDate, setStatus, hasAnyRecord, lastReviewKey, setLastReviewKey } from '../../services/records';
import { getDueReminders, markReminderShown } from '../../services/preferences';
import { STATUS_LABELS, elapsedSeconds, durationText, errorText } from '../../services/execution';
import { TaskStatus } from '../../types/domain';
import { localDateKey, parseLocalDate, weekDays, shiftDays, minuteOfDate, timeState } from '../../utils/calendar';
import { progress, blockProgress } from '../../utils/progress';
import { beginCalendarGesture, calendarGestureCancelled, calendarSwipeDays, CalendarGesture } from '../../utils/calendar-gesture';
import { getDayRest, startRestToday, resumeToday } from '../../services/rest-days';

type UIBlock = Omit<PlanBlock, 'actions'> & { expanded: boolean; stateText: string; doneCount: number; totalCount: number; actions: any[] };
const STATES: TaskStatus[] = ['doing', 'done', 'skipped', 'deferred', 'aborted', 'todo'];
const STATE_OPTIONS = ['开始或继续执行', '标记完成', '跳过这项任务', '标记延期并选择日期', '中止这项任务', '恢复为待开始'];

Page({
  clockTimer: null as ReturnType<typeof setInterval> | null,
  lastToday: '', lastClockMinute: '', reviewShownInSession: '',
  shownReminderKeys: {} as Record<string, boolean>,
  calendarGesture: null as CalendarGesture | null,
  suppressDayTapUntil: 0,
  data: {
    selectedDate: '', dayTitle: '', week: [] as any[], blocks: [] as UIBlock[], expandedBlock: '',
    isToday: true, heroCaption: '此刻的安排', heroTitle: '加载中', heroTime: '', doneLabel: '0 / 0',
    percent: 0, notice: DEMO_NOTICE, reminderText: '', loadError: '',
    showDeferEditor: false, deferTargetId: '', deferTargetTitle: '', deferDate: '',
    restActive: false, restRecorded: false, restReason: '', restWasResumed: false,
    restEditorVisible: false, restFormDate: '', restReasonInput: '', restSaving: false, restError: ''
  },
  onLoad() { this.lastToday = localDateKey(new Date()); this.choose(this.lastToday); },
  onShow() {
    const today = localDateKey(new Date()); this.lastClockMinute = '';
    if (!this.data.selectedDate) this.choose(today); else this.updateClock();
    this.showYesterdayRecap(today);
    this.stopClock(); this.clockTimer = setInterval(() => this.updateClock(), 1000);
  },
  onHide() { this.stopClock(); this.onCalendarTouchCancel(); },
  onUnload() { this.stopClock(); this.onCalendarTouchCancel(); },
  stopClock() { if (this.clockTimer !== null) clearInterval(this.clockTimer); this.clockTimer = null; },
  updateClock() {
    const now = new Date(), today = localDateKey(now), clockMinute = today + ':' + minuteOfDate(now);
    if (this.lastClockMinute === clockMinute) return;
    this.lastClockMinute = clockMinute;
    if (this.lastToday && this.lastToday !== today && this.data.selectedDate === this.lastToday) this.choose(today);
    else this.refresh();
    this.lastToday = today; this.showYesterdayRecap(today);
    this.checkReminders(today, minuteOfDate(now));
  },
  checkReminders(today: string, nowMinute: number) {
    try {
      if (getDayRest(today)?.active) { this.setData({ reminderText: '' }); return; }
      const due = getDueReminders(today, nowMinute, getDayBlocks(today), getDayBlocks(shiftDays(today, 1)));
      const reminder = due.find(item => !this.shownReminderKeys[item.key]);
      if (!reminder) return;
      // In-memory deduplication prevents repeated prompts if local persistence fails.
      this.shownReminderKeys[reminder.key] = true;
      try { markReminderShown(reminder.key); } catch (_err) {}
      this.setData({ reminderText: reminder.title + '（仅在页面前台提示）' });
      wx.showToast({ title: reminder.title, icon: 'none', duration: 3000 });
    } catch (_err) {
      if (!this.data.reminderText) this.setData({ reminderText: '提醒暂时不可用，请检查本地设置。' });
    }
  },
  onPullDownRefresh() { this.refresh(); wx.stopPullDownRefresh(); },
  choose(date: string) {
    try { parseLocalDate(date); }
    catch (_err) { wx.showToast({ title: '日期无效，请重新选择', icon: 'none' }); return; }
    this.setData({ selectedDate: date, expandedBlock: '', showDeferEditor: false, restEditorVisible: false, restError: '' }); this.refresh();
  },
  refresh() {
    const date = this.data.selectedDate || localDateKey(new Date()), today = localDateKey(new Date()), now = minuteOfDate(new Date());
    try {
      const details = recordDetailsForDate(date), records: Record<string, TaskStatus> = Object.create(null);
      Object.keys(details).forEach(id => { records[id] = details[id].status; });
      const raw = getDayBlocks(date), total = progress(raw, records), rest = getDayRest(date);
      const restActive = date === today && !!rest?.active;
      const blocks: UIBlock[] = raw.map(block => {
        const count = blockProgress(block, records), state = date === today ? timeState(block.start, block.end, now) : '';
        return { ...block,
          colorCategory: block.category === '加班' || block.title === '加班' ? 'overtime' : block.category === '训练' ? 'training' : block.category === '兴趣' ? 'interest' : block.category === '工作' ? 'work' : 'life',
          actions: block.actions.map(action => ({ ...action, done: records[action.id] === 'done',
            status: records[action.id] || 'todo', statusText: restActive && (!records[action.id] || records[action.id] === 'todo') ? '今日休息' : STATUS_LABELS[records[action.id] || 'todo'],
            deferredTo: details[action.id]?.deferredTo || '',
            elapsedText: durationText(elapsedSeconds(details[action.id])),
            feedback: details[action.id]?.feedback })),
          expanded: block.id === this.data.expandedBlock,
          stateText: restActive ? '今日休息' : state === 'current' ? '当前时段' : state === 'upcoming' ? '待开始' : '',
          doneCount: count.completed, totalCount: count.total };
      });
      let running: any;
      if (date === today) {
        for (const block of blocks) {
          const action = block.actions.find(item => item.status === 'doing');
          if (action) { running = action; break; }
        }
      }
      const available = (block: UIBlock) => block.kind === 'fixed' || block.doneCount < block.totalCount;
      const current = date === today ? blocks.find(block => available(block) && timeState(block.start, block.end, now) === 'current') : undefined;
      const next = date === today ? blocks.find(block => available(block) && timeState(block.start, block.end, now) === 'upcoming') : undefined;
      const focus = current || next;
      this.setData({
        selectedDate: date, isToday: date === today, loadError: '',
        dayTitle: date.slice(5).replace('-', '月') + '日 · ' + getWeekdayName(date),
        week: weekDays(date).map((item: any, index: number) => ({ ...item, selected: item.date === date, isToday: item.date === today,
          monthLabel: index === 0 || item.day === 1 ? Number(item.date.slice(5, 7)) + '月' : '' })),
        blocks, doneLabel: total.completed + ' / ' + total.total, percent: total.percent,
        restActive, restRecorded: !!rest, restReason: rest?.reason || '', restWasResumed: !!rest && !rest.active,
        ...(restActive ? { reminderText: '', showDeferEditor: false } : {}),
        heroCaption: restActive ? '按自己的节奏来' : running ? '正在执行' : current ? '此刻正在进行' : next ? '接下来' : date !== today ? '查看这一天' : '今天的日程已结束',
        heroTitle: restActive ? '今天休息' : running ? running.title : focus ? focus.title : date !== today ? '按时间完成每项计划' : '好好休息',
        heroTime: restActive ? '今天的安排已暂停，已完成记录保留。' : running ? '实际执行 ' + running.elapsedText : focus ? focus.start + '–' + focus.end : date !== today ? '切回今天查看当前任务' : '明天继续加油'
      });
    } catch (err) {
      this.setData({ loadError: errorText(err), heroTitle: '暂时无法读取日程', heroCaption: '请稍后重试', heroTime: '', blocks: [], doneLabel: '—', percent: 0 });
    }
  },
  onChooseDay(e: any) { if (Date.now() < this.suppressDayTapUntil) return; this.choose(String(e.currentTarget.dataset.date)); },
  onCalendarTouchStart(e: any) { this.calendarGesture = beginCalendarGesture(e.touches, Date.now()); },
  onCalendarTouchMove(e: any) { if (calendarGestureCancelled(this.calendarGesture, e.touches)) this.calendarGesture = null; },
  onCalendarTouchCancel() { this.calendarGesture = null; this.suppressDayTapUntil = 0; },
  onCalendarTouchEnd(e: any) {
    const gesture = this.calendarGesture; this.calendarGesture = null;
    const days = calendarSwipeDays(gesture, e.changedTouches, Date.now());
    if (!days) return;
    this.suppressDayTapUntil = Date.now() + 300;
    this.choose(shiftDays(this.data.selectedDate, days));
  },
  onShiftWeek(e: any) { this.choose(shiftDays(this.data.selectedDate, Number(e.currentTarget.dataset.delta) * 7)); },
  onToday() { this.choose(localDateKey(new Date())); },
  onOpenRest() {
    const date = localDateKey(new Date());
    if (this.data.selectedDate !== date) return;
    try {
      const rest = getDayRest(date);
      if (rest?.active) { this.refresh(); return; }
      this.setData({ restEditorVisible: true, restFormDate: date, restReasonInput: '', restError: '' });
    } catch (err) { wx.showToast({ title: errorText(err), icon: 'none' }); }
  },
  onRestReasonInput(e: any) { this.setData({ restReasonInput: String(e.detail.value), restError: '' }); },
  onCancelRest() { this.setData({ restEditorVisible: false, restError: '' }); },
  onConfirmRest() {
    if (this.data.restSaving) return;
    const date = localDateKey(new Date());
    if (this.data.restFormDate !== date || this.data.selectedDate !== date) {
      this.setData({ restEditorVisible: false }); this.refresh();
      wx.showToast({ title: '日期已变化，请重新选择今天的安排', icon: 'none' }); return;
    }
    try {
      this.setData({ restSaving: true, restError: '' });
      startRestToday(this.data.restReasonInput);
      this.setData({ restEditorVisible: false }); this.refresh();
      wx.showToast({ title: '今天先好好休息', icon: 'none' });
    } catch (err) { this.setData({ restError: errorText(err) }); this.refresh(); }
    finally { this.setData({ restSaving: false }); }
  },
  onResumeRest() {
    if (this.data.restSaving || this.data.selectedDate !== localDateKey(new Date())) return;
    try {
      this.setData({ restSaving: true }); resumeToday(); this.refresh();
      wx.showToast({ title: '已恢复安排，需要时再手动开始', icon: 'none' });
    } catch (err) { wx.showToast({ title: errorText(err), icon: 'none' }); }
    finally { this.setData({ restSaving: false }); }
  },
  executionPaused(): boolean {
    try {
      const date = localDateKey(new Date());
      if (this.data.selectedDate !== date || !getDayRest(date)?.active) return false;
      this.refresh(); wx.showToast({ title: '今天正在休息，恢复安排后再执行', icon: 'none' }); return true;
    } catch (err) { wx.showToast({ title: errorText(err), icon: 'none' }); return true; }
  },
  onToggleBlock(e: any) {
    const id = String(e.currentTarget.dataset.id);
    this.setData({ expandedBlock: this.data.expandedBlock === id ? '' : id }); this.refresh();
  },
  onToggleTask(e: any) {
    if (this.executionPaused()) return;
    const id = String(e.currentTarget.dataset.id);
    try {
      const record = recordDetailsForDate(this.data.selectedDate)[id];
      setStatus(this.data.selectedDate, id, record?.status === 'done' ? 'todo' : 'done');
      this.refresh();
    } catch (err) { wx.showToast({ title: errorText(err), icon: 'none' }); }
  },
  onTaskMenu(e: any) {
    if (this.executionPaused()) return;
    const id = String(e.currentTarget.dataset.id);
    const action = this.data.blocks.reduce((items: any[], block: any) => items.concat(block.actions), []).find(item => item.id === id);
    if (!action) return;
    wx.showActionSheet({ itemList: STATE_OPTIONS, success: result => {
      const status = STATES[result.tapIndex]; if (!status) return;
      if (status === 'deferred') {
        const today = localDateKey(new Date()), base = this.data.selectedDate > today ? this.data.selectedDate : today;
        this.setData({ showDeferEditor: true, deferTargetId: id, deferTargetTitle: action.title, deferDate: shiftDays(base, 1) }); return;
      }
      try { setStatus(this.data.selectedDate, id, status); this.refresh(); }
      catch (err) { wx.showToast({ title: errorText(err), icon: 'none' }); }
    } });
  },
  onDeferDateChange(e: any) { this.setData({ deferDate: String(e.detail.value) }); },
  onCancelDefer() { this.setData({ showDeferEditor: false }); },
  onConfirmDefer() {
    if (this.executionPaused()) return;
    try {
      setStatus(this.data.selectedDate, this.data.deferTargetId, 'deferred', { deferredTo: this.data.deferDate });
      this.setData({ showDeferEditor: false }); this.refresh();
      wx.showToast({ title: '已标记延期，可到计划页一键安排', icon: 'none' });
    } catch (err) { wx.showToast({ title: errorText(err), icon: 'none' }); }
  },
  onOpenTraining(e: any) {
    wx.navigateTo({ url: '/pages/training/index?date=' + encodeURIComponent(this.data.selectedDate) + '&blockId=' + encodeURIComponent(String(e.currentTarget.dataset.id)) });
  },
  showYesterdayRecap(today: string) {
    if (this.reviewShownInSession === today || lastReviewKey() === today) return;
    const yesterday = shiftDays(today, -1); if (!hasAnyRecord(yesterday)) return;
    try {
      const records = forDate(yesterday), result = progress(getDayBlocks(yesterday), records);
      const values = Object.keys(records).map(id => records[id]);
      setLastReviewKey(today); this.reviewShownInSession = today;
      wx.showModal({ title: '昨日回顾',
        content: '昨天完成 ' + result.completed + '/' + result.total + ' 项（' + result.percent + '%）。' +
          '跳过 ' + values.filter(status => status === 'skipped').length + ' 项，中止 ' + values.filter(status => status === 'aborted').length + ' 项。' +
          (result.percent >= 80 ? '保持节奏，今天也很棒！' : '每次行动都是进步，今天继续按自己的节奏来。'),
        showCancel: false, confirmText: '开始今天' });
    } catch (_err) { /* An unreadable review must not be marked as successfully shown. */ }
  }
});

