const crypto = require('node:crypto');
const { validatePlan } = require('./shared/plan-validation');
const { validateEnvelope } = require('./shared/record-validation');
const { validatePreferences } = require('./shared/preferences-validation');
const { validateInstances } = require('./shared/instance-validation');
const { validatePhotos } = require('./shared/media-validation');
const { parseLocalDate } = require('./shared/calendar');
const MAX_BYTES = 900000;
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
function account(context) {
  if (!context || typeof context.OPENID !== 'string' || !context.OPENID || typeof context.APPID !== 'string' || !context.APPID) throw new Error('AUTH_REQUIRED');
  return crypto.createHash('sha256').update(context.APPID + ':' + context.OPENID).digest('hex');
}
function validateFileID(fileID, context, accountId) {
  if (context.privateStorageReady !== true) throw new Error('MEDIA_NOT_CONFIGURED');
  if (typeof context.environmentId !== 'string' || !context.environmentId) throw new Error('ENVIRONMENT_REQUIRED');
  if (typeof fileID !== 'string') throw new Error('INVALID_MEDIA');
  const match = /^cloud:\/\/([^/]+)\/(dayflow-photos\/[a-f0-9]{64}\/[A-Za-z0-9_-]{1,100}\.jpg)$/.exec(fileID);
  if (!match || !(match[1] === context.environmentId || match[1].startsWith(context.environmentId + '.')) ||
      !match[2].startsWith('dayflow-photos/' + accountId + '/')) throw new Error('MEDIA_OWNER_MISMATCH');
}
function validateTree(value, depth = 0) {
  if (depth > 30) throw new Error('PAYLOAD_TOO_DEEP');
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number') { if (!Number.isFinite(value)) throw new Error('INVALID_NUMBER'); return; }
  if (typeof value === 'string') { if (value.length > 10000) throw new Error('TEXT_TOO_LONG'); return; }
  if (Array.isArray(value)) { value.forEach(item => validateTree(item, depth + 1)); return; }
  if (!object(value)) throw new Error('INVALID_VALUE');
  Object.keys(value).forEach(key => {
    if (['__proto__', 'prototype', 'constructor', '$where'].includes(key)) throw new Error('INVALID_KEY');
    validateTree(value[key], depth + 1);
  });
}
function validDate(key) {
  try { parseLocalDate(key); return true; } catch (_err) { return false; }
}
function validatePayload(payload, context, accountId) {
  if (!object(payload) || payload.schemaVersion !== 1 || Object.keys(payload).some(key =>
    !['schemaVersion', 'plans', 'planVersions', 'instances', 'records', 'preferences', 'media'].includes(key))) throw new Error('INVALID_PAYLOAD');
  const json = JSON.stringify(payload);
  if (Buffer.byteLength(json, 'utf8') > MAX_BYTES) throw new Error('PAYLOAD_TOO_LARGE');
  validateTree(payload);
  if (!validatePlan(payload.plans).ok || !Array.isArray(payload.planVersions) || payload.planVersions.some(value => !validatePlan(value).ok)) throw new Error('INVALID_PLANS');
  try { validateInstances(payload.instances); } catch (_err) { throw new Error('INVALID_INSTANCES'); }
  try { validateEnvelope(payload.records); } catch (_err) { throw new Error('INVALID_RECORDS'); }
  try { validatePreferences(payload.preferences); } catch (_err) { throw new Error('INVALID_PREFERENCES'); }
  try { validatePhotos(payload.media); } catch (_err) { throw new Error('INVALID_MEDIA'); }
  payload.media.forEach(photo => {
    if (!object(photo) || Object.prototype.hasOwnProperty.call(photo, 'localPath') || !validDate(photo.dateKey) ||
        typeof photo.id !== 'string' || typeof photo.targetId !== 'string' || !Number.isFinite(photo.createdAt)) throw new Error('INVALID_MEDIA');
    validateFileID(photo.cloudFileID, context, accountId);
  });
}
function createHandler(repository) {
  return async (event, context) => {
    try {
      const accountId = account(context);
      if (!object(event)) throw new Error('INVALID_REQUEST');
      if (event.action === 'identity') return { ok: true, accountId, uploadPrefix: 'dayflow-photos/' + accountId + '/', mediaEnabled: context.privateStorageReady === true };
      if (event.action === 'validateMedia') {
        validateFileID(event.fileID, context, accountId);
        return { ok: true };
      }
      if (event.action !== 'push') throw new Error('INVALID_ACTION');
      if (!Number.isInteger(event.expectedVersion) || event.expectedVersion < 0) throw new Error('INVALID_VERSION');
      validatePayload(event.payload, context, accountId);
      return await repository.transact(accountId, async current => {
        if (current && current.owner !== context.OPENID) throw new Error('OWNER_MISMATCH');
        const version = current ? current.version : 0;
        if (version !== event.expectedVersion) return { write: false, result: { ok: true, conflict: true, version, payload: current.payload } };
        const document = { owner: context.OPENID, version: version + 1, payload: event.payload, updatedAt: Date.now() };
        return { write: true, document, result: { ok: true, version: document.version } };
      });
    } catch (error) {
      // No payloads, identifiers, filenames, or private record notes in logs/errors.
      const known = new Set(['AUTH_REQUIRED','INVALID_REQUEST','INVALID_ACTION','INVALID_VERSION','INVALID_PAYLOAD','PAYLOAD_TOO_LARGE','PAYLOAD_TOO_DEEP','INVALID_NUMBER','TEXT_TOO_LONG','INVALID_VALUE','INVALID_KEY','INVALID_PLANS','INVALID_INSTANCES','INVALID_RECORDS','INVALID_PREFERENCES','INVALID_MEDIA','MEDIA_NOT_CONFIGURED','MEDIA_OWNER_MISMATCH','ENVIRONMENT_REQUIRED','OWNER_MISMATCH']);
      return { ok: false, code: known.has(error.message) ? error.message : 'SYNC_UNAVAILABLE' };
    }
  };
}
module.exports = { createHandler, account, validateFileID, validatePayload };
