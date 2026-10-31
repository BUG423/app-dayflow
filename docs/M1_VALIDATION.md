# M1 验证报告 · 2026-10-31

## 范围与基线

- 需求：M1-VERIFY-001/002/003/004、M1-QA-001，参见 PRD。
- 本地路径：`D:\Data\app-dayflow`。目录有源码，但没有 `.git`，因此不能报告本地分支或干净工作区。
- 远程基线：PR #1，`feat/m1-miniprogram-foundation`，提交 `0405219c0581089c8fe464046deb9f57ab23407f`；PR 处于草稿状态。
- 已按 Git blob SHA 核对全部 39 个基线文件；只有本次预期修改存在差异。没有重建项目或覆盖未知改动。
- 本次使用独立远程分支 `feat/m1-validation-hardening`。本地 Git 克隆失败，使用已连接 GitHub 接口提交；原 PR 分支不变。
- 基线 CI：工作流 `dayflow-quality`，run `41166072862`，状态 `completed/success`。它不代表微信模拟器或真机通过。

## 本机环境与实际尝试

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

安装版 `wechatide-skill/SKILL.md` 明确规定“禁止在沙箱 / sandbox 中运行 wechatide”。发现这一限制后停止尝试业务 CLI。当前沙箱不能申请解除，不能用变更系统或安全设置来替代授权。

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
- PowerShell AST 与真实函数契约测试通过，覆盖错误响应、pending 不重放、令牌脱敏、精确恢复及恢复失败。契约使用 Fake-Ide，没有执行脚本业务入口或真实模拟器交互，不能报告模拟器通过。

## 待完成验收

- 恢复开发者工具窗口，在普通 Windows PowerShell 中运行脚本；按工具提示完成本机登录或客户端授权。
- 取得模拟器编译、页面点击和截图证据；若 `touristappid` 被工具拒绝，仅在本机配置合适 AppID，不能提交凭证。
- 验证不同模拟器尺寸、长文本、放大字体、安全区域与触摸热区。
- Android / iOS 微信真机测试、重启微信后的持久化、订阅提醒、云同步和用户隔离均未验证；后两项尚未实现。
- M1 模拟器验收仍处于阻塞状态，M2–M5 未宣告完成。

运行步骤、授权中断恢复与记录保护机制见 [微信测试说明](WECHAT_TESTING.md)。自动化运行产生的备份、日志和截图保存在忽略的 `artifacts/`，禁止上传用户本地执行记录。
