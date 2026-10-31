# 私有同步服务部署说明

本目录只交付源码与规则示例，未创建云环境、部署云函数或修改实际安全规则。真实跨账户隔离、照片权限和订阅送达须另行验收。

1. 在已关联本小程序的云环境中创建集合 `dayflow_private_state`。按 `database.rules.json` 禁止客户端直接读写，所有访问仅经过可信云函数。
2. 修改共享校验源后先执行 `node cloudfunctions/dayflowSync/build-validation.js`，再运行类型检查与单元测试。函数内的 `shared/` 是前端纯校验源的转译产物，服务端不导入微信客户端服务，打包一致性有回归。随后部署 `dayflowSync`，云端安装其精确版本依赖。函数用 `getWXContext()` 的可信用户身份派生账户键，不接受客户端提供的所有者；事务比较版本，冲突返回双方内容供用户选择。
3. 云存储必须采用 `storage.rules.json` 的仅创建者可读写规则。默认公共读取不符合照片隐私要求。先实际部署规则并通过双账户隔离验收，再由部署方设置云函数环境变量 `DAYFLOW_PRIVATE_STORAGE_READY=true`。默认没有该标记时客户端会在上传前拒绝，服务端也拒绝照片文件操作。该标记只是部署方确认，并不是自动探测规则已生效的证据。服务端签发用户专属上传前缀，并核对每个媒体文件编号的环境及账户路径。
4. 在本机 `miniprogram/config/runtime.ts` 填写已部署的环境编号和已获可用的任务/睡眠订阅模板后重新编译。公开版本保留空占位，真实配置不提交。用户仍须在“我的设置”主动开启同步，照片还须逐张选择上传。
5. 用两个独立微信测试账户验收：互相读取/写入数据库失败、不能读取对方照片、伪造 owner/文件编号失败、同版本并发写入有冲突、本机换账户拒绝自动上传旧数据、离线队列保留后可重试。

同步快照限九十万字节，超过时拒绝上传并保留全部本机数据，不能截断历史冒充同步成功。需要更多历史容量时应先实现按日期分片迁移。请求和日志均不得输出用户记录或身份。`console` 调试不应打印整个事件。

提醒偏好及前台提示可以离线使用。后台提醒源码采用一次性闭环：先预览下一条具体任务或睡眠时刻，用户再点击确认订阅，原生接口明确接受后才请求登记。每次只登记这一条，不按周期增殖。前台开关不会取消后台已登记项，修改计划也不会修改其快照，须在“我的设置”中取消并重新登记。微信 API 成功仅记为“已提交微信”，不代表用户已收到。

后台登记函数 `dayflowReminders` 与发送函数 `dayflowReminderTick` 分离，后者不接受客户端 owner/openid/模板参数。创建集合 `dayflow_reminder_jobs`，客户端直接读写均拒绝；采用账户聚合文档及数据库事务，最多二十条待发或提交中、五百条总登记，达到上限拒绝新增而不截断历史。相同账户、目标和时刻的稳定编号去重，包括取消及已发送状态；新授权不会让旧条目偷偷再发。任务限定未来七天内，服务端反算当地日期、钟点和时区偏移校验 epoch；只支持一次性登记，不构建长期授权。

部署前执行 `node cloudfunctions/dayflowReminders/build-tick.js`，同步发送函数的纯 worker、数据库适配器与配置构建产物。测试只比对产物，发现漂移会失败，不在测试时自动改写。部署两个函数均使用精确 `wx-server-sdk` 版本，并通过服务器环境变量提供 `DAYFLOW_REMINDER_TEMPLATES`，结构为 `{"task":{"id":"<已申请模板>","titleField":"thing1","timeField":"time2"},"sleep":{"id":"<已申请模板>","titleField":"thing1","timeField":"time2"}}`；字段名必须与实际微信模板对应。标题按二十字符截取，时间字段使用实际提醒当地日期和钟点。`DAYFLOW_MESSAGE_STATE` 默认为 `developer`，只可在验收后明确改成 `trial` 或 `formal`。

