import { getPreferences, savePreferences, Preferences } from '../../services/preferences';
import { prepareReminder, registerReminder, listReminders, cancelReminder, reminderStatusText, ReminderPreview } from '../../services/reminders';
import { getSyncState, configureSync, syncNow, resolveSyncConflict } from '../../services/sync';
import { clearRecords } from '../../services/records';
import { exportLocalBackupFile, chooseLocalBackupFile, shareLocalBackupFile, previewLocalBackup, restoreLocalBackup,
  getLocalBackupState, previewUndoLocalBackup, undoLocalBackup, LocalBackupFile, LocalBackupPreview,
  LocalBackupSummary } from '../../services/local-backup';
import { localDateKey } from '../../utils/calendar';
import { clearTimer } from '../../services/timer';

function backupSummaryView(summary: LocalBackupSummary) {
  const date = new Date(summary.exportedAt);
  const time = localDateKey(date) + ' ' + String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0');
  return { planName: summary.planName, scheduleCount: summary.scheduleCount, recordCount: summary.recordCount,
    recordDateCount: summary.recordDateCount, snapshotCount: summary.snapshotCount, restDayCount: summary.restDayCount,
    exportedAtLabel: time, dateRangeLabel: summary.rangeStart ? summary.rangeStart + ' 至 ' + summary.rangeEnd : '暂无历史记录' };
}

function backupError(error: any, fallback: string) {
  const message = error && error.message;
  if (typeof message !== 'string' || !/[\u3400-\u9fff]/.test(message) || message.length > 240 ||
      /[\r\n\t{}\[\]]|(?:wxfile|https?|file|cloud):\/\/|[A-Za-z]:[\\/]|\\\\|\/(?:usr|tmp|home|var|data|sandbox|private|Users)[\\/]/i.test(message)) return fallback;
  return message;
}
function backupToast(title: string) { try { wx.showToast({ title, icon: 'none' }); } catch (_error) { /* The inline outcome remains available. */ } }
function backupMessages(messages: string[], fallback: string) {
  return [...new Set((Array.isArray(messages) ? messages : []).map(message => backupError({ message }, fallback)))].join('；') || fallback;
}
function backupWarnings(messages: string[]) {
  return [...new Set((Array.isArray(messages) ? messages : []).map(message => backupError({ message }, '请核对备份范围与恢复说明')))];
}

