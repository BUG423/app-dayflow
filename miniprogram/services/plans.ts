import { getBlocksForDate, PlanBlock, PlanAction } from '../data/template';
import { Action, DailyInstance, ImportPreview, PlanTemplate, Schedule, Task, TimeBlock } from '../types/domain';
import { localDateKey, parseLocalDate, minutesOf, shiftDays } from '../utils/calendar';
import { resolveBlocks, validatePlan } from '../utils/plan-validation';
import { validateEnvelope, validateLegacyRecords } from '../utils/record-validation';

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
function defaultTemplate(): PlanTemplate {
  const schedules: Schedule[] = [];
  for (let weekday = 0; weekday < 7; weekday++) {
    const key = shiftDays('2026-11-01', weekday);
    const blocks = getBlocksForDate(key).map(block => {
      const tasks: Task[] = block.kind === 'fixed' ? [] : block.kind === 'parallel'
        ? block.actions.map(action => ({ ...action, actions: [] }))
        : [{ id: 'training-task', title: block.title, start: block.start, end: block.end, actions: block.actions.map(action => ({ ...action })) }];
      return { id: block.id, title: block.title, start: block.start, end: block.end, kind: block.kind, category: block.category, tasks };
    });
    schedules.push({ id: 'weekday-' + weekday, title: ['周日','周一','周二','周三','周四','周五','周六'][weekday] + '示例安排', weekdays: [weekday], effectiveFrom: '2000-01-01', exceptions: [], blocks });
  }
  return { schemaVersion: 1, id: 'dayflow-plan', name: '每日示例计划', version: 1, updatedAt: 0, schedules };
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
      if (training.length !== 1 || training[0].kind !== 'sequence' || minutesOf(training[0].end) - minutesOf(training[0].start) !== 15) throw new Error('简化方案快照无效，须保留十五分钟训练');
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
function freezeRecorded(template: PlanTemplate, nextTemplate?: PlanTemplate) {
  const dates = recordedDates();
  const saved = instances();
  let changed = false;
  dates.forEach(date => {
    if (!saved[date]) { saved[date] = build(date, template); changed = true; }
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
  if (existing && date < today() && !existing.locked) { existing.locked = true; wx.setStorageSync(INSTANCE_KEY, saved); return clone(existing); }
  if (existing && !existing.locked && existing.mode === 'emergency' && (existing.templateVersion !== template.version || existing.templateId !== template.id)) {
    saved[date] = rebaseEmergency(existing, template); wx.setStorageSync(INSTANCE_KEY, saved); return clone(saved[date]);
  }
  if (existing && (existing.locked || (existing.templateId === template.id && existing.templateVersion === template.version))) {
    if (!existing.locked && date < today()) { existing.locked = true; wx.setStorageSync(INSTANCE_KEY, saved); }
    return clone(existing);
  }
  saved[date] = build(date, template);
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
export function saveSchedule(schedule: Schedule, expectedVersion?: number): PlanTemplate {
  const template = getTemplate();
  const index = template.schedules.findIndex(item => item.id === schedule.id);
  if (index < 0) template.schedules.push(clone(schedule)); else template.schedules[index] = clone(schedule);
  return saveTemplate(template, expectedVersion);
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
  try { return validatePlan(JSON.parse(text)); } catch (_err) { return { ok: false, errors: ['无法解析模板，请检查标准格式文本'], warnings: [], summary: empty }; }
}
export function importTemplate(text: string, expectedVersion?: number): PlanTemplate {
  const preview = previewImport(text);
  if (!preview.ok) throw new Error(preview.errors.join('；'));
  return saveTemplate(preview.template, expectedVersion);
}
export function exportTemplate(): string { return JSON.stringify(getTemplate(), null, 2); }
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
  if (minutesOf(first.end) - start < 15 || start + 15 > 1439) throw new Error('原训练时间不足十五分钟，请先调整计划');
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
  const duration = minutesOf(source.end) - minutesOf(source.start);
  let start = minutesOf(source.start);
  for (const block of target.blocks) {
    const left = minutesOf(block.start), right = minutesOf(block.end);
    if (start + duration <= left) break;
    if (start < right && start + duration > left) start = right;
  }
  if (start + duration > 1439) throw new Error('目标日没有足够空档，请手动调整计划');
  const action: Action = { id: id + '-step', title: source.title, start: hhmm(start), end: hhmm(start + duration) };
  ['dosage','description','equipment','searchKeyword','safety'].forEach(field => { if ((source as any)[field]) (action as any)[field] = (source as any)[field]; });
  const block: TimeBlock = { id, title: '延期安排：' + source.title, start: action.start, end: action.end, kind: 'parallel', category: sourceBlock.category, tasks: [{ id: id + '-task', title: source.title, start: action.start, end: action.end, actions: [action], origin: { date: sourceDate, targetId } }] };
  saveSchedule({ id, title: block.title, weekdays: [], effectiveFrom: targetDate, effectiveTo: targetDate, exceptions: [{ date: targetDate, kind: 'replace', blocks: [block] }], blocks: [block] }, getTemplate().version);
  return { date: targetDate, targetId: action.id, start: action.start, end: action.end };
}
