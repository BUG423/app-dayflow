import { getBlocksForDate, PlanBlock, PlanAction } from '../data/template';
import { getLegacyBlocksForDate } from '../data/legacy-template';
import { Action, DailyInstance, ImportPreview, PlanTemplate, Schedule, Task, TimeBlock } from '../types/domain';
import { localDateKey, parseLocalDate, minutesOf, endMinutesOf, shiftDays } from '../utils/calendar';
import { resolveBlocks, validatePlan } from '../utils/plan-validation';
import { validateEnvelope, validateLegacyRecords } from '../utils/record-validation';
import { sortScheduleTimes, prepareScheduleIdentities } from '../utils/plan-identities';
import { blocksOnDate } from '../utils/schedule-occurrences';
import { AvailabilityOptions, AvailabilityResult, PlanningConflict, findScheduleConflicts, findPlanConflicts, getBlockAvailability } from '../utils/planning-availability';
import { getTimer } from './timer';
import { prepareScheduleOverwrite, OverwriteRemoval } from '../utils/plan-overwrite';
import { removeFutureOvertime } from '../utils/evening-routine';

const PLAN_KEY = 'dayflow.plans.v1';
const INSTANCE_KEY = 'dayflow.instances.v1';
const VERSIONS_KEY = 'dayflow.planVersions.v1';
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const object = (value: any) => value && typeof value === 'object' && !Array.isArray(value);
const today = () => localDateKey(new Date());

