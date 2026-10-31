import { PlanTemplate, Schedule, TimeBlock } from '../types/domain';
import { blocksOnDate, representativeDates } from './schedule-occurrences';

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
function chronological<T extends { start: string; end: string }>(values: T[]): T[] {
  return values.map((value, index) => ({ value, index })).sort((a, b) =>
    String(a.value.start).localeCompare(String(b.value.start)) ||
    String(a.value.end).localeCompare(String(b.value.end)) || a.index - b.index).map(item => item.value);
}

/** Sort only the edited copy; task groups and every user field remain intact. */
export function sortScheduleTimes(input: Schedule): Schedule {
  const schedule = clone(input);
  function sortBlocks(blocks: TimeBlock[]) {
    blocks.forEach(block => {
      if (block.kind === 'sequence') {
        block.tasks.forEach(task => { task.actions = chronological(task.actions); });
        block.tasks = chronological(block.tasks);
      }
    });
    return chronological(blocks);
  }
  schedule.blocks = sortBlocks(schedule.blocks);
  schedule.exceptions.forEach(exception => { if (exception.blocks) exception.blocks = sortBlocks(exception.blocks); });
  schedule.exceptions.sort((a, b) => a.date.localeCompare(b.date));
  return schedule;
}

export interface IdentityChange { kind: 'block' | 'task' | 'action'; from: string; to: string; }
export interface PreparedSchedule { schedule: Schedule; changes: IdentityChange[]; }

/**
 * Legacy weekday rules intentionally reuse IDs on disjoint days. Expanding a
 * rule can make those IDs coincide. Fork only the edited node that actually
 * collides on an effective day, without mutating other rules or origin links.
 */
export function prepareScheduleIdentities(template: PlanTemplate, input: Schedule): PreparedSchedule {
  const schedule = sortScheduleTimes(input), changes: IdentityChange[] = [];
  const other = template.schedules.filter(item => item.id !== schedule.id);
  const allocated = new Set<string>();
  const paths = new Map<object, string>();
  function collect(rule: Schedule, edited: boolean) {
    function scan(blocks: TimeBlock[], prefix: string) {
      blocks.forEach((block, bi) => {
        allocated.add(block.id); if (edited) paths.set(block, prefix + '-b' + bi);
        block.tasks.forEach((task, ti) => {
          allocated.add(task.id); if (edited) paths.set(task, prefix + '-b' + bi + '-t' + ti);
          task.actions.forEach((action, ai) => { allocated.add(action.id); if (edited) paths.set(action, prefix + '-b' + bi + '-t' + ti + '-a' + ai); });
        });
      });
    }
    scan(rule.blocks, 'base'); rule.exceptions.forEach(exception => { if (exception.blocks) scan(exception.blocks, exception.date); });
  }
  template.schedules.forEach(rule => collect(rule, false)); collect(schedule, true);
  function fork(node: { id: string }, kind: IdentityChange['kind']) {
    const from = node.id, source = schedule.id + '|' + kind + '|' + paths.get(node) + '|' + from;
    let hash = 2166136261;
    for (let i = 0; i < source.length; i++) { hash ^= source.charCodeAt(i); hash = Math.imul(hash, 16777619); }
    const stem = 'df-' + kind + '-' + (hash >>> 0).toString(36); let id = stem, suffix = 0;
    while (allocated.has(id)) id = stem + '-' + (++suffix);
    allocated.add(id); node.id = id; changes.push({ kind, from, to: id });
  }
  for (const date of representativeDates(other.concat(schedule))) {
    const blockIds = new Set<string>(), taskIds = new Set<string>(), targets = new Set<string>();
    other.forEach(rule => blocksOnDate(rule, date).forEach(block => {
      blockIds.add(block.id); block.tasks.forEach(task => { taskIds.add(task.id); if (task.actions.length) task.actions.forEach(action => targets.add(action.id)); else targets.add(task.id); });
    }));
    blocksOnDate(schedule, date).forEach(block => {
      if (blockIds.has(block.id)) fork(block, 'block'); blockIds.add(block.id);
      block.tasks.forEach(task => {
        if (taskIds.has(task.id) || (!task.actions.length && targets.has(task.id))) fork(task, 'task');
        taskIds.add(task.id);
        if (task.actions.length) task.actions.forEach(action => { if (targets.has(action.id)) fork(action, 'action'); targets.add(action.id); });
        else targets.add(task.id);
      });
    });
  }
  return { schedule, changes };
}
