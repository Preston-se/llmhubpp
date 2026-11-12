import { afterEach, describe, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import { setLocale } from 'src/i18n';
import { NOTE_INDEX_TASK_PREFIX, type PendingIndexTask } from 'src/core/ragLifecycle';
import { TaskManager } from 'src/core/taskManager';
import * as taskMonitor from './TaskMonitorModal';

type ElementOptions = { text?: string; attr?: Record<string, string | number> };

class TestElement {
  readonly children: TestElement[] = [];
  readonly ownerDocument = { activeElement: null };
  readonly attr: Record<string, string | number>;
  private listeners = new Map<string, () => void>();
  open = false;
  hidden = false;
  text: string;

  constructor(readonly tag: string, options: ElementOptions = {}) {
    this.text = options.text ?? '';
    this.attr = { ...options.attr };
  }
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(' '); }
  createEl(tag: string, options?: ElementOptions): TestElement {
    const child = new TestElement(tag, options);
    this.children.push(child);
    return child;
  }
  createDiv(options?: ElementOptions): TestElement { return this.createEl('div', options); }
  createSpan(options?: ElementOptions): TestElement { return this.createEl('span', options); }
  empty(): void { this.text = ''; this.children.length = 0; }
  setText(text: string): void { this.text = text; }
  addClass(): void {}
  addEventListener(event: string, listener: () => void): void { this.listeners.set(event, listener); }
  trigger(event: string): void { this.listeners.get(event)?.(); }
  findAll(tag: string): TestElement[] {
    return [...this.children.filter(child => child.tag === tag), ...this.children.flatMap(child => child.findAll(tag))];
  }
}

vi.mock('obsidian', async importOriginal => ({
  ...await importOriginal<typeof import('obsidian')>(),
  Modal: class {
    contentEl = new TestElement('main');
    modalEl = new TestElement('dialog');
    setTitle() { return this; }
    open() { (this as unknown as taskMonitor.TaskMonitorModal).onOpen(); }
    close() { (this as unknown as taskMonitor.TaskMonitorModal).onClose(); }
  },
}));

const app = {} as App;
function queue(initial: PendingIndexTask[]) {
  let entries = initial;
  const listeners = new Set<() => void>();
  return {
    listPendingIndexTasks: () => entries,
    observe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); },
    change(next: PendingIndexTask[]) { entries = next; for (const listener of listeners) listener(); },
  };
}

afterEach(() => { vi.useRealTimers(); setLocale('en'); });

