// Synthetic acceptance data, built through the actual local template service.
// No real account, photos, cloud environment or personal records are read.
const { createRuntime, clone } = require('../tests/helpers/miniprogram');
const { wizardPayload, seedWizard } = require('./wizard-acceptance-fixtures');

function sunshinePayload(date, at, scenario = 'sunshine') {
  const base = wizardPayload(date, at);
  if (!['sunshine', 'empty', 'custom'].includes(scenario)) throw new Error('Invalid sunshine fixture scenario');
  const run = createRuntime(new Date(at));
  const plans = run.load('miniprogram/services/plans.ts');
  const calendar = run.load('miniprogram/utils/calendar');
  const template = scenario === 'custom' ? JSON.parse(plans.exportDefaultTemplate(2)) : clone(plans.getTemplate());
  template.id = 'sunshine-acceptance-template';
  template.name = '阳光节奏合成验收';
  template.updatedAt = at;
  if (scenario === 'empty') template.schedules = [];
  if (scenario === 'custom') {
    template.version = 4;
    template.name = '保留白天自定义的合成旧计划';
    template.schedules.forEach(rule => {
      const morning = rule.blocks.find(block => block.id === 'work-morning');
      if (morning) Object.assign(morning, { title: '自定义白天工作', start: '08:00', end: '12:00' });
    });
    template.schedules.push({ id: 'sunshine-custom-interest', title: '自选午间阅读', weekdays: [0,1,2,3,4,5,6], effectiveFrom: '2000-01-01', exceptions: [],
      blocks: [{ id: 'sunshine-custom-interest-block', title: '自选午间阅读', start: '12:40', end: '12:55', kind: 'parallel', category: '兴趣',
        tasks: [{ id: 'sunshine-custom-interest-task', title: '自选午间阅读', start: '12:40', end: '12:55', actions: [] }] }] });
  }
  const records = clone(base.values['dayflow.records.v2']);
  const instances = clone(base.values['dayflow.instances.v1']);
  if (scenario === 'sunshine' || scenario === 'custom') {
    const blocks = run.load('miniprogram/utils/plan-validation.ts').resolveBlocks(template, date);
    const target = blocks.flatMap(b => b.tasks).find(t => t.id === 'music-guitar');
    if (!target) throw new Error('Current template has no expected music target');
    records.byDate[date] = {
      [target.id]: { date, targetId: target.id, taskId: target.id, status: 'done',
        finishedAt: at - 60000, updatedAt: at - 60000,
        events: [{ id: 'sunshine-completed-event', from: 'todo', to: 'done', at: at - 60000 }] }
    };
    instances[date] = { date, templateId: template.id, templateVersion: template.version,
      blocks: clone(blocks), locked: true, mode: 'standard', createdAt: at - 120000 };
  }
  const weekday = calendar.parseLocalDate(date).getDay();
  const wednesdayDate = calendar.shiftDays(date, (3 - weekday + 7) % 7 || 7);
  const result = { ...base, scenario, date, wednesdayDate, thursdayDate: calendar.shiftDays(wednesdayDate, 1),
    values: { 'dayflow.plans.v1': template, 'dayflow.records.v2': records, 'dayflow.instances.v1': instances } };
  const valid = run.load('miniprogram/utils/plan-validation.ts').validatePlan(template);
  if (!valid.ok) throw new Error(valid.errors.join('; '));
  plans.validateInstances(instances);
  run.load('miniprogram/utils/record-validation.ts').validateEnvelope(records);
  return result;
}
module.exports = { sunshinePayload, seedWizard };
if (require.main === module) {
  const now = new Date(), date = process.argv[2] || [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
  process.stdout.write(JSON.stringify({ sunshine: sunshinePayload(date, Date.now()), empty: sunshinePayload(date, Date.now(), 'empty'), custom: sunshinePayload(date, Date.now(), 'custom'), seedWizard: seedWizard.toString() }));
}
