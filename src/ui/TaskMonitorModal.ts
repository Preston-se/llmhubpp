import { Modal, type App } from 'obsidian';
import { NOTE_INDEX_TASK_PREFIX, type PendingIndexTask, type RagLifecycle } from 'src/core/ragLifecycle';
import { SourceDocumentError, type SourceErrorCode } from 'src/core/sourceDocuments';
import type { ManagedTask, TaskManager, TaskSnapshot, TaskStatus } from 'src/core/taskManager';
import { t, type TranslationKey } from 'src/i18n';
import { sourceErrorText } from './sourceReading';

type IndexTasks = Pick<RagLifecycle, 'listPendingIndexTasks' | 'observe'>;
type TaskEntry = { task: ManagedTask; state: TaskSnapshot };
type NoteGroup = { path: string; active: TaskEntry[]; pending: PendingIndexTask[] };
type Disclosure = { element: HTMLDetailsElement; summary: HTMLElement; rows: HTMLElement };

const ACTIVE_STATUSES: readonly TaskStatus[] = ['running', 'pausing', 'queued', 'paused'];
const HOLD_LABELS = { save: 'taskMonitor.awaitSave', choice: 'taskMonitor.awaitChoice', rebuild: 'taskMonitor.awaitRebuild' } as const;
const SYNC_ERRORS: Partial<Record<string, TranslationKey>> = {
  'store-unavailable': 'sync.errorStoreUnavailable', 'setting-not-found': 'sync.errorSettingMissing',
  'index-not-syncable': 'settings.externalIndexSyncDisabled', 'embedding-missing': 'sync.errorEmbeddingMissing',
};

function isPendingNote(entry: PendingIndexTask): boolean {
  return entry.status === 'waiting' || entry.status === 'queued' || entry.status === 'held';
}

export function taskStatusText(tasks: readonly ManagedTask[], pending: readonly PendingIndexTask[]): string {
  const snapshots = tasks.map(task => task.snapshot);
  const parts: string[] = [];
  for (const status of ACTIVE_STATUSES) {
    const count = snapshots.filter(state => state.status === status).length;
    if (count) parts.push(`${t(`taskMonitor.${status}`)} ${count}`);
  }
  const waiting = new Set(pending.filter(isPendingNote).map(entry => entry.path)).size;
  if (waiting) parts.push(t('taskMonitor.barPending', { count: waiting }));
  return t('taskMonitor.bar', { summary: parts.join(' · ') || t('index.idle') });
}

function isNoteIndexTask(state: TaskSnapshot): boolean {
  return state.descriptor?.kind === 'custom' && !!state.descriptor.setting && !!state.source
    && state.title === NOTE_INDEX_TASK_PREFIX + state.source;
}

function fileName(path: string): string { return path.split(/[\\/]/).at(-1) ?? path; }

function noteOrder(group: NoteGroup): number {
  if (group.active.length) return -1;
  let earliest = Number.MAX_SAFE_INTEGER;
  for (const entry of group.pending) {
    if (entry.status === 'queued') return 0;
    if (entry.status === 'waiting') earliest = Math.min(earliest, entry.dueAt);
  }
  return earliest;
}

function indexOutcomeKey(path: string, setting: string | undefined, status: TaskStatus): string {
  return JSON.stringify([path, setting, status]);
}

function statusBadge(parent: HTMLElement, status: TaskStatus | PendingIndexTask['status'], label: string): void {
  parent.createSpan({ cls: 'llm-hub-task-status', text: label, attr: { 'data-status': status } });
}

function timestamp(parent: HTMLElement, value: number): void {
  if (!value) return;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return;
  parent.createEl('time', { cls: 'llm-hub-task-time', text: date.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'medium' }),
    attr: { datetime: date.toISOString() } });
}

function createDisclosure(parent: HTMLElement, onToggle: () => void): Disclosure {
  const element = parent.createEl('details', { cls: 'llm-hub-task-disclosure' });
  const summary = element.createEl('summary');
  const rows = element.createDiv({ cls: 'llm-hub-task-list' });
  element.addEventListener('toggle', onToggle);
  return { element, summary, rows };
}

function updateDisclosure(disclosure: Disclosure, title: string, count: number): void {
  disclosure.element.hidden = count === 0;
  disclosure.summary.setText(`${title} · ${count}`);
}