Page({
  localBackupFile: null as LocalBackupFile | null,
  localBackupCandidate: null as { text: string; preview: LocalBackupPreview } | null,
  localBackupSelectedText: null as string | null,
  localBackupBlockingTimer: null as { dateKey: string; targetId: string; updatedAt: number } | null,
  backupOperation: 0, backupDisposed: false,
  data: {
    version: '本地开发版', storage: '仅本机存储', preferences: {} as Preferences,
    phaseRuleDrafts: [] as any[], sync: { enabled: false, configured: false, pending: false, conflict: false },
    syncText: '云服务尚未连接', feedbackText: '', reminderPreview: null as ReminderPreview | null,
    reminderJobs: [] as any[], reminderBusy: false,
    expandedSection: '', phaseRulesVisible: false, phaseRulesDirty: false, recordManagementVisible: false,
    localBackupVisible: false, backupBusy: false, backupAction: '', backupMessage: '',
    backupExportReady: false, backupExportSummary: null as any, backupPreviewSummary: null as any,
    backupPreviewWarnings: [] as string[], backupPreviewNeedsRecheck: false,
    backupUndoAvailable: false, backupUndoReason: '', backupRecoveryRequired: false,
    backupStateFailed: false, backupTimerBlocked: false
  },
  onShow() { this.refreshSettings(); this.refreshLocalBackupState(); },
  onUnload() { this.backupDisposed = true; this.backupOperation++; },
  refreshSettings() {
    try {
      const preferences = getPreferences(); const sync = getSyncState();
      this.setData({ preferences, phaseRuleDrafts: this.data.phaseRulesDirty ? this.data.phaseRuleDrafts : preferences.phaseRules.map(rule => ({ ...rule })), sync,
        storage: sync.enabled ? '本机记录与可选云同步' : '仅本机存储',
        syncText: !sync.configured ? '云服务尚未连接' : sync.accountMismatch ? '账户已变化，请切回原账户后同步' : sync.conflict ? '两份内容均已保留，请选择使用哪份' : sync.queued ? '有待同步内容，本机记录已保留' : sync.lastSyncedAt ? '上次同步已完成' : '尚未同步' });
    } catch (_err) { this.setData({ feedbackText: '设置暂时无法读取，原始记录已保留，请稍后再试' }); }
  },
  onToggleSection(e: any) {
    const section = String(e.currentTarget.dataset.section);
    if (!['reminders', 'training', 'data', 'about'].includes(section)) return;
    this.setData({ expandedSection: this.data.expandedSection === section ? '' : section });
  },
  onTogglePhaseRules() { this.setData({ phaseRulesVisible: !this.data.phaseRulesVisible }); },
  onToggleRecordManagement() {
    if (this.blockProfileWrite()) return;
    this.setData({ recordManagementVisible: !this.data.recordManagementVisible });
  },
  onToggleLocalBackup() {
    if (this.data.backupBusy) return;
    if (this.data.backupRecoveryRequired || this.data.backupStateFailed) {
      this.setData({ localBackupVisible: true }); this.refreshLocalBackupState(); return;
    }
    this.setData({ localBackupVisible: !this.data.localBackupVisible });
    if (this.data.localBackupVisible) this.refreshLocalBackupState();
  },
  refreshLocalBackupState() {
    try {
      const state = getLocalBackupState();
      this.localBackupBlockingTimer = state.blockingTimer ? { dateKey: state.blockingTimer.dateKey,
        targetId: state.blockingTimer.targetId, updatedAt: state.blockingTimer.updatedAt } : null;
      this.setData({ backupStateFailed: false, backupUndoAvailable: state.canUndo,
        backupUndoReason: state.reason ? backupError({ message: state.reason }, '恢复前副本暂时无法核对，请保留现有数据') : '',
        backupRecoveryRequired: state.recoveryRequired, backupTimerBlocked: !!state.blockingTimer });
      if (state.recoveryRequired) this.setData({ expandedSection: 'data', localBackupVisible: true, recordManagementVisible: false });
    } catch (error) {
      this.localBackupBlockingTimer = null;
      this.setData({ backupStateFailed: true, backupUndoAvailable: false,
        backupTimerBlocked: false,
        backupUndoReason: backupError(error, '暂时无法检查恢复前副本，请保留现有文件'),
        expandedSection: 'data', localBackupVisible: true, recordManagementVisible: false });
    }
  },
  onRecheckLocalBackupState() { if (!this.data.backupBusy) this.refreshLocalBackupState(); },
  blockProfileWrite(): boolean {
    if (!this.data.backupBusy && !this.data.backupRecoveryRequired && !this.data.backupStateFailed) return false;
    if (this.data.backupRecoveryRequired || this.data.backupStateFailed) this.setData({ expandedSection: 'data', localBackupVisible: true,
      backupMessage: '请先恢复原内容或重新检查恢复状态，再继续修改设置。' });
    return true;
  },
  beginBackupAction(action: string): number {
    if (this.data.backupBusy || this.backupDisposed) return 0;
    const operation = ++this.backupOperation;
    this.setData({ backupBusy: true, backupAction: action, backupMessage: '', feedbackText: '' });
    return operation;
  },
  isBackupActionCurrent(operation: number): boolean { return !this.backupDisposed && operation === this.backupOperation; },
  finishBackupAction(operation: number) {
    if (this.isBackupActionCurrent(operation)) this.setData({ backupBusy: false, backupAction: '' });
  },
  async onExportLocalBackup() {
    if (this.data.backupRecoveryRequired || this.data.backupStateFailed) return;
    const operation = this.beginBackupAction('export'); if (!operation) return;
    try {
      const file = await exportLocalBackupFile();
      if (!this.isBackupActionCurrent(operation)) return;
      this.localBackupFile = file;
      this.setData({ backupExportReady: true, backupExportSummary: backupSummaryView(file.summary),
        backupMessage: '备份文件已生成在本机，尚未发送。请另行保存到安全位置。' });
      backupToast('备份文件已生成');
    } catch (error) {
      if (this.isBackupActionCurrent(operation)) this.setData({ backupMessage: backupError(error, '备份文件未能生成，现有记录已保留') });
    } finally { this.finishBackupAction(operation); }
  },
  async onShareLocalBackup() {
    const file = this.localBackupFile;
    if (!file || this.data.backupBusy) return;
    const operation = this.beginBackupAction('share'); if (!operation) return;
    try {
      // Keep the native send request in this independent user gesture.
      await shareLocalBackupFile(file);
      if (this.isBackupActionCurrent(operation)) this.setData({ backupMessage: '文件发送流程已完成，请自行确认接收位置是否已保存。' });
    } catch (error) {
      if (this.isBackupActionCurrent(operation)) this.setData({ backupMessage: backupError(error, '未能发送，本机备份文件仍保留') });
    } finally { this.finishBackupAction(operation); }
  },
  async onImportLocalBackup() {
    if (this.data.backupRecoveryRequired || this.data.backupStateFailed) return;
    const operation = this.beginBackupAction('import'); if (!operation) return;
    try {
      const file = await chooseLocalBackupFile();
      if (!this.isBackupActionCurrent(operation)) return;
      if (!file) { this.setData({ backupMessage: '未选择备份，现有记录和预览均保留' }); return; }
      this.localBackupSelectedText = file.text;
      const preview = file.preview;
      if (!preview.ok || !preview.summary || !preview.lease) {
        this.setData({ backupPreviewNeedsRecheck: !!this.localBackupCandidate,
          backupMessage: backupMessages(preview.errors, '这份备份暂时无法恢复，现有记录已保留') });
        this.refreshLocalBackupState(); return;
      }
      this.localBackupCandidate = { text: file.text, preview };
      this.setData({ backupPreviewSummary: backupSummaryView(preview.summary), backupPreviewWarnings: backupWarnings(preview.warnings), backupPreviewNeedsRecheck: false,
        backupMessage: '请核对备份内容，点击确认后才会恢复。' });
      this.refreshLocalBackupState();
    } catch (error) {
      if (this.isBackupActionCurrent(operation)) this.setData({ backupMessage: backupError(error, '未能读取这份备份，现有记录和预览均保留') });
    } finally { this.finishBackupAction(operation); }
  },
  onCancelLocalBackupPreview() {
    if (this.data.backupBusy) return;
    this.localBackupCandidate = null;
    this.localBackupSelectedText = null;
    this.setData({ backupPreviewSummary: null, backupPreviewWarnings: [], backupPreviewNeedsRecheck: false,
      backupMessage: '已取消本次预览，现有记录未改变' });
  },
  onRecheckLocalBackupPreview() {
    const candidate = this.localBackupCandidate;
    if (!candidate || this.data.backupRecoveryRequired || this.data.backupStateFailed) return;
    const operation = this.beginBackupAction('recheck'); if (!operation) return;
    try {
      const preview = previewLocalBackup(candidate.text);
      if (!preview.ok || !preview.summary || !preview.lease) {
        this.setData({ backupPreviewNeedsRecheck: true, backupMessage: backupMessages(preview.errors, '这份备份暂时无法恢复，现有内容未改变') }); return;
      }
      this.localBackupCandidate = { text: candidate.text, preview };
      this.setData({ backupPreviewSummary: backupSummaryView(preview.summary), backupPreviewWarnings: backupWarnings(preview.warnings),
        backupPreviewNeedsRecheck: false, backupMessage: '已重新检查，请再次核对内容后确认恢复。' });
    } catch (error) {
      this.setData({ backupPreviewNeedsRecheck: true, backupMessage: backupError(error, '暂时无法重新检查，现有内容未改变') });
    } finally { this.finishBackupAction(operation); }
  },
  onConfirmLocalBackup() {
    if (this.data.backupRecoveryRequired || this.data.backupStateFailed || this.data.backupPreviewNeedsRecheck) return;
    const candidate = this.localBackupCandidate;
    if (!candidate || !candidate.preview.lease) return;
    const operation = this.beginBackupAction('restore'); if (!operation) return;
    let modalSettled = false;
    const fail = (error: any) => {
      if (!this.isBackupActionCurrent(operation)) return;
      this.setData({ backupMessage: backupError(error, '恢复未完成，请保留现有备份并检查恢复提示') });
      this.refreshLocalBackupState(); this.finishBackupAction(operation);
    };
    try { wx.showModal({ title: '恢复这份备份？',
      content: '将替换本机计划、打卡、反馈、设置和休息记录。恢复前内容会保留为副本；照片保留，提醒恢复后关闭。' +
        (this.data.phaseRulesDirty ? '尚未保存的训练目标也会放弃。' : ''),
      confirmText: '确认恢复', success: async result => {
        if (modalSettled || !this.isBackupActionCurrent(operation)) return;
        modalSettled = true;
        if (!result.confirm) { this.finishBackupAction(operation); return; }
        try {
          await restoreLocalBackup(candidate.text, candidate.preview.lease!);
          if (!this.isBackupActionCurrent(operation)) return;
          this.localBackupCandidate = null;
          this.localBackupSelectedText = null;
          this.setData({ backupPreviewSummary: null, backupPreviewWarnings: [], backupPreviewNeedsRecheck: false,
            phaseRulesDirty: false, reminderPreview: null,
            backupMessage: '备份已恢复。提醒保持关闭，请按需要重新开启；恢复前副本已保留。' });
          this.refreshSettings(); this.refreshLocalBackupState();
          backupToast('备份已恢复');
        } catch (error) {
          if (this.isBackupActionCurrent(operation)) this.setData({ backupPreviewNeedsRecheck: true });
          fail(error);
        }
        finally { this.finishBackupAction(operation); }
      }, fail: error => { if (!modalSettled) { modalSettled = true; fail(error); } } });
    } catch (error) { fail(error); }
  },
  onUndoLocalBackup() {
    if (this.data.backupBusy) return;
    const operation = this.beginBackupAction('undo'); if (!operation) return;
    let modalSettled = false;
    const fail = (error: any) => {
      if (!this.isBackupActionCurrent(operation)) return;
      this.setData({ backupMessage: backupError(error, '暂时无法恢复原内容，请保留现有备份') });
      this.refreshLocalBackupState(); this.finishBackupAction(operation);
    };
    try {
      const state = getLocalBackupState();
      this.setData({ backupRecoveryRequired: state.recoveryRequired });
      if (!state.canUndo && !state.recoveryRequired) {
        this.setData({ backupMessage: backupError({ message: state.reason }, '暂无可以直接撤销的恢复，现有内容未改变') });
        this.finishBackupAction(operation); return;
      }
      const preview = previewUndoLocalBackup();
      if (!preview.ok || !preview.lease) {
        this.setData({ backupMessage: backupMessages(preview.errors, '暂时无法恢复原内容，副本仍保留') });
        this.finishBackupAction(operation); return;
      }
      wx.showModal({ title: state.recoveryRequired ? '继续恢复原内容？' : '撤销最近一次恢复？',
        content: '将恢复上次操作前保存的本机内容。照片和云端内容不变。' + (this.data.phaseRulesDirty ? '尚未保存的训练目标也会放弃。' : ''),
        confirmText: state.recoveryRequired ? '继续恢复' : '确认撤销', success: async result => {
          if (modalSettled || !this.isBackupActionCurrent(operation)) return;
          modalSettled = true;
          if (!result.confirm) { this.finishBackupAction(operation); return; }
          try {
            await undoLocalBackup(preview.lease!);
            if (!this.isBackupActionCurrent(operation)) return;
            this.localBackupCandidate = null;
            this.localBackupSelectedText = null;
            this.setData({ backupPreviewSummary: null, backupPreviewWarnings: [], backupPreviewNeedsRecheck: false,
              phaseRulesDirty: false, reminderPreview: null,
              backupMessage: '已恢复上次操作前的本机内容。' });
            this.refreshSettings(); this.refreshLocalBackupState();
            backupToast('原内容已恢复');
          } catch (error) { fail(error); }
          finally { this.finishBackupAction(operation); }
        }, fail: error => { if (!modalSettled) { modalSettled = true; fail(error); } } });
    } catch (error) { fail(error); }
  },
  onClearLocalBackupTimer() {
    const expected = this.localBackupBlockingTimer;
    if (!expected || this.data.backupRecoveryRequired || this.data.backupStateFailed) return;
    const operation = this.beginBackupAction('timer'); if (!operation) return;
    let settled = false;
    const fail = (error: any) => {
      if (!this.isBackupActionCurrent(operation)) return;
      this.setData({ backupMessage: backupError(error, '计时未能结束，请重新检查当前计时') });
      this.refreshLocalBackupState(); this.finishBackupAction(operation);
    };
    try { wx.showModal({ title: '结束当前计时？', content: '仅结束这次倒计时，不改变任务完成情况。备份会重新检查，仍需你另外确认恢复。',
      confirmText: '结束计时', success: result => {
        if (settled || !this.isBackupActionCurrent(operation)) return;
        settled = true;
        if (!result.confirm) { this.finishBackupAction(operation); return; }
        try {
          clearTimer(expected);
          this.refreshLocalBackupState();
          if (this.data.backupRecoveryRequired || this.data.backupStateFailed) {
            this.setData({ backupMessage: '计时已结束，请先检查恢复状态。任务完成情况未改变。' }); return;
          }
          const text = this.localBackupSelectedText;
          if (text) {
            const preview = previewLocalBackup(text);
            if (preview.ok && preview.summary && preview.lease) {
              this.localBackupCandidate = { text, preview };
              this.setData({ backupPreviewSummary: backupSummaryView(preview.summary), backupPreviewWarnings: backupWarnings(preview.warnings),
                backupPreviewNeedsRecheck: false, backupMessage: '计时已结束，任务完成情况未改变。备份已重新检查，请核对后确认恢复。' });
            } else this.setData({ backupPreviewNeedsRecheck: !!this.localBackupCandidate,
              backupMessage: '计时已结束，任务完成情况未改变。' + backupMessages(preview.errors, '请重新选择有效备份。') });
          } else this.setData({ backupMessage: '计时已结束，任务完成情况未改变。现在可以选择备份文件。' });
        } catch (error) { fail(error); }
        finally { this.finishBackupAction(operation); }
      }, fail: error => { if (!settled) { settled = true; fail(error); } } });
    } catch (error) { fail(error); }
  },
  saveSetting(patch: Partial<Preferences>) {
    if (this.blockProfileWrite()) return;
    try {
      savePreferences(patch);
      if (patch.phaseRules) this.setData({ phaseRulesDirty: false });
      this.refreshSettings(); this.setData({ feedbackText: '设置已保存' });
    }
    catch (_err) { wx.showToast({ title: '未能保存，请检查时间或输入范围', icon: 'none' }); this.refreshSettings(); }
  },
  onSleepReminderChange(e: any) { this.saveSetting({ sleepReminderEnabled: !!e.detail.value }); },
  onSleepTimeChange(e: any) { this.saveSetting({ sleepTime: String(e.detail.value) }); },
  onTaskReminderChange(e: any) { this.saveSetting({ taskReminderEnabled: !!e.detail.value }); },
  onLeadMinutesChange(e: any) { this.saveSetting({ leadMinutes: Number(e.detail.value) }); },
  onChoosePhase() {
    if (this.blockProfileWrite()) return;
    const rules = this.data.preferences.phaseRules || [];
    if (!rules.length) { wx.showToast({ title: '阶段设置暂不可读取，请稍后再试', icon: 'none' }); return; }
    wx.showActionSheet({ itemList: rules.map(rule => rule.name), success: result => {
      if (rules[result.tapIndex]) this.saveSetting({ trainingPhase: rules[result.tapIndex].name });
    } });
  },
  onPhaseRuleChange(e: any) {
    const { id, field } = e.currentTarget.dataset;
    if (field !== 'minSessions' && field !== 'description') return;
    this.setData({ phaseRuleDrafts: this.data.phaseRuleDrafts.map(rule => rule.id === id ? { ...rule, [field]: e.detail.value } : rule), phaseRulesDirty: true });
  },
  onSavePhaseRules() { this.saveSetting({ phaseRules: this.data.phaseRuleDrafts.map(rule => ({ ...rule, minSessions: Number(rule.minSessions) })) }); },
  onRequestSubscription() {
    if (this.blockProfileWrite()) return;
    wx.showActionSheet({ itemList: ['任务开始提醒', '睡眠提醒'], success: async result => {
      this.setData({ reminderBusy: true, reminderPreview: null });
      try {
        const kind = result.tapIndex === 0 ? 'task' : 'sleep';
        if (!getPreferences().subscriptionTemplateIds[kind === 'task' ? 0 : 1]) {
          this.setData({ feedbackText: '尚未配置对应订阅模板，已保存的前台提醒仍可使用' }); return;
        }
        const preview = await prepareReminder(kind);
        this.setData({ reminderPreview: preview, feedbackText: preview ? '请核对本次提醒，再点击确认订阅；不会自动登记后续日期' : '未来七天内暂无可登记的对应提醒' });
      } catch (_err) { this.setData({ feedbackText: '后台提醒暂不可用，请检查云端连接或稍后重新预览；前台提醒仍可使用' }); }
      finally { this.setData({ reminderBusy: false }); }
    } });
  },
  onConfirmReminderSubscription() {
    if (this.blockProfileWrite()) return;
    const preview = this.data.reminderPreview;
    if (this.data.reminderBusy || !preview || preview.dueAt <= Date.now() + 60000 || Date.now() - preview.preparedAt > 300000) {
      this.setData({ reminderPreview: null, feedbackText: '请重新预览具体提醒后授权' }); return;
    }
    if (typeof wx.requestSubscribeMessage !== 'function') { this.setData({ feedbackText: '当前微信暂不支持订阅授权，前台提醒仍可使用' }); return; }
    this.setData({ reminderBusy: true });
    // This native request stays in the user gesture, before any cloud await.
    try { wx.requestSubscribeMessage({ tmplIds: [preview.templateId], success: async result => {
      try {
        if (result[preview.templateId] !== 'accept') { this.setData({ feedbackText: '未授权本次订阅，不影响本地日程和前台提醒' }); return; }
        const job = await registerReminder(preview, true);
        this.setData({ reminderPreview: null, feedbackText: job.status === 'pending' ? '已登记本次提醒；微信实际发送仍受订阅额度和平台限制' : '该条提醒已登记，请查看其当前状态' });
        await this.loadReminderJobs();
      } catch (_err) { this.setData({ reminderPreview: null, feedbackText: '未能登记本次提醒，请重新预览；已授权不代表已安排后台发送' }); }
      finally { this.setData({ reminderBusy: false }); }
    }, fail: () => this.setData({ reminderBusy: false, feedbackText: '本次订阅授权未完成，不影响本地日程' }) }); }
    catch (_error) { this.setData({ reminderBusy: false, feedbackText: '本次订阅授权未完成，不影响本地日程' }); }
  },
  async loadReminderJobs() {
    const jobs = await listReminders();
    this.setData({ reminderJobs: jobs.map(job => ({ ...job, statusText: reminderStatusText[job.status] || '状态待核实', canCancel: job.status === 'pending' })) });
  },
  async onRefreshReminderJobs() {
    if (this.data.reminderBusy) return;
    this.setData({ reminderBusy: true });
    try { await this.loadReminderJobs(); }
    catch (_err) { this.setData({ feedbackText: '后台提醒列表暂不可用，请检查云端连接后重试' }); }
    finally { this.setData({ reminderBusy: false }); }
  },
  onCancelReminder(e: any) {
    if (this.blockProfileWrite()) return;
    if (this.data.reminderBusy) return;
    const id = e.currentTarget.dataset.id;
    wx.showModal({ title: '取消本次后台提醒？', content: '仅等待发送的提醒可取消；正在提交或已提交微信的消息无法撤回。', confirmText: '取消提醒', success: async choice => {
      if (!choice.confirm || this.data.reminderBusy) return;
      this.setData({ reminderBusy: true });
      try {
        const job = await cancelReminder(id);
        this.setData({ feedbackText: job.status === 'cancelled' ? '本次后台提醒已取消' : '该提醒已进入提交过程，无法撤回；请查看当前状态' });
        await this.loadReminderJobs();
      } catch (_err) { this.setData({ feedbackText: '未能确认取消，请刷新列表查看当前状态' }); }
      finally { this.setData({ reminderBusy: false }); }
    } });
  },
  onToggleSync(e: any) {
    if (this.blockProfileWrite()) return;
    const enabled = !!e.detail.value;
    let state;
    try { state = getSyncState(); } catch (_err) { this.refreshSettings(); return; }
    if (!enabled) {
      try { configureSync({ enabled: false, envId: state.envId }); }
      catch (_err) { this.setData({ feedbackText: '未能保存同步设置，请稍后重试' }); }
      this.refreshSettings(); return;
    }
    if (!state.configured) { wx.showToast({ title: '云服务尚未连接，本机功能可继续使用', icon: 'none' }); this.refreshSettings(); return; }
    wx.showModal({ title: '开启云端同步？', content: '手动同步会将计划、执行记录和反馈保存到你的小程序私有云端账户。照片需逐张选择上传；发生版本冲突会保留两份内容，不会自动覆盖。', confirmText: '选择开启', success: result => {
      try { if (result.confirm) configureSync({ enabled: true, envId: state.envId }); }
      catch (_err) { this.setData({ feedbackText: '未能开启同步，请稍后重试' }); }
      this.refreshSettings();
    } });
  },
  async onSyncNow() {
    if (this.blockProfileWrite()) return;
    this.setData({ 'sync.pending': true });
    try { const result = await syncNow(); this.setData({ feedbackText: result.message }); }
    catch (_err) { this.setData({ feedbackText: '无法同步，请检查本机数据，原始内容已保留' }); }
    finally { this.refreshSettings(); }
  },
  onResolveConflict() {
    if (this.blockProfileWrite()) return;
    wx.showActionSheet({ itemList: ['使用当前本机内容', '使用云端内容'], success: choice => {
      wx.showModal({ title: '确认选择这份内容？', content: '另一份内容会继续保留在本机备份中。使用云端内容会替换计划和执行记录，尚未上传的本机照片会保留。', confirmText: '确认选择', success: async result => {
        if (!result.confirm) return;
        try { const response = await resolveSyncConflict(choice.tapIndex === 0 ? 'local' : 'remote'); this.setData({ feedbackText: response.message }); }
        catch (_err) { this.setData({ feedbackText: '恢复未完成，请保留本机备份并停止继续同步' }); }
        this.refreshSettings();
      } });
    } });
  },
  onClearRecords() {
    if (this.blockProfileWrite()) return;
    wx.showModal({ title: '重置本机当前执行记录？', content: '此操作重置当前任务状态、执行事件和反馈，不能直接撤销。计划、日程快照、照片、云端及已保留的同步副本（如有）不变，仍可能从副本恢复记录。', confirmText: '确认重置', confirmColor: '#C25B56', success: result => {
      if (!result.confirm) return;
      try { clearRecords(); wx.showToast({ title: '当前执行记录已重置', icon: 'none' }); }
      catch (_err) { wx.showToast({ title: '清除未完成，请稍后重试', icon: 'none' }); }
      this.refreshSettings();
    } });
  }
});
