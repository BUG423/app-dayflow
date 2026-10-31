import { getWeekdayName } from '../../data/template';
import { localDateKey, weekDays } from '../../utils/calendar';
import { getTemplate, getDayBlocks, getTemplateVersions, saveTemplate, saveSchedule, deleteSchedule, previewImport, importTemplate, exportTemplate, scheduleDeferredTarget } from '../../services/plans';
import { getHistory } from '../../services/records';
import { Action, Schedule, TimeBlock } from '../../types/domain';

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
  draftSchedule: null as Schedule | null,
  draftExpectedVersion: 1,
  originalBlocks: [] as TimeBlock[],
  data: {
    days: [] as any[], today: '', showNotice: true, schedules: [] as any[], templateVersion: 1,
    versions: [] as any[], deferredItems: [] as any[], errorMessage: '',
    editorVisible: false, editingId: '', scheduleTitle: '', title: '', start: '18:30', end: '19:00', category: '自定义',
    effectiveFrom: '', effectiveTo: '', selectedWeekdays: [] as number[], weekdayOptions: [] as any[],
    kindIndex: 1, kindOptions: ['固定占用','并行任务','顺序执行'], actionRows: [] as any[],
    editingBlockIndex: 0, blockOptions: [] as any[], exceptionDate: '', exceptions: [] as any[],
    exceptionModeIndex: 0, exceptionModes: ['跳过当天','当天替换'],
    importVisible: false, importText: '', importPreview: null as any
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
      const schedules = template.schedules.map(schedule => ({ id: schedule.id, title: schedule.title,
        weekLabel: weekdays.filter(day => schedule.weekdays.includes(day)).map(day => labels[day]).join('、') || '按例外日期生效',
        effectiveLabel: schedule.effectiveFrom + (schedule.effectiveTo ? ' 至 ' + schedule.effectiveTo : ' 起'),
        blockLabel: schedule.blocks.map(block => block.start + '–' + block.end + ' ' + block.title).join('；') }));
      const versions = getTemplateVersions().map(item => ({ version: item.version, label: '第' + item.version + '版', updatedLabel: item.updatedAt ? localDateKey(new Date(item.updatedAt)) : '内置示例', isCurrent: item.version === template.version }));
      const deferredItems = getHistory().filter(record => record.status === 'deferred' && record.deferredTo).map(record => {
        const source = getDayBlocks(record.date).reduce((all: any[], block) => all.concat(block.actions), []).find(action => action.id === record.targetId);
        return { recordKey: record.date + ':' + record.targetId, date: record.date, targetId: record.targetId, title: source ? source.title : '延期事项', deferredTo: record.deferredTo };
      });
      this.setData({ today, days, schedules, templateVersion: template.version, versions, deferredItems, errorMessage: '' });
    } catch (error) { this.fail(error); }
  },
  updateWeekdays(selected: number[]) { this.setData({ selectedWeekdays: selected, weekdayOptions: weekdays.map(value => ({ value, label: labels[value], selected: selected.includes(value) })) }); },
  showBlock(index: number) {
    const block = this.draftSchedule.blocks[index];
    const rows = block.tasks.reduce((all: any[], task) => all.concat(task.actions.length ? task.actions.map(action => ({ ...action, _taskId: task.id })) : [{ ...task, actions: undefined, origin: undefined, _taskId: task.id }]), []);
    this.setData({ editingBlockIndex: index, blockOptions: this.draftSchedule.blocks.map((b, value) => ({ value, label: '时间块' + (value + 1) + '：' + (b.title || '未命名') })),
      title: block.title, start: block.start, end: block.end, category: block.category, kindIndex: kinds.indexOf(block.kind),
      actionRows: rows.map(row => ({ ...row, dosage: row.dosage || '', description: row.description || '', equipment: row.equipment || '', searchKeyword: row.searchKeyword || '', safety: row.safety || '' })) });
  },
  collectBlock(): TimeBlock {
    const old = this.draftSchedule.blocks[this.data.editingBlockIndex];
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
      newRows.forEach((row: any) => block.tasks.push(block.kind === 'parallel' ? { ...row, actions: [] } : { id: newId('task'), title: row.title, start: row.start, end: row.end, actions: [row] }));
    } else {
      if (block.kind === 'parallel') block.tasks = rows.map((row: any) => ({ ...row, actions: [] }));
      if (block.kind === 'sequence') block.tasks = [{ id: newId('task'), title: block.title, start: block.start, end: block.end, actions: rows as Action[] }];
    }
    return block;
  },
  storeBlock() { this.draftSchedule.blocks[this.data.editingBlockIndex] = this.collectBlock(); },
  openEditor(schedule: Schedule, existing: boolean) {
    this.draftExpectedVersion = this.data.templateVersion;
    this.draftSchedule = clone(schedule); this.originalBlocks = clone(schedule.blocks);
    this.setData({ editorVisible: true, editingId: existing ? schedule.id : '', scheduleTitle: schedule.title, effectiveFrom: schedule.effectiveFrom, effectiveTo: schedule.effectiveTo || '', exceptions: clone(schedule.exceptions), exceptionDate: '', exceptionModeIndex: 0, errorMessage: '' });
    this.updateWeekdays(schedule.weekdays); this.showBlock(0);
    if (typeof wx.pageScrollTo === 'function') wx.pageScrollTo({ selector: '#schedule-editor', duration: 200 });
  },
  onCreateSchedule() { const date = this.data.today || localDateKey(new Date()); this.openEditor({ id: newId('schedule'), title: '', weekdays: [new Date().getDay()], effectiveFrom: date, exceptions: [], blocks: [blankBlock()] }, false); },
  onEditSchedule(e: any) { try { const schedule = getTemplate().schedules.find(item => item.id === String(e.currentTarget.dataset.id)); if (!schedule) throw new Error('未找到日程规则'); this.openEditor(schedule, true); } catch (error) { this.fail(error); } },
  onCloseEditor() { this.draftSchedule = null; this.setData({ editorVisible: false }); },
  onEditorInput(e: any) { const field = String(e.currentTarget.dataset.field); if (['scheduleTitle','title','start','end','category','effectiveFrom','effectiveTo'].includes(field)) this.setData({ [field]: String(e.detail.value) }); },
  onKindChange(e: any) { const index = Number(e.detail.value); if (this.draftSchedule && kinds[index] !== this.draftSchedule.blocks[this.data.editingBlockIndex].kind && this.draftSchedule.blocks[this.data.editingBlockIndex].tasks.some(task => task.origin)) { this.fail(new Error('延期安排需保留来源关联，不能切换执行方式')); return; } if (index >= 0 && index < kinds.length) this.setData({ kindIndex: index }); },
  onToggleWeekday(e: any) { const value = Number(e.currentTarget.dataset.value); if (!weekdays.includes(value)) return; const selected = this.data.selectedWeekdays.includes(value) ? this.data.selectedWeekdays.filter(day => day !== value) : this.data.selectedWeekdays.concat(value); this.updateWeekdays(selected); },
  onAddAction() { this.setData({ actionRows: this.data.actionRows.concat({ id: newId('item'), title: '', start: this.data.start, end: this.data.end, dosage: '', description: '', equipment: '', searchKeyword: '', safety: '' }) }); },
  onRemoveAction(e: any) { const index = Number(e.currentTarget.dataset.index); this.setData({ actionRows: this.data.actionRows.filter((_row: any, i: number) => i !== index) }); },
  onActionInput(e: any) { const index = Number(e.currentTarget.dataset.index), field = String(e.currentTarget.dataset.field); if (!this.data.actionRows[index] || !['title','start','end','dosage','description','equipment','searchKeyword','safety'].includes(field)) return; const rows = clone(this.data.actionRows); rows[index][field] = String(e.detail.value); this.setData({ actionRows: rows }); },
  onEditorBlockChange(e: any) { const index = Number(e.detail.value); if (!this.draftSchedule || !this.draftSchedule.blocks[index]) return; this.storeBlock(); this.showBlock(index); },
  onAddEditorBlock() { if (!this.draftSchedule) return; this.storeBlock(); this.draftSchedule.blocks.push(blankBlock()); this.originalBlocks.push(clone(this.draftSchedule.blocks[this.draftSchedule.blocks.length - 1])); this.showBlock(this.draftSchedule.blocks.length - 1); },
  onRemoveEditorBlock() { if (!this.draftSchedule || this.draftSchedule.blocks.length <= 1) { wx.showToast({ title: '至少保留一个时间块', icon: 'none' }); return; } this.draftSchedule.blocks.splice(this.data.editingBlockIndex, 1); this.originalBlocks.splice(this.data.editingBlockIndex, 1); this.showBlock(0); },
  onExceptionDateInput(e: any) { this.setData({ exceptionDate: String(e.detail.value) }); },
  onExceptionModeChange(e: any) { this.setData({ exceptionModeIndex: Number(e.detail.value) === 1 ? 1 : 0 }); },
  onAddException() {
    if (!this.data.exceptionDate) { wx.showToast({ title: '请先选择例外日期', icon: 'none' }); return; }
    const exception: any = { date: this.data.exceptionDate, kind: this.data.exceptionModeIndex === 1 ? 'replace' : 'skip' };
    if (exception.kind === 'replace') {
      this.storeBlock(); exception.blocks = clone(this.draftSchedule.blocks);
      this.draftSchedule.blocks = clone(this.originalBlocks); this.showBlock(Math.min(this.data.editingBlockIndex, this.draftSchedule.blocks.length - 1));
      wx.showToast({ title: '当前设置仅用于例外日', icon: 'none' });
    }
    this.setData({ exceptions: this.data.exceptions.filter((item: any) => item.date !== exception.date).concat(exception), exceptionDate: '' });
  },
  onRemoveException(e: any) { const index = Number(e.currentTarget.dataset.index); this.setData({ exceptions: this.data.exceptions.filter((_item: any, i: number) => i !== index) }); },
  onSaveSchedule() {
    try {
      if (!this.draftSchedule) return;
      this.storeBlock(); const schedule = clone(this.draftSchedule);
      schedule.title = this.data.scheduleTitle.trim(); schedule.weekdays = this.data.selectedWeekdays; schedule.effectiveFrom = this.data.effectiveFrom;
      if (this.data.effectiveTo) schedule.effectiveTo = this.data.effectiveTo; else delete schedule.effectiveTo;
      schedule.exceptions = clone(this.data.exceptions);
      if (!schedule.weekdays.length && !schedule.exceptions.some(item => item.kind === 'replace')) throw new Error('请选择重复星期，或添加当天替换例外');
      saveSchedule(schedule, this.draftExpectedVersion); this.onCloseEditor(); this.refresh(); wx.showToast({ title: '计划已保存', icon: 'success' });
    } catch (error) { this.fail(error); }
  },
  onDeleteSchedule(e: any) {
    const id = String(e.currentTarget.dataset.id), version = this.data.templateVersion;
    wx.showModal({ title: '删除这条日程规则？', content: '未来安排将移除，已有执行历史和锁定快照会保留。', confirmText: '确认删除', success: result => { if (!result.confirm) return; try { deleteSchedule(id, version); this.refresh(); wx.showToast({ title: '已删除规则', icon: 'success' }); } catch (error) { this.fail(error); } } });
  },
  onToggleImport() { this.setData({ importVisible: !this.data.importVisible, importPreview: null }); },
  onImportInput(e: any) { this.setData({ importText: String(e.detail.value), importPreview: null }); },
  onPreviewImport() { this.setData({ importPreview: previewImport(this.data.importText) }); },
  onConfirmImport() {
    const preview = previewImport(this.data.importText); this.setData({ importPreview: preview }); if (!preview.ok) return;
    const text = this.data.importText, version = this.data.templateVersion;
    wx.showModal({ title: '确认导入计划？', content: '将保存为新的计划版本。已有执行记录和锁定历史不会被覆盖。', confirmText: '确认导入', success: result => { if (!result.confirm) return; try { importTemplate(text, version); this.setData({ importVisible: false, importText: '', importPreview: null }); this.refresh(); wx.showToast({ title: '导入成功', icon: 'success' }); } catch (error) { this.fail(error); } } });
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