export class TaskMonitorModal extends Modal {
  private unsubscribeTasks?: () => void;
  private unsubscribeIndex?: () => void;
  private renderTimer?: number;
  private countdownTimer?: number;
  private countdowns: { element: HTMLTimeElement; dueAt: number }[] = [];
  private view?: { activity: HTMLElement; saveError: HTMLElement; deferred: Disclosure; history: Disclosure };
  private deferredNotes: NoteGroup[] = [];
  private recent: TaskSnapshot[] = [];
  private olderFailures: PendingIndexTask[] = [];

  constructor(app: App, private readonly tasks: TaskManager, private lifecycle?: IndexTasks) { super(app); }

  onOpen(): void {
    this.setTitle(t('taskMonitor.title'));
    this.modalEl.addClass('llm-hub-task-monitor');
    const saveError = this.contentEl.createDiv({ cls: 'llm-hub-task-alert', attr: { role: 'status' } });
    const activity = this.contentEl.createDiv({ cls: 'llm-hub-task-activity' });
    const deferred = createDisclosure(this.contentEl, () => this.renderDeferred());
    const history = createDisclosure(this.contentEl, () => this.renderHistory());
    this.view = { activity, saveError, deferred, history };
    this.unsubscribeTasks = this.tasks.subscribe(this.requestRender);
    this.unsubscribeIndex = this.lifecycle?.observe(this.requestRender);
    this.render();
  }

  setLifecycle(lifecycle: IndexTasks): void {
    this.unsubscribeIndex?.();
    this.lifecycle = lifecycle;
    if (!this.view) return;
    this.unsubscribeIndex = lifecycle.observe(this.requestRender);
    this.requestRender();
  }

  private readonly requestRender = (): void => {
    if (!this.view || this.renderTimer !== undefined) return;
    this.renderTimer = window.setTimeout(() => {
      this.renderTimer = undefined;
      this.render();
    }, 150);
  };

  private render(): void {
    const view = this.view;
    if (!view) return;
    const focus = view.activity.ownerDocument.activeElement?.getAttribute('data-task-action');
    view.activity.empty();
    this.countdowns = [];
    const error = this.tasks.lastSaveError;
    view.saveError.hidden = !error;
    view.saveError.setText(error ? `${t('taskMonitor.saveError')} · ${error.message}` : '');

    const records = this.tasks.list().reverse().map(task => ({ task, state: task.snapshot }));
    records.sort((a, b) => b.state.updatedAt - a.state.updatedAt);
    const active = records.filter(({ state }) => ACTIVE_STATUSES.includes(state.status));
    active.sort((a, b) => ACTIVE_STATUSES.indexOf(a.state.status) - ACTIVE_STATUSES.indexOf(b.state.status));
    this.recent = records.filter(({ state }) => !ACTIVE_STATUSES.includes(state.status)).map(({ state }) => state);

    const groups = new Map<string, NoteGroup>();
    const groupFor = (path: string) => {
      const group = groups.get(path) ?? { path, active: [], pending: [] };
      groups.set(path, group);
      return group;
    };
    const current: TaskEntry[] = [];
    for (const entry of active) {
      if (isNoteIndexTask(entry.state)) groupFor(entry.state.source).active.push(entry);
      else current.push(entry);
    }
    const pending = this.lifecycle?.listPendingIndexTasks() ?? [];
    for (const entry of pending) groupFor(entry.path).pending.push(entry);
    const notes: NoteGroup[] = [];
    this.deferredNotes = [];
    for (const group of groups.values()) {
      if (group.active.length || group.pending.some(isPendingNote)) notes.push(group);
      else {
        const deferred = group.pending.filter(entry => entry.status === 'deferred');
        if (deferred.length) this.deferredNotes.push({ ...group, pending: deferred });
      }
    }
    notes.sort((a, b) => noteOrder(a) - noteOrder(b));
    if (current.length) {
      const list = this.section(view.activity, t('taskMonitor.active'), current.length);
      for (const { state, task } of current) this.renderTask(list, state, task);
    }
    if (notes.length) {
      const list = this.section(view.activity, t('taskMonitor.noteIndex'), notes.length);
      for (const note of notes) this.renderNote(list, note);
    }
    if (!current.length && !notes.length) view.activity.createDiv({ cls: 'llm-hub-task-empty', text: t('taskMonitor.empty') });

    const outcomes = new Set(this.recent.filter(isNoteIndexTask).map(state => indexOutcomeKey(state.source, state.descriptor?.setting, state.status)));
    this.olderFailures = pending.filter(entry => (entry.status === 'failed' || entry.status === 'cancelled')
      && !outcomes.has(indexOutcomeKey(entry.path, entry.setting, entry.status)));
    updateDisclosure(view.deferred, t('taskMonitor.deferred'), this.deferredNotes.length);
    updateDisclosure(view.history, t('taskMonitor.history'), this.recent.length + this.olderFailures.length);
    this.renderDeferred();
    this.renderHistory();

    if (focus) view.activity.querySelector<HTMLButtonElement>(`[data-task-action="${focus}"]`)?.focus({ preventScroll: true });
    this.updateCountdowns();
    if (this.countdowns.length && this.countdownTimer === undefined)
      this.countdownTimer = window.setInterval(() => this.updateCountdowns(), 1000);
    if (!this.countdowns.length) this.clearCountdownTimer();
  }

