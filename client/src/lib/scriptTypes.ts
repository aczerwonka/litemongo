import type { SchemaField } from './mqlCompletion';

/**
 * Lightweight type inference for free-query scripts (no TypeScript worker: the
 * bundle stays small for jump hosts). Follows what a script does with documents
 * so completion can dig into the domain model:
 *
 *   const p = db.policies.findOne({ … });     p.            → policy fields
 *   p.covers.forEach((c) => c.                              → cover item fields
 *   for (const cl of db.claims.find().toArray()) cl.        → claim fields
 *   db.policies.find().forEach(function (doc) { doc.holder. → holder fields
 *   if (p.status === "                                      → status enum codes
 *
 * Pure: field definitions come in through a lookup, so it is easy to test.
 */

export type ScriptType =
  | { t: 'db' }
  | { t: 'collection'; coll: string }
  | { t: 'cursor'; coll: string | null }
  /** Value inside a collection's documents: `path` [] is the document itself; `array` = an array of the values at `path`. */
  | { t: 'value'; coll: string; path: string[]; array: boolean }
  | { t: 'unknown' };

export type FieldLookup = (collection: string) => SchemaField[];

const UNKNOWN: ScriptType = { t: 'unknown' };
const IDENT = /[A-Za-z0-9_$]/;
const IDENT_START = /[A-Za-z_$]/;
const KEYWORDS = new Set([
  'return', 'typeof', 'new', 'await', 'in', 'of', 'instanceof', 'delete', 'void', 'case', 'else', 'do', 'yield', 'throw',
]);
const CURSOR_CHAIN = new Set([
  'sort', 'limit', 'skip', 'project', 'projection', 'batchSize', 'hint', 'maxTimeMS', 'comment', 'collation', 'allowDiskUse', 'pretty', 'readPref',
]);
const ARRAY_SAME = new Set(['filter', 'slice', 'reverse', 'sort', 'concat', 'toSorted', 'toReversed']);
const ARRAY_ELEMENT = new Set(['find', 'findLast', 'at', 'pop', 'shift']);
const CALLBACKS = 'forEach|map|filter|find|findLast|findIndex|some|every|flatMap|sort';

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Index of the opening bracket matching the closing one at `close` (backwards, strings skipped). */
function matchBackward(text: string, close: number): number {
  const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  const stack: string[] = [];
  for (let i = close; i >= 0; i--) {
    const ch = text[i] as string;
    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i - 1;
      while (j >= 0 && !(text[j] === ch && text[j - 1] !== '\\')) j--;
      i = j;
      continue;
    }
    if (ch in pairs) stack.push(pairs[ch] as string);
    else if (ch === '(' || ch === '[' || ch === '{') {
      if (stack.pop() !== ch) return -1;
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

/**
 * Start index of the member/call chain that ends right before `end`
 * (`db.policies.find({…}).limit(5)`, `p.covers[0]`, `doc.holder`), or -1.
 */
export function exprStartBefore(text: string, end: number): number {
  let i = end; // exclusive
  let afterDot = true; // skip whitespace before the end (`find()\n  .forEach`)
  for (;;) {
    if (afterDot) while (i > 0 && /\s/.test(text[i - 1] as string)) i--;
    const ch = text[i - 1];
    if (ch === undefined) break;
    if (ch === ')' || ch === ']') {
      const open = matchBackward(text, i - 1);
      if (open < 0) return -1;
      i = open;
      afterDot = false;
      continue;
    }
    if (IDENT.test(ch)) {
      let j = i - 1;
      while (j > 0 && IDENT.test(text[j - 1] as string)) j--;
      const word = text.slice(j, i);
      if (KEYWORDS.has(word) || !IDENT_START.test(word[0] as string)) break;
      i = j;
      // Continue through a dot before the identifier (whitespace allowed for multi-line chains).
      let k = i;
      while (k > 0 && /\s/.test(text[k - 1] as string)) k--;
      if (text[k - 1] === '.' && text[k - 2] !== '.') {
        i = text[k - 2] === '?' ? k - 2 : k - 1;
        afterDot = true;
        continue;
      }
      break;
    }
    break;
  }
  if (i >= end) return -1;
  return i;
}

/** End index (exclusive) of the expression starting at `start`: up to a top-level `;` `,` `)` or a line break not followed by `.chain`. */
export function exprEndAfter(text: string, start: number): number {
  let depth = 0;
  let i = start;
  while (i < text.length) {
    const ch = text[i] as string;
    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1;
      while (j < text.length && text[j] !== ch) j += text[j] === '\\' ? 2 : 1;
      i = j + 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i);
      if (nl < 0) return text.length;
      i = nl;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) return i;
      depth--;
    } else if (depth === 0 && (ch === ';' || ch === ',')) return i;
    else if (depth === 0 && ch === '\n') {
      const rest = /^\s*(\S)/.exec(text.slice(i));
      if (rest?.[1] !== '.') return i;
    }
    i++;
  }
  return i;
}

