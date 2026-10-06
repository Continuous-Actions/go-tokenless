// Surgical text edits on YAML files. Workflows are parsed with `yaml` to find
// nodes, but changes are applied as line-level text patches so the rest of the
// file (comments, quoting, flow style, blank lines) stays byte-for-byte intact.

import { isMap, isPair, isScalar, isSeq, type Document, type Pair, type YAMLMap, type Node } from 'yaml';

export type TextEdit = { start: number; end: number; text: string };

export class Source {
  readonly lineStarts: number[] = [0];
  readonly text: string;
  constructor(text: string) {
    this.text = text;
    for (let i = 0; i < text.length; i++) if (text[i] === '\n') this.lineStarts.push(i + 1);
  }
  /** 0-based line index containing `offset`. */
  lineOf(offset: number): number {
    let lo = 0, hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.lineStarts[mid]! <= offset) lo = mid; else hi = mid - 1;
    }
    return lo;
  }
  lineStart(line: number): number {
    return this.lineStarts[line] ?? this.text.length;
  }
  /** Offset just past the newline that ends `line` (or end of text). */
  lineEnd(line: number): number {
    return this.lineStarts[line + 1] ?? this.text.length;
  }
  column(offset: number): number {
    return offset - this.lineStart(this.lineOf(offset));
  }
  lineText(line: number): string {
    return this.text.slice(this.lineStart(line), this.lineEnd(line)).replace(/\r?\n$/, '');
  }
}

export function applyEdits(text: string, edits: TextEdit[]): string {
  // Apply back to front. Inserts at the same offset are applied last-pushed
  // first, so they end up in the order they were pushed.
  const sorted = edits.map((e, i) => ({ e, i })).sort((a, b) => b.e.start - a.e.start || b.e.end - a.e.end || b.i - a.i).map((x) => x.e);
  let out = text;
  let floor = Infinity;
  for (const e of sorted) {
    if (e.end > floor) continue; // overlapping edit: keep the later one, drop this
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
    floor = e.start;
  }
  return out;
}

const NL = (text: string) => (text.includes('\r\n') ? '\r\n' : '\n');

export function getPair(map: unknown, key: string): Pair<any, any> | undefined {
  if (!isMap(map)) return undefined;
  return map.items.find((p) => isScalar(p.key) && p.key.value === key) as Pair<any, any> | undefined;
}

export function get(map: unknown, key: string): any {
  return getPair(map, key)?.value;
}

export function str(node: unknown): string | undefined {
  if (isScalar(node)) return node.value == null ? undefined : String(node.value);
  return undefined;
}

/** Text edit that deletes a block-map pair (all of its lines). */
export function deletePair(src: Source, pair: Pair<any, any>, parent?: YAMLMap): TextEdit {
  const keyStart = (pair.key as Node).range![0];
  const value = pair.value as Node | null;
  const end = value?.range ? value.range[1] : (pair.key as Node).range![1];
  const first = src.lineOf(keyStart);
  const last = src.lineOf(Math.max(keyStart, end - 1));
  // `- env: ...` as the first key of a list item: keep the dash and pull the next key up to it.
  const before = src.text.slice(src.lineStart(first), keyStart);
  if (/-\s*$/.test(before) && /\S/.test(before)) {
    const idx = parent ? parent.items.indexOf(pair) : -1;
    const next = idx >= 0 ? parent!.items[idx + 1] : undefined;
    if (next) return { start: keyStart, end: (next.key as Node).range![0], text: '' };
  }
  return { start: src.lineStart(first), end: src.lineEnd(last), text: '' };
}

/** Indentation (spaces) of the keys in a block map. */
export function keyIndent(src: Source, map: YAMLMap): number {
  const first = map.items[0];
  return first ? src.column((first.key as Node).range![0]) : 0;
}

/** Offset after the last line of a block map (where a new key can be appended). */
export function mapEnd(src: Source, map: YAMLMap): number {
  const last = map.items[map.items.length - 1]!;
  const node = (last.value ?? last.key) as Node;
  const end = node.range ? node.range[1] : (last.key as Node).range![1];
  return src.lineEnd(src.lineOf(Math.max(0, end - 1)));
}

