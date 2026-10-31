# 本轮迭代契约与验收清单

日期：2026-10-31。基线为 `fea3cfff72bbb358feb57cd2d684a4c66fa8c7ea`。
本文件先冻结跨模块接口；实现状态以各模块交付与 `ITERATION_VALIDATION.md` 的真实证据为准，不能将本契约写成已完成功能。

## 需求、负责模块与验收

| 编号 | 需求 | 负责模块 | 验收标准 |
| --- | --- | --- | --- |
| UI-001 | 面向中文用户的界面 | 中文界面 | 去掉所有装饰性英文、英文副标题和里程碑缩写；数据中的技术字段、导入格式和代码标识不受此限制 |
| UI-002 | 手机布局与操作区 | 中文界面 | 七日导航、卡片、表单在窄屏可滚动；正文换行；主要点击区至少 44px；底部操作不遮挡内容，预留安全区 |
| M2-EXEC-001 | 完整执行状态 | 执行记录 | 待开始、进行中、完成、跳过、延期、中止可明确操作；固定占用块没有完成打卡；只有完成进入完成率分子 |
| M2-DEFER-001 | 延期后的自主安排 | 日程引擎、执行记录 | 原日保留延期事实；用户在计划页一键生成目标日的关联例外任务；目标锁定、无空档或重复来源时明确处理，不自动搬移历史 |
| M2-EXEC-002 | 真实执行与反馈 | 执行记录 | 状态变化追加事件；只记录真实发生的开始/结束时刻，不把计划时间或迁移时刻伪装成执行时间；可保存自选强度、不适、备注 |
| M2-REVIEW-001 | 昨日复盘和中止 | 执行记录 | 复盘使用历史快照，每日最多一次；训练中止保存未完成动作的真实状态，不自动完成剩余项目 |
| M3-PLAN-001 | 计划编辑 | 日程引擎 | 原生表单创建、修改、删除安排；分钟级时间、重复星期、生效日期与日期例外可校验保存 |
| M3-PLAN-002 | 模板导入、预览和版本 | 日程引擎 | 导入先解析校验、显示数量与错误/警告，用户确认后提交；无效导入不改原数据；每次保存递增版本 |
| M3-HISTORY-001 | 计划与历史分离 | 日程引擎、执行记录 | 修改模板前为既有记录固化编辑前快照；已锁定实例不被未来计划重写；旧记录和损坏数据不能静默覆盖 |
| M3-MEDIA-001 | 照片打卡 | 账户与数据 | 用户主动选择照片后持久保存并关联日期/目标；取消或失败不产生伪记录；本地路径不能当作跨设备云文件 |
| M3-MEDIA-002 | 照片存储管理边界 | 账户与数据、中文界面 | 若仅移除关联而保留应用保存副本，界面和报告明确仍占本机空间；不能声称彻底删除。原相册照片不动；未关联应用副本回收能力须单独验证或列为限制 |
| M3-SYNC-001 | 云同步与隔离 | 账户与数据 | 默认关闭；完整快照严格读写，读取故障不能上传空数据；服务端使用可信用户标识，版本冲突保留两份，不静默覆盖 |
| M4-STAT-001 | 历史与连续执行 | 日程引擎 | 历史、周统计和连续执行读取日快照与真实记录；固定块不计分母，跳过/延期/中止不计完成 |
| M4-TRAIN-001 | 15 分钟简化计划 | 日程引擎、执行记录 | 用户可主动启用或退出，训练时间约束为 15 分钟；有执行记录的当日实例不被替换；不强制完成或医学解锁 |
| M4-TIMER-001 | 自选动作计时 | 执行记录、中文界面 | 可选时长、开始/暂停/继续/重置；隐藏或重启后按持久化结束时刻恢复；结束不自动完成任务，不承诺后台提醒 |
| M4-PHASE-001 | 可配置阶段目标 | 账户与数据 | 用户手选基础、巩固或自主调整阶段，并配置参考次数和说明，仅记录自选目标；实际动作需用户编辑计划，不自动改强度、不医学解锁 |
| M5-REMIND-001 | 提醒偏好、前台到点提示和订阅入口 | 账户与数据、执行记录 | 开启后前台按睡眠时间/任务提前分钟提示并去重；后台停止检查；缺模板或拒绝授权如实说明，不声称后台送达 |
| M5-REMIND-002 | 有限的一次性后台提醒 | 账户与数据、中文界面 | 具体日期/时刻/标题可见，用户主动订阅并接受后只登记该次任务；服务端归属隔离、稳定 ID 去重、原子领取与单次发送；部署和真实送达另验收 |
| QA-001 | 自动化与回归 | 质量验证 | 新增纯逻辑有测试；类型检查与单元测试通过；核心路径有微信模拟器日志，未验证项目单独列出 |