function read(key: string): any {
  const value = wx.getStorageSync(key);
  return value === '' || value === undefined || value === null ? undefined : value;
}
function assertDate(date: string) { try { parseLocalDate(date); } catch (_err) { throw new Error('日期无效，请重新选择'); } }
function validated(value: any): PlanTemplate {
  const result = validatePlan(value);
  if (!result.ok) throw new Error(result.errors.join('；'));
  return result.template;
}
function defaultTemplate(version: 1 | 2 | 3 = 3): PlanTemplate {
  const schedules: Schedule[] = [];
  for (let weekday = 0; weekday < 7; weekday++) {
    const key = shiftDays('2026-11-01', weekday);
    const blocks = (version === 3 ? getBlocksForDate(key) : getLegacyBlocksForDate(key, version)).map(block => {
      const tasks: Task[] = block.kind === 'fixed' ? [] : block.kind === 'parallel'
        ? block.actions.map(action => ({ ...action, actions: [] }))
        : [{ id: 'training-task', title: block.title, start: block.start, end: block.end, actions: block.actions.map(action => ({ ...action })) }];
      return { id: block.id, title: block.title, start: block.start, end: block.end, kind: block.kind, category: block.category, tasks };
    });
    schedules.push({ id: 'weekday-' + weekday, title: ['周日','周一','周二','周三','周四','周五','周六'][weekday] + '示例安排', weekdays: [weekday], effectiveFrom: '2000-01-01', exceptions: [], blocks });
  }
  return { schemaVersion: 1, id: 'dayflow-plan', name: '每日示例计划', version, updatedAt: 0, schedules };
}
/** Earlier records without a saved plan were created against the original built-in example. */
function historicalTemplate(current: PlanTemplate): PlanTemplate {
  return read(PLAN_KEY) === undefined ? defaultTemplate(1) : current;
}
export function getTemplate(): PlanTemplate {
  const value = read(PLAN_KEY);
  return value === undefined ? defaultTemplate() : validated(value);
}
function instances(): Record<string, DailyInstance> {
  const value = read(INSTANCE_KEY);
  if (value === undefined) return {};
  validateInstances(value);
  return clone(value);
}
export function validateInstances(value: any): void {
  if (!object(value)) throw new Error('日程快照数据损坏，请先导出并检查');
  for (const date of Object.keys(value)) {
    assertDate(date);
    const item = value[date];
    if (!object(item) || Object.keys(item).some(key => !['date','templateId','templateVersion','blocks','locked','mode','createdAt'].includes(key)) || item.date !== date || !Array.isArray(item.blocks) || typeof item.locked !== 'boolean' || !['standard','emergency'].includes(item.mode) || !Number.isInteger(item.templateVersion) || item.templateVersion < 1 || !Number.isFinite(item.createdAt) || item.createdAt < 0) throw new Error('日程快照数据损坏，请先导出并检查');
    const preview = validatePlan({ schemaVersion: 1, id: item.templateId, name: '日程快照', version: item.templateVersion, updatedAt: item.createdAt, schedules: [{ id: 'snapshot', title: '日程快照', weekdays: [parseLocalDate(date).getDay()], effectiveFrom: date, effectiveTo: date, exceptions: [], blocks: item.blocks }] });
    if (!preview.ok) throw new Error('日程快照数据损坏，请先导出并检查');
    if (item.mode === 'emergency') {
      const training = item.blocks.filter((block: TimeBlock) => block.category === '训练' || block.id === 'training');
      if (training.length !== 1 || training[0].kind !== 'sequence' || endMinutesOf(training[0].end) - minutesOf(training[0].start) !== 15) throw new Error('简化方案快照无效，须保留十五分钟训练');
    }
  }
}
function build(date: string, template: PlanTemplate): DailyInstance {
  return { date, templateId: template.id, templateVersion: template.version, blocks: resolveBlocks(template, date), locked: date < today(), mode: 'standard', createdAt: Date.now() };
}
function rebaseEmergency(item: DailyInstance, template: PlanTemplate): DailyInstance {
  const base = build(item.date, template);
  base.blocks = base.blocks.filter(block => block.category !== '训练' && block.id !== 'training').concat(clone(item.blocks.filter(block => block.category === '训练' || block.id === 'training'))).sort((a, b) => a.start.localeCompare(b.start));
  base.mode = 'emergency'; base.createdAt = item.createdAt;
  const training = base.blocks.filter(block => block.category === '训练' || block.id === 'training');
  // An explicit old simplification keeps its actual time. Moving the surrounding
  // evening must not silently place that selection inside new work occupation.
  if (training.some(selected => base.blocks.some(block => !training.includes(block)
      && minutesOf(selected.start) < endMinutesOf(block.end) && minutesOf(block.start) < endMinutesOf(selected.end)))) return clone(item);
  try { validateInstances({ [item.date]: base }); } catch (_err) { throw new Error('新计划与已选简化方案不兼容，请先恢复标准方案后编辑'); }
  return base;
}
function recordedDates(): string[] {
  const dates = new Set<string>();
  const modern = read('dayflow.records.v2');
  if (modern !== undefined) {
    validateEnvelope(modern);
    for (const key of Object.keys(modern.byDate)) if (Object.keys(modern.byDate[key]).length) dates.add(key);
    return [...dates].sort();
  }
  const legacy = read('dayflow.records.v1');
  if (legacy !== undefined) {
    validateLegacyRecords(legacy);
    for (const key of Object.keys(legacy)) {
      assertDate(key); if (!object(legacy[key])) throw new Error('原打卡记录损坏，已停止修改计划');
      if (Object.keys(legacy[key]).length) dates.add(key);
    }
  }
  return [...dates].sort();
}
/** Existing facts are immutable even when their calendar date is in the future. */
function immutableDates(): string[] {
  const saved = instances();
  return [...new Set(Object.keys(saved).filter(date => saved[date].locked).concat(recordedDates()))].sort();
}
function freezeRecorded(template: PlanTemplate, nextTemplate?: PlanTemplate) {
  const dates = recordedDates();
  const saved = instances();
  let changed = false;
  dates.forEach(date => {
    if (!saved[date]) { saved[date] = build(date, historicalTemplate(template)); changed = true; }
    if (!saved[date].locked) { saved[date].locked = true; changed = true; }
  });
  Object.keys(saved).forEach(date => {
    if (saved[date].locked) return;
    if (date < today()) saved[date].locked = true;
    else if (saved[date].mode === 'emergency') { if (nextTemplate) rebaseEmergency(saved[date], nextTemplate); return; }
    else delete saved[date]; // Only derived, unexecuted caches are invalidated.
    changed = true;
  });
  if (changed) wx.setStorageSync(INSTANCE_KEY, saved);
}
export function getDailyInstance(date: string): DailyInstance {
  assertDate(date);
  const template = getTemplate(), saved = instances(), existing = saved[date];
  const recorded = recordedDates().includes(date);
  if (existing && recorded && !existing.locked) { existing.locked = true; wx.setStorageSync(INSTANCE_KEY, saved); return clone(existing); }
  if (existing && date < today() && !existing.locked) { existing.locked = true; wx.setStorageSync(INSTANCE_KEY, saved); return clone(existing); }
  if (existing && !existing.locked && existing.mode === 'emergency' && (existing.templateVersion !== template.version || existing.templateId !== template.id)) {
    const rebased = rebaseEmergency(existing, template);
    if (JSON.stringify(rebased) === JSON.stringify(existing)) return clone(existing);
    saved[date] = rebased; wx.setStorageSync(INSTANCE_KEY, saved); return clone(saved[date]);
  }
  if (existing && (existing.locked || (existing.templateId === template.id && existing.templateVersion === template.version))) {
    if (!existing.locked && date < today()) { existing.locked = true; wx.setStorageSync(INSTANCE_KEY, saved); }
    return clone(existing);
  }
  const source = date < today() || recorded ? historicalTemplate(template) : template;
  saved[date] = build(date, source);
  if (recorded) saved[date].locked = true;
  wx.setStorageSync(INSTANCE_KEY, saved);
  return clone(saved[date]);
}
export function lockDailyInstance(date: string): DailyInstance {
  const item = getDailyInstance(date);
  if (!item.locked) { item.locked = true; const saved = instances(); saved[date] = item; wx.setStorageSync(INSTANCE_KEY, saved); }
  return clone(item);
}
export function getDayBlocks(date: string): PlanBlock[] {
  return getDailyInstance(date).blocks.map(block => ({
    id: block.id, title: block.title, start: block.start, end: block.end, kind: block.kind, category: block.category,
    actions: block.tasks.reduce((actions: PlanAction[], task) => actions.concat(task.actions.length
      ? task.actions.map(action => ({ ...action, taskId: task.id, actionId: action.id }))
      : [{ id: task.id, title: task.title, start: task.start, end: task.end, taskId: task.id, dosage: task.dosage, description: task.description, equipment: task.equipment, searchKeyword: task.searchKeyword, safety: task.safety }]), [])
  }));
}
export function getSnapshotDates(): string[] { return Object.keys(instances()).sort(); }
export interface DateEditState {
  locked: boolean;
  reason: 'past' | 'recorded' | 'snapshot' | '';
}
/** Read-only eligibility check: selecting an editor date must not create a daily instance. */
export function getDateEditState(date: string): DateEditState {
  assertDate(date);
  const saved = instances(), recorded = recordedDates();
  if (date < today()) return { locked: true, reason: 'past' };
  if (recorded.includes(date)) return { locked: true, reason: 'recorded' };
  if (saved[date] && saved[date].locked) return { locked: true, reason: 'snapshot' };
  return { locked: false, reason: '' };
}
export function getTemplateVersions(): PlanTemplate[] {
  const value = read(VERSIONS_KEY);
  if (value !== undefined && !Array.isArray(value)) throw new Error('计划版本数据损坏');
  const versions = (value || []).map(validated);
  const current = getTemplate();
  if (!versions.some((item: PlanTemplate) => item.id === current.id && item.version === current.version)) versions.push(current);
  return clone(versions).sort((a: PlanTemplate, b: PlanTemplate) => b.version - a.version);
}
export function saveTemplate(template: PlanTemplate, expectedVersion?: number): PlanTemplate {
  const current = getTemplate();
  if (expectedVersion !== undefined && expectedVersion !== current.version) throw new Error('计划已更新，请重新打开后再保存');
  const checked = validated(template);
  const next = validated({ ...checked, id: current.id, version: current.version + 1, updatedAt: Date.now() });
  const versions = getTemplateVersions();
  freezeRecorded(current, next);
  // Preserve the previous version before making the new one current. If any
  // earlier write fails, the active template and existing records stay intact.
  wx.setStorageSync(VERSIONS_KEY, versions);
  wx.setStorageSync(PLAN_KEY, next);
  return clone(next);
}
export interface SchedulePreview {
  ok: boolean; schedule?: Schedule; conflicts: PlanningConflict[]; errors: string[]; identityAdjusted: boolean;
}
function candidateWithSchedule(template: PlanTemplate, schedule: Schedule): PlanTemplate {
  const next = clone(template), index = next.schedules.findIndex(item => item.id === schedule.id);
  if (index < 0) next.schedules.push(clone(schedule)); else next.schedules[index] = clone(schedule);
  return next;
}
function readablePlanErrors(errors: string[], template: PlanTemplate): string[] {
  return errors.map(message => {
    const ruleIndex = /第(\d+)条规则/.exec(message), rule = ruleIndex && template.schedules[Number(ruleIndex[1]) - 1];
    const exception = rule && /条规则例外/.test(message) && rule.exceptions.find(item => item.blocks &&
      validatePlan({ ...template, schedules: [{ ...rule, blocks: [], exceptions: [item] }] }).errors.some(error =>
        error.replace(/第\d+条规则/, '') === message.replace(/第\d+条规则/, '')));
    const blockIndex = /第(\d+)个时间块/.exec(message), block = rule && blockIndex && (exception ? exception.blocks : rule.blocks)[Number(blockIndex[1]) - 1];
    const taskIndex = /第(\d+)项任务/.exec(message), task = block && taskIndex && block.tasks[Number(taskIndex[1]) - 1];
    const actionIndex = /第(\d+)步/.exec(message), action = task && actionIndex && task.actions[Number(actionIndex[1]) - 1];
    if (block && /顺序(?:动作|任务)不能重叠或倒序/.test(message)) {
      const rows = block.tasks.reduce((all: { title: string; start: string; end: string }[], item) => all.concat(item.actions.length ? item.actions : [item]), []);
      for (let i = 1; i < rows.length; i++) if (rows[i].start < rows[i - 1].end) {
        return (exception ? exception.date + '的' : '') + '时段“' + block.title + '”内，“' + rows[i].title + '” ' + rows[i].start + '–' + rows[i].end
          + ' 与前一步“' + rows[i - 1].title + '” ' + rows[i - 1].start + '–' + rows[i - 1].end
          + ' 的执行顺序或时间重叠，请调整这两个步骤。';
      }
    }
    if (rule) message = message.replace(/第\d+条规则(?:例外)?/, '安排“' + (rule.title || '未命名安排') + '”' + (exception ? '在' + exception.date : ''));
    if (block) message = message.replace(/第\d+个时间块/, '的时段“' + (block.title || '未命名时段') + '”（' + block.start + '–' + block.end + '）');
    if (task) message = message.replace(/第\d+项任务/, '内的“' + (task.title || '未命名事项') + '”（' + task.start + '–' + task.end + '）');
    if (action) message = message.replace(/第\d+步/, '的步骤“' + (action.title || '未命名步骤') + '”（' + action.start + '–' + action.end + '）');
    if (/标识/.test(message)) return '安排内容的引用不完整，请重新打开这项安排后再试；原计划已保留。';
    return message;
  });
}
function assertTimerReferencePreserved(current: PlanTemplate, next: Schedule): void {
  const previous = current.schedules.find(item => item.id === next.id);
  if (!previous) return;
  const timer = getTimer();
  if (!timer || timer.status === 'finished') return;
  const targets = (rule: Schedule) => blocksOnDate(rule, timer.dateKey).reduce((all: string[], block) => all.concat(block.tasks.reduce((ids: string[], task) => ids.concat(task.actions.length ? task.actions.map(action => action.id) : [task.id]), [])), []);
  if (!targets(previous).includes(timer.targetId) || targets(next).includes(timer.targetId)) return;
  const saved = instances();
  if (saved[timer.dateKey]?.locked || recordedDates().includes(timer.dateKey)) return;
  throw new Error(timer.dateKey + '的该事项仍有计时，请先结束或重新选择计时事项，再修改重复范围；原计划已保留。');
}
/** Read-only preparation shared by the wizard and the final save boundary. */
export function previewSchedule(input: Schedule, expectedVersion?: number): SchedulePreview {
  const empty = { ok: false, conflicts: [] as PlanningConflict[], errors: [] as string[], identityAdjusted: false };
  try {
    const current = getTemplate();
    if (expectedVersion !== undefined && expectedVersion !== current.version) return { ...empty, errors: ['计划已更新，请重新打开这项安排后再保存；已填内容仍保留。'] };
    // Preparing an edit must fail closed when history protection cannot be read.
    const excludedDates = immutableDates();
    const sorted = sortScheduleTimes(input);
    const standalone = { ...current, schedules: [sorted] };
    const structural = validatePlan(standalone).errors.filter(message => !/同一天的(?:时间块|任务|执行目标)标识不能重复/.test(message));
    if (structural.length) return { ...empty, errors: readablePlanErrors(structural, standalone) };
    if (sorted.effectiveTo === sorted.effectiveFrom && getDateEditState(sorted.effectiveFrom).locked) {
      return { ...empty, errors: [sorted.effectiveFrom + '已有记录或属于历史日期，当天计划会保留。请选择未执行的日期后再保存。'] };
    }
    const prepared = prepareScheduleIdentities(current, sorted), candidate = candidateWithSchedule(current, prepared.schedule);
    const checked = validatePlan(candidate);
    if (!checked.ok) return { ...empty, errors: readablePlanErrors(checked.errors, candidate) };
    assertTimerReferencePreserved(current, prepared.schedule);
    const conflicts = findScheduleConflicts(current, prepared.schedule, { notBefore: today(), excludedDates });
    return { ok: !conflicts.length, schedule: clone(prepared.schedule), conflicts, errors: conflicts.map(item => item.message), identityAdjusted: prepared.changes.length > 0 };
  } catch (error) {
    return { ...empty, errors: [error && error.message || '安排暂时无法检查，原计划已保留，请重新打开后再试。'] };
  }
}
export function getScheduleAvailability(schedule: Schedule, blockId: string, options: AvailabilityOptions = {}): AvailabilityResult {
  return getBlockAvailability(getTemplate(), clone(schedule), blockId, { ...options, notBefore: today(), excludedDates: immutableDates() });
}
/** Analyze the entire draft with the same immutable-date scope as final save. */
export function getScheduleConflicts(schedule: Schedule): PlanningConflict[] {
  return findScheduleConflicts(getTemplate(), clone(schedule), { notBefore: today(), excludedDates: immutableDates() });
}
export function saveSchedule(schedule: Schedule, expectedVersion?: number): PlanTemplate {
  const version = expectedVersion === undefined ? getTemplate().version : expectedVersion;
  const preview = previewSchedule(schedule, version);
  if (!preview.ok || !preview.schedule) throw new Error(preview.errors.join('；') || '请先调整安排，再确认保存。');
  return saveTemplate(candidateWithSchedule(getTemplate(), preview.schedule), version);
}
export interface ScheduleOverwritePreview extends SchedulePreview {
  template?: PlanTemplate; removed: OverwriteRemoval[]; lease: string;
}
function assertOverwriteTimerPreserved(current: PlanTemplate, candidate: PlanTemplate): void {
  const timer = getTimer();
  if (!timer || timer.status === 'finished') return;
  const targets = (template: PlanTemplate) => template.schedules.reduce((ids: string[], rule) => ids.concat(
    blocksOnDate(rule, timer.dateKey).reduce((rows: string[], block) => rows.concat(block.tasks.reduce((all: string[], task) =>
      all.concat(task.actions.length ? task.actions.map(action => action.id) : [task.id]), [])), [])), []);
  if (!targets(current).includes(timer.targetId) || targets(candidate).includes(timer.targetId)) return;
  if (immutableDates().includes(timer.dateKey)) return;
  throw new Error(timer.dateKey + '的旧安排仍有未结束的计时，请先结束或重新选择计时事项，再确认替换；原计划已保留。');
}
/** A replacement confirmation is a read-only lease, never a storage mutation. */
export function previewScheduleOverwrite(input: Schedule, expectedVersion?: number): ScheduleOverwritePreview {
  const empty: ScheduleOverwritePreview = { ok: false, conflicts: [], errors: [], identityAdjusted: false, removed: [], lease: '' };
  try {
    const current = getTemplate();
    if (expectedVersion !== undefined && current.version !== expectedVersion) return { ...empty, errors: ['计划已更新，请重新确认要替换的安排；已填内容仍保留。'] };
    const excludedDates = immutableDates(), sorted = sortScheduleTimes(input), standalone = { ...current, schedules: [sorted] };
    const structural = validatePlan(standalone).errors.filter(message => !/同一天的(?:时间块|任务|执行目标)标识不能重复/.test(message));
    if (structural.length) return { ...empty, errors: readablePlanErrors(structural, standalone) };
    if (sorted.effectiveTo === sorted.effectiveFrom && getDateEditState(sorted.effectiveFrom).locked) return {
      ...empty, errors: [sorted.effectiveFrom + '已有记录或属于历史日期，当天安排会保留，请选择未执行的日期。'] };
    const identity = prepareScheduleIdentities(current, sorted);
    const prepared = prepareScheduleOverwrite(current, identity.schedule, { notBefore: today(), excludedDates });
    const checked = validatePlan(prepared.template);
    if (!checked.ok) return { ...empty, errors: readablePlanErrors(checked.errors, prepared.template) };
    assertOverwriteTimerPreserved(current, prepared.template);
    const conflicts = findScheduleConflicts(prepared.template, prepared.schedule, { notBefore: today(), excludedDates });
    if (conflicts.length) return { ...empty, conflicts, errors: conflicts.map(item => item.message) };
    const lease = JSON.stringify({ current, input: sorted, template: prepared.template, removed: prepared.removed, excludedDates, date: today() });
    return { ok: true, schedule: clone(prepared.schedule), template: clone(prepared.template), removed: clone(prepared.removed),
      conflicts: [], errors: [], lease, identityAdjusted: identity.changes.length > 0 };
  } catch (error) { return { ...empty, errors: [error && error.message || '替换安排暂时无法检查，原计划已保留。'] }; }
}
/** Selection deliberately permits occupied external minutes, while keeping siblings separate. */
export function getOverwriteSelectionAvailability(schedule: Schedule, blockId: string, options: AvailabilityOptions = {}): AvailabilityResult {
  const current = getTemplate();
  return getBlockAvailability({ ...current, schedules: [] }, clone(schedule), blockId,
    { ...options, notBefore: today(), excludedDates: immutableDates() });
}
export function getOverwriteScheduleAvailability(schedule: Schedule, blockId: string, options: AvailabilityOptions = {}): AvailabilityResult {
  const preview = previewScheduleOverwrite(schedule);
  if (!preview.ok || !preview.template || !preview.schedule) throw new Error(preview.errors.join('；') || '请重新检查替换范围。');
  // Identity preparation can rename the selected block. Match its original position.
  const original = sortScheduleTimes(schedule);
  const originalBlocks = options.exceptionDate ? original.exceptions.find(item => item.date === options.exceptionDate)?.blocks || [] : original.blocks;
  const preparedBlocks = options.exceptionDate ? preview.schedule.exceptions.find(item => item.date === options.exceptionDate)?.blocks || [] : preview.schedule.blocks;
  const index = originalBlocks.findIndex(block => block.id === blockId), resolved = preparedBlocks[index]?.id || blockId;
  return getBlockAvailability(preview.template, preview.schedule, resolved, { ...options, notBefore: today(), excludedDates: immutableDates() });
}
export function getOverwriteScheduleConflicts(schedule: Schedule): PlanningConflict[] {
  return previewScheduleOverwrite(schedule).conflicts;
}
export function saveScheduleOverwrite(schedule: Schedule, expectedVersion: number, confirmedLease: string): PlanTemplate {
  const preview = previewScheduleOverwrite(schedule, expectedVersion);
  if (!preview.ok || !preview.template) throw new Error(preview.errors.join('；') || '请重新检查替换范围。');
  if (!confirmedLease || confirmedLease !== preview.lease) throw new Error('安排或替换范围已变化，请重新确认后再保存；原计划已保留。');
  const keys = wx.getStorageInfoSync().keys;
  const backup = [PLAN_KEY, VERSIONS_KEY, INSTANCE_KEY].map(key => ({ key, exists: keys.includes(key), value: wx.getStorageSync(key) }));
  try { return saveTemplate(preview.template, expectedVersion); }
  catch (_error) {
    let recovered = true;
    backup.reverse().forEach(item => { try { if (item.exists) wx.setStorageSync(item.key, item.value); else wx.removeStorageSync(item.key); } catch (_rollbackError) { recovered = false; } });
    throw new Error(recovered ? '替换未能保存，原计划和记录已保留，请稍后重试' : '替换未完成，部分数据恢复失败，请先检查本机数据');
  }
}
export interface EveningRoutineUpdatePreview {
  ok: boolean; template?: PlanTemplate; removed: OverwriteRemoval[]; lease: string; errors: string[]; routines: Schedule[];
  summary: { from: string; days: number; replaced: number; keepsToday: boolean };
}
/** Opt-in update of only morning sleep and evening occupation, preserving daytime customization. */
export function previewEveningRoutineUpdate(expectedVersion?: number): EveningRoutineUpdatePreview {
  const date = today(), empty: EveningRoutineUpdatePreview = { ok: false, removed: [], lease: '', errors: [], routines: [], summary: { from: date, days: 7, replaced: 0, keepsToday: false } };
  try {
    const current = getTemplate();
    if (expectedVersion !== undefined && current.version !== expectedVersion) throw new Error('计划已更新，请重新预览晚间作息后再确认。');
    const excludedDates = immutableDates(), stripped = removeFutureOvertime(current, date, excludedDates);
    let candidate = stripped.template;
    const removed = stripped.removed.slice(), routines: Schedule[] = [];
    for (const example of defaultTemplate(3).schedules) {
      const weekday = example.weekdays[0];
      const draft: Schedule = { ...example, id: 'evening-v3-' + weekday + '-' + date.replace(/-/g, ''),
        title: ['周日','周一','周二','周三','周四','周五','周六'][weekday] + '晚间作息', effectiveFrom: date,
        blocks: example.blocks.filter(block => !['work-morning','music','work-afternoon'].includes(block.id)) };
      const identity = prepareScheduleIdentities(candidate, draft);
      const prepared = prepareScheduleOverwrite(candidate, identity.schedule, { notBefore: date, excludedDates });
      candidate = prepared.template; removed.push(...prepared.removed); routines.push(prepared.schedule);
    }
    const checked = validatePlan(candidate);
    if (!checked.ok) throw new Error(readablePlanErrors(checked.errors, candidate).join('；'));
    for (const routine of routines) {
      const conflicts = findScheduleConflicts(candidate, routine, { notBefore: date, excludedDates });
      if (conflicts.length) throw new Error(conflicts[0].message);
    }
    assertOverwriteTimerPreserved(current, candidate);
    const lease = JSON.stringify({ current, candidate, removed, excludedDates, date });
    return { ok: true, template: clone(candidate), removed: clone(removed), lease, errors: [], routines: clone(routines),
      summary: { from: date, days: 7, replaced: removed.length, keepsToday: excludedDates.includes(date) } };
  } catch (error) { return { ...empty, errors: [error && error.message || '暂时无法更新晚间作息，原计划已保留。'] }; }
}
export function saveEveningRoutineUpdate(expectedVersion: number, confirmedLease: string): PlanTemplate {
  const preview = previewEveningRoutineUpdate(expectedVersion);
  if (!preview.ok || !preview.template) throw new Error(preview.errors.join('；'));
  if (!confirmedLease || preview.lease !== confirmedLease) throw new Error('晚间作息或影响范围已变化，请重新预览确认，原计划已保留。');
  const keys = wx.getStorageInfoSync().keys;
  const backups = [PLAN_KEY, VERSIONS_KEY, INSTANCE_KEY].map(key => ({ key, exists: keys.includes(key), value: wx.getStorageSync(key) }));
  try { return saveTemplate(preview.template, expectedVersion); }
  catch (_error) {
    let recovered = true;
    backups.reverse().forEach(item => { try { if (item.exists) wx.setStorageSync(item.key, item.value); else wx.removeStorageSync(item.key); } catch (_rollbackError) { recovered = false; } });
    throw new Error(recovered ? '晚间作息未能保存，原计划和记录已保留，请稍后重试' : '更新未完成，部分数据恢复失败，请先检查本机数据');
  }
}
export function deleteSchedule(scheduleId: string, expectedVersion?: number): PlanTemplate {
  const template = getTemplate();
  if (!template.schedules.some(item => item.id === scheduleId)) throw new Error('未找到该日程规则');
  template.schedules = template.schedules.filter(item => item.id !== scheduleId);
  return saveTemplate(template, expectedVersion);
}
export function previewImport(text: string): ImportPreview {
  const empty = { schedules: 0, blocks: 0, tasks: 0, actions: 0 };
  if (typeof text !== 'string' || text.length > 262144) return { ok: false, errors: ['导入内容过大或格式无效'], warnings: [], summary: empty };
  try {
    const preview = validatePlan(JSON.parse(text));
    if (!preview.ok) {
      preview.errors = preview.errors.map(message => /同一天的(?:时间块|任务|执行目标)标识不能重复/.test(message)
        ? '导入模板在同一天重复使用了事项编号，请为模板中的每个时间块、任务和步骤提供独立编号后重新导入。'
        : message);
      return preview;
    }
    const conflicts = findPlanConflicts(preview.template, { notBefore: today(), excludedDates: immutableDates() });
    if (conflicts.length) return { ...preview, ok: false, errors: conflicts.map(conflict => conflict.message) };
    return preview;
  } catch (_err) { return { ok: false, errors: ['无法解析模板，请检查标准格式文本'], warnings: [], summary: empty }; }
}
export function importTemplate(text: string, expectedVersion?: number): PlanTemplate {
  const preview = previewImport(text);
  if (!preview.ok) throw new Error(preview.errors.join('；'));
  return saveTemplate(preview.template, expectedVersion);
}
export function exportTemplate(): string { return JSON.stringify(getTemplate(), null, 2); }
/** Preview only: callers must use the ordinary validated import confirmation to apply it. */
export function exportDefaultTemplate(version: 1 | 2 | 3 = 3): string { return JSON.stringify(defaultTemplate(version), null, 2); }
function hhmm(minute: number) { return String(Math.floor(minute / 60)).padStart(2, '0') + ':' + String(minute % 60).padStart(2, '0'); }
export function setEmergencyPlan(date: string, enabled: boolean, blockId?: string): DailyInstance {
  assertDate(date);
  const item = getDailyInstance(date);
  if (item.mode === (enabled ? 'emergency' : 'standard')) {
    if (enabled && blockId && !item.blocks.some(block => (block.category === '训练' || block.id === 'training') && block.id === blockId)) throw new Error('这一天已选择另一训练块的简化方案，请先恢复标准方案');
    return item;
  }
  if (item.locked || date < today() || recordedDates().includes(date)) throw new Error('已有执行记录或历史日程不能切换方案，请选择未执行的日期');
  if (!enabled) { const standard = build(date, getTemplate()); const saved = instances(); saved[date] = standard; wx.setStorageSync(INSTANCE_KEY, saved); return clone(standard); }
  const training = item.blocks.filter(block => block.category === '训练' || block.id === 'training');
  if (!training.length) throw new Error('这一天没有可简化的训练时间块');
  if (blockId && !training.some(block => block.id === blockId)) throw new Error('所选时间块不是可简化的训练');
  const first = (blockId ? training.find(block => block.id === blockId) : undefined) || training.find(block => block.kind === 'sequence') || training[0], start = minutesOf(first.start);
  if (endMinutesOf(first.end) - start < 15 || start + 15 > 1440) throw new Error('原训练时间不足十五分钟，请先调整计划');
  const steps: Action[] = [
    { id: 'emergency-warmup', title: '轻柔活动与热身', start: hhmm(start), end: hhmm(start + 3), dosage: '三分钟，自主调整', description: '仅选择自己已确认适合的轻柔活动。', safety: '不适时随时停止，并咨询专业人员。' },
    { id: 'emergency-move', title: '自选舒适活动', start: hhmm(start + 3), end: hhmm(start + 12), dosage: '九分钟，可提前结束', description: '可以选择熟悉的舒适活动，也可以休息；没有必须完成的动作。', safety: '不追求强度或进阶，不适立即停止。' },
    { id: 'emergency-relax', title: '轻柔放松或休息', start: hhmm(start + 12), end: hhmm(start + 15), dosage: '三分钟', description: '在舒适范围内放松，允许直接休息。', safety: '避免强力牵拉或压迫不适部位。' }
  ];
  const replacement: TimeBlock = { ...first, kind: 'sequence', title: '十五分钟简化训练', end: hhmm(start + 15), tasks: [{ id: 'emergency-training', title: '自主简化训练', start: first.start, end: hhmm(start + 15), actions: steps }] };
  item.blocks = item.blocks.filter(block => !training.some(t => t.id === block.id)); item.blocks.push(replacement); item.blocks.sort((a, b) => a.start.localeCompare(b.start)); item.mode = 'emergency';
  const saved = instances(); saved[date] = item; wx.setStorageSync(INSTANCE_KEY, saved); return clone(item);
}