/** Render `key: value` lines (value may be a nested record of scalars) at `indent`. */
export function renderPair(key: string, value: string | Record<string, string>, indent: number, unit: number, nl: string): string {
  const pad = ' '.repeat(indent);
  if (typeof value === 'string') return `${pad}${key}: ${value}${nl}`;
  return `${pad}${key}:${nl}` + Object.entries(value).map(([k, v]) => `${' '.repeat(indent + unit)}${k}: ${v}${nl}`).join('');
}

/**
 * Add `key: value` to a map. Block maps get a new line after the last key (or
 * before `before`, when given and present); flow maps are rewritten in place.
 */
export function addPair(src: Source, map: YAMLMap, key: string, value: string | Record<string, string>, opts: { before?: string; unit?: number } = {}): TextEdit {
  const nl = NL(src.text);
  if (map.flow) {
    const [s, e] = map.range!;
    const inner = src.text.slice(s, e).replace(/^\{\s*/, '').replace(/\s*\}$/, '').trim();
    const add = typeof value === 'string' ? `${key}: ${value}` : `${key}: { ${Object.entries(value).map(([k, v]) => `${k}: ${v}`).join(', ')} }`;
    return { start: s, end: e, text: `{ ${inner ? `${inner}, ${add}` : add} }` };
  }
  const indent = keyIndent(src, map);
  const unit = opts.unit ?? 2;
  const anchor = opts.before ? getPair(map, opts.before) : undefined;
  let at = anchor ? src.lineStart(src.lineOf((anchor.key as Node).range![0])) : mapEnd(src, map);
  if (anchor) {
    // Insert above any comment lines that introduce the anchor key.
    // Only comment lines at the key's own indent, and never inside the previous value
    // (a `#` line in a multi-line string is not a comment).
    const idx = map.items.indexOf(anchor);
    const prev = idx > 0 ? map.items[idx - 1] : undefined;
    const prevNode = (prev?.value ?? prev?.key) as Node | undefined;
    const floor = prevNode?.range ? src.lineOf(Math.max(0, prevNode.range[1] - 1)) + 1 : 0;
    let line = src.lineOf(at);
    while (line - 1 >= floor && /^\s*#/.test(src.lineText(line - 1)) && src.lineText(line - 1).search(/\S/) === indent) line--;
    at = src.lineStart(line);
  }
  let text = renderPair(key, value, indent, unit, nl);
  // mapEnd can land at end-of-file without a trailing newline.
  if (at === src.text.length && !src.text.endsWith('\n')) text = nl + text;
  return { start: at, end: at, text };
}

/** Insert a step (rendered from simple key/values) before an existing step. */
export function insertStepBefore(src: Source, step: Node, fields: Array<[string, string | Record<string, string>]>, unit = 2): TextEdit {
  const nl = NL(src.text);
  const start = step.range![0];
  let line = src.lineOf(start);
  let lineText = src.lineText(line);
  let dash = lineText.indexOf('-');
  // A list item written as a bare `-` line with its keys below it.
  if (!(dash >= 0 && dash < src.column(start)) && line > 0 && src.lineText(line - 1).trim() === '-') {
    line -= 1;
    lineText = src.lineText(line);
    dash = lineText.indexOf('-');
  }
  const col = dash >= 0 && (dash < src.column(start) || lineText.trim() === '-') ? dash : Math.max(0, src.column(start) - 2);
  const keyCol = col + 2;
  let text = '';
  fields.forEach(([k, v], i) => {
    const rendered = renderPair(k, v, keyCol, unit, nl);
    text += i === 0 ? ' '.repeat(col) + '- ' + rendered.slice(keyCol) : rendered;
  });
  // Keep the file's spacing when steps are separated by blank lines.
  if (line > 0 && src.lineText(line - 1).trim() === '') text += nl;
  return { start: src.lineStart(line), end: src.lineStart(line), text };
}

/** Indentation unit used by the file (2 or 4, best effort). */
export function indentUnit(doc: Document, src: Source): number {
  const jobs = (doc.contents && isMap(doc.contents) ? get(doc.contents, 'jobs') : undefined) as YAMLMap | undefined;
  if (isMap(jobs) && jobs.items[0]) {
    const top = src.column((jobs.items[0].key as Node).range![0]);
    if (top > 0) return top;
  }
  return 2;
}

export { isMap, isSeq, isScalar, isPair };
