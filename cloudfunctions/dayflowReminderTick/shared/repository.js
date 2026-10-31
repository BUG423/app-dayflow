module.exports = function createRepository(db) {
  return {
    async transact(id, update) {
      const result = await db.runTransaction(async transaction => {
        const doc = transaction.collection('dayflow_reminder_jobs').doc(id);
        const response = await doc.get();
        const current = Array.isArray(response.data) ? response.data[0] : response.data;
        const operation = await update(current || null);
        if (operation.document) await doc.set({ data: operation.document });
        return { operationResult: operation.result };
      });
      const envelope = result && result.result || result;
      return envelope.operationResult;
    },
    async findDue(now) {
      const response = await db.collection('dayflow_reminder_jobs').where({ nextDueAt: db.command.lte(now) }).orderBy('nextDueAt', 'asc').limit(20).get();
      return response.data.map(item => item._id);
    }
  };
};
