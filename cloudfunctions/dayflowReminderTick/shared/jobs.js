const crypto = require('node:crypto');
const DAY = 86400000;
const clone = value => JSON.parse(JSON.stringify(value));
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function assertDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('INVALID_DATE');
  const [y, m, d] = value.split('-').map(Number); const date = new Date(Date.UTC(y, m - 1, d));
  if (y < 2000 || y > 2099 || date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) throw new Error('INVALID_DATE');
}
function validateCandidate(value, now) {
  const keys = ['kind','targetDate','targetId','title','dateKey','time','dueAt','timezoneOffset'];
  if (!object(value) || Object.keys(value).some(key => !keys.includes(key)) || !['task','sleep'].includes(value.kind) ||
      typeof value.targetId !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(value.targetId) ||
      typeof value.title !== 'string' || !value.title.trim() || value.title.length > 80 || /[\u0000-\u001f]/.test(value.title) ||
      typeof value.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value.time) ||
      !Number.isInteger(value.dueAt) || value.dueAt <= now + 60000 || value.dueAt > now + 7 * DAY ||
      !Number.isInteger(value.timezoneOffset) || Math.abs(value.timezoneOffset) > 840) throw new Error('INVALID_CANDIDATE');
  assertDate(value.dateKey); assertDate(value.targetDate);
  const [year, month, day] = value.dateKey.split('-').map(Number); const [hour, minute] = value.time.split(':').map(Number);
  if (Date.UTC(year, month - 1, day, hour, minute) + value.timezoneOffset * 60000 !== value.dueAt) throw new Error('INVALID_LOCAL_TIME');
  const target = Date.parse(value.targetDate + 'T00:00:00Z'); const actual = Date.UTC(year, month - 1, day);
  if (target - actual < 0 || target - actual > DAY) throw new Error('INVALID_TARGET_DATE');
  return clone(value);
}
function configuredTemplate(config, kind) {
  const template = config && config.templates && config.templates[kind];
  if (!template || typeof template.id !== 'string' || !/^[A-Za-z0-9_-]{10,128}$/.test(template.id) ||
      !/^thing[1-9]\d*$/.test(template.titleField) || !/^time[1-9]\d*$/.test(template.timeField) ||
      !['developer','trial','formal'].includes(config.miniprogramState)) return null;
  return template;
}
function summary(job) {
  const { owner, openid, template, ...safe } = job;
  return clone(safe);
}
function nextDue(jobs) {
  const times = jobs.filter(job => job.status === 'pending').map(job => job.dueAt);
  return times.length ? Math.min(...times) : Number.MAX_SAFE_INTEGER;
}
function validAccount(current, accountId) {
  return !current || current.owner === accountId && Array.isArray(current.jobs) &&
    current.jobs.every(job => job && job.owner === accountId && typeof job.openid === 'string' && !!job.openid);
}
function createHandler(repository, config, clock = Date.now) {
  return async (event, context) => {
    try {
      if (!context || typeof context.OPENID !== 'string' || !context.OPENID || typeof context.APPID !== 'string' || !context.APPID) return { ok: false, code: 'IDENTITY_REQUIRED' };
      const accountId = hash(context.APPID + ':' + context.OPENID);
      if (!object(event)) return { ok: false, code: 'INVALID_REQUEST' };
      if (event.action === 'capability') {
        const template = configuredTemplate(config, event.kind);
        return { ok: true, accountId, available: !!template && config.enabled === true, templateId: template ? template.id : '' };
      }
      if (event.action === 'list') return await repository.transact(accountId, current => {
        if (!validAccount(current, accountId)) throw new Error('OWNER_MISMATCH');
        return { result: { ok: true, accountId, jobs: (current && current.jobs || []).map(summary) } };
      });
      if (event.action === 'register') {
        if (!config.enabled) return { ok: false, code: 'UNCONFIGURED' };
        const candidate = validateCandidate(event.candidate, clock());
        const template = configuredTemplate(config, candidate.kind);
        if (!template || event.templateId !== template.id || event.expectedAccountId !== accountId) return { ok: false, code: 'PREVIEW_CHANGED' };
        const id = hash([accountId, candidate.kind, candidate.targetDate, candidate.targetId, candidate.dueAt].join(':'));
        return await repository.transact(accountId, current => {
          if (!validAccount(current, accountId)) throw new Error('OWNER_MISMATCH');
          const jobs = current && current.jobs || [];
          const existing = jobs.find(job => job.id === id);
          // Registration is idempotent even after send/cancellation: no hidden second send.
          if (existing) return { result: { ok: true, accountId, job: summary(existing) } };
          if (jobs.length >= 500 || jobs.filter(job => job.status === 'pending' || job.status === 'sending').length >= 20) return { result: { ok: false, code: 'LIMIT_REACHED' } };
          const now = clock();
          const job = { ...candidate, id, owner: accountId, openid: context.OPENID, template: clone(template), status: 'pending', createdAt: now, updatedAt: now };
          const updated = [...jobs, job];
          return { document: { owner: accountId, jobs: updated, nextDueAt: nextDue(updated) }, result: { ok: true, accountId, job: summary(job) } };
        });
      }
      if (event.action === 'cancel') {
        if (typeof event.id !== 'string' || !/^[a-f0-9]{64}$/.test(event.id)) return { ok: false, code: 'INVALID_REQUEST' };
        return await repository.transact(accountId, current => {
          if (!validAccount(current, accountId)) throw new Error('OWNER_MISMATCH');
          const jobs = current && current.jobs || []; const job = jobs.find(item => item.id === event.id);
          if (!job) return { result: { ok: false, code: 'NOT_FOUND' } };
          if (job.status === 'pending') { job.status = 'cancelled'; job.updatedAt = clock(); }
          return { document: { owner: accountId, jobs, nextDueAt: nextDue(jobs) }, result: { ok: true, accountId, job: summary(job) } };
        });
      }
      return { ok: false, code: 'UNKNOWN_ACTION' };
    } catch (_error) { return { ok: false, code: 'REMINDER_UNAVAILABLE' }; }
  };
}
async function runDueJobs(repository, sender, now = Date.now()) {
  const accounts = await repository.findDue(now); let claimed = 0;
  for (const accountId of accounts) {
    // Bounded workload. A later tick handles the remaining pending jobs.
    for (let attempt = 0; attempt < 10; attempt++) {
      const job = await repository.transact(accountId, current => {
        if (!current || !validAccount(current, accountId)) return { result: null };
        const item = current.jobs.find(candidate => candidate.status === 'pending' && candidate.dueAt <= now);
        if (!item) return { result: null };
        item.status = now - item.dueAt > 10 * 60000 ? 'expired' : 'sending'; item.updatedAt = now;
        return { document: { ...current, nextDueAt: nextDue(current.jobs) }, result: clone(item) };
      });
      if (!job) break;
      if (job.status === 'expired') continue;
      claimed++;
      // sending is durable before the external side effect. Never reclaim it: a
      // crash or network timeout could have occurred after WeChat accepted send.
      let status = 'unknown';
      try {
        const response = await sender(job);
        if (response && (response.errCode === 0 || response.errcode === 0)) status = 'sent';
        else if (response && (Number.isInteger(response.errCode) || Number.isInteger(response.errcode))) status = 'failed';
      } catch (error) {
        // Only a positive provider business error establishes a definite failure.
        if (error && (Number.isInteger(error.errCode) && error.errCode > 0 || Number.isInteger(error.errcode) && error.errcode > 0)) status = 'failed';
      }
      await repository.transact(accountId, current => {
        if (!validAccount(current, accountId)) throw new Error('OWNER_MISMATCH');
        const item = current && current.jobs.find(candidate => candidate.id === job.id);
        if (!item || item.status !== 'sending') return { result: null };
        item.status = status; item.updatedAt = now;
        return { document: current, result: null };
      });
    }
  }
  return { ok: true, claimed };
}
module.exports = { createHandler, runDueJobs, configuredTemplate };
