const cloud = require('wx-server-sdk');
const { createHandler } = require('./jobs');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const repository = require('./repository')(cloud.database({ throwOnNotFound: false }));
exports.main = async event => {
  try { return await createHandler(repository, require('./configuration')(process.env))(event, cloud.getWXContext()); }
  catch (_error) { return { ok: false, code: 'REMINDER_UNAVAILABLE' }; }
};
