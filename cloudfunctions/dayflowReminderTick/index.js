const cloud = require('wx-server-sdk');
const crypto = require('node:crypto');
const { runDueJobs, configuredTemplate } = require('./shared/jobs');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const repository = require('./shared/repository')(cloud.database({ throwOnNotFound: false }));
function validToken(event, secret) {
  if (typeof secret !== 'string' || !/^[a-f0-9]{64}$/.test(secret)) return false;
  let provided = event && event.timerToken;
  if (!provided && event && typeof event.Message === 'string') {
    try { provided = JSON.parse(event.Message).timerToken; } catch (_error) { return false; }
  }
  return typeof provided === 'string' && /^[a-f0-9]{64}$/.test(provided) &&
    crypto.timingSafeEqual(Buffer.from(provided, 'hex'), Buffer.from(secret, 'hex'));
}
function validPrivateTrigger(event, context) {
  const name = process.env.DAYFLOW_TIMER_TRIGGER_NAME;
  const source = process.env.DAYFLOW_TIMER_SOURCE;
  return typeof name === 'string' && /^dayflow_[a-f0-9]{32}$/.test(name) &&
    typeof source === 'string' && !!source && context && context.SOURCE === source &&
    !context.OPENID && event && event.Type === 'Timer' && event.TriggerName === name;
}
exports.main = async event => {
  // A client-provided Type or source is never authorization. Even with platform
  // client invocation denied, this entry requires selected server-only authorization.
  try {
    if (process.env.DAYFLOW_TIMER_READY !== 'true') return { ok: false, code: 'TIMER_FORBIDDEN' };
    const allowed = process.env.DAYFLOW_TIMER_AUTH_MODE === 'private-trigger'
      ? validPrivateTrigger(event, cloud.getWXContext())
      : process.env.DAYFLOW_TIMER_AUTH_MODE === 'token' && validToken(event, process.env.DAYFLOW_TIMER_TOKEN);
    if (!allowed) return { ok: false, code: 'TIMER_FORBIDDEN' };
    const configuration = require('./shared/configuration')(process.env);
    if (!configuration.enabled) return { ok: false, code: 'TIMER_UNCONFIGURED' };
    return await runDueJobs(repository, async job => {
      const template = configuredTemplate(configuration, job.kind);
      if (!template || template.id !== job.template.id || template.titleField !== job.template.titleField || template.timeField !== job.template.timeField) return { errCode: 40037 };
      return cloud.openapi.subscribeMessage.send({
        touser: job.openid, templateId: template.id, page: 'pages/today/index',
        miniprogramState: configuration.miniprogramState, lang: 'zh_CN',
        data: { [template.titleField]: { value: Array.from(job.title).slice(0, 20).join('') },
          [template.timeField]: { value: job.dateKey + ' ' + job.time } }
      });
    });
  } catch (_error) { return { ok: false, code: 'TIMER_UNAVAILABLE' }; }
};
