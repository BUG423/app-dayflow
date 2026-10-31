// Generated from shared pure validation sources. Rebuild with node cloudfunctions/dayflowSync/build-validation.js
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validId = validId;
exports.checkDate = checkDate;
exports.checkStatus = checkStatus;
exports.checkFeedback = checkFeedback;
exports.validateEnvelope = validateEnvelope;
exports.validateLegacyRecords = validateLegacyRecords;
const calendar_1 = require("./calendar");
const STATUSES = ['todo', 'doing', 'done', 'skipped', 'deferred', 'aborted'];
const isMap = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const timestamp = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
function validId(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= 160 && !['__proto__', 'prototype', 'constructor'].includes(value);
}
function checkDate(date) { (0, calendar_1.parseLocalDate)(date); }
function checkStatus(value) {
    if (!STATUSES.includes(value))
        throw new Error('任务状态无效');
}
function checkFeedback(value) {
    if (!isMap(value) || Object.keys(value).some(key => !['effort', 'discomfort', 'note'].includes(key)))
        throw new Error('反馈格式无效');
    if (value.effort !== undefined && (!Number.isInteger(value.effort) || value.effort < 1 || value.effort > 5))
        throw new Error('请在一至五级中选择强度');
    if (value.discomfort !== undefined && typeof value.discomfort !== 'boolean')
        throw new Error('不适反馈格式无效');
    if (value.note !== undefined && (typeof value.note !== 'string' || value.note.length > 1000))
        throw new Error('反馈备注不能超过一千字');
}
function validateEnvelope(value) {
    if (!isMap(value) || value.schemaVersion !== 2 || !isMap(value.byDate))
        throw new Error('执行记录数据损坏，请先恢复备份');
    for (const date of Object.keys(value.byDate)) {
        checkDate(date);
        const entries = value.byDate[date];
        if (!isMap(entries))
            throw new Error('当天执行记录数据损坏');
        for (const id of Object.keys(entries)) {
            const item = entries[id];
            if (!validId(id) || !isMap(item) || item.date !== date || item.targetId !== id || !validId(item.taskId) ||
                (item.actionId !== undefined && !validId(item.actionId)) || !timestamp(item.updatedAt) || !Array.isArray(item.events))
                throw new Error('执行记录格式无效');
            checkStatus(item.status);
            if (item.actualStartedAt !== undefined && !timestamp(item.actualStartedAt))
                throw new Error('执行开始时间无效');
            if (item.finishedAt !== undefined && !timestamp(item.finishedAt))
                throw new Error('执行结束时间无效');
            if (item.deferredTo !== undefined) {
                checkDate(item.deferredTo);
                if (item.deferredTo <= date)
                    throw new Error('延期目标必须晚于原计划日期');
            }
            if (item.status === 'deferred' && !item.deferredTo)
                throw new Error('延期记录缺少目标日期');
            if (item.status !== 'deferred' && item.deferredTo !== undefined)
                throw new Error('非延期记录不能带延期目标');
            if (item.feedback !== undefined)
                checkFeedback(item.feedback);
            const eventIds = new Set();
            let previousState;
            for (const event of item.events) {
                if (!isMap(event) || !validId(event.id) || eventIds.has(event.id) || !timestamp(event.at) ||
                    (event.reason !== undefined && (typeof event.reason !== 'string' || event.reason.length > 200)))
                    throw new Error('执行事件格式无效');
                eventIds.add(event.id);
                checkStatus(event.from);
                checkStatus(event.to);
                if (previousState && previousState !== event.from)
                    throw new Error('执行事件状态链无效');
                previousState = event.to;
            }
            if (previousState && previousState !== item.status)
                throw new Error('执行事件与当前状态不一致');
        }
    }
}
function validateLegacyRecords(value) {
    if (!isMap(value))
        throw new Error('旧版执行记录数据损坏');
    for (const date of Object.keys(value)) {
        checkDate(date);
        if (!isMap(value[date]))
            throw new Error('旧版当天记录数据损坏');
        for (const id of Object.keys(value[date])) {
            if (!validId(id) || !['todo', 'done'].includes(value[date][id]))
                throw new Error('旧版任务记录格式无效');
        }
    }
}
