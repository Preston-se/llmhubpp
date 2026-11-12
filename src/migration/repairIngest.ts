import type { MigrationFiles } from './unifiedStorage';

/** Repair the known V2.2 preset in place, never guessing about a user-edited parser. */
export async function repairKnownIngest(io: MigrationFiles, pluginDir: string, workspace: string, directory = `${workspace}/tools`): Promise<boolean> {
  const target = `${directory}/source-auto-ingest.ps1`;
  if (!await io.exists(target)) return false;
  const original = await io.read(target);
  const legacy = await io.read(`${pluginDir}/resources/inbox/source-auto-ingest.legacy.ps1`);
  const normalized = (text: string) => text.replace(/\r\n/g, '\n');
  const fixedLegacy = `${pluginDir}/resources/inbox/source-auto-ingest.v2.2-fixed.ps1`;
  const matchesPrevious = await io.exists(fixedLegacy) && normalized(original) === normalized(await io.read(fixedLegacy));
  const r6=`${pluginDir}/resources/inbox/source-auto-ingest.r6.ps1`;
  const matchesR6=await io.exists(r6)&&normalized(original)===normalized(await io.read(r6));
  if (normalized(original) !== normalized(legacy) && !matchesPrevious && !matchesR6) return false;
  const helper = `${directory}/Normalize-Xlsx.ps1`;
  const helperText = await io.read(`${pluginDir}/resources/inbox/Normalize-Xlsx.ps1`);
  if (await io.exists(helper) && normalized(await io.read(helper)) !== normalized(helperText)) return false;
  const publisher = `${directory}/Publish-Markdown.ps1`;
  const publisherResource = `${pluginDir}/resources/inbox/Publish-Markdown.ps1`;
  const publisherText = await io.read(publisherResource);
  const oldPublisher=await io.exists(publisher)?await io.read(publisher):undefined;
  const previousPublisher=`${pluginDir}/resources/inbox/Publish-Markdown.r6.ps1`;
  if(oldPublisher!==undefined&&normalized(oldPublisher)!==normalized(publisherText)&&(!await io.exists(previousPublisher)||normalized(oldPublisher)!==normalized(await io.read(previousPublisher))))return false;
  const receipt=`${directory}/Ingest-Receipt.ps1`,receiptText=await io.read(`${pluginDir}/resources/inbox/Ingest-Receipt.ps1`);
  if(await io.exists(receipt)&&normalized(await io.read(receipt))!==normalized(receiptText))return false;
  const fixed = await io.read(`${pluginDir}/resources/inbox/source-auto-ingest.ps1`);
  const backupDir = `${pluginDir}/legacy-backup`;
  if (!await io.exists(backupDir)) await io.mkdir(backupDir);
  let backup = `${backupDir}/source-auto-ingest.ps1`;
  for (let serial = 2; await io.exists(backup); serial++) backup = `${backupDir}/source-auto-ingest-${serial}.ps1`;
  await io.write(backup, original);
  if (await io.read(target) !== original) throw new Error('Inbox script changed during compatibility repair.');
  if (!await io.exists(helper)) await io.write(helper, helperText);
  if(oldPublisher!==undefined&&normalized(oldPublisher)!==normalized(publisherText)){
    let publisherBackup=`${backupDir}/Publish-Markdown.ps1`;
    for(let serial=2;await io.exists(publisherBackup);serial++)publisherBackup=`${backupDir}/Publish-Markdown-${serial}.ps1`;
    await io.write(publisherBackup,oldPublisher);
    if(await io.read(publisher)!==oldPublisher)throw new Error('Publisher changed during compatibility repair.');
  }
  await io.write(publisher,publisherText);
  if(!await io.exists(receipt))await io.write(receipt,receiptText);
  await io.write(target, fixed);
  return true;
}
