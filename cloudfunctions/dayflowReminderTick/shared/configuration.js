// Deployment configuration is server-only. No real template IDs are in Git.
module.exports = function configuration(env = process.env) {
  let templates = {};
  try { templates = JSON.parse(env.DAYFLOW_REMINDER_TEMPLATES || '{}'); } catch (_error) { /* disabled */ }
  const authReady = env.DAYFLOW_TIMER_AUTH_MODE === 'token' && /^[a-f0-9]{64}$/.test(env.DAYFLOW_TIMER_TOKEN || '') ||
    env.DAYFLOW_TIMER_AUTH_MODE === 'private-trigger' && /^dayflow_[a-f0-9]{32}$/.test(env.DAYFLOW_TIMER_TRIGGER_NAME || '') && !!env.DAYFLOW_TIMER_SOURCE;
  return { enabled: env.DAYFLOW_REMINDERS_READY === 'true' && env.DAYFLOW_TIMER_READY === 'true' && !!authReady, templates, miniprogramState: env.DAYFLOW_MESSAGE_STATE || 'developer' };
};
