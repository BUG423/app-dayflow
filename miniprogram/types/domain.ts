/** Local dates and clock times are calendar values, not UTC timestamps. */
export type DateKey = string;
export type TaskStatus = 'todo' | 'doing' | 'done' | 'skipped' | 'deferred' | 'aborted';
export type Status = TaskStatus;
export type BlockKind = 'fixed' | 'parallel' | 'sequence';
export interface Action {
  id: string; title: string; start: string; end: string;
  dosage?: string; description?: string; equipment?: string; searchKeyword?: string; safety?: string;
}
export interface Task {
  id: string; title: string; start: string; end: string; actions: Action[];
  dosage?: string; description?: string; equipment?: string; searchKeyword?: string; safety?: string;
  origin?: { date: string; targetId: string };
}
export interface TimeBlock {
  id: string; title: string; start: string; end: string; kind: BlockKind; category: string; tasks: Task[];
}
export interface ScheduleException { date: string; kind: 'skip' | 'replace'; blocks?: TimeBlock[]; }
export interface Schedule {
  id: string; title: string; weekdays: number[]; effectiveFrom: string; effectiveTo?: string;
  exceptions: ScheduleException[]; blocks: TimeBlock[];
}
export interface PlanTemplate { schemaVersion: 1; id: string; name: string; version: number; schedules: Schedule[]; updatedAt: number; }
export interface DailyInstance {
  date: string; templateId: string; templateVersion: number; blocks: TimeBlock[];
  locked: boolean; mode: 'standard' | 'emergency'; createdAt: number;
}
export interface ExecutionEvent { id: string; from: TaskStatus; to: TaskStatus; at: number; reason?: string; }
export interface TrainingFeedback { effort?: 1 | 2 | 3 | 4 | 5; discomfort?: boolean; note?: string; }
export type Feedback = TrainingFeedback;
export interface ExecutionRecord {
  date: string; targetId: string; taskId: string; actionId?: string; status: TaskStatus;
  actualStartedAt?: number; finishedAt?: number; updatedAt: number; deferredTo?: string;
  feedback?: TrainingFeedback; events: ExecutionEvent[];
}
export interface RecordEnvelope { schemaVersion: 2; byDate: Record<string, Record<string, ExecutionRecord>>; }
export interface ImportPreview {
  ok: boolean; template?: PlanTemplate; errors: string[]; warnings: string[];
  summary: { schedules: number; blocks: number; tasks: number; actions: number };
}
export interface DaySummary {
  date: string; label: string; completed: number; total: number; percent: number;
  trainingCompleted: number; trainingTotal: number;
}
