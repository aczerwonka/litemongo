/**
 * Helpers for canonical Extended JSON as returned by the API. Documents stay as
 * plain JSON in the browser (lossless, clipboard-ready); these helpers only
 * classify and format values for display.
 */

export type ValueKind =
  | 'objectId'
  | 'date'
  | 'decimal'
  | 'int'
  | 'long'
  | 'double'
  | 'string'
  | 'bool'
  | 'null'
  | 'uuid'
  | 'binary'
  | 'regex'
  | 'timestamp'
  | 'other'
  | 'object'
  | 'array';

export interface Classified {
  kind: ValueKind;
  /** Short display text for scalars. */
  text: string;
  /** BSON type label. */
  type: string;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function base64ToHex(b64: string): string {
  try {
    return Array.from(atob(b64), (c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
  } catch {
    return b64;
  }
}

function formatUuid(hex: string): string {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function dateText(raw: unknown): string {
  let ms: number | undefined;
  if (typeof raw === 'string') return raw;
  if (isObj(raw) && typeof raw.$numberLong === 'string') ms = Number(raw.$numberLong);
  else if (typeof raw === 'number') ms = raw;
  if (ms === undefined || !Number.isFinite(ms)) return String(raw);
  try {
    return new Date(ms).toISOString();
  } catch {
    return String(ms);
  }
}

export function classify(v: unknown): Classified {
  if (v === null || v === undefined) return { kind: 'null', text: 'null', type: 'null' };
  if (typeof v === 'string') return { kind: 'string', text: v, type: 'string' };
  if (typeof v === 'boolean') return { kind: 'bool', text: String(v), type: 'bool' };
  if (typeof v === 'number') return { kind: 'double', text: String(v), type: 'number' };
  if (Array.isArray(v)) return { kind: 'array', text: `[${v.length}]`, type: 'array' };
  if (isObj(v)) {
    const keys = Object.keys(v);
    if (keys.length === 1 || keys.length === 2) {
      if (typeof v.$oid === 'string') return { kind: 'objectId', text: v.$oid, type: 'ObjectId' };
      if ('$date' in v) return { kind: 'date', text: dateText(v.$date), type: 'Date' };
      if (typeof v.$numberDecimal === 'string') return { kind: 'decimal', text: v.$numberDecimal, type: 'Decimal128' };
      if (typeof v.$numberInt === 'string') return { kind: 'int', text: v.$numberInt, type: 'Int32' };
      if (typeof v.$numberLong === 'string') return { kind: 'long', text: v.$numberLong, type: 'Long' };
      if (typeof v.$numberDouble === 'string') return { kind: 'double', text: v.$numberDouble, type: 'Double' };
      if (typeof v.$uuid === 'string') return { kind: 'uuid', text: v.$uuid, type: 'UUID' };
      if (isObj(v.$binary)) {
        const { base64, subType } = v.$binary as { base64?: string; subType?: string };
        if (subType === '04' && base64) return { kind: 'uuid', text: formatUuid(base64ToHex(base64)), type: 'UUID' };
        return { kind: 'binary', text: `Binary(${subType ?? '?'}, ${base64?.length ?? 0} b64 chars)`, type: 'Binary' };
      }
      if (isObj(v.$regularExpression)) {
        const r = v.$regularExpression as { pattern?: string; options?: string };
        return { kind: 'regex', text: `/${r.pattern ?? ''}/${r.options ?? ''}`, type: 'Regex' };
      }
      if (isObj(v.$timestamp)) {
        const t = v.$timestamp as { t?: number; i?: number };
        return { kind: 'timestamp', text: `Timestamp(${t.t}, ${t.i})`, type: 'Timestamp' };
      }
      if ('$minKey' in v) return { kind: 'other', text: 'MinKey', type: 'MinKey' };
      if ('$maxKey' in v) return { kind: 'other', text: 'MaxKey', type: 'MaxKey' };
    }
    return { kind: 'object', text: `{${keys.length}}`, type: 'object' };
  }
  return { kind: 'other', text: String(v), type: typeof v };
}

export function isContainer(v: unknown): boolean {
  const k = classify(v).kind;
  return k === 'object' || k === 'array';
}

/** Shell-style text, e.g. ObjectId("…"), ISODate("…"), NumberDecimal("…"). */
export function shellText(v: unknown): string {
  const c = classify(v);
  switch (c.kind) {
    case 'objectId':
      return `ObjectId("${c.text}")`;
    case 'date':
      return `ISODate("${c.text}")`;
    case 'decimal':
      return `NumberDecimal("${c.text}")`;
    case 'long':
      return `NumberLong("${c.text}")`;
    case 'uuid':
      return `UUID("${c.text}")`;
    case 'string':
      return JSON.stringify(c.text);
    default:
      return c.text;
  }
}

/** Comparable key for client-side table sorting. */
export function sortKey(v: unknown): string | number {
  const c = classify(v);
  if (c.kind === 'int' || c.kind === 'long' || c.kind === 'double' || c.kind === 'decimal') {
    const n = Number(c.text);
    return Number.isFinite(n) ? n : c.text;
  }
  if (c.kind === 'date') return Date.parse(c.text) || c.text;
  return c.text;
}

/** Stable identity of a document's _id (for de-duplication). */
export function idKey(doc: Record<string, unknown>): string {
  return JSON.stringify(doc._id ?? null);
}

// ---------------------------------------------------------------------------
// Query text -> Extended JSON object
// ---------------------------------------------------------------------------

const ARG = String.raw`\s*(?:"([^"]*)"|'([^']*)'|(-?\d+(?:\.\d+)?))\s*`;
const HELPERS: [RegExp, (value: string) => string][] = [
  [new RegExp(String.raw`(?:new\s+)?ObjectId\(${ARG}\)`, 'g'), (v) => `{"$oid":${JSON.stringify(v)}}`],
  [new RegExp(String.raw`(?:new\s+)?(?:ISODate|Date)\(${ARG}\)`, 'g'), (v) => `{"$date":${JSON.stringify(v)}}`],
  [new RegExp(String.raw`NumberDecimal\(${ARG}\)`, 'g'), (v) => `{"$numberDecimal":${JSON.stringify(v)}}`],
  [new RegExp(String.raw`NumberLong\(${ARG}\)`, 'g'), (v) => `{"$numberLong":${JSON.stringify(v)}}`],
  [new RegExp(String.raw`NumberInt\(${ARG}\)`, 'g'), (v) => `{"$numberInt":${JSON.stringify(v)}}`],
  [new RegExp(String.raw`UUID\(${ARG}\)`, 'g'), (v) => `{"$uuid":${JSON.stringify(v)}}`],
];

function expandHelpers(text: string): string {
  let out = text;
  for (const [re, make] of HELPERS) {
    out = out.replace(re, (_m, dq?: string, sq?: string, num?: string) => make(dq ?? sq ?? num ?? ''));
  }
  return out;
}

/** Quote bare keys ({ status: 1 } -> { "status": 1 }) and convert single-quoted strings. */
function relaxToJson(text: string): string {
  return text
    .replace(/'((?:[^'\\]|\\.)*)'/g, (_m, s: string) => JSON.stringify(s.replace(/\\'/g, "'")))
    .replace(/([{,]\s*)([A-Za-z_$][\w.$]*)\s*:/g, '$1"$2":')
    .replace(/,\s*([}\]])/g, '$1');
}

/**
 * Parse an editor buffer into an Extended JSON object. Accepts strict JSON/EJSON,
 * mongosh helpers (ObjectId, ISODate, NumberDecimal, NumberLong, NumberInt, UUID),
 * unquoted keys, single quotes and trailing commas.
 */
export function parseQueryText(text: string, label: string): Record<string, unknown> {
  const trimmed = text.trim();
  if (!trimmed) return {};
  const expanded = expandHelpers(trimmed);
  let parsed: unknown;
  try {
    parsed = JSON.parse(expanded);
  } catch (strictErr) {
    try {
      parsed = JSON.parse(relaxToJson(expanded));
    } catch {
      throw new Error(`${label}: ${(strictErr as Error).message}`);
    }
  }
  if (!isObj(parsed)) throw new Error(`${label} must be an object`);
  return parsed;
}

export function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
