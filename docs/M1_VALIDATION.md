# M1 验证报告 · 2026-10-31

## 范围与基线

- 需求：M1-VERIFY-001/002/003/004、M1-QA-001，参见 PRD。
- 本地路径：`D:\Data\app-dayflow`。目录有源码，但没有 `.git`，因此不能报告本地分支或干净工作区。
- 远程基线：PR #1，`feat/m1-miniprogram-foundation`，提交 `0405219c0581089c8fe464046deb9f57ab23407f`；PR 处于草稿状态。
- 已按 Git blob SHA 核对全部 39 个基线文件；只有本次预期修改存在差异。没有重建项目或覆盖未知改动。
- 本次使用独立远程分支 `feat/m1-validation-hardening`。本地 Git 克隆失败，使用已连接 GitHub 接口提交；原 PR 分支不变。
- 基线 CI：工作流 `dayflow-quality`，run `41166072862`，状态 `completed/success`。它不代表微信模拟器或真机通过。

## 首次检查与尝试（历史记录，复试结果见下文）

| 检查 | 真实结果 |
| --- | --- |
| PowerShell / Node / npm / Git | 7.6.5 / 24.19.0 / 11.17.0 / 2.53.0.windows.3 |
| 微信开发者工具 | 注册表确认版本 `2.02.2608080`，路径 `E:\Software\微信web开发者工具` |
| CLI 文件 | `cli.bat`、`wechatide.cmd` 和安装版 `wechatide-skill` 均存在 |
| 公开 AppID | `touristappid`；未更改私密配置，也未读取 AppSecret、私钥或令牌 |
| 普通 npm / Git 网络 | npm 返回 `ENOTFOUND registry.npmjs.org`；Git 克隆返回 `getaddrinfo() thread failed to start` |
| 依赖恢复 | 通过可联网运行时从 npm 注册表下载 TypeScript 5.9.3、miniprogram-api-typings 5.2.3，核验 SHA-512 后离线安装；无新增运行时框架 |
| 原 CLI 启动器 | 返回 `Access is denied` / `Cannot find Electron executable`，未打开项目 |
| Node 读取 CLI 帮助 | 成功显示命令目录；只是 CLI 帮助，不是编译结果 |
| Node 调用 open | 初始化失败，`ENOENT ... Default\.cli`；直接运行系统 Node 的路径散列与 Electron 安装路径不匹配，不能当作正式启动方案 |
| 桌面检查 | 受控桌面连接找到 `WeChat Web Devtools`；窗口最小化，读取返回 `window is minimized; call activate_window, refresh with get_window, then retry get_window_state`。当前暴露接口无法恢复该窗口，重新调用启动入口后仍然最小化 |
| 服务端口、登录、自动化授权 | 未取得有效就绪响应，不能确认开启、登录有效或已授权 |

安装版 `wechatide-skill/SKILL.md` 明确规定“禁止在沙箱 / sandbox 中运行 wechatide”。首次检查因而停止受限 shell 中的业务 CLI；随后通过普通本机进程入口完成复试，没有更改系统安全设置或凭证。

## 已完成修复

1. 今日页在前台按本地分钟刷新当前/下一事项，隐藏及卸载清理定时器，避免重复渲染和时钟堆积。
2. 跨午夜时跟随原先选中的今天；主动选择的历史或未来日期保留。
3. 模板使用严格本地日期解析，训练页对非法路由日期提示并阻止写记录；未知动作不能写入训练状态。
4. 增加可复用 PowerShell 模拟器流程和依赖锁文件，CI 使用 `npm ci`。
5. 故障注入复现存储读取失败后历史被覆盖的问题：写入前必须成功读取有效记录，否则停止写入；写入失败保留原状态。损坏数据保留供后续恢复。

## 验证结果

- 基线 Node 测试：8/8 通过。
- 修复后 `npm run typecheck`：通过。
- 依赖锁文件：在项目内缓存已校验的包后，`npm ci --offline --ignore-scripts --no-audit --no-fund --cache artifacts/npm-cache` 通过。
- 修复后 `npm test`：19/19 通过，无跳过项。
- 新增测试覆盖起止分钟、前后台跨午夜、时钟清理、并行独立勾选、跨日隔离、训练详情返回刷新、存储重新载入、昨日回顾每日一次、非法日期、七天模板时间/顺序/ID，以及存储读取/写入失败和损坏数据保护。
- PowerShell AST 与真实函数契约测试通过，覆盖错误响应、pending 不重放、令牌脱敏、精确恢复及恢复失败；复试后增加 stderr 诊断、页面栈等待和已知只读超时的回归。契约使用 Fake-Ide，不代表模拟器结果；真实结果单独记录如下。

