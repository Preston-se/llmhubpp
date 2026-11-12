import type { DataAdapter } from 'obsidian';
import type { TaskDescriptor, TaskSnapshot, TaskErrorCode } from './taskManager';
import { ensureStorageDirectory } from './storagePaths';

const ERROR_CODES = new Set<TaskErrorCode>(['store-unavailable', 'setting-not-found', 'index-not-syncable', 'embedding-missing',
    'missing', 'unsupported', 'no-text', 'corrupt', 'encrypted', 'too-large', 'source-changed', 'manifest-invalid', 'invalid-pattern', 'index-conflict', 'conversion-failed']);
const KNOWN_STAGES = new Set([
    '等待执行', '进行中', '已完成', '已恢复，等待继续', '运行中断，请检查后从原工作流运行',
    '已保存，等待下次继续', '退出保存失败；可继续或重试保存', '无法确认进程退出，请检查原工作流',
    '扫描RAG文档', '准备RAG分块', '生成RAG向量', '保存RAG索引', '已保存可检索', '已处理空文档',
    '正在转换/执行脚本', '等待文件稳定', '归档原件', '正在转换Markdown', '拆分Markdown',
    '发布文档分段', '文档转换完成', '已暂停',
]);
const UNSAFE_IDENTIFIER = /(?:https?:\/\/|bearer\s+\S+|(?:api[_\s-]?key|access[_\s-]?token|authorization|password|secret|token)["']?\s*[:=]|[?&](?:[^=\s]+)=|\bsk-[a-z0-9_-]{8,})/i;

export function safeTaskErrorCode(raw: unknown): TaskErrorCode | undefined {
    return typeof raw === 'string' && ERROR_CODES.has(raw as TaskErrorCode) ? raw as TaskErrorCode : undefined;
}
function safeIdentifier(value: unknown, max = 4096): string {
    return typeof value === 'string' && value.length <= max && !UNSAFE_IDENTIFIER.test(value)
        && !Array.from(value).some(character => character.charCodeAt(0) < 32) ? value : '';
}
function safeText(value: unknown, max = 4096): string {
    const s = typeof value === 'string' ? value : '';
    return s.replace(/([?&](?:api_key|key|token|secret)=)[^&\s]+/gi, '$1[redacted]').replace(/(Bearer\s+)[^\s]+/gi, '$1[redacted]').slice(0, max);
}
export function safeDescriptor(raw: unknown): TaskDescriptor | undefined {
    if (!raw || typeof raw !== 'object')
        return undefined;
    const d = raw as Record<string, unknown>;
    if (!['rag', 'ingest', 'source', 'custom'].includes(String(d.kind)))
        return undefined;
    return { kind: d.kind as TaskDescriptor['kind'], setting: safeText(d.setting), source: safeText(d.source), workflow: safeText(d.workflow), groupName: safeText(d.groupName, 255) || undefined, maxMarkdownChars: typeof d.maxMarkdownChars === 'number' && Number.isInteger(d.maxMarkdownChars) && d.maxMarkdownChars >= 1000 && d.maxMarkdownChars <= 1000000 ? d.maxMarkdownChars : undefined };
}
function persistedDescriptor(raw: unknown): TaskDescriptor | undefined {
    const descriptor = safeDescriptor(raw);
    if (!descriptor) return undefined;
    const d = raw as Record<string, unknown>;
    const fields = ['setting', 'source', 'workflow', 'groupName'] as const;
    const unsafe = fields.some(field => typeof d[field] === 'string' && d[field] !== '' && !safeIdentifier(d[field]));
    // Never resume using an altered path or setting: preserve an interrupted record instead.
    if (unsafe) return { kind: 'custom' };
    return descriptor;
}
function sanitize(raw: unknown): TaskSnapshot | null {
    if (!raw || typeof raw !== 'object')
        return null;
    const d = raw as Record<string, unknown>;
    if (typeof d.id !== 'string' || !/^\d+-\d+$/.test(d.id) || !['queued', 'running', 'pausing', 'paused', 'completed', 'cancelled', 'failed', 'interrupted'].includes(String(d.status)))
        return null;
    const number = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
    return { id: safeText(d.id, 100), title: safeIdentifier(d.title) || '任务', source: safeIdentifier(d.source),
        stage: typeof d.stage === 'string' && KNOWN_STAGES.has(d.stage) ? d.stage : '任务进度',
        status: d.status as TaskSnapshot['status'], completed: number(d.completed), total: number(d.total),
        detail: safeIdentifier(d.detail), updatedAt: number(d.updatedAt),
        error: d.error ? '任务失败；原始错误仅在当前会话显示，请检查原工作流或服务' : undefined,
        errorCode: safeTaskErrorCode(d.errorCode), descriptor: persistedDescriptor(d.descriptor),
        savedCount: number(d.savedCount), savedDetail: safeIdentifier(d.savedDetail), savedAt: number(d.savedAt) };
}
export class TaskJournal {
    private sequence = 0;
    constructor(private io: DataAdapter, private directory: string) { }
    async load(): Promise<TaskSnapshot[]> {
        if (!await this.io.exists(this.directory))
            return [];
        const paths = (await this.io.list(this.directory)).files.filter(p => /\/tasks-[0-9]+\.json$/.test(p)).sort().reverse();
        if (paths.length)
            this.sequence = Number(/tasks-(\d+)/.exec(paths[0])?.[1] || 0);
        for (const path of paths) {
            try {
                const data = JSON.parse(await this.io.read(path)) as {
                    version: number;
                    tasks: unknown[];
                };
                if (data.version !== 1 || !Array.isArray(data.tasks))
                    continue;
                const tasks = data.tasks.map(sanitize);
                if (tasks.every((t): t is TaskSnapshot => t !== null))
                    return tasks;
            }
            catch { /* Try previous complete journal. */ }
        }
        if (paths.length)
            throw new Error('任务记录损坏，已保留文件，未自动启动任务');
        return [];
    }
    async save(tasks: TaskSnapshot[]): Promise<void> {
        if (!await this.io.exists(this.directory))
            await ensureStorageDirectory(this.io, this.directory);
        this.sequence = Math.max(Date.now(), this.sequence + 1);
        const path = `${this.directory}/tasks-${this.sequence}.json`;
        const text = JSON.stringify({ version: 1, tasks: tasks.map(sanitize) });
        await this.io.write(path + '.tmp', text);
        await this.io.rename(path + '.tmp', path);
        const old = (await this.io.list(this.directory)).files.filter(p => /\/tasks-[0-9]+\.json$/.test(p)).sort().reverse().slice(2);
        for (const name of old)
            try {
                await this.io.remove(name);
            }
            catch { /* Retention cannot turn a successful save into failure. */ }
    }
}
