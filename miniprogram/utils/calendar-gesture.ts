/** Calendar gestures use one pointer only and never turn a vertical scroll into a week change. */
export interface CalendarTouch { identifier?: number; clientX?: number; clientY?: number; pageX?: number; pageY?: number; }
export interface CalendarGesture { identifier: number; x: number; y: number; at: number; }
function point(touch: CalendarTouch | undefined) {
  if (!touch) return null;
  const x = typeof touch.clientX === 'number' ? touch.clientX : touch.pageX;
  const y = typeof touch.clientY === 'number' ? touch.clientY : touch.pageY;
  const identifier = touch.identifier === undefined ? 0 : touch.identifier;
  return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(identifier) ? { x: x as number, y: y as number, identifier } : null;
}
export function beginCalendarGesture(touches: CalendarTouch[], at: number): CalendarGesture | null {
  if (!Array.isArray(touches) || touches.length !== 1 || !Number.isFinite(at)) return null;
  const start = point(touches[0]);
  return start ? { ...start, at } : null;
}
export function calendarGestureCancelled(start: CalendarGesture | null, touches: CalendarTouch[]): boolean {
  if (!start || !Array.isArray(touches) || touches.length !== 1) return true;
  const current = point(touches[0]);
  if (!current || current.identifier !== start.identifier) return true;
  const dx = Math.abs(current.x - start.x), dy = Math.abs(current.y - start.y);
  return dy >= 32 && dy > dx;
}
/** Returns local calendar days: swipe left shows the next week; swipe right the previous week. */
export function calendarSwipeDays(start: CalendarGesture | null, changedTouches: CalendarTouch[], at: number): number {
  if (!start || !Array.isArray(changedTouches) || changedTouches.length !== 1 || !Number.isFinite(at)) return 0;
  const end = point(changedTouches[0]);
  if (!end || end.identifier !== start.identifier) return 0;
  const dx = end.x - start.x, dy = Math.abs(end.y - start.y), duration = at - start.at;
  // Pointer delivery may batch a fast pen/mouse/touch trajectory into one clock tick.
  // Intent comes from distance and direction, rather than a minimum assumed human speed.
  if (duration < 0 || duration > 1200 || Math.abs(dx) < 44 || dy > 28 || Math.abs(dx) < dy * 1.5) return 0;
  return dx < 0 ? 7 : -7;
}
