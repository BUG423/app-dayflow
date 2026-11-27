import { initializeRuntimeSettings } from './config/runtime';
import { hasPendingLocalBackupRecovery } from './services/local-backup-guard';

function showRecoveryIfNeeded(): void {
  if (!hasPendingLocalBackupRecovery()) return;
  const pages = getCurrentPages();
  if (!pages.length || pages[pages.length - 1].route === 'pages/profile/index') return;
  wx.switchTab({ url: '/pages/profile/index' });
}

App({
  onLaunch() {
    try { initializeRuntimeSettings(); }
    catch (_err) { wx.showToast({ title: '部分设置暂时无法读取，本机记录仍保留', icon: 'none' }); }
  },
  onShow() {
    if (!hasPendingLocalBackupRecovery()) return;
    if (getCurrentPages().length) showRecoveryIfNeeded();
    else setTimeout(showRecoveryIfNeeded, 150); // One bounded startup check; never a retry loop.
  },
  globalData: {
    appName: '日程流'
  }
});