  private section(parent: HTMLElement, title: string, count: number): HTMLElement {
    const section = parent.createEl('section', { cls: 'llm-hub-task-section' });
    section.createEl('h3', { text: `${title} · ${count}` });
    return section.createDiv({ cls: 'llm-hub-task-list' });
  }

  private renderDeferred(): void {
    const deferred = this.view?.deferred;
    if (!deferred) return;
    deferred.rows.empty();
    if (!deferred.element.open || deferred.element.hidden) return;
    for (const note of this.deferredNotes) this.renderNote(deferred.rows, note);
  }

  private renderHistory(): void {
    const history = this.view?.history;
    if (!history) return;
    history.rows.empty();
    if (!history.element.open || history.element.hidden) return;
    for (const state of this.recent) this.renderTask(history.rows, state);
    const failures = new Map<string, PendingIndexTask[]>();
    for (const entry of this.olderFailures) {
      const entries = failures.get(entry.path) ?? [];
      entries.push(entry);
      failures.set(entry.path, entries);
    }
    for (const [path, pending] of failures) this.renderNote(history.rows, { path, active: [], pending });
  }

  private renderNote(parent: HTMLElement, note: NoteGroup): void {
    const row = parent.createDiv({ cls: 'llm-hub-task-row' });
    row.createEl('h4', { cls: 'llm-hub-task-title', text: fileName(note.path), attr: { title: note.path } });
    const slash = note.path.lastIndexOf('/');
    if (slash !== -1) row.createDiv({ cls: 'llm-hub-task-meta', text: note.path.slice(0, slash) });
    const indexes = row.createDiv({ cls: 'llm-hub-task-indexes' });
    for (const { state, task } of note.active) this.renderTask(indexes, state, task, true);
    for (const entry of note.pending) {
      const index = indexes.createDiv({ cls: 'llm-hub-task-index' });
      const header = index.createDiv({ cls: 'llm-hub-task-line' });
      header.createSpan({ cls: 'llm-hub-task-title', text: entry.setting });
      if (entry.status === 'waiting') {
        const date = new Date(entry.dueAt);
        const element = header.createEl('time', { cls: 'llm-hub-task-status',
          attr: { 'data-status': 'waiting', datetime: date.toISOString(), title: date.toLocaleString() } });
        this.countdowns.push({ element, dueAt: entry.dueAt });
      } else {
        statusBadge(header, entry.status, entry.status === 'held' ? t(HOLD_LABELS[entry.reason]) : t(`taskMonitor.${entry.status}`));
      }
      if (entry.operation === 'delete') index.createDiv({ cls: 'llm-hub-task-meta', text: t('taskMonitor.removeIndex') });
      if ('error' in entry) index.createDiv({ cls: 'llm-hub-task-error', text: entry.error });
    }
  }