发送默认关闭。两个后端函数必须同时具有 `DAYFLOW_REMINDERS_READY=true`、`DAYFLOW_TIMER_READY=true` 及完整的下列一种服务器专用授权配置，否则 capability 不可用、无法登记或领取发送任务：

- IDE 私有定时触发器：`DAYFLOW_TIMER_AUTH_MODE=private-trigger`；`DAYFLOW_TIMER_TRIGGER_NAME` 是部署方独立生成的 `dayflow_` 加三十二位随机十六进制字符，`DAYFLOW_TIMER_SOURCE` 必须来自该独立函数真实 IDE Timer 调用时经核对的 SDK 来源，源码不猜来源枚举。入口同时要求 SDK 来源匹配、无 OPENID、`Type=Timer` 和私有触发器名匹配。随机名字按后端凭据保护，不进代码、前端、日志或 PR；仅名字或仅 `Type=Timer` 均不能授权。
- 服务器令牌：`DAYFLOW_TIMER_AUTH_MODE=token`；`DAYFLOW_TIMER_TOKEN` 是独立生成的六十四位随机十六进制后端凭据。受控定时调用须提供相同 `timerToken`，或 IDE Timer 的 `Message` JSON 中提供同名值，入口采用恒定时间比较。平台是否支持安全注入该 Message，以及该调用是否具备微信 CloudAPI 票据，均须在真实部署时验证，不能仅因适配器存在就声称 IDE 定时可发送。

两种模式都必须将 `functions.rules.json` 的 `dayflowReminderTick.invoke=false` 部署生效、禁用 HTTP/网关入口或通过对应 OPA 策略拒绝客户端；函数级规则仅适用于 SDK 调用，不能替代 HTTP OPA。只给必要部署角色定时管理权限。私有 Timer 模式应是独立函数，仅承接经配置的 IDE Timer，不与客户端或 HTTP 混用，避免 SDK 环境复用残留身份。真实触发器名字和时间表只在部署环境配置，本仓库不放会自动启用的 cron；两个 ready 标记只是部署方完成验收的确认，不能当作权限检测证据。

worker 先原子领取 `pending→sending` 再发送，成功后记 `sent`，明确微信业务失败记 `failed`，网络超时或结果不明记 `unknown`；过时十分钟记 `expired`。发送中进程退出也不重新领取，不自动重发，以避免同一授权重复提交。最终微信额度以实际 OpenAPI 结果为准，客户端声称接受授权并不是可信额度证明。尚未部署真实环境、后台模板、调用权限、IDE Timer、票据和送达验收；不能宣称后台提醒已经上线或无限通知。

实现依据：[订阅消息与一次性额度](https://docs.cloudbase.net/en/recipes/add-subscribe-message-cloud-function)、[定时触发器](https://docs.cloudbase.net/cloud-function/timer-trigger)、[函数访问控制与 HTTP 权限边界](https://docs.cloudbase.net/cloud-function/security-rules)、[定时事件字段示例](https://docs.cloudbase.net/cli-v1/functions/logger)、[微信票据与 IDE Timer 例外](https://docs.cloudbase.net/faq/knowledge/missing-wxcloudapitoken-error)。

照片入口在 `wx.requirePrivacyAuthorize` 可用时先等待平台授权成功，拒绝时不进入照片选择器；旧基础库仍由照片接口自身的原生权限控制。没有自定义监听或自动同意隐私授权。发布前必须在微信后台隐私指引声明照片的任务记录用途、本机持久保存、用户自主移除关联及可选私有云上传；这些后台声明和真实授权界面尚未配置验收，不能标为发布通过，也不能把不支持的接口名称擅自加入 `requiredPrivateInfos`。

实现依据为微信小程序 API 类型声明、CloudBase 官方说明：[云函数可信身份](https://docs.cloudbase.net/recipes/add-cloud-function-wechat-miniprogram)、[事务](https://docs.cloudbase.net/database/transaction)、[私有存储规则](https://docs.cloudbase.net/storage/security-rules)。规则文件是待部署配置，不是已生效的权限证明。
