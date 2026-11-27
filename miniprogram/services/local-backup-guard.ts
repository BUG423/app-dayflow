/** A small, read-only barrier; recovery transactions themselves use raw storage. */
export const LOCAL_BACKUP_POINT_KEY = 'dayflow.localBackup.restorePoint.v1';
const MESSAGE = '本机恢复尚未完成，请到“我的”继续恢复原内容';
const fields = ['schemaVersion', 'kind', 'state', 'filePath', 'fileName', 'nonce', 'createdAt', 'journalByteLength', 'journalChecksum'];
let epoch = 0;

function allowedToken(): string {
  try {
    const info = wx.getStorageInfoSync();
    if (!info || !Array.isArray(info.keys) || info.keys.some(key => typeof key !== 'string')) throw new Error(MESSAGE);
    const value = wx.getStorageSync(LOCAL_BACKUP_POINT_KEY);
    if (!info.keys.includes(LOCAL_BACKUP_POINT_KEY)) {
      if (value === '' || value === undefined) return '';
      throw new Error(MESSAGE);
    }
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.keys(value).length !== fields.length || Object.keys(value).some(key => !fields.includes(key)) ||
        value.schemaVersion !== 1 || value.kind !== 'dayflow-local-record-restore-manifest' ||
        !['writing', 'restored', 'recovery-required'].includes(value.state) ||
        typeof value.nonce !== 'string' || !/^[a-z0-9]+-[a-z0-9]{1,12}$/.test(value.nonce) ||
        typeof value.fileName !== 'string' || !/^dayflow-restore-\d{1,16}-[a-z0-9]+-[a-z0-9]{1,12}\.json$/.test(value.fileName) ||
        !value.fileName.endsWith('-' + value.nonce + '.json') ||
        typeof value.filePath !== 'string' || value.filePath.length > 2048 || value.filePath.indexOf('\0') >= 0 ||
        /(^|[\\/])\.\.([\\/]|$)/.test(value.filePath) || !value.filePath.endsWith('/' + value.fileName) ||
        !Number.isInteger(value.journalByteLength) || value.journalByteLength < 1 || value.journalByteLength > 24 * 1024 * 1024 ||
        typeof value.journalChecksum !== 'string' || !/^fnv1a32-utf16le:[a-f0-9]{8}$/.test(value.journalChecksum) ||
        !Number.isInteger(value.createdAt) || value.createdAt < 0 || !Number.isFinite(new Date(value.createdAt).getTime()) ||
        value.state !== 'restored') throw new Error(MESSAGE);
    return JSON.stringify(value);
  } catch (_error) { throw new Error(MESSAGE); }
}

/** Async operations retain this token so an older callback cannot cross a restore. */
export function getLocalBackupCheckpoint(): string { return epoch + ':' + allowedToken(); }

/** Call immediately before a restore/undo transaction, including retry recovery. */
export function advanceLocalBackupEpoch(): void { epoch += 1; }

/** Routing/UI may inspect the barrier without swallowing the need for recovery. */
export function hasPendingLocalBackupRecovery(): boolean {
  try { allowedToken(); return false; } catch (_error) { return true; }
}

export function assertNoPendingLocalBackup(expectedCheckpoint?: string): void {
  const current = getLocalBackupCheckpoint();
  if (expectedCheckpoint !== undefined && current !== expectedCheckpoint) {
    throw new Error('本机记录刚刚恢复，请重新进行此操作');
  }
}

export const assertLocalBackupWritable = assertNoPendingLocalBackup;
