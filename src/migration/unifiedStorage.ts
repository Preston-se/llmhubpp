export interface MigrationFiles {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  write(path: string, text: string): Promise<unknown>;
  mkdir(path: string): Promise<unknown>;
}

/** First-run migration only. Existing new settings always win; legacy files stay intact. */
export async function initializeUnifiedStorage(io: MigrationFiles, configDir: string, destinationDir: string): Promise<void> {
  const plans: Array<{source: string; target: string; backup: string; text: string}> = [];
  for (const [id, filename] of [['llm-hub', 'data.json'], ['llm-hub-safe-guard', 'safe-guard.json']]) {
    const source = `${configDir}/plugins/${id}/data.json`;
    const target = `${destinationDir}/${filename}`;
    if (await io.exists(target) || !await io.exists(source)) continue;
    const text = await io.read(source);
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`Invalid legacy settings: ${id}`);
    plans.push({source, target, backup: `${destinationDir}/legacy-backup/${id}.json`, text});
  }
  if (!plans.length) return;
  const backupDir = `${destinationDir}/legacy-backup`;
  if (!await io.exists(backupDir)) await io.mkdir(backupDir);
  for (const plan of plans) {
    if (await io.exists(plan.backup)) {
      if (await io.read(plan.backup) !== plan.text) throw new Error('Legacy source changed since backup; refusing to overwrite backup.');
    } else await io.write(plan.backup, plan.text);
    if (await io.read(plan.source) !== plan.text) throw new Error('Legacy settings changed during migration.');
    if (await io.exists(plan.target)) throw new Error('Destination changed during migration.');
    await io.write(plan.target, plan.text);
  }
}
