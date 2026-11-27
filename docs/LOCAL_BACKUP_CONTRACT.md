# 本机记录备份与恢复契约

日期：2026-11-02，用户日期与日程按设备本地日历呈现。本轮承接已完成的游泳后加班修订，不重新安排用户日程、不接入真实云环境，也不放宽已执行日期的历史保护。

## 需求与验收

| 编号 | 产品行为 | 验收标准 |
| --- | --- | --- |
| BACKUP-01 | 生成可携带的本机记录备份 | 独立生成JSON文件，包含计划、历史版本、日快照、执行记录、偏好与休息记录；明确不含照片原文件、照片关联、云配置、授权及运行计时，不称为完整小程序备份。生成与摘要读取不改业务存储。 |
| BACKUP-02 | 自主保存或发送 | 文件生成成功后才提供单独的发送按钮；用户再次点击后进入微信原生发送界面。生成不代表已发送，取消发送不影响日程和记录，不自动选择联系人。 |
| BACKUP-03 | 恢复前校验与预览 | 选择JSON后先检查格式、大小、数据和当前操作条件，显示日期范围、计划/记录数量、排除项及覆盖含义；校验、预览、取消均零业务写入。 |
| BACKUP-04 | 一次确认恢复整份记录 | 用户明确确认后才替换本轮覆盖的数据组，不自动合并。保存前重算确认租约和全部门禁，内容或当前状态变化后旧确认失效。 |
| BACKUP-05 | 保护照片、同步与执行 | 本机照片及云端内容不改动；照片关联所需的任务上下文不可破坏。进行中的执行、未结束计时、进行中/待处理的同步、损坏状态及不兼容照片上下文阻止恢复。 |
| BACKUP-06 | 失败保护与最近一次撤销 | 写入前保留原值与存在性，跨键失败精确回滚并读回；失败恢复不完整时保留恢复点。最近一次成功恢复可再次预览确认撤销，但之后本机内容变化时拒绝覆盖。 |
| BACKUP-07 | 提醒与隐私边界明确 | 恢复的前台提醒默认关闭，本机订阅模板配置保留，不恢复微信授权、不登记或取消后台消息。备份含反馈和休息理由，应提示只向自己或信任的人发送。 |
| QA-BACKUP | 分层验证 | 新逻辑、真实页面处理器、文件流程、微信模拟器及真实原生发送界面分别留证。合成数据测试、CI与受控原生回调不替代实际授权、发送或真机。 |

## 文件格式

根对象仅接受以下字段，`data`仅接受下述六组；未知包格式、版本或额外数据组拒绝恢复。

```typescript
interface LocalBackupPackage {
  schemaVersion: 1;
  kind: 'dayflow-local-record-backup';
  exportedAt: number;
  sourceDate: string;
  data: {
    plans: PlanTemplate;
    planVersions: PlanTemplate[];
    instances: Record<string, DailyInstance>;
    records: RecordEnvelope; // schemaVersion: 2
    preferences: Preferences; // portable subscriptionTemplateIds is []
    restDays: RestDays;
  };
}
```

- `exportedAt`是有效、非负的时间戳，`sourceDate`是合法本地`YYYY-MM-DD`。导入不同地区或日期的备份时，不用当前时区重写包内日期，也不强求两个地区的日期显示相同。
- 文本及文件上限统一为4 MiB UTF-8字节；生成、读取与最终恢复均检查。不依赖字符数代替UTF-8大小，不接受静默截断的JSON。
- 文件位于小程序自身的`USER_DATA_PATH/dayflow-backups/`，使用受控名称和`.json`后缀；原始文件、路径及内容不进入公开日志。该目录不是照片回收目标。
- 复用实际计划、日快照、执行记录、偏好和休息记录校验。记录统一为v2；已有v2是权威，不能重新合入残留v1旧记录。
- 可读的旧记录及未知旧目标沿用现有迁移语义，保留原状态，不伪造动作身份、开始/结束时间或执行事件。
- 包内`subscriptionTemplateIds`必须为空数组。恢复时使用当前本机模板配置，并把`sleepReminderEnabled`及`taskReminderEnabled`设为`false`；不从文件复制模板或授权。

## 只读导出和历史来源

已有有效历史快照优先，特别是已锁快照和自主选择的简化方案。未执行的当前/未来standard快照只是派生缓存，版本不匹配时不能把旧缓存当作实际生效日程；只读投影须沿用计划服务的重建、历史锁及简化方案兼容语义。缺快照记录在导出表示中补齐所需历史上下文，不落盘、不调用会生成缓存或锁定实例的显示读取接口。

