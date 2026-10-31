// Generated from shared pure validation sources. Rebuild with node cloudfunctions/dayflowSync/build-validation.js
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateInstances = validateInstances;
const calendar_1 = require("./calendar");
const plan_validation_1 = require("./plan-validation");
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
function assertDate(date) { try {
    (0, calendar_1.parseLocalDate)(date);
}
catch (_err) {
    throw new Error('日期无效，请重新选择');
} }
function validateInstances(value) {
    if (!object(value))
        throw new Error('日程快照数据损坏，请先导出并检查');
    for (const date of Object.keys(value)) {
        assertDate(date);
        const item = value[date];
        if (!object(item) || Object.keys(item).some(key => !['date', 'templateId', 'templateVersion', 'blocks', 'locked', 'mode', 'createdAt'].includes(key)) || item.date !== date || !Array.isArray(item.blocks) || typeof item.locked !== 'boolean' || !['standard', 'emergency'].includes(item.mode) || !Number.isInteger(item.templateVersion) || item.templateVersion < 1 || !Number.isFinite(item.createdAt) || item.createdAt < 0)
            throw new Error('日程快照数据损坏，请先导出并检查');
        const preview = (0, plan_validation_1.validatePlan)({ schemaVersion: 1, id: item.templateId, name: '日程快照', version: item.templateVersion, updatedAt: item.createdAt, schedules: [{ id: 'snapshot', title: '日程快照', weekdays: [(0, calendar_1.parseLocalDate)(date).getDay()], effectiveFrom: date, effectiveTo: date, exceptions: [], blocks: item.blocks }] });
        if (!preview.ok)
            throw new Error('日程快照数据损坏，请先导出并检查');
        if (item.mode === 'emergency') {
            const training = item.blocks.filter((block) => block.category === '训练' || block.id === 'training');
            if (training.length !== 1 || training[0].kind !== 'sequence' || (0, calendar_1.minutesOf)(training[0].end) - (0, calendar_1.minutesOf)(training[0].start) !== 15)
                throw new Error('简化方案快照无效，须保留十五分钟训练');
        }
    }
}
