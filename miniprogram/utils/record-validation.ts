import { parseLocalDate } from './calendar';
import { RecordEnvelope, TaskStatus, TrainingFeedback } from '../types/domain';
const STATUSES: TaskStatus[] = ['todo', 'doing', 'done', 'skipped', 'deferred', 'aborted'];
const isMap = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const timestamp = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
export function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 160 && !['__proto__', 'prototype', 'constructor'].includes(value);
}
export function checkDate(date: string): void { parseLocalDate(date); }
export function checkStatus(value: unknown): asserts value is TaskStatus {
  if (!STATUSES.includes(value as TaskStatus)) throw new Error('任务状态无效');
}
export function checkFeedback(value: unknown): asserts value is TrainingFeedback {
  if (!isMap(value) || Object.keys(value).some(key => !['effort', 'discomfort', 'note'].includes(key))) throw new Error('反馈格式无效');
  if (value.effort !== undefined && (!Number.isInteger(value.effort) || value.effort < 1 || value.effort > 5)) throw new Error('请在一至五级中选择强度');
  if (value.discomfort !== undefined && typeof value.discomfort !== 'boolean') throw new Error('不适反馈格式无效');
  if (value.note !== undefined && (typeof value.note !== 'string' || value.note.length > 1000)) throw new Error('反馈备注不能超过一千字');
}
export function validateEnvelope(value: unknown): asserts value is RecordEnvelope {
  if (!isMap(value) || value.schemaVersion !== 2 || !isMap(value.byDate)) throw new Error('执行记录数据损坏，请先恢复备份');
  for (const date of Object.keys(value.byDate)) {
    checkDate(date); const entries = value.byDate[date];
    if (!isMap(entries)) throw new Error('当天执行记录数据损坏');
    for (const id of Object.keys(entries)) {
      const item = entries[id];
      if (!validId(id) || !isMap(item) || item.date !== date || item.targetId !== id || !validId(item.taskId) ||
          (item.actionId !== undefined && !validId(item.actionId)) || !timestamp(item.updatedAt) || !Array.isArray(item.events)) throw new Error('执行记录格式无效');
      checkStatus(item.status);
      if (item.actualStartedAt !== undefined && !timestamp(item.actualStartedAt)) throw new Error('执行开始时间无效');
      if (item.finishedAt !== undefined && !timestamp(item.finishedAt)) throw new Error('执行结束时间无效');
      if (item.deferredTo !== undefined) { checkDate(item.deferredTo); if (item.deferredTo <= date) throw new Error('延期目标必须晚于原计划日期'); }
      if (item.status === 'deferred' && !item.deferredTo) throw new Error('延期记录缺少目标日期');
      if (item.status !== 'deferred' && item.deferredTo !== undefined) throw new Error('非延期记录不能带延期目标');
      if (item.feedback !== undefined) checkFeedback(item.feedback);
      const eventIds = new Set<string>();
      let previousState: TaskStatus | undefined;
      for (const event of item.events) {
        if (!isMap(event) || !validId(event.id) || eventIds.has(event.id) || !timestamp(event.at) ||
            (event.reason !== undefined && (typeof event.reason !== 'string' || event.reason.length > 200))) throw new Error('执行事件格式无效');
        eventIds.add(event.id); checkStatus(event.from); checkStatus(event.to);
        if (previousState && previousState !== event.from) throw new Error('执行事件状态链无效');
        previousState = event.to;
      }
      if (previousState && previousState !== item.status) throw new Error('执行事件与当前状态不一致');
    }
  }
}

export function validateLegacyRecords(value: unknown): asserts value is Record<string, Record<string, 'todo' | 'done'>> {
  if (!isMap(value)) throw new Error('旧版执行记录数据损坏');
  for (const date of Object.keys(value)) {
    checkDate(date);
    if (!isMap(value[date])) throw new Error('旧版当天记录数据损坏');
    for (const id of Object.keys(value[date])) {
      if (!validId(id) || !['todo', 'done'].includes(value[date][id])) throw new Error('旧版任务记录格式无效');
    }
  }
}
