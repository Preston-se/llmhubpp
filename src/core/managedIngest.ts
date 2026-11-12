import type { App } from 'obsidian';
import type { WorkflowNode, ExecutionContext } from '../workflow/types';
import type { TaskDescriptor, ManagedTask } from './taskManager';
import { parseWorkflowFromMarkdown } from 'obsidian-llm-hub-common/workflow';
import { handleShellNode } from '../workflow/handlers/shell';
import { replaceVariables } from '../workflow/handlers/utils';
const normalize = (s: string) => s.replace(/\r\n/g, '\n').trim();
const vmWrapper = "param([Parameter(Mandatory=$true)][string]$SourceRelativePath)\n$ErrorActionPreference = 'Stop'\n$env:PATH = 'C:\\Program Files\\Pandoc;C:\\Program Files\\7-Zip;' + $env:PATH\n& (Join-Path $PSScriptRoot 'source-auto-ingest.ps1') -SourceRelativePath $SourceRelativePath\nexit $LASTEXITCODE";
export async function describeShellTask(app: App, node: WorkflowNode, context: ExecutionContext, pluginDir: string, selected: string): Promise<TaskDescriptor> {
    const source = String(context.variables.get('_eventFilePath') || '');
    let workflow = '', setting = selected;
    const io = app.vault.adapter;
    for (const file of app.vault.getMarkdownFiles().filter(f => (f.path.startsWith('workflows/') || f.path.includes('/tools/')) && f.stat.size < 200000)) {
        try {
            const parsed = parseWorkflowFromMarkdown(await app.vault.read(file));
            const match = parsed.nodes.get(node.id);
            if (match && match.properties.command === node.properties.command && match.properties.args === node.properties.args) {
                workflow = file.path;
                const rag = [...parsed.nodes.values()].find(n => n.type === 'rag-sync');
                setting = rag?.properties.ragSetting || selected;
                break;
            }
        }
        catch { /* Non-workflow notes are normal. */ }
    }
    const custom: TaskDescriptor = { kind: 'custom', source, workflow };
    const command = replaceVariables(node.properties.command || '', context).replace(/\\/g, '/').toLowerCase();
    if (!['pwsh', 'pwsh.exe', 'c:/program files/powershell/7/pwsh.exe'].includes(command))
        return custom;
    if (node.properties.cwd)
        return custom;
    if (node.properties.env) {
        try {
            if (Object.keys(JSON.parse(node.properties.env) as object).length)
                return custom;
        }
        catch {
            return custom;
        }
    }
    if (!source.startsWith('22-SaveFromInternet/00-Inbox/') || source.slice('22-SaveFromInternet/00-Inbox/'.length).includes('/'))
        return custom;
    try {
        const args = JSON.parse(replaceVariables(node.properties.args || '[]', context)) as unknown;
        if (!Array.isArray(args) || !args.every(a => typeof a === 'string'))
            return custom;
        const options = new Map<string, string>();
        for (let i = 0; i < args.length; i++) {
            const flag = args[i].toLowerCase();
            if (options.has(flag))
                return custom;
            if (flag === '-noprofile') {
                options.set(flag, '');
                continue;
            }
            if (!['-executionpolicy', '-file', '-sourcerelativepath', '-groupname', '-maxmarkdownchars'].includes(flag) || i + 1 >= args.length)
                return custom;
            options.set(flag, args[++i]);
        }
        if (options.get('-executionpolicy') && !['bypass', 'remotesigned'].includes(options.get('-executionpolicy')!.toLowerCase()))
            return custom;
        if (options.get('-sourcerelativepath') !== source)
            return custom;
        const groupName = options.get('-groupname'), maxRaw = options.get('-maxmarkdownchars'), maxMarkdownChars = maxRaw ? Number(maxRaw) : undefined;
        if (groupName && (/[<>:"/\\|?*]/.test(groupName) || ['.', '..'].includes(groupName)))
            return custom;
        if (maxMarkdownChars !== undefined && (!Number.isInteger(maxMarkdownChars) || maxMarkdownChars < 1000 || maxMarkdownChars > 1000000))
            return custom;
        const path = options.get('-file');
        if (!path)
            return custom;
        let script = await io.read(path);
        let directory = path.slice(0, path.lastIndexOf('/'));
        if (/(?:^|[\\/])vm-source-auto-ingest\.ps1$/i.test(path)) {
            if (options.has('-groupname') || options.has('-maxmarkdownchars') || normalize(script) !== normalize(vmWrapper))
                return custom;
            script = await io.read(path.replace(/vm-source-auto-ingest\.ps1$/i, 'source-auto-ingest.ps1'));
        }
        else if (!/(?:^|[\\/])source-auto-ingest\.ps1$/i.test(path))
            return custom;
        if (normalize(script) !== normalize(await io.read(`${pluginDir}/resources/inbox/source-auto-ingest.ps1`)))
            return custom;
        for (const helper of ['Publish-Markdown.ps1', 'Ingest-Receipt.ps1', 'Normalize-Xlsx.ps1'])
            if (normalize(await io.read(`${directory}/${helper}`)) !== normalize(await io.read(`${pluginDir}/resources/inbox/${helper}`)))
                return custom;
        return { kind: 'ingest', source, workflow, setting, groupName, maxMarkdownChars };
    }
    catch {
        return custom;
    }
}
export async function resumeManagedIngest(app: App, pluginDir: string, descriptor: TaskDescriptor, task: ManagedTask): Promise<void> {
    const source = descriptor.source || '';
    const base = (app.vault.adapter as {
        basePath?: string;
    }).basePath || '.';
    const runtime = window as unknown as {
        require: (id: string) => unknown;
    };
    const fs = runtime.require('fs') as typeof import('fs');
    const processEnv = (runtime.require('process') as typeof process).env;
    const candidates = [`${processEnv.ProgramFiles || 'C:/Program Files'}/PowerShell/7/pwsh.exe`];
    const command = candidates.find(p => fs.existsSync(p)) || 'pwsh';
    const paths = [processEnv.PATH || '', `${processEnv.ProgramFiles || 'C:/Program Files'}/Pandoc`, `${processEnv.ProgramFiles || 'C:/Program Files'}/7-Zip`].join(';');
    const node: WorkflowNode = { id: 'resume-managed-ingest', canvasNodeId: '', type: 'shell', properties: { command, args: JSON.stringify(['-NoProfile', '-File', `${base}/${pluginDir}/resources/inbox/source-auto-ingest.ps1`, '-SourceRelativePath', source, ...(descriptor.groupName ? ['-GroupName', descriptor.groupName] : []), ...(descriptor.maxMarkdownChars ? ['-MaxMarkdownChars', String(descriptor.maxMarkdownChars)] : [])]), env: JSON.stringify({ PATH: paths }), timeout: '600000', throwOnError: 'true' } };
    await handleShellNode(node, { variables: new Map([['_eventFilePath', source]]), logs: [] }, app, task);
}
