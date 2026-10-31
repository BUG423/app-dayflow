# Dayflow Agent 工作规范

## 原则
1. 先确认需求编号、数据模型及验收标准，避免直接修改所有页面。
2. 使用微信原生小程序、TypeScript、WXML、WXSS；不引入未经必要性审查的运行时框架。
3. 业务时间以用户设备本地时区呈现。日期键使用当地 YYYY-MM-DD，不得直接用 UTC ISO 截断。
4. 区分时间块（fixed / parallel / sequence）、执行任务及历史记录；固定占用块不计入任务完成率。
5. 不使用个人身份、病史、照片或私密 AppID/密钥作为公开演示数据。
6. 对动作训练仅呈现用户可选择的示例，禁止强制解锁、强制完成或推断医学安全。
7. 新增纯逻辑必须补测试；每次改动运行 npm run typecheck 和 npm test，并在 PR 写出未验证项目。
8. 严禁声称已经过安卓/iOS 真机或微信开发者工具测试，除非有实际日志。
9. 功能开发使用独立 feat/* 分支和 PR，不允许直接强推 main。

## 职责建议
- 架构：docs、数据模型、接口契约
- 体验：pages 下 WXML/WXSS、无障碍
- 日程引擎：utils/calendar、data/template
- 执行记录：services/records、任务状态
- QA：tests、CI、微信工具验证