“延期”先保留原日的延期状态与目标日期，界面提示“已标记延期，可到计划页一键安排”。用户在计划页主动确认后才生成目标日关联例外任务；不会在设置延期状态时自动复制，也不改写来源历史。目标日排程是否成功必须以 plans 返回结果为准。

## 文件所有权

| 负责人 | 可修改范围 |
| --- | --- |
| 架构 | 本契约、PRD、ARCHITECTURE、README，以及获协调者授权的 package 脚本元数据 |
| 中文界面 | 所有 WXML/WXSS、app.wxss、app.json、页面 JSON；与页面逻辑负责人约定 data 和事件，不改服务 |
| 日程引擎 | `types/domain.ts`、`services/plans.ts`、`services/insights.ts`、模板适配、计划页和统计页 TypeScript、对应模块测试 |
| 执行记录 | records/execution 服务、今日页和训练页 TypeScript、progress 逻辑、对应模块测试 |
| 账户与数据 | preferences/media/sync 服务、个人页 TypeScript、cloudfunctions、对应模块测试 |
| 质量验证 | 自动化 scripts、验收测试、`ITERATION_VALIDATION.md`；不与模块单元测试文件争抢写入 |
| 主协调者 | 接口协调、冲突处理安排、集成审查、实际验收、GitHub 提交与 PR；不直接实现业务功能 |

文件所有权调整必须先通知相关负责人。一个模块不得通过自行复制另一模块的服务来绕开接口。

## 共享模型

公共类型由日程引擎独占写入 `miniprogram/types/domain.ts`。日期键为设备本地 `YYYY-MM-DD`；钟点为本地 `HH:mm`；执行和版本时间戳使用 epoch 毫秒。

```ts
type TaskStatus = 'todo' | 'doing' | 'done' | 'skipped' | 'deferred' | 'aborted';
type BlockKind = 'fixed' | 'parallel' | 'sequence';
interface Action {
  id: string; title: string; start: string; end: string;
  dosage?: string; description?: string; equipment?: string;
  searchKeyword?: string; safety?: string;
}
interface Task {
  id: string; title: string; start: string; end: string;
  actions: Action[];
  dosage?: string; description?: string; equipment?: string;
  searchKeyword?: string; safety?: string;
  origin?: {date: string; targetId: string};
}
interface TimeBlock {
  id: string; title: string; start: string; end: string;
  kind: BlockKind; category: string; tasks: Task[];
}
interface ScheduleException {
  date: string; kind: 'skip' | 'replace'; blocks?: TimeBlock[];
}
interface Schedule {
  id: string; title: string;
  weekdays: number[]; // 与 JS getDay 一致：0=周日，1=周一，…，6=周六
  effectiveFrom: string; effectiveTo?: string;
  exceptions: ScheduleException[]; blocks: TimeBlock[];
}
interface PlanTemplate {
  schemaVersion: 1; id: string; name: string;
  version: number; schedules: Schedule[]; updatedAt: number;
}
interface DailyInstance {
  date: string; templateId: string; templateVersion: number;
  blocks: TimeBlock[]; locked: boolean;
  mode: 'standard' | 'emergency'; createdAt: number;
}
interface ExecutionEvent {
  id: string; from: TaskStatus; to: TaskStatus; at: number; reason?: string;
}
interface TrainingFeedback {
  effort?: 1 | 2 | 3 | 4 | 5; discomfort?: boolean; note?: string;
}
interface ExecutionRecord {
  date: string; targetId: string; taskId: string; actionId?: string;
  status: TaskStatus; actualStartedAt?: number; finishedAt?: number;
  updatedAt: number; deferredTo?: string; feedback?: TrainingFeedback;
  events: ExecutionEvent[];
}
type Status = TaskStatus;
type Feedback = TrainingFeedback;
interface RecordEnvelope {
  schemaVersion: 2;
  byDate: Record<string, Record<string, ExecutionRecord>>;
}
```