type Segment =
  | { k: 'ident'; name: string }
  | { k: 'prop'; name: string }
  | { k: 'index'; text: string }
  | { k: 'call'; text: string }
  | { k: 'paren'; text: string };

/** Split a member/call chain into segments (`db`, `.policies`, `.find`, `({…})`, `[0]`). */
export function segments(expr: string): Segment[] | null {
  const out: Segment[] = [];
  let i = 0;
  const s = expr.trim().replace(/^(?:await|new)\s+/, '');
  while (i < s.length) {
    const ch = s[i] as string;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '.' || (ch === '?' && s[i + 1] === '.')) {
      i += ch === '?' ? 2 : 1;
      while (/\s/.test(s[i] ?? '')) i++;
      const m = /^[A-Za-z_$][\w$]*/.exec(s.slice(i));
      if (!m) return out.length ? out : null; // trailing dot
      out.push({ k: 'prop', name: m[0] });
      i += m[0].length;
      continue;
    }
    if (ch === '(' || ch === '[') {
      const close = exprEndAfter(s, i + 1);
      if (s[close] !== (ch === '(' ? ')' : ']')) return null;
      const text = s.slice(i + 1, close);
      if (ch === '[') out.push({ k: 'index', text });
      else out.push(out.length === 0 ? { k: 'paren', text } : { k: 'call', text });
      i = close + 1;
      continue;
    }
    if (IDENT_START.test(ch) && out.length === 0) {
      const m = /^[A-Za-z_$][\w$]*/.exec(s.slice(i)) as RegExpExecArray;
      out.push({ k: 'ident', name: m[0] });
      i += m[0].length;
      continue;
    }
    return null;
  }
  return out;
}

