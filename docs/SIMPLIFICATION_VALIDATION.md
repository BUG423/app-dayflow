# 日常使用简化验证

日期：2026-11-27。验收要求见 [简化契约](SIMPLIFICATION_CONTRACT.md)。

## 代码范围

- 今日、计划、我的三Tab；记录作为独立页面从我的进入。
- 今日减少重复进度、类别和待开始标签，休息入口置底，昨日回顾主动打开后确认已读。
- 普通安排两步填写，复用既有校验、冲突覆盖与历史保护；第二步保留紧凑草稿摘要。
- 我的仅突出记录、提醒和备份，训练偏好与关于按需展开；已有同步或恢复异常仍可处理。
- 训练辅助内容按动作展开，当前计时、停止和安全提示外显；不改训练剂量或记录格式。

## 验证分级

| 层级 | 结果与证据 |
| --- | --- |
| 修改前基线 | 类型检查退出0；346/346 Node测试通过，日志在忽略的`artifacts/simplification/baseline-*.log`。 |
| 本轮类型与Node | 最终集成`npm run typecheck`退出0，`npm test`381/381通过，0失败、0跳过、退出0。比基线增加35项回归；覆盖两步保存、非法时间、覆盖取消回访、9时段完整保留与编辑、按需复盘及跨午夜、恢复拒写、同步退化、记录导航与训练展开。日志在`artifacts/simplification/final-typecheck.log`与`final-tests.log`。 |
| 独立WXML/WXSS编译 | 本机已安装微信工具附带的wcc/wcsc对五页独立编译，10/10退出0；最终计划页展示补丁后两项重新编译均退出0。该结果仅证明所用编译器的语法编译，不是模拟器运行或布局验收。日志在`artifacts/simplification/*-wxml.log`及`*-wxss.log`。 |
| 微信开发者工具模拟器 | 本轮尚未执行。当前会话没有可用的桌面控制或获准的普通宿主自动化通道；不在受限沙箱内启动wechatide。旧备份专项390px的126条断言不覆盖本轮新界面。 |
| 自动验收脚本 | 新增`Simplification`模式，完成PowerShell语法及隔离helper契约检查；真实流程尚未运行。旧复杂模式仍有历史选择器待迁移。 |
| 原生交互、真实云、Android/iOS真机 | 本轮未验证，包含照片权限、文件选择/分享、订阅送达、字体放大和输入法。 |
| GitHub CI | 随提交核对实际运行，实时结果见本轮PR检查；本地通过不代替CI或模拟器。 |

## 可重复命令

```powershell
npm run typecheck
npm test
# 以下命令需在已授权的普通Windows宿主执行，不能以此文件代替实际运行日志。
npm run test:wechat
pwsh -NoProfile -File scripts/wechat-planning-wizard.ps1 -Mode Simplification -Label narrow
```

本轮未读取、覆盖或迁移用户的真实小程序存储；页面测试仅操作隔离合成数据。私有项目配置和测试产物不提交。