五个概念分别落地：TimeBlock 只描述容纳方式；Task 是独立执行事项；Action 是任务内部步骤；Record 保存执行事实；Schedule 保存重复规则。DailyInstance 保存某日生效的模板快照。

并行音乐块生成两个无步骤 Task；顺序训练块生成训练 Task 及多个 Action。完成率以叶子执行单元计算：有步骤的任务只计 Action，没有步骤的任务计 Task，不能同时把父任务和子步骤计入分母。固定块的 tasks 必须为空。

现有 `template.PlanBlock.actions` 保留为 UI 适配投影：无步骤 Task 投影为一行，有步骤 Task 将各 Action 投影为一行；每行的 `id` 是 targetId，并增加 `taskId`、可选 `actionId`。现有默认动作 ID 保持稳定，记录通过日期加 targetId 隔离。

## 存储、迁移与失败边界

| Key | 结构与归属 |
| --- | --- |
| `dayflow.plans.v1` | 当前 PlanTemplate，日程引擎拥有 |
| `dayflow.planVersions.v1` | 历史 PlanTemplate 数组，日程引擎拥有；冗余版本可保留，不能失败后覆盖当前模板 |
| `dayflow.instances.v1` | `{[date]: DailyInstance}`，日程引擎拥有 |
| `dayflow.records.v1` | 旧 `{[date]: {[targetId]: 'todo'|'done'}}`；迁移时保留，不作为新事实写入；用户明确重置当前记录时可移除 |
| `dayflow.records.v2` | `{schemaVersion:2, byDate:{[date]:{[targetId]:ExecutionRecord}}}`，执行记录拥有 |
| `dayflow.review.v1` | 每日已提示的日期键，保持兼容 |
| `dayflow.preferences.v1` | 提醒和用户自主选择的阶段偏好，账户与数据拥有 |
| `dayflow.remindersShown.v1` | 前台提醒已提示的去重键，只保留本机，不上传同步 |
| `dayflow.reminderJobs.v1` | 一次性后台任务的本机摘要缓存，不含 owner，不上传同步 |
| `dayflow.timer.v1` | 当前设备单个活动动作计时，不上传同步 |
| `dayflow.media.v1` | PhotoRecord 列表，账户与数据拥有 |
| `dayflow.sync.v1` | 用户显式配置的环境与同步版本状态，不含凭证 |
| `dayflow.sync.queue.v1` | 待同步的业务 payload，本机保留，不作为另一端数据自动覆盖来源 |
| `dayflow.sync.conflicts.v1` | 冲突时本地与远端两份内容及版本，不静默丢弃 |
| `dayflow.sync.restoreBackup.v1` | 跨 key 恢复前原始值与待恢复内容，本机保留用于失败恢复 |
| `dayflow.sync.previousBinding.v1` | 切换云环境时保留的原绑定状态，本机保留 |