  private renderTask(parent: HTMLElement, state: TaskSnapshot, task?: ManagedTask, grouped = false): void {
    const source = state.source || state.descriptor?.source || '';
    const setting = state.descriptor?.setting;
    const repeatedSource = [source, fileName(source)].find(part => part && state.title.endsWith(' · ' + part));
    const title = grouped && setting ? setting : repeatedSource ? state.title.slice(0, -(repeatedSource.length + 3)) : state.title;
    const row = parent.createDiv({ cls: grouped ? 'llm-hub-task-index' : 'llm-hub-task-row' });
    const header = row.createDiv({ cls: 'llm-hub-task-line' });
    header.createEl(grouped ? 'span' : 'h4', { cls: 'llm-hub-task-title', text: title });
    statusBadge(header, state.status, t(`taskMonitor.${state.status}`));
    timestamp(header, state.updatedAt);

    if (!grouped && source && source !== title) row.createDiv({ cls: 'llm-hub-task-meta', text: source });
    if (!grouped && setting && setting !== source && !state.title.endsWith(' · ' + setting))
      row.createDiv({ cls: 'llm-hub-task-meta', text: setting });
    if (state.descriptor?.workflow)
      row.createDiv({ cls: 'llm-hub-task-meta', text: t('taskMonitor.workflow', { name: state.descriptor.workflow }) });
    const stage = (task || state.status === 'interrupted') && !['等待执行', '进行中'].includes(state.stage) ? state.stage : '';
    const progress = state.total > 0 ? `${state.completed}/${state.total}` : '';
    const description = [stage, progress].filter(Boolean).join(' · ');
    if (description) row.createDiv({ cls: 'llm-hub-task-meta', text: description });
    if (task && state.total > 0) row.createEl('progress', { cls: 'llm-hub-task-progress', attr: {
      value: Math.min(state.completed, state.total), max: state.total, 'aria-label': description,
    } });
    const repeats = new Set([state.title, title, source, fileName(source), setting]);
    if (state.detail && !repeats.has(state.detail)) row.createDiv({ cls: 'llm-hub-task-meta', text: state.detail });
    if (state.savedCount) {
      const saved = row.createDiv({ cls: 'llm-hub-task-meta llm-hub-task-saved' });
      saved.createSpan({ text: t('taskMonitor.saved', { count: state.savedCount }) });
      if (state.savedDetail && !repeats.has(state.savedDetail)) saved.createSpan({ text: state.savedDetail });
      if (state.savedAt) timestamp(saved, state.savedAt);
    }
    const errorKey = state.errorCode && SYNC_ERRORS[state.errorCode];
    const error = errorKey ? t(errorKey) : state.errorCode ? sourceErrorText(new SourceDocumentError(state.errorCode as SourceErrorCode)) : state.error;
    if (error) row.createDiv({ cls: 'llm-hub-task-error', text: error });

    if (task) {
      const actions = row.createDiv({ cls: 'llm-hub-task-actions' });
      const resume = state.status === 'paused' || state.status === 'pausing';
      actions.createEl('button', { text: t(resume ? 'taskMonitor.resume' : 'taskMonitor.pause'), attr: {
        type: 'button', 'data-task-action': `${state.id}-toggle`, ...(resume ? {} : { title: t('taskMonitor.pauseHint') }),
      } }).addEventListener('click', () => { if (resume) task.resume(); else task.pause(); });
      actions.createEl('button', { text: t('common.cancel'), attr: { type: 'button', 'data-task-action': `${state.id}-cancel` } })
        .addEventListener('click', () => task.cancel());
    }
  }

  private updateCountdowns(): void {
    const now = Date.now();
    for (const { element, dueAt } of this.countdowns) {
      const seconds = Math.max(0, Math.ceil((dueAt - now) / 1000));
      const duration = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
      element.setText(seconds ? t('taskMonitor.countdown', { time: duration }) : t('taskMonitor.queued'));
      if (!seconds) this.requestRender();
    }
  }

  private clearCountdownTimer(): void {
    if (this.countdownTimer !== undefined) window.clearInterval(this.countdownTimer);
    this.countdownTimer = undefined;
  }

  onClose(): void {
    this.unsubscribeTasks?.();
    this.unsubscribeTasks = undefined;
    this.unsubscribeIndex?.();
    this.unsubscribeIndex = undefined;
    if (this.renderTimer !== undefined) window.clearTimeout(this.renderTimer);
    this.renderTimer = undefined;
    this.clearCountdownTimer();
    this.countdowns = [];
    this.deferredNotes = [];
    this.recent = [];
    this.olderFailures = [];
    this.view = undefined;
    this.contentEl.empty();
  }
}
