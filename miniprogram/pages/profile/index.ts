import { getPreferences, savePreferences, Preferences } from '../../services/preferences';
import { prepareReminder, registerReminder, listReminders, cancelReminder, reminderStatusText, ReminderPreview } from '../../services/reminders';
import { getSyncState, configureSync, syncNow, resolveSyncConflict } from '../../services/sync';
import { clearRecords } from '../../services/records';

Page({
  data: {
    version: '本地开发版', storage: '仅本机存储', preferences: {} as Preferences,
    phaseRuleDrafts: [] as any[], sync: { enabled: false, configured: false, pending: false, conflict: false },
    syncText: '云服务尚未连接', feedbackText: '', reminderPreview: null as ReminderPreview | null,
    reminderJobs: [] as any[], reminderBusy: false,
    expandedSection: '', phaseRulesVisible: false, phaseRulesDirty: false, recordManagementVisible: false
  },
  onShow() { this.refreshSettings(); },
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
  onToggleRecordManagement() { this.setData({ recordManagementVisible: !this.data.recordManagementVisible }); },
  saveSetting(patch: Partial<Preferences>) {
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
    this.setData({ 'sync.pending': true });
    try { const result = await syncNow(); this.setData({ feedbackText: result.message }); }
    catch (_err) { this.setData({ feedbackText: '无法同步，请检查本机数据，原始内容已保留' }); }
    finally { this.refreshSettings(); }
  },
  onResolveConflict() {
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
    wx.showModal({ title: '重置本机当前执行记录？', content: '此操作重置当前任务状态、执行事件和反馈，不能直接撤销。计划、日程快照、照片、云端及已保留的同步副本（如有）不变，仍可能从副本恢复记录。', confirmText: '确认重置', confirmColor: '#C25B56', success: result => {
      if (!result.confirm) return;
      try { clearRecords(); wx.showToast({ title: '当前执行记录已重置', icon: 'none' }); }
      catch (_err) { wx.showToast({ title: '清除未完成，请稍后重试', icon: 'none' }); }
      this.refreshSettings();
    } });
  }
});
