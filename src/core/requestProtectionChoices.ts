import { createHash, randomUUID } from 'crypto';
import type { DataAdapter } from 'obsidian';
import { ensureStorageDirectory } from './storagePaths';

export interface ProtectionException {
  origin: string;
  model: string;
  reason: string;
  settingsKey: string;
}

/** Local user decisions only. Never include these in Agent-editable settings. */
export class RequestProtectionChoices {
  private tail: Promise<unknown> = Promise.resolve();
  private decisions = new Map<string, boolean>();
  constructor(private readonly io: DataAdapter, private readonly path: string,
    private readonly choose: (scope: ProtectionException) => Promise<boolean | undefined>) {}

  private key(scope: ProtectionException): string {
    return createHash('sha256').update(JSON.stringify(scope)).digest('hex');
  }

  known(scope: ProtectionException): boolean | undefined {
    return this.decisions.get(this.key(scope));
  }

  async remembered(scope: ProtectionException): Promise<boolean | undefined> {
    return this.readOrChoose(scope, false);
  }

  /** Serialize prompts with the local choice log. Closing a prompt declines this request without saving a choice. */
  async allow(scope: ProtectionException): Promise<boolean> {
    return (await this.readOrChoose(scope, true)) === true;
  }

  async rememberAllow(scope: ProtectionException): Promise<void> {
    await this.readOrChoose(scope, true, true);
  }

  private async readOrChoose(scope: ProtectionException, ask: boolean, decisionOverride?: boolean): Promise<boolean | undefined> {
    const task = this.tail.then(async () => {
      const key = this.key(scope);
      const known = this.decisions.get(key);
      if (known !== undefined) return known;
      const raw: unknown = await this.io.exists(this.path) ? JSON.parse(await this.io.read(this.path)) : {};
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('已记住的保护选择无效，请在设置中重置后重试');
      const values = raw as Record<string, unknown>;
      const generation = values.generation ?? 'initial';
      if (typeof generation !== 'string' || !/^(initial|[a-f0-9-]{36})$/.test(generation)) throw new Error('保护选择代次无效，请重置后重试');
      if (Object.prototype.hasOwnProperty.call(values, key) && typeof values[key] === 'boolean') {
        this.decisions.set(key, values[key]);
        return values[key];
      }
      const directory = this.path + '.entries/' + generation;
      const entry = directory + '/' + key + '.json';
      if (await this.io.exists(entry)) {
        const saved: unknown = JSON.parse(await this.io.read(entry));
        if (typeof saved !== 'boolean') throw new Error('已记住的保护选择无效，请重置后重试');
        this.decisions.set(key, saved);
        return saved;
      }
      if (!ask) return undefined;
      const decision = decisionOverride ?? await this.choose(scope);
      if (decision === undefined) return undefined;
      await ensureStorageDirectory(this.io, directory);
      const pending = entry + '.' + randomUUID() + '.tmp';
      await this.io.write(pending, JSON.stringify(decision));
      await this.io.rename(pending, entry);
      this.decisions.set(key, decision);
      return decision;
    });
    this.tail = task.catch(() => undefined);
    return task;
  }

  async reset(): Promise<void> {
    const task = this.tail.then(async () => {
      await ensureStorageDirectory(this.io, this.path.slice(0, this.path.lastIndexOf('/')));
      await this.io.write(this.path, JSON.stringify({ generation: randomUUID() }));
      this.decisions.clear();
    });
    this.tail = task.catch(() => undefined);
    return task;
  }
}
