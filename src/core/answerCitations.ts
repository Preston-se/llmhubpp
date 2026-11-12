import type { Message } from 'src/types';
import { readGroundedEvidence } from './groundedAnswer';

export interface CitationToken { id: number; start: number; end: number }
export interface AnswerSource {
  id: number;
  filePath: string;
  text: string;
  chunkIndex?: number;
  heading?: string;
  documentOffset?: number;
  documentId?: string;
  documentRevision?: string;
  chunkId?: string;
  indexSetting?: string;
  pageLabel?: string;
}
export interface AnswerCitations {
  sources: AnswerSource[];
  unknownIds: number[];
  status: 'cited' | 'uncited' | 'legacy-unmapped' | 'none';
}

/** Offsets refer to the original answer, never to an indexed document. */
function citationOccurrences(content: string): Array<CitationToken & { escaped: boolean }> {
  const ignored: Array<[number, number]> = [];
  const blocks = /(^|\n)[ \t]{0,3}(`{3,}|~{3,})[^\n]*\n/g;
  let fence: RegExpExecArray | null;
  while ((fence = blocks.exec(content))) {
    const marker = fence[2];
    const close = new RegExp('(?:^|\\n)[ \\t]{0,3}' + marker[0] + '{' + marker.length + ',}[^\\n]*(?=\\n|$)', 'g');
    close.lastIndex = blocks.lastIndex;
    const end = close.exec(content);
    const stop = end ? close.lastIndex : content.length;
    ignored.push([fence.index, stop]);
    blocks.lastIndex = stop;
  }
  const patterns = [
    /(`+)[\s\S]*?\1/g,
    /\[[^\]\n]*\]\([^\n]*?\)/g,
    /(^|\n)[ \t]{0,3}\[\d+\]:[^\n]*/g,
    /\$\$[\s\S]*?\$\$|\$[^$\n]+\$/g,
    /<(?:pre|code|script|style|math)\b[^>]*>[\s\S]*?<\/(?:pre|code|script|style|math)>/gi,
    /<!--[^]*?-->/g,
    /(?:^|\n\n)(?:(?: {4}|\t)[^\n]*(?:\n|$))+/g,
    /!?\[\[[^\n]*?\]\]/g,
  ];
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) ignored.push([match.index, match.index + match[0].length]);
  }
  const referenceLabels = new Set(Array.from(content.matchAll(/(?:^|\n)[ \t]{0,3}\[([^\]\n]+)\]:/g), match => match[1].toLowerCase()));
  for (const match of content.matchAll(/\[[^\]\n]*\]\[([^\]\n]+)\]/g)) {
    if (referenceLabels.has(match[1].toLowerCase())) ignored.push([match.index, match.index + match[0].length]);
  }
  for (const match of content.matchAll(/\[([^\]\n]+)\]/g)) {
    if (referenceLabels.has(match[1].toLowerCase())) ignored.push([match.index, match.index + match[0].length]);
  }
  const tokens: Array<CitationToken & { escaped: boolean }> = [];
  for (const match of content.matchAll(/\[([1-9]\d*)\]/g)) {
    const start = match.index;
    let slashes = 0;
    for (let index = start - 1; index >= 0 && content[index] === '\\'; index--) slashes++;
    if (ignored.some(([from, to]) => start >= from && start < to)) continue;
    tokens.push({ id: Number(match[1]), start, end: start + match[0].length, escaped: slashes % 2 !== 0 });
  }
  return tokens;
}

export function parseCitationTokens(content: string): CitationToken[] {
  return citationOccurrences(content).filter(token => !token.escaped).map(({ id, start, end }) => ({ id, start, end }));
}

/** Match rendered occurrences in order, including escaped literals that Markdown unescapes. */
export function getRenderedCitationTokens(content: string, rendered: readonly string[]): CitationToken[][] {
  const occurrences = citationOccurrences(content);
  let cursor = 0;
  return rendered.map(text => {
    const tokens: CitationToken[] = [];
    for (const match of text.matchAll(/\[([1-9]\d*)\]/g)) {
      const id = Number(match[1]);
      const next = occurrences[cursor];
      // Do not decorate an unexpected rendered marker (e.g. one produced by HTML).
      if (!next || next.id !== id) continue;
      cursor++;
      if (!next.escaped) tokens.push({ id, start: match.index, end: match.index + match[0].length });
    }
    return tokens;
  });
}

/** Select only evidence the answer actually cites, keeping the original numbering. */
export function getAnswerCitations(message: Message): AnswerCitations {
  const evidence = readGroundedEvidence(message);
  if (!evidence) {
    const historical = !!(message.ragSources?.length || message.ragContexts?.length || message.ragCitations?.length);
    return { sources: [], unknownIds: [], status: historical ? 'legacy-unmapped' : 'none' };
  }
  const ids = [...new Set(parseCitationTokens(message.content).map(token => token.id))];
  const byId = new Map(evidence.sources.map(source => [source.id, source]));
  const sources = ids.flatMap(id => { const source = byId.get(id); return source ? [source] : []; });
  return { sources, unknownIds: ids.filter(id => !byId.has(id)), status: sources.length ? 'cited' : 'uncited' };
}