1. 新写入接口失败必须抛错，由页面提示；不能把保存失败显示成成功。显示层可降级为空视图，但写入、迁移、同步必须严格读取原始存储。
2. 第一次修改模板前，严格读取当前权威记录的全部日期，并使用编辑前模板固化对应历史实例；没有 v2 时，旧 M1 v1 历史使用原七日示例适配。v2 一旦存在即为权威，即使 byDate 为空也不能再用残留 v1 重新锁日或复活完成状态。所有必要快照成功持久化后，才保存新模板。失败拒绝计划修改，旧 key 保留为备份。
3. 过去日期或第一次执行后锁定快照。未执行的今天和未来快照可在模板版本变化时重建，避免浏览一次未来日期便永久冻结安排。
4. records 写入前调用 plans.lockDailyInstance，之后只更新 records；plans 不导入 records 服务，通过严格读取已约定的记录 key 完成迁移，避免循环依赖。
5. 旧记录迁移不能推断 actualStartedAt/finishedAt；迁移时刻只可作为 updatedAt 或标注迁移的事件时刻。不能伪造历史执行时间。
6. 多 key 写入不是原子事务：保存顺序为必要历史快照、版本历史、当前模板。中途失败可以保留已写入但尚未生效的快照或冗余版本，不得先覆盖记录再尝试修复。重复迁移按已有锁定快照幂等处理。
7. 计划写入使用 expectedVersion 检测本地并发变化；导入、保存前重新校验，不信任 UI 预览对象。

## 服务接口（冻结）

所有日期/时间参数必须严格解析；新 mutating API 出错抛 Error。界面向用户显示中文错误，日志/类型可保留技术标识。

### plans.ts

```ts
getTemplate(): PlanTemplate
getTemplateVersions(): PlanTemplate[]
saveTemplate(template: PlanTemplate, expectedVersion?: number): PlanTemplate
saveSchedule(schedule: Schedule, expectedVersion?: number): PlanTemplate
deleteSchedule(scheduleId: string, expectedVersion?: number): PlanTemplate
getDailyInstance(date: string): DailyInstance
lockDailyInstance(date: string): DailyInstance
getDayBlocks(date: string): PlanBlock[]
getSnapshotDates(): string[]
previewImport(text: string): ImportPreview
importTemplate(text: string, expectedVersion?: number): PlanTemplate
exportTemplate(): string
setEmergencyPlan(date: string, enabled: boolean, blockId?: string): DailyInstance
scheduleDeferredTarget(sourceDate: string, targetId: string, targetDate: string): {
  date: string; targetId: string; start: string; end: string;
}
```

`ImportPreview` 为 `{ok, template?, errors:string[], warnings:string[], summary:{schedules,blocks,tasks,actions}}`。导入仅接受有限大小 JSON 文本；拒绝非法日期/钟点、空标题、无效类型、重复目标 ID、越界/负时长、顺序动作重叠等。标识唯一性按实际适用的同一天验证，不能把默认七日中复用的“工作/音乐”语义 ID 误判为全局冲突。

应急计划将未锁定实例的当日训练改为一个 15 分钟训练块，开始时刻取用户选择的训练块；其他训练块在该日覆盖中不再显示，非训练安排保留。不能改写已执行的动作或历史。它是显式的当日训练覆盖，不是可随模板编辑丢弃的派生缓存：模板版本变化时更新非训练安排，保留用户所选简化训练，合并冲突在模板保存前拒绝。mode 为 emergency 的实例恰有一个 sequence 训练块且为 15 分钟，以其块 ID 表示选中来源，没有新增私有快照字段。用户主动退出后才恢复最新标准模板。恢复标准计划同样受锁定规则限制；可选择其他日期，不强制用户清空记录。

延期安排从来源锁定快照读取叶子，并验证原记录确为 deferred、目标日期匹配。目标日必须为今天或未来且未锁定、无执行记录，也不能是已有应急覆盖日。优先采用来源时刻后的足够长空档；没有空档则拒绝，不能覆盖固定占用或现有安排。生成仅目标日生效的一次性 Schedule：weekdays 为空、effectiveFrom/effectiveTo 均为目标日期、replace 例外只携带新时间块。Task.origin 保存来源关联，目标稳定 ID 防重复生成。保存仍遵守版本检查和历史冻结顺序。

表单打开时捕获编辑基线版本，不能因页面返回前台刷新了展示版本便抬高旧草稿的 expectedVersion。多块、多 Task 和未编辑说明必须保留；含来源关联的延期块若转换类型会丢关联，应保留关联或明确拒绝，而非静默丢弃。

### records.ts / execution.ts

