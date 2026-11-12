import type { MigrationFiles } from './unifiedStorage';

/** Copy explicit shortcuts to the new owner, preserving old IDs for rollback. */
export async function migrateLegacyHotkeys(io: MigrationFiles, configDir: string, pluginDir: string): Promise<boolean> {
  const file = `${configDir}/hotkeys.json`;
  if (!await io.exists(file)) return false;
  const original = await io.read(file);
  const parsed: unknown = JSON.parse(original);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid hotkey settings.');
  const keys = parsed as Record<string, unknown>;
  const merged = {...keys};
  let changed = false;
  for (const [id, binding] of Object.entries(keys)) {
    if (!/^(llm-hub|llm-hub-safe-guard):/.test(id)) continue;
    const target = `llmhubpp:${id.slice(id.indexOf(':') + 1)}`;
    if (Object.prototype.hasOwnProperty.call(merged, target)) continue;
    merged[target] = binding;
    changed = true;
  }
  if (!changed) return false;
  const backupDir = `${pluginDir}/legacy-backup`;
  if (!await io.exists(backupDir)) await io.mkdir(backupDir);
  let backup = `${backupDir}/hotkeys.json`;
  for (let serial = 2; await io.exists(backup); serial++) backup = `${backupDir}/hotkeys-${serial}.json`;
  await io.write(backup, original);
  if (await io.read(file) !== original) throw new Error('Hotkey settings changed during migration.');
  await io.write(file, JSON.stringify(merged, null, 2));
  return true;
}
