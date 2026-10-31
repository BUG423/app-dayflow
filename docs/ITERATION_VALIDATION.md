# 本轮验收矩阵

基线：`fea3cff`。本轮由质量验证子智能体独占微信 CLI；业务源码由各模块负责人修改。真实结果在实际运行后补充，不能将下列预期列为通过。

| 需求 | 本轮验收方法 | 当前结果 |
| --- | --- | --- |
| UI-001/002 | 五页编译、页面文本中文检查、真实截图、长编辑器滚动及点击区域检查 | 待集成模拟器 |
| M2-EXEC-001/002 | 页面点击状态菜单、执行/完成/跳过/中止，核对事件和实际时间；Node 状态单测 | 待集成模拟器 |
| M2-DEFER-001 | 页面延期日期确认，再到计划页安排目标日；原日状态及历史保留 | 待集成模拟器 |
| M2-REVIEW-001 | 受控合成历史数据复盘、中止不自动完成剩余项 | 待集成模拟器 |
| M3-PLAN-001/002 | 真实原生表单输入、创建/编辑/删除；导入校验预览与确认；版本列表 | 待集成模拟器 |
| M3-HISTORY-001 | 页面计划修改后比较已执行日快照；Node 不可变/并发/错误测试 | 待集成模拟器 |
| M3-MEDIA-001/002 | 纯合成图片及受控选择 API，保存与取消/失败；不使用用户相册 | 待集成模拟器；真实选择器与真机持久化另列 |
| M3-SYNC-001 | 云服务只读环境检查；本地未配置降级；服务端隔离/冲突契约 | 待环境确认，不部署云资源 |
| M4-STAT-001 | 统计历史页、记录事件展开、连续执行与训练统计；Node 统计测试 | 待集成模拟器 |
| M4-TRAIN-001 | 未执行未来日期切换15分钟计划，再恢复；执行后禁止覆盖 | 待集成模拟器 |
| M4-TIMER-001 | 自选5秒计时、暂停/继续/重置/重新进入；到点不完成任务 | 待集成模拟器 |
| M4-PHASE-001 | 个人页阶段规则与训练页自主选择，无自动医学进阶 | 待集成模拟器 |
| M5-REMIND-001 | 偏好开关、无模板降级、受控时间注入；无后台送达声明 | 待集成模拟器 |
| M1 时间与错误边界 | 在模拟器同一次 try/finally 中临时注入 Date/存储错误，立即恢复；非法训练路由不写记录 | 待集成模拟器；现有 Node 回归保留 |
| Android/iOS 真机 | 只读检查已连接设备/官方能力，需扫码或本机安全授权不代替操作 | 尚未验证 |

## 数据保护

新流程必须备份当前全部 `dayflow.` 前缀 key，并覆盖契约可能新建的 key，逐项保留原值及存在性。测试只使用合成计划与合成照片；结束删除测试新建 key 并恢复原始存在性，再读回比较。备份、日志、截图仅放入忽略的 `artifacts/`，禁止提交或上传用户原始记录。

契约 key 覆盖：plans、planVersions、instances、records.v1/v2、review、preferences、remindersShown、reminderJobs、timer、media、sync、sync.queue、sync.conflicts、sync.restoreBackup、sync.previousBinding。实际发现的其他 `dayflow.` key 也必须原样恢复；测试中新建而原本不存在的前缀 key 会移除以恢复原始存在性。

## 环境检查记录

本轮首次子线程 node_repl 调用未返回，未启动 CLI；该调用被主协调者中断后确认无验收进程。后续如本机入口超过约20秒仍无响应，立即向协调者报告，由主交互线程代理执行同一 QA 脚本，避免重复排队。

2026-10-31 已由主交互线程使用普通本机入口代理执行 Environment：`artifacts/wechat-iteration/20261031-141951-57442e/`。结果为 `environment-checked`，无待授权或待恢复数据。CLI 版本/登录门禁就绪；ADB 可用，已授权和未授权 Android 设备均为0；即插即用硬件枚举未发现已连接 iOS 硬件。这些计数不代表真机测试通过。

当前项目云环境只读查询失败：`MCP_TOOL_ERROR`，服务端返回 `-601059`（测试号不能使用云服务）。云环境数量为“未知”，不能写成零个，也不能宣称云隔离、照片云上传或后台订阅消息已经真实联调。未选择环境、未部署云资源、未读写云业务数据。

## 可重复入口与恢复

`npm run test:wechat` 的旧入口现已转发到 `scripts/wechat-iteration.ps1 -Mode Validate`，避免只恢复旧版记录。普通 Windows PowerShell 进程需继承 USERPROFILE、LOCALAPPDATA、PATH、PATHEXT；不能从受限 shell 直接运行微信业务 CLI。

```powershell
pwsh -NoProfile -File .\scripts\wechat-iteration.ps1 -Mode Environment
pwsh -NoProfile -File .\scripts\wechat-iteration.ps1 -Mode Validate
```

Environment 仅检查登录/版本、当前项目云环境数量及可连接硬件，不自动选择云环境，不部署或写云数据。iOS 硬件枚举不等于微信真机授权。Validate 使用合成计划和一像素合成 PNG；原生相册选择/隐私授权在模拟器中受控 mock，真实文件持久化另有断言。时间边界由模拟器中暂时替换 Date 后调用真实页面方法注入，不代表自然等待跨午夜；finally 恢复原 Date、API 与当前日期。

遇到 pending 保存任务，不重放点击或写入。用同一运行目录显式查询；进入明确终态后再恢复：

```powershell
pwsh -NoProfile -File .\scripts\wechat-iteration.ps1 -Mode Poll -RunDirectory '<实际运行目录>'
pwsh -NoProfile -File .\scripts\wechat-iteration.ps1 -Mode Restore -RunDirectory '<实际运行目录>'
```

Mock 恢复失败时仍尝试恢复存储，任一恢复失败都保留 `restoreNeeded: true` 并阻止新一轮测试。不要删除备份或用清空微信存储替代恢复。

静态/Node 验证已覆盖：全部中文静态页面和七日示例、全部 key 及存在性恢复、坏备份拒绝、注入异常时恢复 Date/wx API。真实执行结果待协调者代理运行后补充。
