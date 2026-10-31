/** Local-calendar helpers. Never use toISOString().slice(0,10) for a local date. */
function pad(value) { return String(value).padStart(2, '0'); }
function localDateKey(date) {
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
}
function parseLocalDate(key) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) throw new Error('Invalid date key');
  const parts = key.split('-').map(Number);
  const result = new Date(parts[0], parts[1] - 1, parts[2], 12, 0, 0, 0);
  if (localDateKey(result) !== key) throw new Error('Invalid calendar date');
  return result;
}
function shiftDays(key, amount) {
  const date = parseLocalDate(key);
  date.setDate(date.getDate() + amount);
  return localDateKey(date);
}
function mondayOf(key) {
  const date = parseLocalDate(key);
  const delta = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - delta);
  return localDateKey(date);
}
function weekDays(key) {
  const monday = mondayOf(key);
  const labels = ['一','二','三','四','五','六','日'];
  return labels.map((label, index) => {
    const date = shiftDays(monday, index);
    return { date, label, day: Number(date.slice(8)), month: Number(date.slice(5,7)) };
  });
}
function minutesOf(time) {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('Invalid HH:mm');
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}
function minuteOfDate(date) { return date.getHours() * 60 + date.getMinutes(); }
function timeState(start, end, nowMinute) {
  return nowMinute < minutesOf(start) ? 'upcoming' : nowMinute >= minutesOf(end) ? 'past' : 'current';
}
module.exports = { localDateKey, parseLocalDate, shiftDays, mondayOf, weekDays, minutesOf, minuteOfDate, timeState };
