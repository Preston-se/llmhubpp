import type { App } from 'obsidian';
import { repairKnownIngest } from './repairIngest';

/** Materialize editable resources, never replacing an existing user script/workflow. */
export async function installInboxPreset(app: App, pluginDir: string, workspace: string, toolsFolder = `${workspace}/tools`): Promise<void> {
  const io = app.vault.adapter;
  await repairKnownIngest(io, pluginDir, workspace);
  const directory = `${toolsFolder}/llmhubpp-inbox`;
  await repairKnownIngest(io, pluginDir, workspace, directory);
  for (const target of [workspace, toolsFolder, directory]) {
    const parts = target.split('/');
    for (let i = 1; i <= parts.length; i++) { const folder = parts.slice(0, i).join('/'); if (!await io.exists(folder)) await io.mkdir(folder); }
  }
  for (const name of ['source-auto-ingest.ps1', 'Normalize-Xlsx.ps1', 'Publish-Markdown.ps1','Ingest-Receipt.ps1', 'Source-Auto-Ingest.md']) {
    const target = `${directory}/${name}`;
    if (!await io.exists(target)) {
      let text = await io.read(`${pluginDir}/resources/inbox/${name}`);
      if (name.endsWith('.md')) text = text.split('LLMHub/tools/').join(`${toolsFolder}/`);
      await io.write(target, text);
    }
  }
}
