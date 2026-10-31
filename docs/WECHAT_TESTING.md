# M1 微信开发者工具验证

此流程使用安装版 `wechatide-skill` 0.3.11 的新版 `wechatide.cmd`，不使用旧 `cli.bat`，不额外引入 `miniprogram-automator`。脚本已在真实微信开发者工具中运行，最新结果见 [M1 验证报告](M1_VALIDATION.md)。Node 单元测试和 TypeScript 检查不能替代模拟器或 Android/iOS 真机验收。

## 运行条件

必须从有桌面访问权限的普通 Windows PowerShell 7.3+ 会话运行，不能在 sandbox 中执行 `wechatide`。安装版技能根文件明确要求：**“禁止在沙箱 / sandbox 中运行 wechatide”**。本次通过可访问本机的执行入口运行 PowerShell，未解除或绕过受限 shell 的沙箱。

自动化调用进程必须继承有效的 `USERPROFILE`、`LOCALAPPDATA`、`PATH` 和 `PATHEXT`。缺少 `USERPROFILE` 会让 CLI 从错误目录读取端口；缺少 `PATHEXT` 会让 PowerShell 无法把 `.cmd` 识别为可执行命令。只修正调用进程环境，不修改系统环境、安全设置或凭证。

1. 使用已安装并登录的微信开发者工具，允许 Codex 客户端访问。脚本不会修改服务端口、安全设置或 AppID。
2. 默认路径为 `E:\Software\微信web开发者工具\wechatide.cmd`；其他路径通过 `-WechatIde` 指定。
3. 项目中公开的 `touristappid` 仅为演示占位。若工具拒绝使用，请在工具中为本地项目选择有权限的 AppID，不提交个人配置或凭证。不要提供 AppSecret、私钥或云密钥。
4. 若工具启用了 CLI 访问令牌，只通过当前 PowerShell 进程的 `DAYFLOW_WECHAT_CLI_TOKEN` 环境变量提供。不要将令牌写进命令参数示例、项目文件、截图或日志。MCP Token 与 CLI Token 不同，脚本不读取任何 Token 文件。
5. 使用仅供测试的模拟器会话，测试期间不要同时手动打卡或编辑数据，也不要并发运行脚本。脚本操作当前项目的真实本地记录，会在结束时恢复。

```powershell
Set-Location D:\Data\app-dayflow
npm run typecheck
npm test
pwsh -NoProfile -File .\scripts\wechat-smoke.ps1
```

脚本不会调用云端、预览上传、正式发布、远程调试或真机接口，也不会执行清空缓存/存储。

## 检查内容与证据

脚本先验证版本关系及登录状态，打开项目，逐页请求 WXML/WXSS 编译，再编译并打开今日页面。通过 `automation_page_action/getData` 读取页面数据，通过 `automation_element_action/tap` 点击真实 WXML 元素，失败返回非零退出码。CLI 的 stderr 诊断保存在日志，只解析 stdout JSON；返回失败或未知数据结构时不猜测为成功。

导航后先读取页面栈，确认目标路由后再绑定选择器等待。重新编译期间已知的只读桥接超时最多重查五次；点击、存储写入、授权及未知错误不自动重试，避免重复执行用户操作。

实际断言包括：默认今天及七日导航、逐日切换、前后周日期、并行勾选互不影响、跨日期隔离、返回日期后状态保持、训练详情勾选及返回时间轴刷新、四个 Tab 可加载、返回今日后的记录保持。

运行证据保存在 `artifacts/wechat-smoke/<时间与随机编号>/`：

- `state.json`：断言、执行结果、待授权任务、恢复状态；真机验证始终为 false。
- 编号日志：每次 CLI 的返回内容，包含编译、交互与错误证据。
- `today.png`、`training.png`：通过 `simulator_screenshot` 获取的真实模拟器页面截图。
- `console-errors.json`：`grep -i error` 的控制台结果，需要人工或后续审查区分业务异常与平台日志。交互断言通过时状态为 `interaction-pass-console-review-required`，不是正式发布通过。
- `records-backup.json`：交互测试前 `dayflow.records.v1` 的原始值；仅本机保留，可能含私密记录，禁止提交、上传或分享整个 artifacts 目录。

记录备份与恢复参数文件保留原值，以确保精确恢复；其余日志和状态中的 CLI 令牌会脱敏。交互通过后仅设置 `simulatorInteractionVerified: true`，同时保留 `consoleReviewRequired: true`，不声明整个模拟器验收完成。

刷新请求成功只表示请求已触发，不等同整个项目编译成功。脚本同时要求真实页面和交互断言成立，但仍需审阅控制台。脚本没有验证字体放大、所有屏幕尺寸、安全区、连续计时边界、Android/iOS 真机、云权限、提醒或发布流程。

## 数据恢复与中断

脚本在首次打开今日页面后、执行勾选前备份记录。打开页面本身可能触发应用既有的昨日复盘弹窗及其“今日已提示”标记；脚本不清理或修改此标记。若原生弹窗阻挡交互，请先在工具中关闭，保留失败证据后重新运行。

正常结束或非授权类失败会在 `finally` 中恢复原始 records 值并立即读回比较。只恢复 `dayflow.records.v1`，不清空其他键；原先没有 records 键时写入空对象，以避免任何删除操作。恢复后的 UI 可能暂时展示测试状态，切换 Tab 或重新打开今日页即可刷新。备份与评测日志会一直保留。

遇到 `pending + taskId`，立即保存 taskId 并以非零退出码暂停；不自动重试、轮询、重放点击或继续写存储。若此时已经勾选，先完成/取消待授权任务，再恢复。不要删除备份或启动另一轮测试。

在微信开发者工具中完成授权后，用输出的同一运行目录查询一次：

```powershell
pwsh -NoProfile -File .\scripts\wechat-smoke.ps1 -Mode Poll -RunDirectory 'D:\Data\app-dayflow\artifacts\wechat-smoke\<实际运行目录>'
```

仍为 pending 时继续等待工具内的确认，稍后再显式执行 Poll。终态无论成功、失败、取消或过期，脚本都不重放原操作。存在 `restoreNeeded: true` 时执行：

```powershell
pwsh -NoProfile -File .\scripts\wechat-smoke.ps1 -Mode Restore -RunDirectory 'D:\Data\app-dayflow\artifacts\wechat-smoke\<实际运行目录>'
```

确认 `restoreNeeded: false` 后，才重新执行完整 Validate。进程被终止或桌面工具崩溃也应先检查 `state.json` 并恢复；未知 pending 状态禁止重放和恢复。若恢复失败，保留备份并解决工具权限/连接问题，不要使用清空存储作为修复手段。

## 当前验收状态

已有真实 CLI、编译及模拟器交互日志；完整断言结果与运行目录见 [M1 验证报告](M1_VALIDATION.md)。真机仍未验证。后续运行必须保留当次失败证据、记录恢复状态及控制台审查结果，不能仅凭退出码宣告发布通过。
