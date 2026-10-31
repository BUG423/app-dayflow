import { DEMO_NOTICE } from '../../data/template';
import { getDayBlocks, getDailyInstance, setEmergencyPlan } from '../../services/plans';
import { recordDetailsForDate, setStatus, saveFeedback } from '../../services/records';
import { getPreferences, savePreferences } from '../../services/preferences';
import { chooseAndSavePhoto, getPhotos, removePhoto } from '../../services/media';
import { getSyncState, getPhotoPreviewPath, uploadPhoto } from '../../services/sync';
import { STATUS_LABELS, elapsedSeconds, durationText, errorText } from '../../services/execution';
import { getTimer, startTimer, pauseTimer, resumeTimer, resetTimer, TimerState } from '../../services/timer';
import { ExecutionRecord, TaskStatus, TrainingFeedback } from '../../types/domain';
import { localDateKey, parseLocalDate, shiftDays } from '../../utils/calendar';
import { progress } from '../../utils/progress';
import { getDayRest } from '../../services/rest-days';

const STATES: TaskStatus[] = ['doing', 'done', 'skipped', 'deferred', 'aborted', 'todo'];
const STATE_OPTIONS = ['开始或继续执行', '标记完成', '跳过这个动作', '标记延期并选择日期', '中止这个动作', '恢复为待开始'];
const PHASES = ['基础', '巩固', '自主调整'];