export function scheduleDeferredTarget(sourceDate: string, targetId: string, targetDate: string): { date: string; targetId: string; start: string; end: string } {
  assertDate(sourceDate); assertDate(targetDate);
  if (targetDate < today()) throw new Error('只能安排到今天或未来日期');
  const envelope = read('dayflow.records.v2');
  if (envelope !== undefined) validateEnvelope(envelope);
  const record = envelope && envelope.schemaVersion === 2 && object(envelope.byDate) && object(envelope.byDate[sourceDate]) ? envelope.byDate[sourceDate][targetId] : undefined;
  if (!record || record.status !== 'deferred' || record.deferredTo !== targetDate) throw new Error('请先把来源任务标记为延期并选择目标日期');
  const sourceBlocks = getDayBlocks(sourceDate);
  const sourceBlock = sourceBlocks.find(block => block.actions.some(action => action.id === targetId));
  const source = sourceBlock && sourceBlock.actions.find(action => action.id === targetId);
  if (!source) throw new Error('来源任务不在原日程快照中');
  let hash = 2166136261;
  for (let i = 0; i < targetId.length; i++) { hash ^= targetId.charCodeAt(i); hash = Math.imul(hash, 16777619); }
  const id = 'deferred-' + sourceDate.replace(/-/g, '') + '-' + targetDate.replace(/-/g, '') + '-' + (hash >>> 0).toString(36);
  const target = getDailyInstance(targetDate);
  if (target.mode === 'emergency') throw new Error('目标日期已选择简化方案，请先恢复标准计划或手动安排');
  const existing = getTemplate().schedules.find(schedule => schedule.id === id);
  if (existing) {
    const task = existing.blocks[0].tasks[0];
    if (!task.origin || task.origin.date !== sourceDate || task.origin.targetId !== targetId) throw new Error('延期安排标识冲突，请手动创建日程');
    const action = task.actions[0];
    if (!getDayBlocks(targetDate).some(block => block.actions.some(row => row.id === action.id))) throw new Error('目标日期的锁定计划未包含该延期事项，请手动安排');
    return { date: targetDate, targetId: action.id, start: action.start, end: action.end };
  }
  if (target.locked || recordedDates().includes(targetDate)) throw new Error('目标日期已有执行记录，不能自动修改，请手动安排其他日期');
  const duration = endMinutesOf(source.end) - minutesOf(source.start);
  let start = minutesOf(source.start);
  for (const block of target.blocks) {
    const left = minutesOf(block.start), right = endMinutesOf(block.end);
    if (start + duration <= left) break;
    if (start < right && start + duration > left) start = right;
  }
  if (start + duration > 1440) throw new Error('目标日没有足够空档，请手动调整计划');
  const action: Action = { id: id + '-step', title: source.title, start: hhmm(start), end: hhmm(start + duration) };
  ['dosage','description','equipment','searchKeyword','safety'].forEach(field => { if ((source as any)[field]) (action as any)[field] = (source as any)[field]; });
  const block: TimeBlock = { id, title: '延期安排：' + source.title, start: action.start, end: action.end, kind: 'parallel', category: sourceBlock.category, tasks: [{ id: id + '-task', title: source.title, start: action.start, end: action.end, actions: [action], origin: { date: sourceDate, targetId } }] };
  saveSchedule({ id, title: block.title, weekdays: [], effectiveFrom: targetDate, effectiveTo: targetDate, exceptions: [{ date: targetDate, kind: 'replace', blocks: [block] }], blocks: [block] }, getTemplate().version);
  return { date: targetDate, targetId: action.id, start: action.start, end: action.end };
}
