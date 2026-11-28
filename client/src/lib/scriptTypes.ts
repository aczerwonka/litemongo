import { GLOBAL_RETURNS, kindOfFieldType, MEMBERS, NAMESPACES, type JsKind, type JsMember } from './jsCatalog';
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
  /** Plain JavaScript value (`of`: element kind of an array). */
  | { t: 'js'; kind: JsKind; of?: JsKind | undefined }
  /** Built-in namespace (Math, JSON, Object, …). */
  | { t: 'ns'; name: string }
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
    if (ch === '"' || ch === "'" || ch === '`') {
      // String literal as the primary: `"a,b".split(",")`
      let j = i - 2;
      while (j >= 0 && !(text[j] === ch && text[j - 1] !== '\\')) j--;
      if (j < 0) return -1;
      i = j;
      break;
    }
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

/** Index of the bracket closing the one at `open` (forward, strings skipped), or -1. */
function matchForward(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i] as string;
    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1;
      while (j < text.length && text[j] !== ch) j += text[j] === '\\' ? 2 : 1;
      i = j;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
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
  | { k: 'paren'; text: string }
  | { k: 'lit'; kind: JsKind };

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
    if (out.length === 0 && (ch === '"' || ch === "'" || ch === '`')) {
      let j = i + 1;
      while (j < s.length && s[j] !== ch) j += s[j] === '\\' ? 2 : 1;
      if (j >= s.length) return null;
      out.push({ k: 'lit', kind: 'string' });
      i = j + 1;
      continue;
    }
    if (out.length === 0 && /\d/.test(ch)) {
      const num = /^\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?/i.exec(s.slice(i)) as RegExpExecArray;
      out.push({ k: 'lit', kind: 'number' });
      i += num[0].length;
      continue;
    }
    if (out.length === 0 && ch === '{') {
      const close = matchForward(s, i);
      if (s[close] !== '}') return null;
      out.push({ k: 'lit', kind: 'object' });
      i = close + 1;
      continue;
    }
    if (out.length === 0 && ch === '/' ) {
      const re = /^\/(?:\\.|[^/\\\n])+\/[a-z]*/.exec(s.slice(i));
      if (!re) return null;
      out.push({ k: 'lit', kind: 'regexp' });
      i += re[0].length;
      continue;
    }
    if (ch === '(' || ch === '[') {
      const close = matchForward(s, i);
      if (s[close] !== (ch === '(' ? ')' : ']')) return null;
      const text = s.slice(i + 1, close);
      if (ch === '[') out.push(out.length === 0 ? { k: 'lit', kind: 'array' } : { k: 'index', text });
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
    if (t.t === 'js' && t.kind === 'array' && t.of) return { t: 'js', kind: t.of };
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
    let start = 0;
    if (first.k === 'lit') cur = { t: 'js', kind: first.kind };
    else if (first.k === 'paren') cur = this.resolve(first.text, before);
    else if (first.k !== 'ident') return UNKNOWN;
    else if (first.name === 'db') cur = { t: 'db' };
    else {
      cur = this.binding(first.name, before);
      if (cur.t === 'unknown') {
        // Built-ins: Math.max(…), ObjectId(…), new Date(…), String(x).
        const kind = GLOBAL_RETURNS[first.name];
        if (rest[0]?.k === 'call' && kind) {
          cur = { t: 'js', kind };
          start = 1;
        } else if (NAMESPACES[first.name]) cur = { t: 'ns', name: first.name };
      }
    }

    for (let i = start; i < rest.length; i++) {
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
          } else if (seg.k === 'prop' && seg.name === 'getCollectionNames' && called) {
            cur = { t: 'js', kind: 'array', of: 'string' };
            i++;
          } else if (seg.k === 'prop' && seg.name === 'getName' && called) {
            cur = { t: 'js', kind: 'string' };
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
            } else if (seg.name === 'countDocuments' || seg.name === 'estimatedDocumentCount') cur = { t: 'js', kind: 'number' };
            else if (seg.name === 'getIndexes') cur = { t: 'js', kind: 'array', of: 'object' };
            else cur = UNKNOWN;
          } else cur = UNKNOWN;
          break;
        case 'cursor':
          if (seg.k === 'prop' && called) {
            i++;
            if (CURSOR_CHAIN.has(seg.name)) break;
            if (seg.name === 'toArray') cur = cur.coll ? { t: 'value', coll: cur.coll, path: [], array: true } : { t: 'js', kind: 'array', of: 'object' };
            else if (seg.name === 'next' || seg.name === 'tryNext') cur = this.element(cur);
            else if (seg.name === 'count' || seg.name === 'itcount') cur = { t: 'js', kind: 'number' };
            else if (seg.name === 'hasNext') cur = { t: 'js', kind: 'boolean' };
            else if (seg.name === 'map') cur = { t: 'js', kind: 'array' };
            else cur = UNKNOWN;
          } else cur = UNKNOWN;
          break;
        case 'value': {
          if (cur.array) {
            if (seg.k === 'index') cur = { ...cur, array: false };
            else if (seg.k === 'prop') {
              const r = this.memberStep(cur, 'array', seg.name, called);
              if (called) i++;
              cur = r;
            } else cur = UNKNOWN;
            break;
          }
          const scalar = this.jsKindOf(cur);
          if (scalar && seg.k === 'prop') {
            const r = this.memberStep(cur, scalar.kind, seg.name, called);
            if (called) i++;
            cur = r;
            break;
          }
          const name = seg.k === 'prop' ? seg.name : seg.k === 'index' ? stringLiteral(seg.text) : null;
          if (!name || called) {
            cur = UNKNOWN;
            break;
          }
          const path = [...cur.path, name];
          cur = { t: 'value', coll: cur.coll, path, array: !!this.field(cur.coll, path)?.isArray };
          break;
        }
        case 'js':
          if (seg.k === 'index') cur = cur.kind === 'array' ? this.element(cur) : cur.kind === 'string' ? { t: 'js', kind: 'string' } : UNKNOWN;
          else if (seg.k === 'prop') {
            const r = this.memberStep(cur, cur.kind, seg.name, called);
            if (called) i++;
            cur = r;
          } else cur = UNKNOWN;
          break;
        case 'ns': {
          const member = seg.k === 'prop' ? NAMESPACES[cur.name]?.find((x) => x.name === seg.name) : undefined;
          if (!member) return UNKNOWN;
          if (called) i++;
          cur = member.returns && member.returns !== 'same' && member.returns !== 'elem' ? { t: 'js', kind: member.returns, of: member.of } : UNKNOWN;
          break;
        }
        default:
          return UNKNOWN;
      }
      if (cur.t === 'unknown') return cur;
    }
    return cur;
  }

  /** Result of `receiver.name(…)` / `receiver.name` for a receiver of JS kind `kind`. */
  private memberStep(receiver: ScriptType, kind: JsKind, name: string, called: boolean): ScriptType {
    const member: JsMember | undefined = MEMBERS[kind].find((x) => x.name === name);
    if (!member || !member.returns || (!member.prop && !called)) return UNKNOWN;
    if (member.returns === 'same') return receiver;
    if (member.returns === 'elem') return this.element(receiver);
    return { t: 'js', kind: member.returns, of: member.of };
  }

  /** JS kind of a value: a plain JS value, or a scalar schema field (string, Date, ObjectId, …). */
  jsKindOf(t: ScriptType): { kind: JsKind; of?: JsKind | undefined } | null {
    if (t.t === 'js') return { kind: t.kind, of: t.of };
    if (t.t !== 'value') return null;
    if (t.array) return { kind: 'array' };
    if (t.path.length === 0 || this.children(t).length > 0) return null;
    const kind = kindOfFieldType(this.field(t.coll, t.path)?.type);
    return kind ? { kind } : null;
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
    case 'js':
      return t.kind === 'array' && t.of ? `${t.of}[]` : t.kind;
    case 'ns':
      return t.name;
    default:
      return '';
  }
}
