// In-memory transfer only: storage is untouched until the verified final call.
// The original acceptance restore remains the sole storage writer/validator.
const { restore } = require('./acceptance-fixtures');
const SLOT = '__dayflowAcceptanceRestoreTransportV1';
const MAX_CHUNK = 8192;
function fnv(text) { let hash = 2166136261; for (let i = 0; i < text.length; i++) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 16777619); } return (hash >>> 0).toString(16).padStart(8, '0'); }
function begin(meta) {
  if (!meta || typeof meta.nonce !== 'string' || !/^[a-f0-9]{32}$/.test(meta.nonce) || !Number.isInteger(meta.total) || meta.total < 1 || meta.total > 4096 || !Number.isInteger(meta.chars) || meta.chars < 1 || meta.chars > 33554432 || !/^[a-f0-9]{8}$/.test(meta.hash)) throw new Error('Invalid restore transfer metadata');
  var app = getApp(), key = '__dayflowAcceptanceRestoreTransportV1';
  if (Object.prototype.hasOwnProperty.call(app, key)) throw new Error('Restore transfer slot is occupied');
  app[key] = { marker: 1, nonce: meta.nonce, total: meta.total, chars: meta.chars, hash: meta.hash, parts: [], receivedChars: 0 };
  return { dayflowSmoke: true, begun: true, total: meta.total, chars: meta.chars };
}
function part(packet) {
  var app = getApp(), key = '__dayflowAcceptanceRestoreTransportV1', state = app[key];
  if (!packet || !state || state.marker !== 1 || state.nonce !== packet.nonce || packet.total !== state.total || !Number.isInteger(packet.index) || packet.index !== state.parts.length || packet.index >= state.total || typeof packet.text !== 'string' || packet.text.length < 1 || packet.text.length > 8192 || packet.chars !== packet.text.length || state.receivedChars + packet.text.length > state.chars || !/^[a-f0-9]{8}$/.test(packet.hash)) throw new Error('Invalid restore transfer chunk');
  var hash = 2166136261; for (var i = 0; i < packet.text.length; i++) { hash ^= packet.text.charCodeAt(i); hash = Math.imul(hash, 16777619); }
  if ((hash >>> 0).toString(16).padStart(8, '0') !== packet.hash) throw new Error('Restore chunk checksum mismatch');
  state.parts.push(packet.text); state.receivedChars += packet.text.length;
  return { dayflowSmoke: true, index: packet.index, received: state.parts.length, chars: packet.text.length };
}
function finish(nonce) {
  var app = getApp(), key = '__dayflowAcceptanceRestoreTransportV1', state = app[key];
  if (!state || state.marker !== 1 || state.nonce !== nonce) throw new Error('Restore transfer nonce mismatch');
  try {
    if (state.parts.length !== state.total || state.receivedChars !== state.chars) throw new Error('Restore transfer is incomplete');
    var text = state.parts.join('');
    if (text.length !== state.chars) throw new Error('Restore transfer length mismatch');
    var hash = 2166136261; for (var i = 0; i < text.length; i++) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 16777619); }
    if ((hash >>> 0).toString(16).padStart(8, '0') !== state.hash) throw new Error('Restore transfer checksum mismatch');
    var snapshot; try { snapshot = JSON.parse(text); } catch (_error) { throw new Error('Restore transfer JSON is invalid'); }
    return ORIGINAL_RESTORE(snapshot);
  } finally { if (app[key] === state) delete app[key]; }
}
function abort(nonce) {
  var app = getApp(), key = '__dayflowAcceptanceRestoreTransportV1';
  if (!Object.prototype.hasOwnProperty.call(app, key)) return { dayflowSmoke: true, aborted: true, absent: true };
  var state = app[key];
  if (!state || state.marker !== 1 || state.nonce !== nonce) throw new Error('Cannot remove another restore transfer');
  delete app[key]; return { dayflowSmoke: true, aborted: true, absent: false };
}
function sources() {
  return { begin: begin.toString(), part: part.toString(), finish: finish.toString().replace('ORIGINAL_RESTORE', '(' + restore.toString() + ')'), abort: abort.toString(), maxChunk: MAX_CHUNK };
}
module.exports = { sources, fnv, SLOT, MAX_CHUNK };
if (require.main === module) process.stdout.write(JSON.stringify(sources()));