缺快照历史沿用当前计划服务的来源语义：已有保存计划用其原内容；没有保存计划的旧记录使用冻结v1来源，不能用当前v4反推。旧v1/v2/v3模板来源保持，不凭名称猜测是否可覆盖。导出行为不改变记录、快照、版本、完成率或今天休息状态。

导出可保留事实状态；若备份内存在`doing`记录，恢复预览必须拒绝，不能把旧`actualStartedAt`作为当前运行时间继续累计，也不能为可恢复而自动改成完成或中止。用户应在结束进行中事项后重新生成可恢复的备份。

## 公共服务接口

实现由`miniprogram/services/local-backup.ts`负责；页面不直接写业务键或恢复点。

```typescript
interface LocalBackupSummary {
  exportedAt: number;
  sourceDate: string;
  planName: string;
  planVersion: number;
  scheduleCount: number;
  planVersionCount: number;
  snapshotCount: number;
  recordDateCount: number;
  recordCount: number;
  restDayCount: number;
  rangeStart: string;
  rangeEnd: string;
}
interface LocalBackupPreview {
  ok: boolean;
  errors: string[];
  warnings: string[];
  summary: LocalBackupSummary | null;
  lease?: string;
}
interface LocalBackupFile {
  filePath: string;
  fileName: string;
  summary: LocalBackupSummary;
}
interface LocalBackupState {
  canUndo: boolean;
  reason: string;
  recoveryRequired: boolean;
  restoredAt?: number;
}
createLocalBackup(): LocalBackupPackage;
previewLocalBackup(text: string): LocalBackupPreview;
restoreLocalBackup(text: string, lease: string): void;
exportLocalBackupFile(): Promise<LocalBackupFile>;
chooseLocalBackupFile(): Promise<{ text: string; fileName: string; preview: LocalBackupPreview }>;
shareLocalBackupFile(file: LocalBackupFile): Promise<void>;
getLocalBackupState(): LocalBackupState;
previewUndoLocalBackup(): LocalBackupPreview;
undoLocalBackup(lease: string): void;
```

摘要的日期范围只统计记录、快照和休息记录的日期联合；没有这些数据时用空字符串。不能把周期规则的2000年生效起点当成用户记录跨度。UI显示中文标签、清楚的覆盖说明和排除项，不展示租约或内部键名。

文件生成不调用分享，文件选择不调用恢复。分享必须是独立用户点击。原生文件选择、文件读取/写入、发送拒绝或取消，均提供可重试状态，不更改业务记录。

## 恢复和撤销事务

覆盖七个本机键：`dayflow.plans.v1`、`dayflow.planVersions.v1`、`dayflow.instances.v1`、`dayflow.records.v2`、`dayflow.records.v1`、`dayflow.preferences.v1`、`dayflow.restDays.v1`。其中旧v1记录在成功恢复时删除，防止未来重新出现；撤销必须恢复它原来的存在性和值。其他键不是恢复包内容，不能用`clearStorage`。

确认租约可以使用明确JSON字符串，不新增加密框架。租约绑定候选包、七组原始值和存在性、当前本地日期、照片及关联副本上下文、同步状态与最近恢复点。最终写入前重新读取和复查；不得只信任页面上一次`ok=true`。