## 同日复试：真实模拟器核心回归通过

最终运行：`artifacts/wechat-smoke/20261031-130318-6fbac3/`（设备本地时间，Asia/Shanghai）。退出码 `0`；原始 `state.json` 结果为 `interaction-pass-console-review-required`，`simulatorInteractionVerified: true`，共 **29 条断言通过**，`restoreNeeded: false`。

| 验证项目 | 实际证据与结果 |
| --- | --- |
| 安装、版本和登录 | 官方安装检查 `compatible: true`；就绪检查 `versionRelation: equal`、`loginExpired: false` |
| 客户端授权 | 官方 `auth -c Codex` 返回 `authorized: true`、`alreadyTrusted: true`；不需要 CLI Token，未读取令牌文件 |
| 编译 | 五个页面的 WXML、WXSS 编译返回 `success: true`，今日页整体编译与打开成功；随后真实页面数据和交互断言成立 |
| 日期导航 | 默认今天、七日逐一切换、前后周日期均通过 |
| 并行与跨日记录 | 吉他勾选变化、声乐保持不变、另一日期状态不变、返回原日期保留变化均通过 |
| 训练详情 | 从时间轴进入正确日期的训练，动作独立勾选，返回今日刷新状态均通过 |
| Tab 与保持 | 计划、统计、我的均取得对应页面数据；返回今日后勾选状态保持 |
| 截图 | 已取得并查看 `today.png`、`training.png`；默认模拟器画面中页面主要内容正常显示 |
| 控制台审阅 | `get_simulator_console` 的 `grep -i error` 返回空字符串，已实际检查对应原始日志与 `console-errors.json`；仅代表该错误筛选无匹配，不代表覆盖所有平台警告 |
| 数据恢复 | `Original Dayflow records restored and read back` 断言通过；未清空本地存储，未执行云端写入、上传或发布 |

### 复试发现并修复的工具兼容问题

1. 调用进程没有继承 `USERPROFILE` 和 `PATHEXT`，分别造成 CLI 从错误用户目录查端口、PowerShell 不能执行 `.cmd`。补齐当前调用进程的 Windows 环境后连接成功；不修改系统级变量。
2. CLI 在 stderr 输出 `[wechatide] skill-call...` 诊断。原脚本混合 stderr 和 stdout 导致合法 JSON 被误判；现分开解析，并保留脱敏诊断日志。
3. 点击训练入口返回时页面切换仍可能未完成，选择器等待被绑定到旧页面，实际错误为 `page is not on top of page stack`。现先确认目标页面栈，再读取页面。
4. 重编译期间自动化桥接可能短暂返回 `timeout waiting for automator response`；仅对此已知的只读查询作最多五次观察。授权、点击、写入或未知错误不自动重试。

失败运行的原始证据仍保留。首次交互失败运行 `20261031-125650-5fb0c6` 已成功恢复并读回原始记录；后续编译等待失败运行尚未写记录。最终完整回归通过后，本机类型检查及 19 项测试再次通过。

复试期间本机项目配置已使用本地 AppID；其值与开发者工具生成的私有配置、备份、日志及截图均不纳入提交。公开仓库继续保留演示占位配置。

## 待完成验收

- 本次未验证公开占位 `touristappid` 的兼容性；复试使用本地已配置 AppID。不得把本地配置或凭证提交到公开仓库。
- 真实连续分钟边界、跨午夜、非法日期路由、故障存储等边界目前由 Node 回归覆盖，未在本次模拟器流程逐项注入。
- 验证不同模拟器尺寸、长文本、放大字体、安全区域与触摸热区。
- Android / iOS 微信真机测试、重启微信后的持久化、订阅提醒、云同步和用户隔离均未验证；后两项尚未实现。
- M1 核心模拟器回归已通过，M2–M5 未宣告完成。

运行步骤、授权中断恢复与记录保护机制见 [微信测试说明](WECHAT_TESTING.md)。自动化运行产生的备份、日志和截图保存在忽略的 `artifacts/`，禁止上传用户本地执行记录。
