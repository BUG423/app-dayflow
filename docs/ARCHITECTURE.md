# Dayflow 架构约定

## 结构
1. Pages：小程序 UI 与事件处理（不直接写静态训练数据）。
2. Data：只读示例周模板，按星期数返回 TimeBlock。
3. Utils：纯日期、当前时间块、完成率逻辑，可在 Node 下单元测试。
4. Services：本地存储接口。未来实现 RemoteRecordsRepository 适配云端，无需重写页面。

## 核心约定
- 日期键：YYYY-MM-DD（设备本地）。
- 周一为一周开始；JS getDay(): 0 代表星期日。
- 开始时间包含、结束时间不包含，即 [start,end)。
- 并行事项：一个时间块，多个 actions；同一时间段可以重复。
- 顺序训练：一个时间块，多个带开始和结束的动作。
- 用户勾选只更新对应日期和 action.id；不把时间进度当完成进度。
- fixed 类型不计入完成率分子或分母。
- 空状态：完成率显示 0 / 0，不认为自动完成 100%。

## 未来数据模型
users, plan_templates, time_blocks, tasks, task_actions,
daily_instances, task_records, media_records, progression, reminder_settings。

## 安全
M1 records 存微信本地 storage。M3 迁移云端时按可信用户标识验证读写，
数据迁移应显式征得用户同意，敏感数据最小化，文件私有存储。

## M1 验证与页面生命周期

- 今日页仅在前台运行时钟，每秒检查本地日期/分钟，仅在分钟变化时刷新页面；返回前台立即刷新，隐藏和卸载时清理时钟。
- 跨午夜只让原先查看今天的页面跟随新日期，保留用户主动选择的其他日期。
- 模板和训练路由统一通过 `parseLocalDate` 校验日历日期，避免 JavaScript 日期自动进位。
- 显示层读取失败可降级为空视图；写入前必须独立成功读取有效记录。读取失败或数据损坏不能被当作空存储再写回，写入失败不能返回伪完成状态。
- `tests/helpers/miniprogram.js` 转译实际 TypeScript 模块，在隔离 VM 中提供微信 API、存储和可控时钟。它验证逻辑与生命周期，不验证微信编译器、WXML、原生组件或真实持久化介质。
- `scripts/wechat-smoke.ps1` 使用开发者工具自带的新版 `wechatide` 接口，无新增应用运行时依赖。模拟器证据与 Node 测试分开记录。

## 后续数据模型门禁（尚未实现）

当前 M1 将最小执行项统一放在 `PlanBlock.actions` 中，记录仅有 `todo/done`，不能视为完整的五概念模型。
M2/M3 实现时应区分：TimeBlock 容纳 Task，Task 包含可选的有序 Action，Schedule 描述本地重复规则与例外日期，DailyInstance 保存生效模板版本及当日快照，Record 保存目标实例 ID、状态变化、执行时间与反馈。
历史复盘和统计应读取快照及记录；计划编辑仅影响未来实例，禁止用新模板重算已有历史。固定占用块不生成完成率分母，中止和跳过不能算完成。
