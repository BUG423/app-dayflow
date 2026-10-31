import { getBlocksForDate, DEMO_NOTICE, PlanBlock } from '../../data/template';
import { forDate, toggleDone } from '../../services/records';
import { progress } from '../../utils/progress';
import { localDateKey } from '../../utils/calendar';

Page({
  data: {
    dateKey: '',
    title: '训练详情',
    time: '',
    actions: [] as any[],
    progressText: '0 / 0',
    percent: 0,
    safety: DEMO_NOTICE
  },
  onLoad(options: any) {
    const dateKey = String(options.date || localDateKey(new Date()));
    const blockId = String(options.blockId || 'training');
    this.setData({ dateKey, blockId });
    this.loadBlock();
  },
  onShow() {
    if (this.data.dateKey) this.loadBlock();
  },
  loadBlock() {
    const blocks = getBlocksForDate(this.data.dateKey);
    const block = blocks.find((item: PlanBlock) => item.id === this.data.blockId && item.kind === 'sequence');
    if (!block) {
      wx.showToast({ title: '未找到该训练计划', icon: 'none' });
      return;
    }
    const records = forDate(this.data.dateKey);
    const total = progress([block], records);
    this.setData({
      title: block.title,
      time: block.start + '–' + block.end,
      actions: block.actions.map(action => ({ ...action, done: records[action.id] === 'done' })),
      progressText: total.completed + ' / ' + total.total,
      percent: total.percent
    });
  },
  onToggleAction(e: any) {
    toggleDone(this.data.dateKey, String(e.currentTarget.dataset.id));
    this.loadBlock();
  },
  onCopyKeyword(e: any) {
    const keyword = String(e.currentTarget.dataset.keyword || '');
    if (keyword) wx.setClipboardData({ data: keyword });
  },
  onStop() {
    wx.showModal({
      title: '结束本次查看',
      content: '可以随时停止或跳过动作。未勾选的动作不会自动记为完成。',
      confirmText: '返回日程',
      success: (res) => { if (res.confirm) wx.navigateBack(); }
    });
  }
});
