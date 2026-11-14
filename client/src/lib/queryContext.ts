/**
 * Cursor-context analysis for MQL editor buffers (relaxed JSON: unquoted keys,
 * single quotes, shell helpers like ObjectId("…")). Pure functions, no Monaco,
 * so they are easy to reason about and test.
 */

export interface CursorContext {
  /** Typing an object key, or a value (object value or array element). */
  position: 'key' | 'value';
  /**
   * Keys from the root to the cursor: one entry per enclosing container
   * (null for array elements) plus, in value position, the key being valued.
   */
  keys: (string | null)[];
  /** Partially typed token before the cursor (without its opening quote). */
  partial: string;
  /** Opening quote of the partial token, if the cursor is inside a string. */
  quote: '"' | "'" | null;
}

interface Frame {
  kind: 'object' | 'array';
  /** Key under which this container sits (null for array elements / root). */
  key: string | null;
  expect: 'key' | 'value';
  lastKey: string | null;
}

const IDENT_START = /[A-Za-z_$]/;
const IDENT_PART = /[\w.$]/;

export function analyzeCursor(text: string): CursorContext {
  const stack: Frame[] = [];
  let i = 0;
  let partial = '';
  let quote: CursorContext['quote'] = null;

  const top = (): Frame | undefined => stack[stack.length - 1];
  const keyForNewContainer = (): string | null => {
    const t = top();
    if (!t) return null;
    return t.kind === 'object' ? t.lastKey : null;
  };
  const token = (value: string) => {
    const t = top();
    if (t?.kind === 'object' && t.expect === 'key') t.lastKey = value;
  };

  while (i < text.length) {
    const ch = text[i] as string;
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      let value = '';
      let closed = false;
      while (j < text.length) {
        const c = text[j] as string;
        if (c === '\\') {
          value += text[j + 1] ?? '';
          j += 2;
          continue;
        }
        if (c === ch) {
          closed = true;
          break;
        }
        value += c;
        j += 1;
      }
      if (!closed) {
        partial = value;
        quote = ch;
        break;
      }
      token(value);
      i = j + 1;
      continue;
    }
    if (IDENT_START.test(ch)) {
      let j = i;
      while (j < text.length && IDENT_PART.test(text[j] as string)) j += 1;
      const word = text.slice(i, j);
      if (j === text.length) {
        partial = word;
        break;
      }
      token(word);
      i = j;
      continue;
    }
    switch (ch) {
      case '{':
        stack.push({ kind: 'object', key: keyForNewContainer(), expect: 'key', lastKey: null });
        break;
      case '[':
        stack.push({ kind: 'array', key: keyForNewContainer(), expect: 'value', lastKey: null });
        break;
      case '}':
      case ']':
        stack.pop();
        break;
      case ':': {
        const t = top();
        if (t?.kind === 'object') t.expect = 'value';
        break;
      }
      case ',': {
        const t = top();
        if (t?.kind === 'object') {
          t.expect = 'key';
          t.lastKey = null;
        }
        break;
      }
      default:
        break;
    }
    i += 1;
  }

  const keys: (string | null)[] = stack.slice(1).map((f) => f.key);
  const t = top();
  let position: CursorContext['position'] = 'value';
  if (t?.kind === 'object') {
    if (t.expect === 'key') position = 'key';
    else keys.push(t.lastKey);
  }
  return { position, keys, partial, quote };
}

const LOGICAL = new Set(['$and', '$or', '$nor']);

export interface FieldContext {
  /** Field path the cursor is "inside" (dotted segments). */
  field: string[];
  /** Innermost enclosing key: a field name, an operator, or null at the root / in an array element. */
  innermost: string | null;
  /** Last operator applying to the field, e.g. "$in". */
  operator: string | null;
}

/** Interpret the key chain as MongoDB query semantics ($elemMatch nests, $in/$eq keep the field). */
export function resolveField(keys: (string | null)[]): FieldContext {
  let field: string[] = [];
  let operator: string | null = null;
  for (const key of keys) {
    if (key === null) continue;
    if (key.startsWith('$')) {
      operator = key === '$elemMatch' || LOGICAL.has(key) ? null : key;
      continue;
    }
    field = [...field, ...key.split('.').filter(Boolean)];
    operator = null;
  }
  const last = keys.length ? (keys[keys.length - 1] ?? null) : null;
  return { field, innermost: last, operator };
}
