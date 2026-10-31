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