describe('Task center', () => {
  it('groups live and waiting indexes under one note and updates the remaining time in place', () => {
    const start = Date.UTC(2026, 10, 11);
    vi.useFakeTimers({ now: start });
    setLocale('zh');
    const manager = new TaskManager();
    const path = 'Notes/alpha.md';
    manager.create(NOTE_INDEX_TASK_PREFIX + path, path, { kind: 'custom', setting: 'Active', source: path })
      .update('生成RAG向量', 2, 5, path);
    const modal = new taskMonitor.TaskMonitorModal(app, manager, queue([
      { path, setting: 'Scheduled', operation: 'update', status: 'waiting', dueAt: start + 600_000 },
      { path, setting: 'Offline', operation: 'update', status: 'failed', error: 'service unavailable' },
      { path, setting: 'Deferred', operation: 'update', status: 'deferred' },
      { path: 'Draft/beta.md', setting: 'Scheduled', operation: 'update', status: 'waiting', dueAt: start + 500_000 },
    ]));
    modal.open();
    const body = modal.contentEl as unknown as TestElement;
    expect(body.textContent.match(/alpha\.md/g)).toHaveLength(1);
    expect(body.textContent).toContain('service unavailable');
    expect(body.textContent).toContain('已暂缓');
    expect(body.findAll('progress').map(progress => [progress.attr.value, progress.attr.max])).toEqual([[2, 5]]);
    const countdown = body.findAll('time').find(element => element.textContent.includes('10:00'));
    expect(countdown).toBeDefined();
    expect(body.textContent).toContain('8:20');
    vi.advanceTimersByTime(1000);
    expect(countdown?.textContent).toContain('9:59');
    expect(body.findAll('time')).toContain(countdown);
    modal.close();
  });

  it('keeps history collapsed initially and shows a terminal error without the stale queued stage', () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 10, 11) });
    setLocale('zh');
    const manager = new TaskManager();
    manager.create('Old job', 'Notes/old.md').fail(new Error('service unavailable'));
    manager.create('Done job').complete();
    manager.create('Cancelled job').cancel();
    manager.create('Interrupted job').markInterrupted('inspect workflow');
    const modal = new taskMonitor.TaskMonitorModal(app, manager);
    modal.open();
    const body = modal.contentEl as unknown as TestElement;
    const history = body.findAll('details').find(details => details.textContent.includes('最近记录'))!;
    expect(history?.findAll('summary')[0]?.textContent).toMatch(/最近记录.*4/);
    expect(history?.open).toBe(false);
    expect(body.textContent).not.toContain('service unavailable');

    history.open = true;
    history.trigger('toggle');
    expect(history.textContent).toContain('service unavailable');
    expect(history.textContent).not.toContain('等待执行');
    expect(history.findAll('time')).toHaveLength(4);

    manager.create('Current job').update('索引任务', 1, 2);
    vi.advanceTimersByTime(200);
    expect(body.findAll('details')).toContain(history);
    expect(history.open).toBe(true);
    expect(body.textContent.indexOf('Current job')).toBeLessThan(body.textContent.indexOf('最近记录'));
    modal.close();
  });

  it('keeps deferred notes and durable failed outcomes accessible in collapsed details', () => {
    setLocale('zh');
    const manager = new TaskManager();
    const path = 'Notes/cancelled.md';
    manager.create(NOTE_INDEX_TASK_PREFIX + path, path, { kind: 'custom', setting: 'S', source: path }).cancel();
    const modal = new taskMonitor.TaskMonitorModal(app, manager, queue([
      { path, setting: 'S', operation: 'update', status: 'cancelled', error: 'cancelled for now' },
      { path: 'Notes/older.md', setting: 'S', operation: 'update', status: 'failed', error: 'older index failure' },
      { path: 'Notes/later.md', setting: 'S', operation: 'update', status: 'deferred' },
    ]));
    modal.open();
    const body = modal.contentEl as unknown as TestElement;
    const deferred = body.findAll('details').find(details => details.textContent.includes('已暂缓'));
    expect(deferred?.open).toBe(false);
    expect(body.textContent).not.toContain('later.md');
    deferred!.open = true;
    deferred!.trigger('toggle');
    expect(deferred?.textContent).toContain('later.md');
    expect(deferred?.findAll('time')).toHaveLength(0);

    const history = body.findAll('details').find(details => details.textContent.includes('最近记录'))!;
    expect(history.findAll('summary')[0]?.textContent).toMatch(/最近记录.*2/);
    history.open = true;
    history.trigger('toggle');
    expect(history.textContent).toContain('older index failure');
    expect(history.textContent.match(/cancelled\.md/g)).toHaveLength(1);
    modal.close();
  });

  it('preserves managed task controls and releases pending updates and listeners on close', () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 10, 11) });
    setLocale('zh');
    const manager = new TaskManager();
    const task = manager.create('Current job');
    const modal = new taskMonitor.TaskMonitorModal(app, manager);
    modal.open();
    const body = modal.contentEl as unknown as TestElement;
    const click = (label: string) => body.findAll('button').find(button => button.textContent === label)?.trigger('click');
    click('暂停');
    expect(task.snapshot.status).toBe('pausing');
    vi.advanceTimersByTime(200);
    click('继续');
    expect(task.snapshot.status).toBe('running');
    const pending = queue([{ path: 'Notes/alpha.md', setting: 'S', operation: 'update', status: 'waiting', dueAt: Date.now() + 30_000 }]);
    modal.setLifecycle(pending);
    vi.advanceTimersByTime(200);
    expect(body.textContent).toContain('alpha.md');
    click('取消');
    expect(task.snapshot.status).toBe('cancelled');
    modal.close();
    expect(vi.getTimerCount()).toBe(0);
    pending.change([]);
    manager.create('New job');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('counts pending notes once each in the status bar and skips unscheduled work', () => {
    setLocale('zh');
    const pending: PendingIndexTask[] = [
      { path: 'Notes/a.md', setting: 'S', operation: 'update', status: 'waiting', dueAt: Date.now() + 60_000 },
      { path: 'Notes/a.md', setting: 'T', operation: 'update', status: 'queued' },
      { path: 'Notes/b.md', setting: 'S', operation: 'update', status: 'held', reason: 'save' },
      { path: 'Notes/c.md', setting: 'T', operation: 'update', status: 'deferred' },
    ];
    expect(taskMonitor.taskStatusText([], pending)).toContain('待索引 2');
    expect(taskMonitor.taskStatusText([], pending.slice(3))).toContain('空闲');
  });
});