```ts
forDate(date: string): Record<string, TaskStatus> // M1 兼容投影
toggleDone(date: string, targetId: string): Record<string, TaskStatus> // 兼容包装
recordDetailsForDate(date: string): Record<string, ExecutionRecord>
setStatus(date: string, targetId: string, status: TaskStatus,
  options?: {deferredTo?: string; reason?: string}): ExecutionRecord
saveFeedback(date: string, targetId: string, feedback: TrainingFeedback): ExecutionRecord
getHistory(fromDate?: string, toDate?: string): ExecutionRecord[]
exportEnvelope(): RecordEnvelope // 严格读取；不使用显示层 fallback
replaceEnvelope(remote: RecordEnvelope): void // 仅供用户已选择的恢复
clearRecords(): void // 页面确认后清打卡与复盘，不清计划和快照
hasAnyRecord(date: string): boolean
lastReviewKey(): string
setLastReviewKey(date: string): void
```

`toggleDone` 保持旧页面兼容：失败 toast 并返回原状态，不返回伪完成；新页面优先调用可抛错的 setStatus。目标必须存在于当日快照，固定块不能写执行记录。重复设置同一状态不制造多条假执行事件；修正状态追加事件，保留先前事实。直接勾选完成没有开始事件时，不推断开始时刻。中止任何时候可用，不把剩余动作自动完成。不适反馈允许用户主动中止，并显示专业人员审核提示。

v2 envelope 一旦存在，即使 byDate 为空，也不能再次自动合并 v1，避免清除或远端恢复后旧数据复活。replaceEnvelope 严格校验 schema、日期、状态和事件后写入；sync 不能在冲突未决时自动调用。clearRecords 只作用 v1/v2/review，UI 使用“重置本机当前执行记录”，明示保留计划、快照、照片、云端与已有同步副本，不能把它描述成删除全部个人数据或声称保留副本也无法恢复。

### insights.ts

```ts
getWeeklySummary(anchorDate: string): {
  days: DaySummary[]; completed: number; total: number; percent: number;
  trainingCompleted: number; trainingTotal: number;
}
getHistorySummary(fromDate?: string, toDate?: string): {
  days: DaySummary[]; streak: number; activeDays: number;
}
```

`DaySummary` 为 `{date,label,completed,total,percent,trainingCompleted,trainingTotal}`。周一开始，未来未发生日期不参与截至今日统计；训练与全任务分别展示。“连续执行”按有至少一项真实完成的连续本地自然日计算，不能把仅查看/跳过的一天记成执行日。insights 可依赖 plans 和 records，不能被二者反向导入。

### preferences.ts

```ts
getPreferences(): Preferences
savePreferences(patch: Partial<Preferences>): Preferences
requestReminderSubscription(kind: 'task'|'sleep'): Promise<SubscriptionResult>
getDueReminders(dateKey: string, nowMinute: number, blocks: PlanBlock[],
  nextDayBlocks?: PlanBlock[]): Reminder[]
markReminderShown(key: string): void
```

偏好字段包括 `sleepReminderEnabled`、`sleepTime:HH:mm`、`taskReminderEnabled`、`leadMinutes`、`subscriptionTemplateIds:string[]`、`trainingPhase:'基础'|'巩固'|'自主调整'`、`phaseRules:{id,name,minSessions,description}[]`。提醒默认关闭。subscriptionTemplateIds[0] 对应任务、[1] 对应睡眠，保留空槽；缺对应位置不调用授权 API。

前台提醒由今日页可见时钟调用，Reminder 为 `{key,kind:'task'|'sleep',title}`；非 fixed 时间块每次开始只提醒一次，不对训练动作逐个轰炸。纯逻辑函数 `computeDueReminders(dateKey,nowMinute,blocks,preferences,shown?,nextDayBlocks?)` 用于测试。前台传入下一日块后，可以在前一日晚间提醒次日零点附近事项，并使用次日目标的同一去重 key；没有运行前台则不保证准点。后台不检查，也不把错过的前台提示说成后台推送已送达。写入提示去重失败时，页面仍需使用内存去重，避免每秒反复提示。

阶段配置只保存用户自选的训练目标、参考次数与说明，不直接改变现有动作、组数、时长或强度。实际训练变化由用户通过计划编辑确认；不从不适反馈推断医学安全，不因完成次数强制切阶段，也不宣传为自动进阶。

