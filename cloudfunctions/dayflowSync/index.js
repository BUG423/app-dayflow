const cloud = require('wx-server-sdk');
const { createHandler } = require('./handler');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database({ throwOnNotFound: false });
const handler = createHandler({
  transact: async (id, update) => {
    const result = await db.runTransaction(async transaction => {
      const reference = transaction.collection('dayflow_private_state').doc(id);
      const response = await reference.get();
      const current = Array.isArray(response.data) ? response.data[0] : response.data;
      const operation = await update(current || null);
      if (operation.write) await reference.set({ data: operation.document });
      return operation.result;
    });
    return result && result.result && result.result.ok === true ? result.result : result;
  }
});
exports.main = async event => {
  try {
    const identity = cloud.getWXContext();
    return await handler(event, {
      OPENID: identity.OPENID, APPID: identity.APPID,
      environmentId: process.env.TCB_ENV || identity.ENV || '',
      privateStorageReady: process.env.DAYFLOW_PRIVATE_STORAGE_READY === 'true'
    });
  } catch (_error) { return { ok: false, code: 'SYNC_UNAVAILABLE' }; }
};
