import { PlanTemplate, TimeBlock, ImportPreview } from '../types/domain';
import { parseLocalDate, minutesOf, shiftDays } from './calendar';

const object = (value: any) => value && typeof value === 'object' && !Array.isArray(value);
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const invalidId = /^(?:__proto__|prototype|constructor)$/;

export function validatePlan(input: any): ImportPreview {
  const errors: string[] = [];
  const warnings: string[] = [];
  const summary = { schedules: 0, blocks: 0, tasks: 0, actions: 0 };
  const error = (message: string) => { if (errors.length < 40) errors.push(message); };
  try { if (JSON.stringify(input).length > 262144) error('模板内容过大，请拆分后导入'); } catch (_err) { error('模板必须是可序列化的数据'); }
  if (errors.length) return { ok: false, errors, warnings, summary };
  function keys(value: any, allowed: string[], label: string) {
    if (!object(value)) { error(label + '必须是对象'); return false; }
    if (Object.keys(value).some(key => !allowed.includes(key))) error(label + '包含未支持的字段');
    return true;
  }
  function text(value: any, label: string, optional = false, max = 120) {
    if (optional && value === undefined) return;
    if (typeof value !== 'string' || (!optional && !value.trim()) || value.length > max) error(label + '不能为空且须在长度限制内');
  }
  function id(value: any, label: string) {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$/.test(value) || invalidId.test(value)) error(label + '标识无效');
  }
  function date(value: any, label: string, optional = false) {
    if (optional && value === undefined) return;
    try { parseLocalDate(value); } catch (_err) { error(label + '日期无效'); }
  }
  function times(value: any, label: string, parent?: any) {
    try {
      const start = minutesOf(value.start), end = minutesOf(value.end);
      if (start >= end) error(label + '结束时间必须晚于开始时间');
      if (parent && (start < minutesOf(parent.start) || end > minutesOf(parent.end))) error(label + '时间必须位于所属时间范围内');
    } catch (_err) { error(label + '时间须为有效的小时和分钟'); }
  }
  function blocks(values: any, label: string) {
    if (!Array.isArray(values) || values.length > 50) { error(label + '时间块列表无效或过多'); return; }
    summary.blocks += values.length;
    values.forEach((block: any, bi: number) => {
      const name = label + '第' + (bi + 1) + '个时间块';
      if (!keys(block, ['id','title','start','end','kind','category','tasks'], name)) return;
      id(block.id, name); text(block.title, name + '标题'); text(block.category, name + '分类'); times(block, name);
      if (!['fixed','parallel','sequence'].includes(block.kind)) error(name + '类型无效');
      if (!Array.isArray(block.tasks) || block.tasks.length > 100) { error(name + '任务列表无效或过多'); return; }
      if (block.kind === 'fixed' && block.tasks.length) error(name + '固定占用不能包含打卡任务');
      if (block.kind !== 'fixed' && !block.tasks.length) error(name + '至少需要一个任务');
      summary.tasks += block.tasks.length;
      let previousEnd = -1;
      block.tasks.forEach((task: any, ti: number) => {
        const taskName = name + '第' + (ti + 1) + '项任务';
        if (!keys(task, ['id','title','start','end','actions','origin','dosage','description','equipment','searchKeyword','safety'], taskName)) return;
        id(task.id, taskName); text(task.title, taskName + '标题'); times(task, taskName, block);
        ['dosage','equipment','searchKeyword'].forEach(field => text(task[field], taskName + '说明', true, 300));
        ['description','safety'].forEach(field => text(task[field], taskName + '说明', true, 2000));
        if (task.origin !== undefined) {
          if (keys(task.origin, ['date','targetId'], taskName + '来源')) { date(task.origin.date, taskName + '来源'); id(task.origin.targetId, taskName + '来源任务'); }
        }
        if (!Array.isArray(task.actions) || task.actions.length > 100) { error(taskName + '步骤列表无效或过多'); return; }
        summary.actions += task.actions.length;
        task.actions.forEach((action: any, ai: number) => {
          const actionName = taskName + '第' + (ai + 1) + '步';
          if (!keys(action, ['id','title','start','end','dosage','description','equipment','searchKeyword','safety'], actionName)) return;
          id(action.id, actionName); text(action.title, actionName + '名称'); times(action, actionName, task);
          ['dosage','equipment','searchKeyword'].forEach(field => text(action[field], actionName + '说明', true, 300));
          ['description','safety'].forEach(field => text(action[field], actionName + '说明', true, 2000));
          if (block.kind === 'sequence') {
            try { if (minutesOf(action.start) < previousEnd) error(name + '顺序动作不能重叠或倒序'); previousEnd = minutesOf(action.end); } catch (_err) {}
          }
        });
        if (block.kind === 'sequence' && !task.actions.length) {
          try { if (minutesOf(task.start) < previousEnd) error(name + '顺序任务不能重叠或倒序'); previousEnd = minutesOf(task.end); } catch (_err) {}
        }
      });
    });
  }
  if (!keys(input, ['schemaVersion','id','name','version','schedules','updatedAt'], '模板')) return { ok: false, errors, warnings, summary };
  if (input.schemaVersion !== 1) error('不支持的模板格式版本');
  id(input.id, '模板'); text(input.name, '模板名称');
  if (!Number.isInteger(input.version) || input.version < 1) error('模板版本须为正整数');
  if (typeof input.updatedAt !== 'number' || !Number.isFinite(input.updatedAt) || input.updatedAt < 0) error('模板更新时间无效');
  if (!Array.isArray(input.schedules) || input.schedules.length > 100) error('日程规则列表无效或超过一百条');
  else {
    summary.schedules = input.schedules.length;
    const scheduleIds = new Set();
    input.schedules.forEach((schedule: any, si: number) => {
      const label = '第' + (si + 1) + '条规则';
      if (!keys(schedule, ['id','title','weekdays','effectiveFrom','effectiveTo','exceptions','blocks'], label)) return;
      id(schedule.id, label); text(schedule.title, label + '名称');
      if (scheduleIds.has(schedule.id)) error('日程规则标识不能重复'); scheduleIds.add(schedule.id);
      if (!Array.isArray(schedule.weekdays) || schedule.weekdays.some((d: any) => !Number.isInteger(d) || d < 0 || d > 6) || new Set(schedule.weekdays).size !== schedule.weekdays.length) error(label + '重复星期无效');
      date(schedule.effectiveFrom, label + '开始'); date(schedule.effectiveTo, label + '结束', true);
      if (schedule.effectiveTo && schedule.effectiveTo < schedule.effectiveFrom) error(label + '生效结束日期不能早于开始日期');
      blocks(schedule.blocks, label);
      if (!Array.isArray(schedule.exceptions) || schedule.exceptions.length > 200) error(label + '例外日期列表无效或过多');
      else {
        const exceptionDates = new Set();
        schedule.exceptions.forEach((exception: any) => {
          if (!keys(exception, ['date','kind','blocks'], label + '例外')) return;
          date(exception.date, label + '例外');
          if (exceptionDates.has(exception.date)) error(label + '例外日期不能重复'); exceptionDates.add(exception.date);
          if (!['skip','replace'].includes(exception.kind)) error(label + '例外类型无效');
          if (exception.kind === 'replace') blocks(exception.blocks, label + '例外');
          else if (exception.blocks !== undefined) error(label + '跳过例外不能包含替换时间块');
          if (exception.date < schedule.effectiveFrom || (schedule.effectiveTo && exception.date > schedule.effectiveTo)) error(label + '例外日期不在生效范围内');
        });
      }
    });
    if (!errors.length) {
      const candidates = new Set<string>();
      const schedules = input.schedules;
      schedules.forEach((s: any) => { for (let i = 0; i < 7; i++) { try { const key = shiftDays(s.effectiveFrom, i); parseLocalDate(key); if (!s.effectiveTo || key <= s.effectiveTo) candidates.add(key); } catch (_err) { break; } } s.exceptions.forEach((e: any) => candidates.add(e.date)); });
      for (let i = 0; i < schedules.length; i++) for (let j = i + 1; j < schedules.length; j++) {
        const from = schedules[i].effectiveFrom > schedules[j].effectiveFrom ? schedules[i].effectiveFrom : schedules[j].effectiveFrom;
        const until = [schedules[i].effectiveTo, schedules[j].effectiveTo].filter(Boolean).sort()[0];
        if (until && until < from) continue;
        const common = schedules[i].weekdays.filter((day: number) => schedules[j].weekdays.includes(day));
        const exceptional = new Set([...schedules[i].exceptions, ...schedules[j].exceptions].map((e: any) => e.date));
        common.forEach((day: number) => {
          const delta = (day - parseLocalDate(from).getDay() + 7) % 7;
          // One ordinary occurrence per weekday represents the repeating pair;
          // every exceptional date is validated separately above.
          for (let week = 0; week <= exceptional.size; week++) {
            try { const key = shiftDays(from, delta + week * 7); parseLocalDate(key); if (until && key > until) break; if (!exceptional.has(key)) { candidates.add(key); break; } } catch (_err) { break; }
          }
        });
      }
      for (const key of candidates) {
        const effective = resolveBlocks(input as PlanTemplate, key);
        const blockIds = new Set(), taskIds = new Set(), targets = new Set();
        effective.forEach(block => {
          if (blockIds.has(block.id)) error('同一天的时间块标识不能重复'); blockIds.add(block.id);
          block.tasks.forEach(task => {
            if (taskIds.has(task.id)) error('同一天的任务标识不能重复'); taskIds.add(task.id);
            const ids = task.actions.length ? task.actions.map(a => a.id) : [task.id];
            ids.forEach(target => { if (targets.has(target)) error('同一天的执行目标标识不能重复'); targets.add(target); });
          });
        });
        if (errors.length) break;
      }
    }
  }
  if (!errors.length) warnings.push('导入将保存为当前计划的新版本；既有执行记录使用原日程快照。训练内容须由使用者自行审核。');
  return { ok: !errors.length, ...(errors.length ? {} : { template: clone(input) as PlanTemplate }), errors, warnings, summary };
}

export function resolveBlocks(template: PlanTemplate, date: string): TimeBlock[] {
  const weekday = parseLocalDate(date).getDay();
  const values: TimeBlock[] = [];
  template.schedules.forEach(schedule => {
    if (date < schedule.effectiveFrom || (schedule.effectiveTo && date > schedule.effectiveTo)) return;
    const exception = schedule.exceptions.find(e => e.date === date);
    if (exception) { if (exception.kind === 'replace') values.push(...exception.blocks); return; }
    if (schedule.weekdays.includes(weekday)) values.push(...schedule.blocks);
  });
  return clone(values).sort((a, b) => a.start.localeCompare(b.start));
}