function stringLiteral(text: string): string | null {
  const m = /^\s*(["'`])((?:\\.|(?!\1).)*)\1\s*$/.exec(text);
  return m ? (m[2] as string) : null;
}

export class ScriptTyper {
  private depth = 0;

  constructor(
    private readonly fieldsOf: FieldLookup,
  ) {}

  private field(coll: string, path: string[]): SchemaField | undefined {
    const p = path.join('.');
    return this.fieldsOf(coll).find((f) => f.path.join('.') === p);
  }

  /** Element type of an iterable (cursor → document, array → element). */
  element(t: ScriptType): ScriptType {
    if (t.t === 'cursor') return t.coll ? { t: 'value', coll: t.coll, path: [], array: false } : UNKNOWN;
    if (t.t === 'value' && t.array) return { ...t, array: false };
    return UNKNOWN;
  }

  /** Type of the expression `expr`; `before` is the script text before it (for variable bindings). */
  resolve(expr: string, before: string): ScriptType {
    if (this.depth > 12) return UNKNOWN;
    this.depth++;
    try {
      return this.resolveSegments(segments(expr), before);
    } finally {
      this.depth--;
    }
  }

  /** Type of the chain ending right before `end` in `text`. */
  resolveBefore(text: string, end: number): ScriptType {
    const start = exprStartBefore(text, end);
    if (start < 0) return UNKNOWN;
    return this.resolve(text.slice(start, end), text.slice(0, start));
  }

  private resolveSegments(segs: Segment[] | null, before: string): ScriptType {
    if (!segs?.length) return UNKNOWN;
    const [first, ...rest] = segs as [Segment, ...Segment[]];
    let cur: ScriptType;
    if (first.k === 'ident') cur = first.name === 'db' ? { t: 'db' } : this.binding(first.name, before);
    else if (first.k === 'paren') cur = this.resolve(first.text, before);
    else return UNKNOWN;

    for (let i = 0; i < rest.length; i++) {
      const seg = rest[i] as Segment;
      const next = rest[i + 1];
      const called = next?.k === 'call';
      switch (cur.t) {
        case 'db':
          if (seg.k === 'prop' && seg.name === 'getCollection' && called) {
            const name = stringLiteral(next.text);
            cur = name ? { t: 'collection', coll: name } : UNKNOWN;
            i++;
          } else if (seg.k === 'prop' && seg.name === 'getSiblingDB' && called) {
            cur = { t: 'db' };
            i++;
          } else if (seg.k === 'prop' && !called) cur = { t: 'collection', coll: seg.name };
          else if (seg.k === 'index') {
            const name = stringLiteral(seg.text);
            cur = name ? { t: 'collection', coll: name } : UNKNOWN;
          } else cur = UNKNOWN;
          break;
        case 'collection':
          if (seg.k === 'prop' && called) {
            const coll = cur.coll;
            i++;
            if (seg.name === 'find') cur = { t: 'cursor', coll };
            else if (seg.name === 'aggregate') cur = { t: 'cursor', coll: null };
            else if (seg.name === 'findOne') cur = { t: 'value', coll, path: [], array: false };
            else if (seg.name === 'distinct') {
              const path = stringLiteral(next.text)?.split('.');
              cur = path ? { t: 'value', coll, path, array: true } : UNKNOWN;
            } else cur = UNKNOWN;
          } else cur = UNKNOWN;
          break;
        case 'cursor':
          if (seg.k === 'prop' && called) {
            i++;
            if (CURSOR_CHAIN.has(seg.name)) break;
            if (seg.name === 'toArray') cur = cur.coll ? { t: 'value', coll: cur.coll, path: [], array: true } : UNKNOWN;
            else if (seg.name === 'next' || seg.name === 'tryNext') cur = this.element(cur);
            else cur = UNKNOWN;
          } else cur = UNKNOWN;
          break;
        case 'value':
          if (cur.array) {
            if (seg.k === 'index') cur = { ...cur, array: false };
            else if (seg.k === 'prop' && called && ARRAY_ELEMENT.has(seg.name)) {
              cur = { ...cur, array: false };
              i++;
            } else if (seg.k === 'prop' && called && ARRAY_SAME.has(seg.name)) i++;
            else cur = UNKNOWN;
          } else {
            const name = seg.k === 'prop' ? seg.name : seg.k === 'index' ? stringLiteral(seg.text) : null;
            if (!name || called) {
              cur = UNKNOWN;
              break;
            }
            const path = [...cur.path, name];
            cur = { t: 'value', coll: cur.coll, path, array: !!this.field(cur.coll, path)?.isArray };
          }
          break;
        default:
          return UNKNOWN;
      }
      if (cur.t === 'unknown') return cur;
    }
    return cur;
  }

  /** Type of variable `name` from its latest binding in `before`. */
  binding(name: string, before: string): ScriptType {
    const n = escapeRe(name);
    let best: { index: number; type: () => ScriptType } | null = null;
    const consider = (index: number, type: () => ScriptType) => {
      if (!best || index > best.index) best = { index, type };
    };
    // const p = <expr>   /   p = <expr>
    for (const m of before.matchAll(new RegExp(`(?:\\b(?:const|let|var)\\s+)?(?<![\\w$.])${n}\\s*=(?![=>])\\s*`, 'g'))) {
      const start = m.index + m[0].length;
      const end = exprEndAfter(before, start);
      consider(m.index, () => this.resolve(before.slice(start, end), before.slice(0, m.index)));
    }
    // for (const p of <expr>)
    for (const m of before.matchAll(new RegExp(`\\bfor\\s*\\(\\s*(?:const|let|var)?\\s*${n}\\s+of\\s+`, 'g'))) {
      const start = m.index + m[0].length;
      const end = exprEndAfter(before, start);
      consider(m.index, () => this.element(this.resolve(before.slice(start, end), before.slice(0, m.index))));
    }
    // <receiver>.forEach((p) => …) / .map(p => …) / .forEach(function (p) { … })
    const cb = new RegExp(`\\.\\s*(?:${CALLBACKS})\\s*\\(\\s*(?:async\\s+)?(?:function\\b[^(]*)?\\(?\\s*${n}\\s*(?=[,)]|=>)`, 'g');
    for (const m of before.matchAll(cb)) {
      const dot = m.index;
      consider(dot, () => {
        const start = exprStartBefore(before, dot);
        if (start < 0) return UNKNOWN;
        return this.element(this.resolve(before.slice(start, dot), before.slice(0, start)));
      });
    }
    const found = best as { index: number; type: () => ScriptType } | null;
    return found ? found.type() : UNKNOWN;
  }

  /** Variables declared in `before` (const / let / var / for-of / callback params). */
  variables(before: string): string[] {
    const names = new Set<string>();
    for (const m of before.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1] as string);
    const cb = new RegExp(`\\.\\s*(?:${CALLBACKS})\\s*\\(\\s*(?:async\\s+)?(?:function\\b[^(]*)?\\(?\\s*([A-Za-z_$][\\w$]*)\\s*(?=[,)]|=>)`, 'g');
    for (const m of before.matchAll(cb)) names.add(m[1] as string);
    names.delete('db');
    return [...names];
  }

  /** Field definition of a value type (for hover / enum values). */
  fieldOf(t: ScriptType): SchemaField | undefined {
    return t.t === 'value' && t.path.length ? this.field(t.coll, t.path) : undefined;
  }

  /** Direct child fields of a (non-array) value. */
  children(t: ScriptType): SchemaField[] {
    if (t.t !== 'value' || t.array) return [];
    return this.fieldsOf(t.coll).filter((f) => f.path.length === t.path.length + 1 && t.path.every((seg, i) => f.path[i] === seg));
  }
}

/** Collections a script references (`db.x`, `db.getCollection("x")`, `db["x"]`). */
export function referencedCollections(script: string): string[] {
  const names = new Set<string>();
  const re = /\bdb\s*\.\s*(?:getCollection\(\s*['"]([^'"]+)['"]\s*\)|([A-Za-z_$][\w$]*)|\[\s*['"]([^'"]+)['"]\s*\])/g;
  for (const m of script.matchAll(re)) {
    const name = m[1] ?? m[3] ?? m[2];
    if (name && !['getCollection', 'getSiblingDB', 'getName', 'getCollectionNames'].includes(name)) names.add(name);
  }
  return [...names];
}

/** Human-readable type label (`policies document`, `policies.covers[]`). */
export function describeType(t: ScriptType): string {
  switch (t.t) {
    case 'db':
      return 'database';
    case 'collection':
      return `collection ${t.coll}`;
    case 'cursor':
      return t.coll ? `cursor<${t.coll}>` : 'cursor';
    case 'value':
      if (t.path.length === 0) return t.array ? `${t.coll} document[]` : `${t.coll} document`;
      return `${t.coll}.${t.path.join('.')}${t.array ? '[]' : ''}`;
    default:
      return '';
  }
}
