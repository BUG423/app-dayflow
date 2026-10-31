// Generated from shared pure validation sources. Rebuild with node cloudfunctions/dayflowSync/build-validation.js
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validatePhotos = validatePhotos;
const calendar_1 = require("./calendar");
function validatePhotos(raw) {
    if (!Array.isArray(raw) || raw.length > 2000)
        throw new Error('照片记录无法读取，原数据已保留');
    const ids = new Set();
    raw.forEach(photo => {
        if (!photo || typeof photo.id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(photo.id) || ids.has(photo.id) ||
            typeof photo.dateKey !== 'string' || typeof photo.targetId !== 'string' || !photo.targetId || photo.targetId.length > 160 ||
            !Number.isInteger(photo.createdAt) || photo.createdAt < 0 ||
            (photo.localPath !== undefined && (typeof photo.localPath !== 'string' || !photo.localPath || photo.localPath.length > 1024 || photo.localPath.indexOf('\0') >= 0)) ||
            (photo.cloudFileID !== undefined && (typeof photo.cloudFileID !== 'string' || !/^cloud:\/\/[^/]+\/[^\s]+$/.test(photo.cloudFileID))) ||
            (!photo.localPath && !photo.cloudFileID))
            throw new Error('照片记录无法读取，原数据已保留');
        try {
            (0, calendar_1.parseLocalDate)(photo.dateKey);
        }
        catch (_err) {
            throw new Error('照片日期无法读取，原数据已保留');
        }
        ids.add(photo.id);
    });
}