### timer.ts（执行记录负责人）

```ts
interface TimerState {
  schemaVersion: 1; dateKey: string; targetId: string;
  durationSeconds: number; remainingSeconds: number;
  status: 'running' | 'paused' | 'finished';
  endsAt?: number; updatedAt: number;
}
getTimer(): TimerState | null
startTimer(dateKey: string, targetId: string, durationSeconds: number): TimerState
pauseTimer(): TimerState | null
resumeTimer(): TimerState | null
resetTimer(): TimerState | null
```

计时为独立工具，不导入或自动修改 records。时长由用户选择，建议整数范围 5 秒至 3 小时；只运行一个活动计时，切换目标需给出清楚的用户操作。运行剩余秒数从 endsAt 与当前 epoch 毫秒计算并取上整，不能靠回调次数扣秒；系统时钟变化时剩余值不超过本轮保存的剩余时长。暂停冻结 remainingSeconds，继续生成新 endsAt，重置恢复原时长并暂停。

页面隐藏只停止界面刷新，不篡改已持久化的计时结束时刻。重新进入或应用重启后按持久状态恢复；getTimer 可将已到期状态派生为 finished，而不要求读取时写入。计时结束不自动勾选完成、不自动宣称动作已做完，也不承诺后台送达通知。损坏存储和保存失败必须如实提示，不能返回伪计时成功。

### media.ts

```ts
interface PhotoRecord {
  id: string; dateKey: string; targetId: string;
  localPath?: string; createdAt: number; cloudFileID?: string;
}
chooseAndSavePhoto(date: string, targetId: string): Promise<PhotoRecord>
getPhotos(date?: string, targetId?: string): PhotoRecord[]
removePhoto(id: string): void
```

只使用用户主动选择的照片，持久化后才写元数据；取消选择不提示“保存成功”。未经用户开启云同步，不上传照片。照片不作为完成状态的强制前提。云拉取记录可以只有 cloudFileID，没有 localPath；UI 不得把云文件谎称为已下载到本机。

当前移除接口只移除记录关联，应用保存副本可能仍占本机空间；界面必须如此说明。未关联应用副本的回收能力列为存储管理限制，不能把移除关联宣传成彻底删除本机或云端照片。来源相册原图不动。

### sync.ts 与云函数

```ts
getSyncState(): SyncState
configureSync(config: {enabled: boolean; envId: string}): SyncState
syncNow(): Promise<SyncResult>
resolveSyncConflict(choice: 'local'|'remote'): Promise<SyncResult>
uploadPhoto(id: string): Promise<PhotoRecord>
getPhotoPreviewPath(photo: PhotoRecord): Promise<string>
```

同步 payload 白名单为 `{schemaVersion:1, plans, planVersions, instances, records, preferences, media}`。严格读取每个原始存储 key；损坏或读取失败拒绝上传，不能调用显示层的吞错 fallback 生成空数据。media 同步剔除 localPath，未上传的本地照片不能伪装成远端可用文件。

服务端从 CloudBase 可信上下文取得 OPENID，客户端不能指定 owner 或读写其他用户。写入携带 expectedVersion，服务端 CAS 比较版本；冲突保留本地与远端两份，由用户选择，不自动覆盖。首次启用、恢复远端与覆盖本地都要有清晰的用户动作。云功能未配置时返回“未配置/不可用”，不显示虚假同步成功。

云函数源代码与单元测试可先交付；真实云环境、部署权限、数据库规则、媒体权限、订阅消息模板及用户授权必须经真实配置后验收。不得把云端 mock 或本地单测写成真实用户隔离通过。

### reminders.ts 与一次性提醒服务端