Page({
  activeRecords: {} as Record<string, ExecutionRecord>,
  clockTimer: null as ReturnType<typeof setInterval> | null,
  timerNotifiedId: '',
  data: {
    dateKey: '', blockId: '', title: '训练详情', time: '', actions: [] as any[], progressText: '0 / 0',
    percent: 0, safety: DEMO_NOTICE, loadError: '', sessionElapsedText: '00:00', isTrainingBlock: true,
    emergencyEnabled: false, emergencyAvailable: false,
    phaseOptions: PHASES, phaseIndex: 0, trainingPhase: '基础', phaseDescription: '', cloudSyncEnabled: false,
    showFeedbackEditor: false, feedbackTargetId: '', feedbackTargetTitle: '', feedbackNote: '',
    feedbackEffort: 3, feedbackDiscomfort: false,
    showDeferEditor: false, deferTargetId: '', deferTargetTitle: '', deferDate: '',
    showTimerPanel: false, timerSelectedId: '', timerSelectedTitle: '', timerTargetTitle: '',
    timerSecondsInput: '60', timerRemainingText: '00:00', timerStatusText: '尚未开始',
    timerState: null as TimerState | null, timerReadError: '',
    restActive: false, restReason: ''
  },
  onLoad(options: any) {
    const date = String(options.date || localDateKey(new Date())), blockId = String(options.blockId || 'training');
    try { parseLocalDate(date); }
    catch (_err) { wx.showToast({ title: '日期无效，请从日程重新进入', icon: 'none' }); return; }
    this.setData({ dateKey: date, blockId }); this.loadBlock();
  },
  onShow() {
    if (!this.data.dateKey) return;
    this.loadBlock(); this.stopClock();
    this.clockTimer = setInterval(() => this.renderElapsed(), 1000);
  },
  onHide() { this.stopClock(); },
  onUnload() { this.stopClock(); },
  stopClock() { if (this.clockTimer !== null) clearInterval(this.clockTimer); this.clockTimer = null; },
  loadBlock() {
    try {
      const blocks = getDayBlocks(this.data.dateKey);
      const block = blocks.find(item => item.id === this.data.blockId && item.kind === 'sequence');
      if (!block) {
        this.activeRecords = {};
        this.setData({ actions: [], progressText: '0 / 0', percent: 0, loadError: '未找到该训练计划' });
        wx.showToast({ title: '未找到该训练计划', icon: 'none' }); return;
      }
      const details = recordDetailsForDate(this.data.dateKey), records: Record<string, TaskStatus> = Object.create(null);
      const rest = getDayRest(this.data.dateKey), restActive = this.data.dateKey === localDateKey(new Date()) && !!rest?.active;
      Object.keys(details).forEach(id => { records[id] = details[id].status; });
      this.activeRecords = details;
      const total = progress([block], records), instance = getDailyInstance(this.data.dateKey);
      const isTrainingBlock = block.category === '训练' || block.id === 'training';
      if (typeof wx.setNavigationBarTitle === 'function') wx.setNavigationBarTitle({ title: isTrainingBlock ? '训练详情' : '执行详情' });
      let warning = '', photos: ReturnType<typeof getPhotos> = [];
      try { photos = getPhotos(this.data.dateKey); } catch (err) { warning = errorText(err); }
      let phaseIndex = 0, trainingPhase = '基础', phaseDescription = '阶段由你自主选择，具体动作与剂量可在计划页调整。';
      try {
        const preferences = getPreferences(); trainingPhase = preferences.trainingPhase;
        phaseIndex = Math.max(0, PHASES.indexOf(trainingPhase));
        const rule = preferences.phaseRules.find(item => item.name === trainingPhase);
        if (rule) phaseDescription = rule.description + '（仅为个人参考，不强制解锁）';
      } catch (err) { warning = errorText(err); }
      let cloudSyncEnabled = false;
      try { const state = getSyncState(); cloudSyncEnabled = Boolean(state.enabled && state.configured); } catch (_err) {}
      this.setData({
        title: block.title, time: block.start + '–' + block.end, loadError: warning, phaseIndex, trainingPhase, phaseDescription, cloudSyncEnabled, isTrainingBlock,
        restActive, restReason: rest?.reason || '', ...(restActive ? { showTimerPanel: false, showDeferEditor: false } : {}),
        emergencyEnabled: isTrainingBlock && instance.mode === 'emergency',
        emergencyAvailable: !restActive && isTrainingBlock && !instance.locked && this.data.dateKey >= localDateKey(new Date()) && !Object.keys(details).length,
        actions: block.actions.map(action => ({ ...action, done: records[action.id] === 'done',
          status: records[action.id] || 'todo', statusText: restActive && (!records[action.id] || records[action.id] === 'todo') ? '今日休息' : STATUS_LABELS[records[action.id] || 'todo'],
          deferredTo: details[action.id]?.deferredTo || '', feedback: details[action.id]?.feedback,
          elapsedText: durationText(elapsedSeconds(details[action.id])), photos: photos.filter(photo => photo.targetId === action.id) })),
        progressText: total.completed + ' / ' + total.total, percent: total.percent
      });
      this.renderElapsed();
    } catch (err) {
      this.activeRecords = {};
      this.setData({ actions: [], progressText: '—', percent: 0, loadError: errorText(err), emergencyAvailable: false });
      wx.showToast({ title: errorText(err), icon: 'none' });
    }
  },
  renderElapsed() {
    const actions = this.data.actions.map(action => ({ ...action, elapsedText: durationText(elapsedSeconds(this.activeRecords[action.id])) }));
    const seconds = actions.reduce((sum, action) => sum + elapsedSeconds(this.activeRecords[action.id]), 0);
    this.setData({ actions, sessionElapsedText: durationText(seconds) });
    this.renderTimer();
  },
  renderTimer() {
    try {
      const timer = getTimer();
      const action = timer ? this.data.actions.find(item => item.id === timer.targetId && timer.dateKey === this.data.dateKey) : undefined;
      this.setData({ timerState: timer, timerRemainingText: timer ? durationText(timer.remainingSeconds) : '00:00',
        timerStatusText: timer ? ({ running: '计时中', paused: '已暂停', finished: '计时结束' })[timer.status] : '尚未开始',
        timerTargetTitle: timer ? (action ? action.title : '其他日期或任务的计时') : '', timerReadError: '' });
      if (timer?.status === 'finished') {
        const key = timer.dateKey + ':' + timer.targetId + ':' + timer.updatedAt;
        if (this.timerNotifiedId !== key) { this.timerNotifiedId = key; wx.showToast({ title: '计时结束，请自行确认是否完成', icon: 'none' }); }
      }
    } catch (err) {
      this.setData({ timerState: null, timerRemainingText: '—', timerStatusText: '计时暂不可用', timerReadError: errorText(err) });
    }
  },
  executionPaused(): boolean {
    try {
      const date = localDateKey(new Date());
      if (this.data.dateKey !== date || !getDayRest(date)?.active) return false;
      this.loadBlock(); wx.showToast({ title: '今天正在休息，恢复安排后再执行', icon: 'none' }); return true;
    } catch (err) { wx.showToast({ title: errorText(err), icon: 'none' }); return true; }
  },
  onViewRestDay() {
    wx.switchTab({ url: '/pages/today/index', success: () => {
      const page = getCurrentPages().find(item => item.route === 'pages/today/index') as any;
      if (page && typeof page.onToday === 'function') page.onToday();
    } });
  },
  onToggleAction(e: any) {
    if (this.executionPaused()) return;
    const id = String(e.currentTarget.dataset.id), action = this.data.actions.find(item => item.id === id);
    if (!action) return;
    try { setStatus(this.data.dateKey, id, action.done ? 'todo' : 'done'); this.loadBlock(); }
    catch (err) { wx.showToast({ title: errorText(err), icon: 'none' }); }
  },
  onActionMenu(e: any) {
    if (this.executionPaused()) return;
    const id = String(e.currentTarget.dataset.id), action = this.data.actions.find(item => item.id === id);
    if (!action) return;
    wx.showActionSheet({ itemList: STATE_OPTIONS, success: result => {
      const status = STATES[result.tapIndex]; if (!status) return;
      if (status === 'deferred') {
        const today = localDateKey(new Date()), base = this.data.dateKey > today ? this.data.dateKey : today;
        this.setData({ showDeferEditor: true, deferTargetId: id, deferTargetTitle: action.title, deferDate: shiftDays(base, 1) }); return;
      }
      try { setStatus(this.data.dateKey, id, status); this.loadBlock(); }
      catch (err) { wx.showToast({ title: errorText(err), icon: 'none' }); }
    } });
  },
  onDeferDateChange(e: any) { this.setData({ deferDate: String(e.detail.value) }); },
  onCancelDefer() { this.setData({ showDeferEditor: false }); },
  onConfirmDefer() {
    if (this.executionPaused()) return;
    try {
      setStatus(this.data.dateKey, this.data.deferTargetId, 'deferred', { deferredTo: this.data.deferDate });
      this.setData({ showDeferEditor: false }); this.loadBlock();
      wx.showToast({ title: '已标记延期，可到计划页一键安排', icon: 'none' });
    } catch (err) { wx.showToast({ title: errorText(err), icon: 'none' }); }
  },
  onStart() {
    if (this.executionPaused()) return;
    if (this.data.actions.some(action => action.status === 'doing')) { wx.showToast({ title: '当前动作正在执行', icon: 'none' }); return; }
    const action = this.data.actions.find(item => !item.done);
    if (!action) { wx.showToast({ title: '当前动作均已完成', icon: 'none' }); return; }
    try { setStatus(this.data.dateKey, action.id, 'doing'); this.loadBlock(); }
    catch (err) { wx.showToast({ title: errorText(err), icon: 'none' }); }
  },
  onStop() {
    if (this.executionPaused()) return;
    if (!this.data.actions.length) return;
    wx.showModal({ title: this.data.isTrainingBlock ? '中止本次训练？' : '中止本次执行？', content: '已完成步骤会保留，其余步骤记录为中止。无需勉强完成，之后可自行继续。',
      confirmText: '确认中止', success: result => {
        if (!result.confirm) return;
        try {
          for (const action of this.data.actions) {
            if (action.status !== 'done' && action.status !== 'aborted') setStatus(this.data.dateKey, action.id, 'aborted', { reason: '用户中止本次训练' });
          }
          this.loadBlock(); wx.showToast({ title: '已记录中止状态', icon: 'none' });
        } catch (err) { this.loadBlock(); wx.showToast({ title: errorText(err), icon: 'none' }); }
      } });
  },
  onEmergency() {
    if (this.executionPaused()) return;
    if (!this.data.emergencyAvailable) { wx.showToast({ title: '已有记录的计划不能替换', icon: 'none' }); return; }
    const enabled = !this.data.emergencyEnabled;
    wx.showModal({ title: enabled ? '选择十五分钟简化计划？' : '恢复常规计划？',
      content: '仅调整这一天尚未执行的训练示例。请按自身情况选择，也可以随时停止。',
      confirmText: '确认切换', success: result => {
        if (!result.confirm) return;
        try { setEmergencyPlan(this.data.dateKey, enabled, this.data.blockId); this.loadBlock(); }
        catch (err) { wx.showToast({ title: errorText(err), icon: 'none' }); }
      } });
  },
  onTrainingPhaseChange(e: any) {
    const phase = PHASES[Number(e.detail.value)]; if (!phase) return;
    try { savePreferences({ trainingPhase: phase as '基础' | '巩固' | '自主调整' }); this.loadBlock(); }
    catch (err) { wx.showToast({ title: errorText(err), icon: 'none' }); }
  },
  onOpenFeedback(e: any) {
    const id = String(e.currentTarget.dataset.id), action = this.data.actions.find(item => item.id === id); if (!action) return;
    const feedback = this.activeRecords[id]?.feedback;
    this.setData({ showFeedbackEditor: true, feedbackTargetId: id, feedbackTargetTitle: action.title,
      feedbackNote: feedback?.note || '', feedbackEffort: feedback?.effort || 3, feedbackDiscomfort: feedback?.discomfort || false });
  },
  onFeedbackNoteInput(e: any) { this.setData({ feedbackNote: String(e.detail.value) }); },
  onFeedbackEffortChange(e: any) { this.setData({ feedbackEffort: Number(e.detail.value) }); },
  onFeedbackDiscomfortChange(e: any) { this.setData({ feedbackDiscomfort: Boolean(e.detail.value) }); },
  onCancelFeedback() { this.setData({ showFeedbackEditor: false }); },
  onSaveFeedback() {
    try {
      saveFeedback(this.data.dateKey, this.data.feedbackTargetId, { effort: this.data.feedbackEffort as TrainingFeedback['effort'],
        discomfort: this.data.feedbackDiscomfort, note: this.data.feedbackNote });
      const discomfort = this.data.feedbackDiscomfort; this.setData({ showFeedbackEditor: false }); this.loadBlock();
      if (discomfort) wx.showModal({ title: '已记录本次感受', content: '如有不适，可随时中止或降低强度，并请专业人员审核。记录不会自动解锁训练阶段。',
        showCancel: false, confirmText: '知道了' });
      else wx.showToast({ title: '感受已保存', icon: 'success' });
    } catch (err) { wx.showToast({ title: errorText(err), icon: 'none' }); }
  },
  async onChoosePhoto(e: any) {
    const id = String(e.currentTarget.dataset.id); if (!this.data.actions.some(action => action.id === id)) return;
    try { await chooseAndSavePhoto(this.data.dateKey, id); this.loadBlock(); wx.showToast({ title: '照片已保存在本机', icon: 'success' }); }
    catch (err) { wx.showToast({ title: errorText(err), icon: 'none' }); }
  },
  onRemovePhoto(e: any) {
    const id = String(e.currentTarget.dataset.photoId);
    wx.showModal({ title: '移除照片关联？', content: '仅移除此任务中的照片关联；本机保存副本可在微信存储管理中清理，不删除相册原图或云端文件。', confirmText: '确认移除',
      success: result => { if (!result.confirm) return;
        try { removePhoto(id); this.loadBlock(); wx.showToast({ title: '已移除关联', icon: 'none' }); } catch (err) { wx.showToast({ title: errorText(err), icon: 'none' }); }
      } });
  },
  async onPreviewPhoto(e: any) {
    const path = String(e.currentTarget.dataset.path || '');
    try {
      const photo = getPhotos(this.data.dateKey).find(item => item.localPath === path || item.cloudFileID === path);
      if (!photo) throw new Error('未找到这张照片');
      const url = await getPhotoPreviewPath(photo); wx.previewImage({ current: url, urls: [url] });
    } catch (err) { wx.showToast({ title: errorText(err), icon: 'none' }); }
  },
  async onUploadPhoto(e: any) {
    try { await uploadPhoto(String(e.currentTarget.dataset.photoId)); this.loadBlock(); wx.showToast({ title: '照片已上传', icon: 'success' }); }
    catch (err) { wx.showToast({ title: errorText(err), icon: 'none' }); }
  },
  onCopyKeyword(e: any) { const keyword = String(e.currentTarget.dataset.keyword || ''); if (keyword) wx.setClipboardData({ data: keyword }); },
  onSelectTimerTarget(e: any) {
    if (this.executionPaused()) return;
    const id = String(e.currentTarget.dataset.id), action = this.data.actions.find(item => item.id === id);
    if (!action) return;
    this.setData({ showTimerPanel: true, timerSelectedId: id, timerSelectedTitle: action.title }); this.renderTimer();
  },
  onCloseTimerPanel() { this.setData({ showTimerPanel: false }); },
  onTimerDurationInput(e: any) { this.setData({ timerSecondsInput: String(e.detail.value) }); },
  onStartTimer() {
    if (this.executionPaused()) return;
    const id = this.data.timerSelectedId || this.data.actions.find(action => action.status === 'doing')?.id || this.data.actions[0]?.id;
    if (!id) return;
    if (!/^\d{1,5}$/.test(this.data.timerSecondsInput)) { wx.showToast({ title: '请输入整数秒数', icon: 'none' }); return; }
    try {
      const current = getTimer();
      const start = () => {
        try { startTimer(this.data.dateKey, id, Number(this.data.timerSecondsInput)); this.renderTimer(); }
        catch (err) { wx.showToast({ title: errorText(err), icon: 'none' }); }
      };
      if (current && current.status !== 'finished') wx.showModal({ title: '替换当前计时？',
        content: '当前计时会被新的倒计时替换，任务完成状态保持不变。', confirmText: '确认替换', success: result => { if (result.confirm) start(); } });
      else start();
    } catch (err) { wx.showToast({ title: errorText(err), icon: 'none' }); }
  },
  onPauseTimer() { try { pauseTimer(); this.renderTimer(); } catch (err) { wx.showToast({ title: errorText(err), icon: 'none' }); } },
  onResumeTimer() { if (this.executionPaused()) return; try { resumeTimer(); this.renderTimer(); } catch (err) { wx.showToast({ title: errorText(err), icon: 'none' }); } },
  onResetTimer() { try { resetTimer(); this.renderTimer(); } catch (err) { wx.showToast({ title: errorText(err), icon: 'none' }); } }
});

