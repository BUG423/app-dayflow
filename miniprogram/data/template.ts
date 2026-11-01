/** Public, adjustable example only. Reserved exercise time is not a medical prescription. */
import { minutesOf, parseLocalDate } from '../utils/calendar';
import { getLegacyBlocksForDate, PlanAction, PlanBlock } from './legacy-template';
export { PlanAction, PlanBlock, BlockKind, getWeekdayName, DEMO_NOTICE } from './legacy-template';

const clock = (minute: number) => String(Math.floor(minute / 60)).padStart(2, '0') + ':' + String(minute % 60).padStart(2, '0');

/** A 90-minute reservation keeps the former exercise dose and adds flexible preparation/rest. */
function exerciseBlock(date: string, swimming: boolean): PlanBlock {
  const day = parseLocalDate(date).getDay();
  const original = getLegacyBlocksForDate(date, 1).find(block => block.id === 'training')!;
  const start = swimming ? '17:30' : '20:30', end = swimming ? '19:00' : '22:00';
  const begin = minutesOf(start), offset = begin + 15 - minutesOf(original.start);
  const actions: PlanAction[] = [
    { id: 'd' + day + '-prepare', title: swimming ? '更衣与活动准备' : '训练准备与自主休息', start, end: clock(begin + 15),
      dosage: '预留十五分钟，可自主调整', description: '留出准备、更衣或休息时间；可以提前结束，不需要额外增加运动量。',
      safety: '根据当天状态调整，不适时停止。' },
    ...original.actions.map(action => ({ ...action, start: clock(minutesOf(action.start) + offset), end: clock(minutesOf(action.end) + offset) })),
    { id: 'd' + day + '-record', title: swimming ? '更衣、放松与记录' : '放松、休息与记录', start: clock(begin + 75), end,
      dosage: '预留十五分钟，可自主调整', description: '按需要休息、更衣和记录感受，不要求继续运动。',
      safety: '不适无需坚持，可停止并咨询专业人员。' }
  ];
  return { ...original, start, end, actions };
}

/** v3 remains reproducible; v4 adds work after swimming without changing recorded days. */
export function getBlocksForDate(dateKey: string, version: 3 | 4 = 4): PlanBlock[] {
  const day = parseLocalDate(dateKey).getDay(), swimming = [2, 4, 6].includes(day);
  const daytime = getLegacyBlocksForDate(dateKey, 1).filter(block => !['training', 'sleep'].includes(block.id));
  const evening: PlanBlock[] = swimming
    ? [{ id: 'swim-commute', title: '下班直接去游泳', start: '17:00', end: '17:30', kind: 'fixed', category: '生活', actions: [] },
       ...(version === 4 ? [
         { id: 'swim-return-work', title: '游泳后返回工作地点', start: '19:00', end: '19:30', kind: 'fixed' as const, category: '生活', actions: [] },
         { id: 'overtime', title: '加班', start: '19:30', end: '21:30', kind: 'fixed' as const, category: '加班', actions: [] },
         { id: 'commute-home', title: '加班后回家', start: '21:30', end: '22:00', kind: 'fixed' as const, category: '生活', actions: [] }
       ] : [])]
    : [{ id: 'overtime', title: '加班', start: '17:00', end: '20:00', kind: 'fixed', category: '加班', actions: [] },
       { id: 'commute-home', title: '加班后回家', start: '20:00', end: '20:30', kind: 'fixed', category: '生活', actions: [] }];
  return [
    { id: 'sleep-morning', title: '继续睡觉，08:00起床', start: '00:00', end: '08:00', kind: 'fixed', category: '生活', actions: [] },
    ...daytime, ...evening, exerciseBlock(dateKey, swimming),
    { id: 'wind-down', title: '洗漱与睡前准备', start: '22:00', end: '23:00', kind: 'fixed', category: '生活', actions: [] },
    { id: 'sleep', title: '睡觉，明早08:00起床', start: '23:00', end: '24:00', kind: 'fixed', category: '生活', actions: [] }
  ].sort((left, right) => left.start.localeCompare(right.start)) as PlanBlock[];
}