```ts
interface ReminderCandidate {
  kind: 'task'|'sleep'; targetDate: string; targetId: string; title: string;
  dateKey: string; time: string; dueAt: number; timezoneOffset: number;
}
interface ReminderPreview extends ReminderCandidate {
  templateId: string; accountId: string; preparedAt: number;
}
interface ReminderJob {
  id: string; kind: 'task'|'sleep'; targetDate: string; targetId: string;
  title: string; dateKey: string; time: string; dueAt: number; timezoneOffset: number;
  status: 'pending'|'sending'|'sent'|'failed'|'unknown'|'expired'|'cancelled';
  createdAt: number; updatedAt: number;
}
getNextReminderCandidate(kind: 'task'|'sleep', now?: Date): ReminderCandidate | null
prepareReminder(kind: 'task'|'sleep'): Promise<ReminderPreview | null>
registerReminder(preview: ReminderPreview, consentAccepted: boolean): Promise<ReminderJob>
listReminders(): Promise<ReminderJob[]>
cancelReminder(id: string): Promise<ReminderJob>
// sync.ts 补充：只获取可信身份/环境，不上传记录
getTrustedCloudContext(options?: {
  allowReminderManagementWhenDisabled?: boolean;
}): Promise<{envId: string; accountId: string}>
```

候选必须区分原任务日期 targetDate 与实际提醒的本地日期/钟点，包含 kind、targetId、title、dueAt（epoch 毫秒）和该时刻的 timezoneOffset（getTimezoneOffset 分钟）。当提前提醒跨到前一日晚间时不能截取 UTC 日期。服务端校验本地日期/钟点经 offset 还原后等于 dueAt，且为未来七天内的有限时间。

服务端私有集合 `dayflow_reminder_jobs` 的 Job 保留稳定 id、可信 owner、目标信息、本地提醒日/钟点、dueAt、timezoneOffset、状态与创建/更新时间，并可保存领取/结果时间。客户端返回的 ReminderJob 是摘要，不含 owner 或 OPENID。状态为 pending、sending、sent、failed、unknown、expired、cancelled；sent 的用户含义只能是“已提交微信”，不代表用户已经收到或读到。

候选与后端模板能力先预载并向用户展示具体时间、实际可发送标题和“仅本次”说明，再由直接绑定用户点击的按钮调用订阅授权。提醒标题在生成候选时按 Unicode 字符截取前二十个，预览、登记与发送使用同一值；不能已消耗授权后才发现合法计划长标题无法登记，源计划标题不因此改变。过时的预览或已改变的候选要求用户重新预览，不能静默切换目标。只有对应模板返回 accept 才登记该次任务；拒绝、缺配置、账户不匹配或登记失败均不能显示登记成功。consentAccepted 是客户端交互门禁，不是服务端可验证的微信额度证明，最终可发送额度由微信接口校验。服务端模板标识与字段映射只接受受控配置，不能让客户端任意指定模板内容结构或其他收件人。

稳定 ID 按可信归属、种类、目标、日期和时刻生成，同一次登记幂等。每用户最多二十条活动任务、五百条总任务；达到上限明确拒绝新登记，不截断原有记录。前台提醒开关与已登记的一次性任务分开：关闭前台提示不冒充取消后台任务，提供独立列表/取消入口；计划编辑不自动改已登记快照，需提示取消后重新订阅。

关闭云同步不取消已登记的一次性任务。对于已经绑定的账户，明确用户动作触发的列表/取消可使用独立管理模式继续校验身份；不重新开启同步、不上传本机历史，账户变化仍拒绝。页面显示不因同步已关闭便自动发起网络请求。

定时处理采用独立的可信 timer adapter，核心逻辑注入 repo、sender 和 now 便于纯测试。发送前原子领取 pending 为 sending，只允许一个 worker 执行一次；超时或结果不明进入 unknown，不自动重新发送，崩溃后不能回收 sending 再发。过期任务不补轰炸。微信接口确认成功后才进入 sent，已知拒绝为 failed；任何结果都不自动注册下次周期任务。

普通客户端不能通过伪造 `Type:Timer` 或 action 获得定时管理员权限。独立 Tick 入口及 manager capability 默认不可用，须同时配置两处 ready 标记及完整的一种服务器专用授权模式：token 模式使用六十四位随机十六进制后端凭据恒定时间比较；private-trigger 模式使用私有随机触发器名、服务端核定的 SDK 来源、无 OPENID、Timer 类型联合守卫。真实来源枚举、触发器名、令牌不由源码猜测，也不写入公开配置或日志。

