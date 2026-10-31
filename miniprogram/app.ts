import { initializeRuntimeSettings } from './config/runtime';

App({
  onLaunch() {
    try { initializeRuntimeSettings(); }
    catch (_err) { wx.showToast({ title: '部分设置暂时无法读取，本机记录仍保留', icon: 'none' }); }
  },
  globalData: {
    appName: '日程流'
  }
});
