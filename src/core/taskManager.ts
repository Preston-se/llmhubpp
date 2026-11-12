import { TaskJournal, safeDescriptor, safeTaskErrorCode } from './taskJournal';
import type { RagSyncPreconditionCode } from './ragSyncPreconditions';
import type { SourceErrorCode } from './sourceDocuments';
export type TaskErrorCode = RagSyncPreconditionCode | SourceErrorCode;
import type { EmbeddingBatchCache } from './embeddingCache';
export type TaskStatus = 'queued' | 'running' | 'pausing' | 'paused' | 'completed' | 'cancelled' | 'failed' | 'interrupted';
export interface TaskDescriptor {
    kind: 'rag' | 'ingest' | 'source' | 'custom';
    setting?: string;
    source?: string;
    workflow?: string;
    groupName?: string;
    maxMarkdownChars?: number;
}
export interface TaskSnapshot {
    descriptor?: TaskDescriptor;
    savedCount?: number;
    savedDetail?: string;
    savedAt?: number;
    id: string;
    title: string;
    source: string;
    stage: string;
    status: TaskStatus;
    completed: number;
    total: number;
    detail: string;
    updatedAt: number;
    error?: string;
    errorCode?: TaskErrorCode;
}
export interface WorkControl {
    batchCache?: EmbeddingBatchCache;
    saved?(detail: string): void;
    readonly signal: AbortSignal;
    checkpoint(): Promise<void>;
    update(stage: string, completed?: number, total?: number, detail?: string): void;
}
export function cancellationError(): Error {
    const error = new Error('任务已取消');
    error.name = 'AbortError';
    return error;
}
async function waitForSerialTurn(previous: Promise<void>, signal: AbortSignal): Promise<void> {
    if (signal.aborted)
        throw cancellationError();
    await new Promise<void>((resolve, reject) => {
        const abort = () => { signal.removeEventListener('abort', abort); reject(cancellationError()); };
        signal.addEventListener('abort', abort, { once: true });
        previous.then(() => { signal.removeEventListener('abort', abort); resolve(); }, error => { signal.removeEventListener('abort', abort); reject(error instanceof Error ? error : new Error(String(error))); });
        if (signal.aborted)
            abort();
    });
}
export async function controlledRequest<T>(control: WorkControl | undefined, request: (signal: AbortSignal) => Promise<T>, timeoutMs = 90000): Promise<T> {
    await control?.checkpoint();
    const abort = new AbortController();
    let timedOut = false;
    const cancel = () => abort.abort();
    control?.signal.addEventListener('abort', cancel, { once: true });
    if (control?.signal.aborted)
        abort.abort();
    const timer = window.setTimeout(() => { timedOut = true; abort.abort(); }, timeoutMs);
    try {
        return await request(abort.signal);
    }
    catch (error) {
        if (control?.signal.aborted)
            throw cancellationError();
        if (timedOut) {
            const timeout = new Error(`嵌入请求超过 ${Math.round(timeoutMs / 1000)} 秒未完成，可重试或调整服务`);
            timeout.name = 'TimeoutError';
            throw timeout;
        }
        throw error;
    }
    finally {
        window.clearTimeout(timer);
        control?.signal.removeEventListener('abort', cancel);
    }
}
export class ManagedTask implements WorkControl {
    batchCache?: EmbeddingBatchCache;
    private controller = new AbortController();
    private suspended = false;
    private recover?: () => void;
    private pauseRequested = false;
    private wake = new Set<() => void>();
    private state: TaskSnapshot;
    private observers = new Set<() => void>();
    constructor(id: string, title: string, source: string, private changed: () => void, descriptor?: TaskDescriptor) {
        this.state = { id, title, source, descriptor: safeDescriptor(descriptor), savedCount: 0, stage: '等待执行', status: 'queued', completed: 0, total: 0, detail: '', updatedAt: Date.now() };
    }
    restore(snapshot: TaskSnapshot, recover?: () => void): void {
        this.state = { ...snapshot };
        this.recover = recover;
        if (['queued', 'running', 'pausing', 'paused'].includes(this.state.status)) {
            this.pauseRequested = !!recover;
            this.state.status = recover ? 'paused' : 'interrupted';
            this.state.stage = recover ? '已恢复，等待继续' : '运行中断，请检查后从原工作流运行';
        }
    }
    markInterrupted(message: string): void { this.state.status = 'interrupted'; this.state.stage = '无法确认进程退出，请检查原工作流'; this.state.error = message; this.notify(); }
    saved(detail: string): void { this.state.savedCount = (this.state.savedCount || 0) + 1; this.state.savedDetail = detail; this.state.savedAt = Date.now(); this.notify(); }
    suspend(): void {
        if (!['queued', 'running', 'pausing', 'paused'].includes(this.state.status))
            return;
        this.suspended = true;
        this.state.status = this.state.descriptor?.kind === 'rag' || this.state.descriptor?.kind === 'ingest' || this.state.descriptor?.kind === 'source' ? 'paused' : 'interrupted';
        this.state.stage = this.state.status === 'paused' ? '已保存，等待下次继续' : '运行中断，请检查后从原工作流运行';
        this.controller.abort();
        for (const wake of this.wake)
            wake();
        this.wake.clear();
        this.notify();
    }
    get isSuspended(): boolean { return this.suspended; }
    rearm(recover: () => void): void {
        this.controller = new AbortController();
        this.suspended = false;
        this.pauseRequested = true;
        this.recover = recover;
        this.state.status = 'paused';
        this.state.stage = '退出保存失败；可继续或重试保存';
        this.notify();
    }
    get signal(): AbortSignal { return this.controller.signal; }
    get snapshot(): TaskSnapshot { return { ...this.state }; }
    observe(listener: () => void): () => void { this.observers.add(listener); return () => this.observers.delete(listener); }
    acknowledgePause(): void { if (this.pauseRequested && !this.signal.aborted) {
        this.state.status = 'paused';
        this.notify();
    } }
    private notify(): void { this.state.updatedAt = Date.now(); this.changed(); for (const observer of this.observers)
        observer(); }
    update(stage: string, completed = 0, total = 0, detail = ''): void {
        if (this.signal.aborted)
            return;
        this.state = { ...this.state, stage, completed, total, detail, status: this.pauseRequested ? 'pausing' : 'running' };
        this.notify();
    }
    pause(): void {
        if (!['queued', 'running', 'pausing'].includes(this.state.status))
            return;
        this.pauseRequested = true;
        this.state.status = 'pausing';
        this.notify();
    }
    resume(): void {
        if (!this.pauseRequested || this.signal.aborted)
            return;
        const recover = this.recover;
        this.recover = undefined;
        this.pauseRequested = false;
        this.state.status = 'running';
        this.notify();
        for (const wake of this.wake)
            wake();
        this.wake.clear();
        recover?.();
    }
    cancel(): void {
        if (['completed', 'failed', 'cancelled', 'interrupted'].includes(this.state.status))
            return;
        this.state.status = 'cancelled';
        this.controller.abort();
        for (const wake of this.wake)
            wake();
        this.wake.clear();
        this.notify();
    }
    async checkpoint(): Promise<void> {
        if (this.signal.aborted)
            throw cancellationError();
        if (this.pauseRequested) {
            this.state.status = 'paused';
            this.notify();
            await new Promise<void>(resolve => this.wake.add(resolve));
        }
        if (this.signal.aborted)
            throw cancellationError();
    }
    complete(): void {
        if (this.signal.aborted)
            return;
        this.state.status = 'completed';
        this.state.stage = '已完成';
        this.notify();
    }
    fail(error: unknown): void {
        if (this.suspended)
            return;
        if (this.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
            this.cancel();
            return;
        }
        this.state.status = 'failed';
        this.state.error = (error instanceof Error ? error.message : String(error)).slice(0, 500);
        this.state.errorCode = safeTaskErrorCode(error && typeof error === 'object' && 'code' in error ? error.code : undefined);
        this.notify();
    }
}
export class TaskManager {
    private tasks: ManagedTask[] = [];
    private listeners = new Set<() => void>();
    private serialTail: Promise<void> = Promise.resolve();
    private serial = 0;
    private resolver?: (descriptor: TaskDescriptor, task: ManagedTask) => Promise<unknown>;
    private writes = 0;
    private journal?: TaskJournal;
    private writer: Promise<void> = Promise.resolve();
    private timer?: number;
    private active = new Set<Promise<unknown>>();
    private stopping = false;
    lastSaveError?: Error;
    async initialize(journal: TaskJournal, resolver: (descriptor: TaskDescriptor, task: ManagedTask) => Promise<unknown>): Promise<number> {
        this.journal = journal;
        this.resolver = resolver;
        let count = 0;
        for (const state of await journal.load()) {
            const task = new ManagedTask(state.id, state.title, state.source, () => this.emit(), state.descriptor);
            const descriptor = state.descriptor;
            const recover = descriptor && descriptor.kind !== 'custom' ? () => { void this.execute(task, () => resolver(descriptor, task), { serial: descriptor.kind === 'rag' || descriptor.kind === 'source' }).catch(() => { }); } : undefined;
            task.restore(state, recover);
            this.tasks.push(task);
            if (task.snapshot.status === 'paused')
                count++;
        }
        this.emit();
        return count;
    }
    create(title: string, source = '', descriptor?: TaskDescriptor): ManagedTask {
        if (this.stopping)
            throw new Error('正在保存并退出，暂不启动新任务');
        const task = new ManagedTask(`${Date.now()}-${++this.serial}`, title, source, () => this.emit(), descriptor);
        this.tasks.push(task);
        const terminal = this.tasks.filter(t => ['completed', 'cancelled', 'failed', 'interrupted'].includes(t.snapshot.status));
        if (terminal.length > 40) {
            const remove = new Set(terminal.slice(0, -40));
            this.tasks = this.tasks.filter(t => !remove.has(t));
        }
        this.emit();
        return task;
    }
    list(): ManagedTask[] { return this.tasks.slice(); }
    subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
    hasUnfinished(): boolean { return this.active.size > 0 || this.tasks.some(t => ['queued', 'running', 'pausing', 'paused'].includes(t.snapshot.status)) || (this.tasks.length > 0 && (this.writes > 0 || this.timer !== undefined || !!this.lastSaveError)); }
    private notifyListeners(): void {
        for (const listener of this.listeners)
            listener();
    }
    private setSaveError(error?: Error): void {
        const changed = error?.message !== this.lastSaveError?.message;
        this.lastSaveError = error;
        if (changed) this.notifyListeners();
    }
    private emit(): void {
        this.notifyListeners();
        if (this.journal && this.timer === undefined)
            this.timer = window.setTimeout(() => { this.timer = undefined; void this.flush().catch(() => { }); }, 100);
    }
    async flush(): Promise<void> {
        if (this.timer !== undefined) {
            window.clearTimeout(this.timer);
            this.timer = undefined;
        }
        const journal = this.journal;
        if (!journal)
            return;
        const states = this.tasks.map(t => t.snapshot);
        this.writes++;
        const write = this.writer.catch(() => { }).then(() => journal.save(states));
        this.writer = write;
        try {
            await write;
        }
        catch (error) {
            const failure = error instanceof Error ? error : new Error(String(error));
            this.setSaveError(failure);
            throw failure;
        }
        finally {
            this.writes--;
        }
        this.setSaveError();
    }
    async run<T>(title: string, work: (task: ManagedTask) => Promise<T>, options: {
        source?: string;
        signal?: AbortSignal;
        serial?: boolean;
        descriptor?: TaskDescriptor;
    } = {}): Promise<T> {
        const task = this.create(title, options.source, options.descriptor);
        return this.execute(task, () => work(task), options);
    }
    private execute<T>(task: ManagedTask, work: () => Promise<T>, options: {
        signal?: AbortSignal;
        serial?: boolean;
    }): Promise<T> {
        const cancel = () => task.cancel();
        options.signal?.addEventListener('abort', cancel, { once: true });
        if (options.signal?.aborted)
            task.cancel();
        let release: (() => void) | undefined;
        const previous = this.serialTail;
        if (options.serial) {
            const released = new Promise<void>(resolve => { release = resolve; });
            // A cancelled queued task may finish immediately, but its successor
            // must still wait for every earlier writer to leave the serial lane.
            this.serialTail = previous.then(() => released, () => released);
        }
        const pending = (async () => {
            try {
                // A recoverable job must be durable before doing external work.
                await this.flush();
                if (options.serial)
                    await waitForSerialTurn(previous, task.signal);
                await task.checkpoint();
                if (task.snapshot.status === 'queued')
                    task.update('进行中');
                const result = await work();
                await task.checkpoint();
                task.complete();
                await this.flush();
                return result;
            }
            catch (error) {
                if (error instanceof Error && error.name === 'TaskTerminationError')
                    task.markInterrupted(error.message);
                else
                    task.fail(error);
                throw error;
            }
            finally {
                release?.();
                options.signal?.removeEventListener('abort', cancel);
            }
        })();
        this.active.add(pending);
        void pending.then(() => this.active.delete(pending), () => this.active.delete(pending));
        return pending;
    }
    async suspendAll(): Promise<void> {
        this.stopping = true;
        for (const task of this.tasks)
            task.suspend();
        const settled = await Promise.allSettled([...this.active]);
        const unsafe = settled.find(r => r.status === 'rejected' && r.reason instanceof Error && r.reason.name === 'TaskTerminationError');
        try {
            await this.flush();
            if (unsafe?.status === 'rejected')
                throw unsafe.reason;
        }
        catch (error) {
            this.stopping = false;
            for (const task of this.tasks) {
                const descriptor = task.snapshot.descriptor;
                if (task.isSuspended && task.snapshot.status === 'paused' && descriptor && descriptor.kind !== 'custom' && this.resolver) {
                    const resolver = this.resolver;
                    task.rearm(() => { void this.execute(task, () => resolver(descriptor, task), { serial: descriptor.kind === 'rag' || descriptor.kind === 'source' }).catch(() => { }); });
                }
            }
            throw error;
        }
    }
    dispose(): void {
        this.stopping = true;
        for (const task of this.tasks)
            task.suspend();
        if (this.timer !== undefined)
            window.clearTimeout(this.timer);
        void this.flush().catch(() => { });
        this.listeners.clear();
    }
}
