Page({
  data: { version: '0.1.0 · M1', storage: '仅本机微信存储' },
  onClearRecords() {
    wx.showModal({
      title: '清除本地打卡记录？',
      content: '这会删除本机已保存的完成状态，且无法恢复。示例计划本身不会删除。',
      confirmText: '确认清除',
      confirmColor: '#C25B56',
      success: (result) => {
        if (!result.confirm) return;
        try {
          wx.removeStorageSync('dayflow.records.v1');
          wx.removeStorageSync('dayflow.review.v1');
          wx.showToast({ title: '已清除', icon: 'success' });
        } catch (_err) {
          wx.showToast({ title: '清除失败', icon: 'none' });
        }
      }
    });
  }
});
