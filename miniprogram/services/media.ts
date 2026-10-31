import { parseLocalDate } from '../utils/calendar';
import { getDayBlocks, lockDailyInstance } from './plans';

export interface PhotoRecord {
  id: string; dateKey: string; targetId: string; localPath?: string; createdAt: number; cloudFileID?: string;
}
const KEY = 'dayflow.media.v1';
const MAX_PHOTOS = 100;
export function validatePhotos(raw: any): void {
  if (!Array.isArray(raw) || raw.length > 2000) throw new Error('照片记录无法读取，原数据已保留');
  const ids = new Set<string>();
  raw.forEach(photo => {
    if (!photo || typeof photo.id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(photo.id) || ids.has(photo.id) ||
        typeof photo.dateKey !== 'string' || typeof photo.targetId !== 'string' || !photo.targetId || photo.targetId.length > 160 ||
        !Number.isInteger(photo.createdAt) || photo.createdAt < 0 ||
        (photo.localPath !== undefined && (typeof photo.localPath !== 'string' || !photo.localPath || photo.localPath.length > 1024 || photo.localPath.indexOf('\0') >= 0)) ||
        (photo.cloudFileID !== undefined && (typeof photo.cloudFileID !== 'string' || !/^cloud:\/\/[^/]+\/[^\s]+$/.test(photo.cloudFileID))) ||
        (!photo.localPath && !photo.cloudFileID)) throw new Error('照片记录无法读取，原数据已保留');
    try { parseLocalDate(photo.dateKey); } catch (_err) { throw new Error('照片日期无法读取，原数据已保留'); }
    ids.add(photo.id);
  });
}
function readPhotos(): PhotoRecord[] {
  const raw = wx.getStorageSync(KEY);
  if (raw === '' || raw === undefined || raw === null) return [];
  validatePhotos(raw);
  return JSON.parse(JSON.stringify(raw));
}
export function getPhotos(date?: string, targetId?: string): PhotoRecord[] {
  return readPhotos().filter(photo => (!date || photo.dateKey === date) && (!targetId || photo.targetId === targetId));
}
export async function chooseAndSavePhoto(dateKey: string, targetId: string): Promise<PhotoRecord> {
  parseLocalDate(dateKey);
  if (typeof targetId !== 'string' || !targetId || targetId.length > 160) throw new Error('请选择要记录的任务');
  const before = readPhotos();
  if (before.filter(photo => !!photo.localPath).length >= MAX_PHOTOS) throw new Error('本地照片已达一百张，请先整理已有照片');
  const hasTarget = () => getDayBlocks(dateKey).some(block => block.kind !== 'fixed' && block.actions.some(action => action.id === targetId));
  if (!hasTarget()) throw new Error('该任务不在当天日程中');
  if (typeof wx.chooseMedia !== 'function' || typeof wx.getFileSystemManager !== 'function') throw new Error('当前微信版本暂不支持照片记录');
  const files = wx.getFileSystemManager();
  if (typeof wx.requirePrivacyAuthorize === 'function') {
    await new Promise((resolve, reject) => wx.requirePrivacyAuthorize({
      success: resolve, fail: () => reject(new Error('未同意照片用途说明，未读取或保存任何照片'))
    }));
  }
  const selection: any = await new Promise((resolve, reject) => wx.chooseMedia({
    count: 1, mediaType: ['image'], sourceType: ['album', 'camera'],
    success: resolve,
    fail: () => reject(new Error('未选择照片，任务状态没有改变'))
  }));
  const file = selection.tempFiles && selection.tempFiles[0];
  if (!file || typeof file.tempFilePath !== 'string' || !file.tempFilePath ||
      (Number.isFinite(file.size) && file.size > 5 * 1024 * 1024)) throw new Error('请选择不超过五兆的图片');
  const saved: any = await new Promise((resolve, reject) => files.saveFile({
    tempFilePath: file.tempFilePath, success: resolve,
    fail: () => reject(new Error('照片未能保存，请检查本机空间后重试'))
  }));
  if (!saved || typeof saved.savedFilePath !== 'string' || !saved.savedFilePath || saved.savedFilePath === file.tempFilePath) {
    throw new Error('照片未取得持久保存路径，请重试');
  }
  try {
    // A photo is execution evidence even if the user has not checked completion.
    lockDailyInstance(dateKey);
    if (!hasTarget()) throw new Error('该任务已发生变化，请重新选择');
    const latest = readPhotos();
    if (latest.filter(photo => !!photo.localPath).length >= MAX_PHOTOS) throw new Error('本地照片已达一百张，请先整理已有照片');
    const photo: PhotoRecord = {
      id: 'photo-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10),
      dateKey, targetId, localPath: saved.savedFilePath, createdAt: Date.now()
    };
    wx.setStorageSync(KEY, [...latest, photo]);
    return { ...photo };
  } catch (_err) {
    // This is only the new app-owned saved copy, never the source album photo.
    await new Promise(resolve => files.removeSavedFile({ filePath: saved.savedFilePath, success: resolve, fail: resolve }));
    throw new Error('照片未能关联到任务，本次保存副本已尝试清理，请重试');
  }
}
export function removePhoto(id: string): void {
  const photos = readPhotos();
  if (!photos.some(photo => photo.id === id)) return;
  // Remove metadata first. Retained file bytes can be reclaimed through WeChat's
  // own storage management; never delete a cloud photo as a side effect.
  wx.setStorageSync(KEY, photos.filter(photo => photo.id !== id));
}
export function markPhotoUploaded(id: string, cloudFileID: string): PhotoRecord {
  if (!/^cloud:\/\//.test(cloudFileID)) throw new Error('上传结果无效，本地照片已保留');
  const photos = readPhotos();
  const photo = photos.find(item => item.id === id);
  if (!photo) throw new Error('未找到该照片记录');
  photo.cloudFileID = cloudFileID;
  wx.setStorageSync(KEY, photos);
  return { ...photo };
}
