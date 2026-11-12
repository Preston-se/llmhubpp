import { MarkdownView, type App } from 'obsidian';
import type { AnswerSource } from 'src/core/answerCitations';
import { getRagSourceStatus } from 'src/core/ragSourceStatus';
import { chatLinkFileRef } from './localFileLink';
import { getLocalRagStore } from 'src/core/localRagStore';

function normalized(value: string): { text: string; offsets: number[] } {
  const chars: string[] = [], offsets: number[] = [];
  for (let index = 0; index < value.length; index++) {
    const char = /\s/.test(value[index]) ? ' ' : value[index];
    if (char === ' ' && chars[chars.length - 1] === ' ') continue;
    chars.push(char);
    offsets.push(index);
  }
  return { text: chars.join(''), offsets };
}

export function findExcerptRange(content: string, source: AnswerSource): { from: number; to: number } | null {
  const haystack = normalized(content);
  const whole = normalized(source.text.trim()).text;
  if (!whole) return null;
  const excerpts = [whole, ...source.text.split(/\n\s*\n/).map(part => normalized(part.trim()).text).filter(part => part.length >= 40)];
  for (const excerpt of excerpts) {
    const first = haystack.text.indexOf(excerpt);
    if (first < 0) continue;
    const ranges: Array<{ from: number; to: number }> = [];
    let index = first;
    while (index >= 0) {
      ranges.push({ from: haystack.offsets[index], to: haystack.offsets[index + excerpt.length - 1] + 1 });
      index = haystack.text.indexOf(excerpt, index + 1);
    }
    const exact = ranges.find(range => range.from === source.documentOffset);
    if (exact) return exact;
    if (ranges.length === 1) return ranges[0];
  }
  return null;
}

export async function openCitationSource(app: App, source: AnswerSource): Promise<'located' | 'opened' | 'missing' | 'failed'> {
  try {
    const adapter = app.vault.adapter as typeof app.vault.adapter & { basePath?: string };
    let path=source.filePath;
    if(source.documentId&&source.indexSetting){
      const current=await getLocalRagStore()?.resolveDocument(app,source.indexSetting,source.documentId);
      if(!current)return 'missing';
      path=current;
    }
    const target = chatLinkFileRef(path, adapter.basePath ?? '');
    if (!target) return 'failed';
    if (await getRagSourceStatus(app, target.path) === 'missing') return 'missing';
    if (target.scope === 'absolute') {
      const require = (window as unknown as { require?: (name: string) => { shell?: { openPath(path: string): Promise<string> } } }).require;
      const shell = require?.('electron').shell;
      return shell && !await shell.openPath(target.path) ? 'opened' : 'failed';
    }
    const page = source.pageLabel?.match(/pages?\s+(\d+)/i)?.[1];
    await app.workspace.openLinkText(target.path + (page ? `#page=${page}` : ''), '', false);
    if (page) return 'located';
    if (!/\.md(?:#.*)?$/i.test(target.path)) return 'opened';
    const active = app.workspace.getActiveViewOfType(MarkdownView);
    const view = active?.file?.path === target.path ? active : app.workspace.getLeavesOfType('markdown')
      .map(leaf => leaf.view).find((candidate): candidate is MarkdownView => candidate instanceof MarkdownView && candidate.file?.path === target.path);
    if (!view) return 'opened';
    const range = findExcerptRange(view.editor.getValue(), source);
    if (!range) return 'opened';
    const from = view.editor.offsetToPos(range.from), to = view.editor.offsetToPos(range.to);
    view.editor.setSelection(from, to);
    view.editor.scrollIntoView({ from, to }, true);
    return 'located';
  } catch {
    return 'failed';
  }
}
