// Generated from shared pure validation sources. Rebuild with node cloudfunctions/dayflowSync/build-validation.js
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validatePreferences = validatePreferences;
const calendar_1 = require("./calendar");
const defaults = {
    sleepReminderEnabled: false, sleepTime: '23:00', taskReminderEnabled: false,
    leadMinutes: 10, subscriptionTemplateIds: [], trainingPhase: '基础',
    phaseRules: [
        { id: 'basic', name: '基础', minSessions: 0, description: '选择熟悉且适合自己的示例动作，按状态调整。' },
        { id: 'steady', name: '巩固', minSessions: 6, description: '参考执行次数后自主选择，不代表医学上的进阶建议。' },
        { id: 'custom', name: '自主调整', minSessions: 12, description: '自行调整动作和时长，需要时请专业人员审核。' }
    ]
};
const copy = (value) => JSON.parse(JSON.stringify(value));
function invalid() { throw new Error('设置格式无效，请检查输入'); }
function validatePreferences(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        invalid();
    const allowed = Object.keys(defaults);
    if (Object.keys(value).some(key => allowed.indexOf(key) < 0))
        invalid();
    if (typeof value.sleepReminderEnabled !== 'boolean' || typeof value.taskReminderEnabled !== 'boolean')
        invalid();
    try {
        (0, calendar_1.minutesOf)(value.sleepTime);
    }
    catch (_err) {
        invalid();
    }
    if (!Number.isInteger(value.leadMinutes) || value.leadMinutes < 0 || value.leadMinutes > 120)
        invalid();
    if (!Array.isArray(value.subscriptionTemplateIds) || value.subscriptionTemplateIds.length > 3 ||
        value.subscriptionTemplateIds.some((id) => typeof id !== 'string' || (id !== '' && !/^[A-Za-z0-9_-]{10,128}$/.test(id))))
        invalid();
    if (!Array.isArray(value.phaseRules) || value.phaseRules.length < 1 || value.phaseRules.length > 6)
        invalid();
    const ids = new Set();
    const names = new Set();
    value.phaseRules.forEach((rule) => {
        if (!rule || typeof rule.id !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(rule.id) || ids.has(rule.id) ||
            typeof rule.name !== 'string' || !rule.name.trim() || rule.name.length > 24 || names.has(rule.name) ||
            !Number.isInteger(rule.minSessions) || rule.minSessions < 0 || rule.minSessions > 10000 ||
            typeof rule.description !== 'string' || rule.description.length > 240)
            invalid();
        ids.add(rule.id);
        names.add(rule.name);
    });
    if (['基础', '巩固', '自主调整'].indexOf(value.trainingPhase) < 0 || !names.has(value.trainingPhase))
        invalid();
    return copy(value);
}
