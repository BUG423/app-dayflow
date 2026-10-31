import { getWeekdayName } from '../../data/template';
import { previewEveningRoutineUpdate, saveEveningRoutineUpdate, EveningRoutineUpdatePreview } from '../../services/plans';
import { localDateKey, weekDays, shiftDays, parseLocalDate, minutesOf, endMinutesOf } from '../../utils/calendar';
import { getTemplate, getDayBlocks, getTemplateVersions, getDateEditState, saveTemplate, previewScheduleOverwrite, saveScheduleOverwrite, ScheduleOverwritePreview, getScheduleAvailability, getOverwriteSelectionAvailability, deleteSchedule, previewImport, importTemplate, exportTemplate, exportDefaultTemplate, scheduleDeferredTarget } from '../../services/plans';
import { getHistory } from '../../services/records';
import { Action, Schedule, TimeBlock } from '../../types/domain';
import { isSimpleBlock, repeatMode, repeatWeekdays, repeatOptionLabels, repeatDescription, simpleBlock } from '../../utils/plan-editor';
import { allowedEnds, AvailabilityResult } from '../../utils/planning-availability';
import { timeColumns, selectedClock, clockFromMinute, moveActionRows } from '../../utils/wizard-state';
import { representativeDates, blocksOnDate } from '../../utils/schedule-occurrences';

const weekdays = [1,2,3,4,5,6,0];
const labels = ['周日','周一','周二','周三','周四','周五','周六'];
const kinds = ['fixed','parallel','sequence'];
let counter = 0;
function newId(prefix: string) { return prefix + '-' + Date.now().toString(36) + '-' + (++counter); }
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
function blankBlock(): TimeBlock { return { id: newId('block'), title: '', start: '18:30', end: '19:00', kind: 'parallel', category: '自定义', tasks: [] }; }
function optionalFields(row: any) {
  const result: any = {};
  ['dosage','description','equipment','searchKeyword','safety'].forEach(key => { if (typeof row[key] === 'string' && row[key].trim()) result[key] = row[key].trim(); });
  return result;
}