生产启用前必须先完成部署侧访问控制：Tick 的客户端 invoke 禁止，HTTP/网关入口另用 OPA 拒绝或不开放；受控模板和发送权限配置后，再按官方支持的方式启用。token 适配不代表 IDE 一定支持注入自定义 Message，也不代表已经取得微信票据；private-trigger 的 SDK 来源同样需要实际平台核定。两种模式的真实配置未验证前，代码和纯测试不能宣传为后台提醒已送达。

官方部署依据：

- [云调用票据限制](https://docs.cloudbase.net/faq/knowledge/missing-wxcloudapitoken-error)：普通定时等调用可能没有云调用票据，通过微信开发者工具配置的定时触发是文档列出的例外。
- [定时触发器配置](https://docs.cloudbase.net/cloud-function/timer-trigger)：微信小程序云函数需要在开发者工具上传触发器；不能把通用 cron 配置自动当作微信票据已具备。
- [云函数访问控制](https://docs.cloudbase.net/cloud-function/security-rules)：客户端与平台管理/定时入口的鉴权适用范围不同，必须按入口配置权限，不能只信事件字段。

## 页面协作与中文规则

保留今日、计划、统计、我的四个 Tab，训练详情独立页面。页面 TS 负责人先向中文界面负责人发布 data/事件列表，界面负责人据此编写 WXML/WXSS；字段调整直接通知双方。

今日/训练页负责状态菜单、反馈、照片、自主应急选择、动作计时与可随时中止；计划页负责表单 CRUD、周期例外、导入预览/版本及延期目标日安排；统计页负责周统计、历史和连续执行；个人页负责提醒、阶段偏好和可选同步配置。

可见文案不得保留 DAYFLOW、MY WEEK、TRAINING SESSION 等装饰英文，也不显示版本里的 M1/M2 缩写；模板 YTWL 改为中文动作名称。技术字段、源码、导出模板的标准键名不必翻译成不兼容的格式。

## 验证门禁与未完成边界

### 云端共享验证器构建

`npm run build:cloud-validation` 使用已有 TypeScript 开发依赖生成 `cloudfunctions/dayflowSync/shared/` 下的 calendar、plan-validation、record-validation、preferences-validation、instance-validation、media-validation 六个纯模块。源分别是客户端日期工具、计划与记录验证器；偏好模块通过 AST 只提取 defaults、copy、invalid、validatePreferences，实例模块只提取 plans 的 object/assertDate/validateInstances，媒体模块只提取 validatePhotos。生成结果不引入 wx 或设备运行时。

生成产物随代码提交，不包含任何本机配置、用户数据或凭证。`tests/cloud-validation-bundle.test.js` 只在内存生成预期内容并逐字比较已提交文件，过期必须失败；测试不能先自动重写产物来掩盖未提交差异。依赖和应用版本不因这个构建入口改变。

`npm run build:reminder-tick` 将 manager 目录中的 jobs、repository、configuration 三个通用模块复制为独立 Tick 的 shared 产物，避免云函数部署后依赖不存在的相邻函数目录。其一致性测试同样只读比较，不自动改写。生产默认禁发和具体部署门禁见 [云函数说明](../cloudfunctions/README.md)。

- 模块作者为新增纯逻辑补单元测试，完成自己的改动后执行 `npm run typecheck` 和 `npm test`；并行中的暂时集成错误必须说明对应未就绪接口。
- QA 在业务模块集成后运行真实微信模拟器，覆盖中文文案、状态、历史隔离、计划编辑、导入预览、反馈、应急与偏好；备份和恢复所有新 key，不把用户数据提交到仓库。
- 照片选择、云端同步、订阅授权如需要真实用户交互或配置，应记录执行条件与实际结果；不能自动接受安全授权或伪造完成。
- Android/iOS 真机、真实微信重启持久化、云隔离、后台订阅送达等没有日志时仍为未验证。
- 完成状态分为“已实现、单元验证、模拟器验证、外部配置待验收、未实现”，不以“计划完成”替代证据。