- 当前有`doing`执行、未结束计时（包括暂停）或同步启用、正在处理、排队、冲突、账户不匹配时拒绝恢复。不能用`configured`代替`enabled`判断；已解决但保留的旧冲突对象只进入确认上下文，不因对象存在就永久封锁。损坏数据不能当空数据覆盖；同步配置不开启、不改变账户、不自动发送。
- 备份包中的进行中记录同样拒绝恢复，不能通过恢复悄悄启动或复活任务。恢复本身不执行任务、不启动计时，不产生伪执行事件。
- 对当前照片及同步恢复副本中保留的`localPath`引用，必须只读证明恢复后的对应日期/目标上下文兼容，包括目标内容、所属任务和时间块关键内容，不能仅凭同名`targetId`存在就认为兼容。无需因文件没有照片字段而一概拒绝；无法证明兼容时说明原因并拒绝，不删除照片或强行重绑目标。
- 照片兼容比较使用恢复前后实际会生效的只读日程投影。未锁且版本过期的standard缓存不能作为关联仍存在的证据；记录日/过去日的先锁、简化方案的rebase或保留逻辑同样需要保持。无法准确证明时保守拒绝，不调用有写入副作用的日程读取来“验证”。
- 业务写入前持久保存原始七键及存在性和恢复候选。每次写入成功后最终逐值读回；回滚也逐值读回。回滚失败或中断时保留可识别的恢复点，并通过明确恢复操作重试原值恢复，不伪称成功。
- `recoveryRequired=true`时，界面优先提供“恢复操作前的数据”；继续使用同一`previewUndoLocalBackup`和`undoLocalBackup`入口完成原值恢复，不把半写状态当新备份或正常恢复结果。仅接受恢复点可证明的失败过程状态，若出现用户后续未知修改则拒绝覆盖；不能要求失败混合状态精确等于完整after-image而永久锁死恢复。
- 最近一次恢复的撤销不是历史任意合并。撤销前预览，确认租约复核当前内容仍是该次恢复结果和当前安全条件；之后内容已变化时拒绝覆盖。首版采用严格七键原始值比较，不忽略日快照缓存变化。
- 正常撤销恢复原始值及原存在性，不再次套用导入的“关闭提醒”变换；它恢复的是本次操作前的本机状态。恢复点本身不进入导出文件，也不能作为云同步业务内容。

恢复点采用不可变的本机journal文件和小manifest，不把完整原值复制进一个超大的storage值。journal上限24 MiB，先写文件并逐字读回，再持久写入及读回`dayflow.localBackup.restorePoint.v1`，两步成功前不得写业务键。manifest仅含`schemaVersion:1`、`kind:'dayflow-local-record-restore-manifest'`、`state:'writing'|'restored'|'recovery-required'`、`filePath`、`fileName`、`nonce`、`createdAt`、`journalByteLength`及`journalChecksum`；文件和manifest须相互验证。`journalByteLength`是UTF-8字节数，须为1至24 MiB的整数；`journalChecksum`格式为`fnv1a32-utf16le:`加8位小写十六进制。校验以2166136261为初值，每个UTF-16 code unit依次处理低8位、高8位，分别xor后以`Math.imul`乘16777619并保留无符号32位结果；解析journal之前先核对字节数和校验值。这只用于发现损坏，不提供鉴权、签名或加密。旧journal保留，不递归扫描或自动清理用户文件。

独立、无依赖的恢复门禁模块在manifest为写入中、恢复未完成或损坏时阻止普通业务写入及计划缓存生成；“我的”页在恢复未完成时自动展开恢复入口。异步操作在开始与回调写入前核对轻量token和进程内epoch，阻止跨恢复、撤销或ABA状态后的旧操作继续写入。本机备份服务的原值回滚和明确恢复重试走自己的受控原始路径，不经普通门禁把恢复本身封死。

## 界面与验证范围

入口放在“我的→数据与同步”中按需展开，不增加Tab，也不再放一屏技术信息。流程为生成文件、用户自主发送；或选择备份、校验摘要、最后确认恢复。最近一次恢复的撤销独立预览与确认，说明“恢复后继续使用或内容变化时，不能直接撤销，恢复前副本仍保留”，不包装成长期任意撤销。按钮保持44px操作热区，长文件名、提示和错误在窄屏正常换行。

验收必须覆盖：旧记录及缺快照历史、导出/预览/取消零写、损坏/超限/未知格式、过期确认、进行中/暂停计时、同步门禁、照片上下文保护、提醒关闭且模板保留、七键写入和回滚失败、撤销原值/存在性、撤销后续变化拒绝、文件取消/读写失败、生成不自动分享及独立发送点击。

真实模拟器只用合成记录和文件，继续备份并精确恢复全部Dayflow数据。用户实际备份、照片、反馈、休息理由、私密AppID、云配置或授权不提交。实际云、原生发送界面、系统文件选择及真机没有真实日志时，分别标记待验收，不借用上一轮286项测试或294条模拟器断言。

## 文件所有权

| Owner | 范围 |
| --- | --- |
| 架构 | 本契约、README、PRD V0.8、ARCHITECTURE当前段；接口和边界审查 |
| 备份引擎 | local-backup服务、计划只读投影、文件IO及对应纯测试 |
| 备份界面 | 我的页TS/WXML/WXSS和页面处理器回归 |
| QA | 合成夹具、专用微信流程与验证报告；不修改实际用户数据 |
| 技术负责人 | 集成、源冻结、真实宿主模拟器、代码审查和GitHub提交/PR |