Page({
  eveningUpdate: null as EveningRoutineUpdatePreview | null,
  draftSchedule: null as Schedule | null,
  draftExpectedVersion: 1,
  originalBlocks: [] as TimeBlock[],
  exceptionDraftBlocks: [] as TimeBlock[],
  exceptionDraftCache: {} as Record<string, TimeBlock[]>,
  baseEditingBlockIndex: 0,
  availability: null as AvailabilityResult | null,
  wizardConflicts: [] as any[],
  generatedIds: {} as Record<string, string>,
  overwritePreview: null as ScheduleOverwritePreview | null,
  overwriteApproval: null as { fingerprint: string; lease: string } | null,
  overwriteModalPending: false,
  lastOverwritePrompt: '',
  suggestedWindow: null as { start: string; end: string } | null,
  occupiedLimit: 12,
  data: {
    days: [] as any[], today: '', showNotice: true, schedules: [] as any[], templateVersion: 1,
    versions: [] as any[], deferredItems: [] as any[], errorMessage: '', dateSelectionHint: '', saveNotice: '',
    editorVisible: false, editingId: '', scheduleTitle: '', title: '', start: '18:30', end: '19:00', category: '自定义',
    effectiveFrom: '', effectiveTo: '', selectedWeekdays: [] as number[], weekdayOptions: [] as any[],
    kindIndex: 1, kindOptions: ['只占用时间','可单独打卡','按步骤执行'], actionRows: [] as any[],
    editingBlockIndex: 0, blockOptions: [] as any[], exceptionDate: '', exceptions: [] as any[],
    exceptionModeIndex: 0, exceptionModes: ['跳过当天','当天替换'],
    importVisible: false, importText: '', importPreview: null as any, examplePreview: false, exampleRows: [] as any[],
    eveningPreview: false, eveningVersion: 0, eveningRemoved: [] as any[], eveningChangesExpanded: false,
    advancedVisible: false, toolsVisible: false, versionsVisible: false, trainingVisible: false,
    simpleMode: true, repeatModeIndex: 0, repeatOptions: ['不重复','每天','工作日','自选星期','每周这一天','非工作日'],
    repeatChoices: [] as Array<{ value: number; label: string }>,
    repeatWorkdayHint: '工作日为周一至周五，非工作日为周六、周日。',
    editorStep: 0, furthestStep: 0, wizardSteps: ['做什么','选时间','重复','确认'], wizardError: '', wizardNextDisabled: true,
    wizardNextLabel: '下一步', saving: false, draftResumeAvailable: false, summaryExpanded: false,
    wizardSummary: '', summaryRows: [] as any[], reviewBlocks: [] as any[], reviewExceptions: [] as any[], previewErrors: [] as string[],
    startTimeRange: [[], []] as string[][], endTimeRange: [[], []] as string[][], startTimeIndices: [0,0], endTimeIndices: [0,0],
    timePickerDisabled: true, freeWindows: [] as any[], occupiedSlots: [] as any[], conflicts: [] as any[],
    timeAvailabilityError: '', availabilityHint: '', suggestedTimeLabel: '',
    occupiedMoreCount: 0, conflictCount: 0, occupiedVisible: false, allFreeWindowsVisible: false,
    exceptionEditorVisible: false, editingExceptionDate: '', exceptionScopeLabel: '', exceptionOnly: false,
    overwriteRequired: false, overwriteConfirmed: false, overwriteRows: [] as any[], overwriteError: '', overwriteExpanded: false
  },
  onShow() { this.refresh(); },
  fail(error: any) { const message = error && error.message || '操作失败，请稍后重试'; this.setData({ errorMessage: message }); wx.showToast({ title: message, icon: 'none' }); },
  refresh() {
    try {
      const today = localDateKey(new Date()), template = getTemplate();
      const days = weekDays(today).map((day: any) => {
        const training = getDayBlocks(day.date).find(block => block.category === '训练' || block.id === 'training');
        return { date: day.date, weekday: getWeekdayName(day.date), title: training ? training.title : '自主安排', minutes: training ? training.start + '–' + training.end : '', actionCount: training ? training.actions.length : 0, selected: today === day.date };
      });
      const schedules = template.schedules.filter(schedule => representativeDates([schedule], today).some(date => blocksOnDate(schedule, date).length > 0)).map(schedule => ({ id: schedule.id, title: schedule.title,
        weekLabel: schedule.effectiveTo === schedule.effectiveFrom ? '仅这一天' : weekdays.filter(day => schedule.weekdays.includes(day)).map(day => labels[day]).join('、') || '在已设日期执行',
        effectiveLabel: schedule.effectiveFrom + (schedule.effectiveTo ? ' 至 ' + schedule.effectiveTo : ' 起'),
        blockLabel: schedule.blocks.map(block => block.start + '–' + block.end + ' ' + block.title).join('；') }));
      const versions = getTemplateVersions().map(item => ({ version: item.version, label: '第' + item.version + '版', updatedLabel: item.updatedAt ? localDateKey(new Date(item.updatedAt)) : '内置示例', isCurrent: item.version === template.version }));
      const deferredItems = getHistory().filter(record => record.status === 'deferred' && record.deferredTo).map(record => {
        const source = getDayBlocks(record.date).reduce((all: any[], block) => all.concat(block.actions), []).find(action => action.id === record.targetId);
        return { recordKey: record.date + ':' + record.targetId, date: record.date, targetId: record.targetId, title: source ? source.title : '延期事项', deferredTo: record.deferredTo };
      });
      this.setData({ today, days, schedules, templateVersion: template.version, versions, deferredItems, errorMessage: '' });
      if (this.data.editorVisible && this.draftSchedule) this.refreshWizard();
    } catch (error) { this.fail(error); }
  },
  editorBlocks(): TimeBlock[] { return this.data.editingExceptionDate ? this.exceptionDraftBlocks : this.draftSchedule.blocks; },
  draftId(key: string): string { return this.generatedIds[key] || (this.generatedIds[key] = newId('task')); },
  scheduleDraft(): Schedule {
    if (!this.draftSchedule) throw new Error('请先打开要填写的安排');
    const schedule = clone(this.draftSchedule), blocks = clone(this.editorBlocks());
    blocks[this.data.editingBlockIndex] = this.collectBlock();
    if (this.data.editingExceptionDate) {
      schedule.exceptions = clone(this.data.exceptions).filter(item => item.date !== this.data.editingExceptionDate)
        .concat({ date: this.data.editingExceptionDate, kind: 'replace', blocks });
    } else { schedule.blocks = blocks; schedule.exceptions = clone(this.data.exceptions); }
    const groupTitle = this.data.scheduleTitle.trim();
    const followsSingleName = this.originalBlocks.length === 1 && isSimpleBlock(this.originalBlocks[0])
      && schedule.blocks.length === 1 && isSimpleBlock(schedule.blocks[0])
      && this.draftSchedule.title === this.originalBlocks[0].title && groupTitle === this.draftSchedule.title;
    schedule.title = followsSingleName ? schedule.blocks[0].title.trim() : groupTitle || schedule.blocks[0].title.trim();
    schedule.weekdays = this.data.selectedWeekdays.slice(); schedule.effectiveFrom = this.data.effectiveFrom;
    if (this.data.effectiveTo) schedule.effectiveTo = this.data.effectiveTo; else delete schedule.effectiveTo;
    return schedule;
  },
  refreshWizard() {
    if (!this.draftSchedule) return;
    try {
      const schedule = this.scheduleDraft(), scopeDate = this.data.editingExceptionDate;
      const block = this.editorBlocks()[this.data.editingBlockIndex];
      const options = { date: scopeDate || this.data.effectiveFrom, ...(scopeDate ? { exceptionDate: scopeDate } : {}) };
      const occupiedResult = getScheduleAvailability(schedule, block.id, options);
      this.suggestedWindow = occupiedResult.suggestedStart ? { start: occupiedResult.suggestedStart, end: occupiedResult.suggestedEnd } : null;
      const result = getOverwriteSelectionAvailability(schedule, block.id, options);
      this.availability = result;
      const preview = previewScheduleOverwrite(schedule, this.draftExpectedVersion), fingerprint = JSON.stringify(schedule);
      this.overwritePreview = preview;
      const approved = !!(preview.ok && this.overwriteApproval?.fingerprint === fingerprint && this.overwriteApproval.lease === preview.lease);
      if (!approved) this.overwriteApproval = null;
      this.wizardConflicts = preview.conflicts.filter(item => !scopeDate || item.date === scopeDate);
      const start = timeColumns(result.allowedStarts, this.data.start), ends = allowedEnds(result, this.data.start), end = timeColumns(ends, this.data.end);
      const conflicts = this.wizardConflicts.slice(0, 8).map(item => ({ ...item, key: item.date + ':' + item.scheduleId + ':' + item.blockId + ':' + item.proposedBlockId }));
      const occupied = occupiedResult.busy.slice(0, this.occupiedLimit).map(item => ({ date: item.date, scheduleTitle: item.scheduleTitle,
        title: item.title, start: item.start, end: item.end, key: item.date + ':' + item.scheduleId + ':' + item.blockId + ':' + item.start, label: item.date + ' ' + item.title + ' ' + item.start + '–' + item.end }));
      const range = scopeDate || this.data.effectiveFrom + (this.data.effectiveTo && this.data.effectiveTo !== this.data.effectiveFrom ? ' 至 ' + this.data.effectiveTo : '');
      const repeatOptions = repeatOptionLabels(this.data.effectiveFrom,
        this.data.repeatModeIndex === 4 && this.data.selectedWeekdays.length === 1 ? this.data.selectedWeekdays[0] : undefined);
      const repeat = this.data.exceptionOnly ? '不重复' : repeatDescription(this.data.repeatModeIndex, this.data.effectiveFrom, this.data.selectedWeekdays);
      const summaryRows = [{ label: '事项', value: this.data.title.trim() || '尚未填写', step: 0 },
        { label: '日期', value: range || '尚未选择', step: 1 }, { label: '时间', value: this.data.start + '–' + this.data.end, step: 1 },
        { label: '重复', value: repeat, step: 2 }, { label: '打卡', value: this.data.kindIndex === 0 ? '不需要' : '需要', step: 0 }];
      this.setData({
        repeatOptions, repeatChoices: [0,4,2,5,1].map(value => ({ value, label: repeatOptions[value] })),
        startTimeRange: start.range, startTimeIndices: start.indices, endTimeRange: end.range, endTimeIndices: end.indices,
        timePickerDisabled: !result.allowedStarts.length, freeWindows: occupiedResult.freeWindows.map((item, index) => ({ ...item, index, label: item.start + '–' + item.end })),
        occupiedSlots: occupied, occupiedMoreCount: Math.max(0, occupiedResult.busy.length - occupied.length), conflicts, conflictCount: this.wizardConflicts.length,
        timeAvailabilityError: !result.allowedStarts.length || !result.proposedValid ? result.message || '请在下方可用时段内选择起止时间' : this.wizardConflicts.length ? this.wizardConflicts[0].message : '',
        availabilityHint: '时间已有安排时，会先询问是否替换。',
        suggestedTimeLabel: !occupiedResult.proposedValid && occupiedResult.suggestedStart ? '选择空闲时段 ' + occupiedResult.suggestedStart + '–' + occupiedResult.suggestedEnd : '',
        wizardSummary: (this.data.title.trim() || '尚未填写事项') + ' · ' + this.data.start + '–' + this.data.end + ' · ' + repeat,
        summaryRows, reviewBlocks: schedule.blocks.slice().sort((a,b) => a.start.localeCompare(b.start)).map(item => ({ ...item, kindLabel: this.data.kindOptions[kinds.indexOf(item.kind)], tasksCount: item.tasks.reduce((count, task) => count + (task.actions.length || 1), 0) })),
        reviewExceptions: schedule.exceptions.map(item => ({ date: item.date, label: item.kind === 'skip' ? '这天不执行这组安排' : '仅修改这一天的安排', blockCount: item.kind === 'replace' ? item.blocks.length : schedule.blocks.length })),
        overwriteRequired: preview.ok && preview.removed.length > 0 && !approved,
        overwriteConfirmed: preview.removed.length > 0 && approved,
        overwriteRows: preview.removed.map((item, index) => ({ ...item, key: item.scheduleId + ':' + item.blockId + ':' + index,
          scope: item.date || (item.weekdays.length === 7 ? '每天' : weekdays.filter(day => item.weekdays.includes(day)).map(day => labels[day]).join('、'))
            + ' · ' + item.effectiveFrom + (item.effectiveTo ? ' 至 ' + item.effectiveTo : ' 起') })),
        overwriteError: !preview.ok ? preview.errors[0] || '请先检查安排内容。' : '',
        wizardNextLabel: scopeDate && !this.data.exceptionOnly && this.data.editorStep === 2 ? '完成这天的修改' : '下一步',
        wizardNextDisabled: this.data.editorStep === 0 ? !this.data.title.trim() : this.data.editorStep === 1 ? !result.proposedValid || this.wizardConflicts.length > 0 : this.data.editorStep === 2 ? this.wizardConflicts.length > 0 || (!this.data.selectedWeekdays.length && !this.data.exceptions.some(item => item.kind === 'replace')) : false
      });
    } catch (error) {
      this.availability = null; this.wizardConflicts = [];
      this.overwriteApproval = null; this.overwritePreview = null;
      this.setData({ overwriteConfirmed: false, overwriteRequired: false, overwriteRows: [], overwriteError: '', timePickerDisabled: true, freeWindows: [], occupiedSlots: [], conflicts: [], timeAvailabilityError: error.message || '暂时无法读取可用时段', wizardNextDisabled: this.data.editorStep !== 0 || !this.data.title.trim() });
    }
  },
  onShowMoreOccupied() { this.occupiedLimit += 12; this.refreshWizard(); },
  onToggleSummary() { this.setData({ summaryExpanded: !this.data.summaryExpanded }); },
  offerOverwrite(force = false) {
    if (!this.draftSchedule || this.overwriteModalPending) return;
    this.refreshWizard();
    const preview = this.overwritePreview, fingerprint = JSON.stringify(this.scheduleDraft());
    if (!preview?.ok || !preview.removed.length || this.data.overwriteConfirmed || !force && this.lastOverwritePrompt === fingerprint) return;
    this.lastOverwritePrompt = fingerprint; this.overwriteModalPending = true;
    const rows = this.data.overwriteRows.map(item => '“' + item.title + '” ' + item.start + '–' + item.end + '\n' + item.scope);
    wx.showModal({ title: '替换已有安排？', content: '将移除以下' + rows.length + '个完整旧时段：\n' + rows.join('\n') + '\n其他安排和已执行记录保留。确认后仍需在最后一步保存。',
      confirmText: '替换安排', cancelText: '返回调整',
      success: result => {
        this.overwriteModalPending = false;
        if (!this.draftSchedule) return;
        if (!result.confirm) { this.setData({ wizardError: '原安排尚未修改，可以继续调整时间。' }); this.refreshWizard(); return; }
        const latest = previewScheduleOverwrite(this.scheduleDraft(), this.draftExpectedVersion);
        if (JSON.stringify(this.scheduleDraft()) !== fingerprint || !latest.ok || latest.lease !== preview.lease) {
          this.overwriteApproval = null; this.setData({ wizardError: '安排内容已变化，请重新确认替换范围。' }); this.refreshWizard(); return;
        }
        this.overwriteApproval = { fingerprint, lease: preview.lease };
        this.setData({ wizardError: '' }); this.refreshWizard();
      },
      fail: () => { this.overwriteModalPending = false; this.setData({ wizardError: '确认窗口未能打开，请查看下方安排后再次确认。' }); }
    });
  },
  onConfirmOverwrite() { this.offerOverwrite(true); },
  onToggleOverwriteDetails() { this.setData({ overwriteExpanded: !this.data.overwriteExpanded }); },
  wizardStepError(step: number): string {
    if (!this.data.title.trim()) return '先写下这件事的名称。';
    if (step === 0) return '';
    try {
      const date = this.data.editingExceptionDate || this.data.effectiveFrom; parseLocalDate(date);
      if (getDateEditState(date).locked && (this.data.editingExceptionDate || this.data.repeatModeIndex === 0)) return '这一天已有执行记录或属于历史日期，请选择尚未执行的日期。';
      if (minutesOf(this.data.start) >= endMinutesOf(this.data.end)) return '结束时间要晚于开始时间。';
      if (!this.availability || !this.availability.proposedValid) return this.data.timeAvailabilityError || '请先选择可用的连续时段。';
      if (this.wizardConflicts.length) return this.wizardConflicts[0].message;
      if (step === 1) return '';
      if (!this.data.selectedWeekdays.length && !this.data.exceptions.some(item => item.kind === 'replace')) return '请选择需要重复的星期。';
      const bounds = this.data.actionRows.find(row => row.start < this.data.start || row.end > this.data.end || row.start >= row.end);
      if (this.data.kindIndex !== 0 && !(this.data.simpleMode && !this.data.advancedVisible) && bounds) return '“' + (bounds.title || '未命名步骤') + '” ' + bounds.start + '–' + bounds.end + ' 必须安排在 ' + this.data.start + '–' + this.data.end + ' 内，请在详细步骤中调整。';
      const preview = previewScheduleOverwrite(this.scheduleDraft(), this.draftExpectedVersion);
      this.setData({ previewErrors: preview.errors || [] });
      if (!preview.ok) return preview.errors[0] || preview.conflicts[0]?.message || '请检查这组安排的内容。';
      if (step === 3 && preview.removed.length && !this.data.overwriteConfirmed) return '请先确认要替换的旧安排，再保存。';
      return '';
    } catch (error) { return error.message || '请检查日期和时间。'; }
  },
  onWizardNext() {
    this.refreshWizard(); const message = this.wizardStepError(this.data.editorStep);
    if (message) { this.setData({ wizardError: message }); return; }
    if (this.data.editorStep > 0 && this.data.overwriteRequired) { this.offerOverwrite(true); return; }
    if (this.data.editingExceptionDate && !this.data.exceptionOnly && this.data.editorStep === 2) { this.finishExceptionEdit(); return; }
    if (this.data.editorStep >= 3) return;
    const next = this.data.editorStep + 1;
    this.setData({ editorStep: next, furthestStep: Math.max(this.data.furthestStep, next), wizardError: '' }); this.refreshWizard();
    if (typeof wx.pageScrollTo === 'function') wx.pageScrollTo({ selector: '#schedule-editor', duration: 150 });
  },
  onWizardBack() { if (this.data.editorStep > 0) { this.setData({ editorStep: this.data.editorStep - 1, wizardError: '' }); this.refreshWizard(); } },
  onWizardStep(e: any) {
    const step = Number(e.currentTarget.dataset.step);
    if (!Number.isInteger(step) || step < 0 || step > 3 || step > this.data.furthestStep) return;
    this.setData({ editorStep: step, wizardError: '' }); this.refreshWizard();
  },
  onTimeColumnChange(e: any, start: boolean) {
    const prefix = start ? 'start' : 'end', range = this.data[prefix + 'TimeRange'] as string[][];
    const indices = (this.data[prefix + 'TimeIndices'] as number[]).slice(), column = Number(e.detail.column), value = Number(e.detail.value);
    if (column !== 0 && column !== 1 || !Number.isInteger(value) || value < 0 || value >= range[column].length) return;
    indices[column] = value;
    if (column === 0) {
      const allowed = start ? this.availability?.allowedStarts || [] : this.availability ? allowedEnds(this.availability, this.data.start) : [];
      const projected = timeColumns(allowed, (start ? this.data.start : this.data.end), range[0][value]);
      this.setData({ [prefix + 'TimeRange']: projected.range, [prefix + 'TimeIndices']: projected.indices });
    } else this.setData({ [prefix + 'TimeIndices']: indices });
  },
  onStartTimeColumnChange(e: any) { this.onTimeColumnChange(e, true); },
  onEndTimeColumnChange(e: any) { this.onTimeColumnChange(e, false); },
  applyTimeWindow(start: string, end: string) {
    let rows = this.data.actionRows;
    if (!this.data.simpleMode && (start !== this.data.start || end !== this.data.end)) rows = moveActionRows(rows, this.data.start, this.data.end, start, end, this.data.kindIndex === 1);
    this.setData({ start, end, actionRows: rows, wizardError: '' }); this.refreshWizard(); this.offerOverwrite();
  },
  onStartTimeChange(e: any) {
    try {
      const start = selectedClock(this.data.startTimeRange, e.detail.value);
      this.refreshWizard(); if (!this.availability || !this.availability.allowedStarts.includes(start)) throw new Error('这个开始时间刚被占用，请重新查看可用时段。');
      const ends = allowedEnds(this.availability, start), wanted = minutesOf(start) + Math.max(1, endMinutesOf(this.data.end) - minutesOf(this.data.start));
      const end = ends.find(value => endMinutesOf(value) >= wanted) || ends[ends.length - 1];
      if (!end) throw new Error('这个时间后没有连续空档，请选择其他开始时间。');
      this.applyTimeWindow(start, end);
    } catch (error) { this.setData({ wizardError: error.message }); this.refreshWizard(); }
  },
  onEndTimeChange(e: any) {
    try {
      const end = selectedClock(this.data.endTimeRange, e.detail.value); this.refreshWizard();
      if (!this.availability || !allowedEnds(this.availability, this.data.start).includes(end)) throw new Error('结束时间必须留在同一段空档内。');
      this.applyTimeWindow(this.data.start, end);
    } catch (error) { this.setData({ wizardError: error.message }); this.refreshWizard(); }
  },
  onChooseFreeWindow(e: any) {
    const index = Number(e.currentTarget.dataset.index); this.refreshWizard();
    const window = this.data.freeWindows[index]; if (!window) return;
    try { const duration = Math.max(1, endMinutesOf(this.data.end) - minutesOf(this.data.start)); this.applyTimeWindow(window.start, clockFromMinute(Math.min(endMinutesOf(window.end), minutesOf(window.start) + duration))); }
    catch (error) { this.setData({ wizardError: error.message }); }
  },
  onChooseSuggestedTime() { this.refreshWizard(); if (this.suggestedWindow) { try { this.applyTimeWindow(this.suggestedWindow.start, this.suggestedWindow.end); } catch (error) { this.setData({ wizardError: error.message }); } } },
  updateWeekdays(selected: number[]) { this.setData({ selectedWeekdays: selected, weekdayOptions: weekdays.map(value => ({ value, label: labels[value], selected: selected.includes(value) })) }); },
  showBlock(index: number) {
    const scope = this.editorBlocks(), block = scope[index];
    const rows = block.tasks.reduce((all: any[], task) => all.concat(task.actions.length ? task.actions.map(action => ({ ...action, _taskId: task.id })) : [{ ...task, actions: undefined, origin: undefined, _taskId: task.id }]), []);
    this.setData({ editingBlockIndex: index, simpleMode: scope.length === 1 && isSimpleBlock(block), blockOptions: scope.map((b, value) => ({ value, label: '时段' + (value + 1) + '：' + (b.title || '尚未命名') })),
      title: block.title, start: block.start, end: block.end, category: block.category, kindIndex: kinds.indexOf(block.kind),
      actionRows: rows.map(row => ({ ...row, dosage: row.dosage || '', description: row.description || '', equipment: row.equipment || '', searchKeyword: row.searchKeyword || '', safety: row.safety || '' })) });
  },
  collectBlock(): TimeBlock {
    const old = this.editorBlocks()[this.data.editingBlockIndex];
    if (this.data.simpleMode && !this.data.advancedVisible) return simpleBlock(old, { title: this.data.title, start: this.data.start, end: this.data.end, category: this.data.category, checkable: this.data.kindIndex !== 0 }, old.tasks[0]?.id || this.draftId('task/' + old.id));
    if (kinds[this.data.kindIndex] !== old.kind && old.tasks.some(task => task.origin)) throw new Error('延期安排需保留来源关联，不能切换执行方式；可以另建日程');
    const block: TimeBlock = { id: old.id, title: this.data.title.trim(), start: this.data.start, end: this.data.end, kind: kinds[this.data.kindIndex] as any, category: this.data.category.trim() || '自定义', tasks: [] };
    const rows = this.data.actionRows.map((row: any) => ({ id: row.id, title: row.title.trim(), start: row.start, end: row.end, ...optionalFields(row) }));
    if (block.kind !== 'fixed' && block.kind === old.kind && old.tasks.length) {
      const newRows = rows.filter((_row: any, index: number) => !this.data.actionRows[index]._taskId);
      block.tasks = old.tasks.reduce((tasks: any[], task) => {
        const members = rows.filter((_row: any, index: number) => this.data.actionRows[index]._taskId === task.id);
        if (task.actions.length) {
          if (old.tasks.length === 1 && block.kind === 'sequence') members.push(...newRows.splice(0));
          if (members.length) tasks.push({ ...task, title: task.title === old.title ? block.title : task.title,
            start: old.tasks.length === 1 ? block.start : members.map((row: any) => row.start).sort()[0],
            end: old.tasks.length === 1 ? block.end : members.map((row: any) => row.end).sort().slice(-1)[0], actions: members });
        } else if (members[0]) tasks.push({ ...members[0], actions: [], ...(task.origin ? { origin: clone(task.origin) } : {}) });
        return tasks;
      }, []);
      newRows.forEach((row: any) => block.tasks.push(block.kind === 'parallel' ? { ...row, actions: [] } : { id: this.draftId('task/' + old.id + '/' + row.id), title: row.title, start: row.start, end: row.end, actions: [row] }));
    } else {
      if (block.kind === 'parallel') block.tasks = rows.map((row: any) => ({ ...row, actions: [] }));
      if (block.kind === 'sequence') block.tasks = [{ id: this.draftId('task/' + old.id + '/sequence'), title: block.title, start: block.start, end: block.end, actions: rows as Action[] }];
    }
    return block;
  },
  storeBlock() { this.editorBlocks()[this.data.editingBlockIndex] = this.collectBlock(); },
  openEditor(schedule: Schedule, existing: boolean) {
    this.draftExpectedVersion = this.data.templateVersion;
    this.generatedIds = {}; this.overwriteApproval = null; this.overwritePreview = null; this.overwriteModalPending = false; this.lastOverwritePrompt = '';
    this.draftSchedule = clone(schedule); this.originalBlocks = clone(schedule.blocks);
    this.exceptionDraftBlocks = []; this.exceptionDraftCache = {}; this.baseEditingBlockIndex = 0; this.occupiedLimit = 12;
    const only = !schedule.weekdays.length && schedule.exceptions.filter(item => item.kind === 'replace').length === 1 ? schedule.exceptions.find(item => item.kind === 'replace') : null;
    if (only) this.exceptionDraftBlocks = clone(only.blocks);
    const simple = schedule.blocks.length === 1 && isSimpleBlock(schedule.blocks[0]);
    this.setData({ editorVisible: true, editingId: existing ? schedule.id : '', scheduleTitle: schedule.title, effectiveFrom: schedule.effectiveFrom, effectiveTo: schedule.effectiveTo || '', exceptions: clone(schedule.exceptions), exceptionDate: '', exceptionModeIndex: 0, errorMessage: '', dateSelectionHint: '', saveNotice: '', simpleMode: simple, advancedVisible: false, occupiedVisible: false, allFreeWindowsVisible: false, repeatModeIndex: repeatMode(schedule),
      editorStep: 0, furthestStep: existing ? 2 : 0, wizardError: '', previewErrors: [], draftResumeAvailable: false, summaryExpanded: false, exceptionEditorVisible: false, overwriteExpanded: false,
      exceptionOnly: !!only, editingExceptionDate: only ? only.date : '', exceptionScopeLabel: only ? '仅修改 ' + only.date + ' 的 ' + only.blocks.length + ' 个时段，原有来源关联保留。' : '' });
    this.updateWeekdays(schedule.weekdays); this.showBlock(0); this.refreshWizard();
    if (typeof wx.pageScrollTo === 'function') wx.pageScrollTo({ selector: '#schedule-editor', duration: 200 });
  },
  onCreateSchedule() {
    try {
      if (this.draftSchedule) { this.onResumeDraft(); this.setData({ wizardError: '当前草稿已保留，请先完成或放弃后再添加安排。' }); return; }
      const today = localDateKey(new Date()); let date = today, hint = '';
      if (getDateEditState(today).locked) {
        let available = '';
        for (let offset = 1; offset <= 7; offset++) { const candidate = shiftDays(today, offset); if (!getDateEditState(candidate).locked) { available = candidate; break; } }
        if (available) { date = available; hint = '今天已有执行记录，保留原计划；已为你选择' + (date === shiftDays(today, 1) ? '明天（' + date + '）' : date) + '，也可以改选其他未执行日期。'; }
        else hint = '今天及未来七天已有执行记录，请自行选择其他尚未执行的日期。';
      }
      this.openEditor({ id: newId('schedule'), title: '', weekdays: repeatWeekdays(0, date, []), effectiveFrom: date, effectiveTo: date, exceptions: [], blocks: [blankBlock()] }, false);
      this.setData({ dateSelectionHint: hint });
    } catch (error) { this.fail(error); }
  },
  onEditSchedule(e: any) { try { if (this.draftSchedule) { this.onResumeDraft(); this.setData({ wizardError: '请先完成或放弃上次的草稿，再修改其他安排。' }); return; } const schedule = getTemplate().schedules.find(item => item.id === String(e.currentTarget.dataset.id)); if (!schedule) throw new Error('未找到日程规则'); this.openEditor(schedule, true); } catch (error) { this.fail(error); } },
  onCloseEditor() { if (this.draftSchedule) { try { this.storeBlock(); } catch (_error) {} } this.setData({ editorVisible: false, draftResumeAvailable: !!this.draftSchedule }); },
  onResumeDraft() { if (this.draftSchedule) { this.setData({ editorVisible: true, draftResumeAvailable: false }); this.refreshWizard(); if (typeof wx.pageScrollTo === 'function') wx.pageScrollTo({ selector: '#schedule-editor', duration: 150 }); } },
  onDiscardDraft() { wx.showModal({ title: '放弃这份未保存的草稿？', content: '已保存的计划和执行记录不会改变。', confirmText: '放弃草稿', success: result => { if (result.confirm) { this.draftSchedule = null; this.exceptionDraftBlocks = []; this.exceptionDraftCache = {}; this.setData({ editorVisible: false, draftResumeAvailable: false, editingExceptionDate: '', exceptionOnly: false }); } } }); },
  onEditorInput(e: any) { const field = String(e.currentTarget.dataset.field); if (['scheduleTitle','title','start','end','category','effectiveFrom','effectiveTo'].includes(field)) {
    const value = String(e.detail.value);
    if ((field === 'start' || field === 'end') && this.draftSchedule) { try { this.applyTimeWindow(field === 'start' ? value : this.data.start, field === 'end' ? value : this.data.end); } catch (error) { this.setData({ wizardError: error.message }); } return; }
    this.setData({ [field]: value, wizardError: '', ...(field === 'effectiveFrom' ? { dateSelectionHint: '' } : {}) });
    if (field === 'effectiveFrom' && (this.data.repeatModeIndex === 0 || this.data.repeatModeIndex === 4)) {
      try { this.updateWeekdays(repeatWeekdays(this.data.repeatModeIndex, value, [])); if (this.data.repeatModeIndex === 0) this.setData({ effectiveTo: value }); } catch (_err) {}
    }
    this.refreshWizard();
    if (field === 'effectiveFrom' || field === 'effectiveTo') this.offerOverwrite();
  } },
  onRepeatModeChange(e: any) {
    const index = Number(e.detail.value); if (!Number.isInteger(index) || index < 0 || index > 5) return;
    try { this.updateWeekdays(repeatWeekdays(index, this.data.effectiveFrom, this.data.selectedWeekdays)); this.setData({ repeatModeIndex: index, effectiveTo: index === 0 ? this.data.effectiveFrom : '', wizardError: '' }); this.refreshWizard(); if (index !== 3) this.offerOverwrite(); } catch (error) { this.fail(error); }
  },
  onChooseRepeat(e: any) { this.onRepeatModeChange({ detail: { value: e.currentTarget.dataset.index } }); },
  onClearRepeatEnd() { if (this.data.repeatModeIndex !== 0) { this.setData({ effectiveTo: '' }); this.refreshWizard(); this.offerOverwrite(); } },
  onToggleOccupied() { this.setData({ occupiedVisible: !this.data.occupiedVisible }); },
  onToggleFreeWindows() { this.setData({ allFreeWindowsVisible: !this.data.allFreeWindowsVisible }); },
  onCheckableChange(e: any) { if (this.data.simpleMode) { this.setData({ kindIndex: e.detail.value ? 1 : 0, wizardError: '' }); this.refreshWizard(); } },
  onToggleAdvanced() {
    if (!this.draftSchedule) return;
    try {
      this.storeBlock(); const scope = this.editorBlocks(), simple = scope.length === 1 && isSimpleBlock(scope[0]);
      this.setData({ advancedVisible: !this.data.advancedVisible, simpleMode: simple }); this.showBlock(this.data.editingBlockIndex); this.refreshWizard();
    } catch (error) { this.fail(error); }
  },
  onToggleTools() { this.setData({ toolsVisible: !this.data.toolsVisible }); },
  onToggleVersions() { this.setData({ versionsVisible: !this.data.versionsVisible }); },
  onToggleTraining() { this.setData({ trainingVisible: !this.data.trainingVisible }); },
  onKindChange(e: any) { const index = Number(e.detail.value), block = this.draftSchedule && this.editorBlocks()[this.data.editingBlockIndex]; if (block && kinds[index] !== block.kind && block.tasks.some(task => task.origin)) { this.fail(new Error('延期安排需保留来源关联，不能切换执行方式')); return; } if (index >= 0 && index < kinds.length) { this.setData({ kindIndex: index }); this.refreshWizard(); } },
  onToggleWeekday(e: any) { const value = Number(e.currentTarget.dataset.value); if (!weekdays.includes(value)) return; const selected = this.data.selectedWeekdays.includes(value) ? this.data.selectedWeekdays.filter(day => day !== value) : this.data.selectedWeekdays.concat(value); this.updateWeekdays(selected); this.refreshWizard(); },
  onAddAction() { this.setData({ actionRows: this.data.actionRows.concat({ id: newId('item'), title: '', start: this.data.start, end: this.data.end, dosage: '', description: '', equipment: '', searchKeyword: '', safety: '' }) }); this.refreshWizard(); },
  onRemoveAction(e: any) { const index = Number(e.currentTarget.dataset.index); this.setData({ actionRows: this.data.actionRows.filter((_row: any, i: number) => i !== index) }); this.refreshWizard(); },
  onActionInput(e: any) { const index = Number(e.currentTarget.dataset.index), field = String(e.currentTarget.dataset.field); if (!this.data.actionRows[index] || !['title','start','end','dosage','description','equipment','searchKeyword','safety'].includes(field)) return; const rows = clone(this.data.actionRows); rows[index][field] = String(e.detail.value); this.setData({ actionRows: rows }); this.refreshWizard(); },
  onEditorBlockChange(e: any) { const index = Number(e.detail.value); if (!this.draftSchedule || !this.editorBlocks()[index]) return; this.storeBlock(); this.showBlock(index); this.refreshWizard(); },
  onAddEditorBlock() { if (!this.draftSchedule) return; this.storeBlock(); this.editorBlocks().push(blankBlock()); this.showBlock(this.editorBlocks().length - 1); this.refreshWizard(); },
  onRemoveEditorBlock() { if (!this.draftSchedule || this.editorBlocks().length <= 1) { wx.showToast({ title: '至少保留一个时段', icon: 'none' }); return; } this.editorBlocks().splice(this.data.editingBlockIndex, 1); this.showBlock(0); this.refreshWizard(); },
  onExceptionDateInput(e: any) { this.setData({ exceptionDate: String(e.detail.value) }); },
  onExceptionModeChange(e: any) { this.setData({ exceptionModeIndex: Number(e.detail.value) === 1 ? 1 : 0 }); },
  onToggleExceptionEditor() { this.setData({ exceptionEditorVisible: !this.data.exceptionEditorVisible }); },
  beginExceptionEdit(date: string) {
    parseLocalDate(date);
    if (getDateEditState(date).locked) throw new Error('这一天已有执行记录或属于历史日期，请选择尚未执行的日期。');
    if (date < this.data.effectiveFrom || this.data.effectiveTo && date > this.data.effectiveTo) throw new Error('这一天不在计划有效期内，请先调整生效日期。');
    this.storeBlock(); this.baseEditingBlockIndex = this.data.editingBlockIndex;
    const existing = this.data.exceptions.find(item => item.date === date && item.kind === 'replace');
    this.exceptionDraftBlocks = clone(this.exceptionDraftCache[date] || (existing ? existing.blocks : this.draftSchedule.blocks));
    this.setData({ editingExceptionDate: date, exceptionScopeLabel: '仅修改 ' + date + ' 的整组 ' + this.exceptionDraftBlocks.length + ' 段时间；其他日期保留原安排。', editorStep: 1, wizardError: '' });
    this.showBlock(0); this.refreshWizard();
  },
  onEditException(e: any) { try { this.beginExceptionEdit(String(e.currentTarget.dataset.date)); } catch (error) { this.setData({ wizardError: error.message }); } },
  finishExceptionEdit() {
    this.storeBlock(); const date = this.data.editingExceptionDate;
    const exceptions = this.data.exceptions.filter(item => item.date !== date).concat({ date, kind: 'replace', blocks: clone(this.exceptionDraftBlocks) });
    delete this.exceptionDraftCache[date];
    this.setData({ exceptions, editingExceptionDate: '', exceptionScopeLabel: '', exceptionDate: '', editorStep: 2, wizardError: '' });
    this.showBlock(Math.min(this.baseEditingBlockIndex, this.draftSchedule.blocks.length - 1)); this.refreshWizard();
  },
  onCancelExceptionEdit() {
    if (!this.data.editingExceptionDate || this.data.exceptionOnly) return;
    try { this.storeBlock(); this.exceptionDraftCache[this.data.editingExceptionDate] = clone(this.exceptionDraftBlocks); }
    catch (error) { this.setData({ wizardError: error.message }); return; }
    this.setData({ editingExceptionDate: '', exceptionScopeLabel: '', editorStep: 2, wizardError: '' });
    this.showBlock(Math.min(this.baseEditingBlockIndex, this.draftSchedule.blocks.length - 1)); this.refreshWizard();
  },
  onAddException() {
    try {
      if (this.data.repeatModeIndex === 0 || this.data.exceptionOnly) return;
      const date = this.data.exceptionDate; parseLocalDate(date);
      if (getDateEditState(date).locked) throw new Error('这一天已有执行记录或属于历史日期，请选择尚未执行的日期。');
      if (date < this.data.effectiveFrom || this.data.effectiveTo && date > this.data.effectiveTo) throw new Error('这一天不在计划有效期内，请先调整生效日期。');
      if (this.data.exceptionModeIndex === 1) { this.beginExceptionEdit(date); return; }
      this.setData({ exceptions: this.data.exceptions.filter(item => item.date !== date).concat({ date, kind: 'skip' }), exceptionDate: '', wizardError: '' }); this.refreshWizard();
    } catch (error) { this.setData({ wizardError: error.message }); }
  },
  onRemoveException(e: any) { const index = Number(e.currentTarget.dataset.index); this.setData({ exceptions: this.data.exceptions.filter((_item: any, i: number) => i !== index) }); this.refreshWizard(); },
  onSaveSchedule() {
    try {
      if (!this.draftSchedule || this.data.saving) return;
      if (this.data.editorStep !== 3 || this.data.editingExceptionDate && !this.data.exceptionOnly) { this.setData({ wizardError: '请按步骤填写，并在确认页保存。' }); return; }
      this.setData({ saving: true }); this.refreshWizard();
      const message = this.wizardStepError(3); if (message) throw new Error(message);
      const draft = this.scheduleDraft(), preview = previewScheduleOverwrite(draft, this.draftExpectedVersion);
      if (!preview.ok || !preview.schedule) throw new Error(preview.errors[0] || preview.conflicts[0]?.message || '请检查计划内容。');
      if (preview.removed.length && (!this.overwriteApproval || this.overwriteApproval.fingerprint !== JSON.stringify(draft) || this.overwriteApproval.lease !== preview.lease)) throw new Error('请先确认要替换的旧安排，再保存。');
      const schedule = preview.schedule;
      if (schedule.effectiveTo === schedule.effectiveFrom && getDateEditState(schedule.effectiveFrom).locked) throw new Error('这一天已有执行记录或属于历史日期，原计划会保留。请选择尚未执行的日期后再保存。');
      const today = localDateKey(new Date()), exception = schedule.exceptions.find(item => item.date === today);
      const appliesToday = schedule.effectiveFrom <= today && (!schedule.effectiveTo || schedule.effectiveTo >= today)
        && (exception ? exception.kind === 'replace' : schedule.weekdays.includes(parseLocalDate(today).getDay()));
      const keepsToday = appliesToday && getDateEditState(today).locked;
      saveScheduleOverwrite(draft, this.draftExpectedVersion, preview.lease); this.draftSchedule = null; this.exceptionDraftBlocks = []; this.exceptionDraftCache = {}; this.overwriteApproval = null;
      this.setData({ editorVisible: false, draftResumeAvailable: false, editingExceptionDate: '', exceptionOnly: false, wizardError: '', saveNotice: keepsToday ? '未来安排已保存；今天已有执行记录，继续保留原计划。' : '' }); this.refresh();
      wx.showToast({ title: keepsToday ? '未来安排已保存' : '计划已保存', icon: keepsToday ? 'none' : 'success' });
    } catch (error) { this.setData({ wizardError: error.message, errorMessage: error.message }); }
    finally { this.setData({ saving: false }); }
  },
  onDeleteSchedule(e: any) {
    const id = String(e.currentTarget.dataset.id), version = this.data.templateVersion;
    wx.showModal({ title: '删除这条日程规则？', content: '未来安排将移除，已有执行历史和锁定快照会保留。', confirmText: '确认删除', success: result => { if (!result.confirm) return; try { deleteSchedule(id, version); this.refresh(); wx.showToast({ title: '已删除规则', icon: 'success' }); } catch (error) { this.fail(error); } } });
  },
  onToggleImport() { this.eveningUpdate = null; this.setData({ importVisible: this.data.examplePreview || !this.data.importVisible, importPreview: null, examplePreview: false, eveningPreview: false }); },
  onPreviewEveningUpdate() {
    if (this.draftSchedule) { this.onResumeDraft(); this.setData({ wizardError: '请先完成或放弃当前填写，再更新晚间作息。' }); return; }
    try {
      const version = getTemplate().version, preview = previewEveningRoutineUpdate(version);
      this.eveningUpdate = preview;
      const rows = preview.routines.map(schedule => ({ id: schedule.id, title: schedule.title,
        blocks: schedule.blocks.map(block => ({ id: block.id, title: block.title, time: block.start + '–' + block.end, label: block.kind === 'fixed' ? '占用时间' : '可打卡' })) }));
      this.setData({ toolsVisible: true, importVisible: true, examplePreview: true, eveningPreview: true, eveningVersion: version,
        eveningChangesExpanded: false, eveningRemoved: preview.removed.map((item,index) => ({ ...item, key: index,
          scope: item.date || weekdays.filter(day => item.weekdays.includes(day)).map(day => labels[day]).join('、') })),
        importText: '', importPreview: { ok: preview.ok, errors: preview.errors, warnings: [],
          summary: { schedules: 7, blocks: rows.reduce((sum,row) => sum + row.blocks.length,0), tasks: 0, actions: 0 } }, exampleRows: rows, errorMessage: '' });
      if (typeof wx.pageScrollTo === 'function') wx.pageScrollTo({ selector: '.import-panel', duration: 150 });
    } catch (error) { this.fail(error); }
  },
  onToggleEveningChanges() { this.setData({ eveningChangesExpanded: !this.data.eveningChangesExpanded }); },
  onConfirmEveningUpdate() {
    const preview = this.eveningUpdate, version = this.data.eveningVersion;
    if (!preview?.ok || !preview.lease) return;
    wx.showModal({ title: '更新晚间作息？', confirmText: '确认更新', cancelText: '暂不更新',
      content: '从' + preview.summary.from + '起更新睡眠、加班、运动与睡前准备。周二四六不加班，其余日先加班再训练。将移除预览中的' + preview.removed.length + '处完整旧时段；白天、不冲突的自定义事项和已执行记录保留。',
      success: result => {
        if (!result.confirm) return;
        if (this.eveningUpdate?.lease !== preview.lease || !this.data.eveningPreview) { this.fail(new Error('预览内容已变化，请重新查看晚间作息后确认。')); return; }
        try {
          saveEveningRoutineUpdate(version, preview.lease); this.eveningUpdate = null;
          this.setData({ importVisible: false, examplePreview: false, eveningPreview: false, importPreview: null, importText: '',
            saveNotice: preview.summary.keepsToday ? '未来作息已更新；今天已有执行记录，继续保留原安排。' : '晚间作息已更新，白天的安排保留。' });
          this.refresh(); wx.showToast({ title: '晚间作息已更新', icon: 'success' });
        } catch (error) { this.fail(error); }
      } });
  },
  onPreviewExample() {
    try {
      const text = exportDefaultTemplate(), preview = previewImport(text);
      if (!preview.ok) throw new Error('示例计划暂时无法预览');
      const rows = preview.template.schedules.map(schedule => ({ id: schedule.id, title: schedule.title,
        blocks: schedule.blocks.map(block => ({ id: block.id, title: block.title, time: block.start + '–' + block.end, label: block.kind === 'fixed' ? '占用时间' : '可打卡' })) }));
      this.eveningUpdate = null;
      this.setData({ toolsVisible: true, importVisible: true, examplePreview: true, eveningPreview: false, importText: text, importPreview: preview, exampleRows: rows });
    } catch (error) { this.fail(error); }
  },
  onImportInput(e: any) { this.eveningUpdate = null; this.setData({ importText: String(e.detail.value), importPreview: null, examplePreview: false, eveningPreview: false }); },
  onPreviewImport() { this.setData({ importPreview: previewImport(this.data.importText) }); },
  onConfirmImport() {
    if (this.data.eveningPreview) { this.onConfirmEveningUpdate(); return; }
    const preview = previewImport(this.data.importText); this.setData({ importPreview: preview }); if (!preview.ok) return;
    const text = this.data.importText, version = this.data.templateVersion;
    wx.showModal({ title: this.data.examplePreview ? '使用这份示例计划？' : '确认导入计划？', content: '将替换尚未执行的未来安排，并保存为新版本。已有执行记录和锁定历史不会被覆盖。', confirmText: '确认使用', success: result => { if (!result.confirm) return; try { importTemplate(text, version); this.setData({ importVisible: false, importText: '', importPreview: null, examplePreview: false }); this.refresh(); wx.showToast({ title: '导入成功', icon: 'success' }); } catch (error) { this.fail(error); } } });
  },
  onExportTemplate() { try { wx.setClipboardData({ data: exportTemplate() }); } catch (error) { this.fail(error); } },
  onRestoreVersion(e: any) {
    const version = Number(e.currentTarget.dataset.version), expectedVersion = this.data.templateVersion;
    wx.showModal({ title: '恢复为新版本？', content: '旧版本的规则会另存为一个新版本，已有执行历史和锁定快照会保留。', confirmText: '确认恢复', success: result => {
      if (!result.confirm) return;
      try { const template = getTemplateVersions().find(item => item.version === version); if (!template) throw new Error('未找到所选版本'); saveTemplate(template, expectedVersion); this.refresh(); wx.showToast({ title: '已恢复为新版本', icon: 'success' }); } catch (error) { this.fail(error); }
    } });
  },
  onScheduleDeferred(e: any) { try { const result = scheduleDeferredTarget(String(e.currentTarget.dataset.date), String(e.currentTarget.dataset.id), String(e.currentTarget.dataset.targetDate)); this.refresh(); wx.showModal({ title: '延期事项已安排', content: result.date + ' ' + result.start + '–' + result.end + '。原日延期记录保留。', showCancel: false }); } catch (error) { this.fail(error); } },
  onViewToday() { wx.switchTab({ url: '/pages/today/index' }); }
});
