/// <reference lib="webworker" />
/**
 * Free-query (script) mode runtime: a small mongosh-like environment.
 *
 * Runs in a dedicated Web Worker in the developer's browser, so user code never
 * executes on the (jump-host) server. Collection methods are synchronous, like
 * in mongosh, thanks to synchronous XHR (allowed in workers): every call becomes
 * one POST /api/shell/op, where the Read-Only guardrail applies to writes.
 *
 * Values coming from the server (canonical EJSON) are turned into handy JS values
 * (numbers, Date, ObjectId, NumberDecimal, …) for the script; the final result is
 * converted back to canonical EJSON for the Tree / Table viewers.
 */
import type { RunRequest, ShellResult, WorkerMessage } from './protocol';

const scope = self as unknown as DedicatedWorkerGlobalScope & Record<string, unknown>;
const post = (msg: WorkerMessage) => scope.postMessage(msg);

const PAGE = 5_000;
const MAX_ITERATE = 50_000;

let conn: { uri: string; readOnly: boolean } = { uri: '', readOnly: true };

// ---------------------------------------------------------------------------
// BSON helper types (shell-style)
// ---------------------------------------------------------------------------

class ObjectIdV {
  readonly $oid: string;
  constructor(hex?: string) {
    if (hex === undefined) {
      const bytes = crypto.getRandomValues(new Uint8Array(12));
      const ts = Math.floor(Date.now() / 1000);
      bytes[0] = (ts >>> 24) & 0xff;
      bytes[1] = (ts >>> 16) & 0xff;
      bytes[2] = (ts >>> 8) & 0xff;
      bytes[3] = ts & 0xff;
      hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    }
    if (!/^[0-9a-fA-F]{24}$/.test(hex)) throw new TypeError(`ObjectId: "${hex}" is not a 24-character hex string`);
    this.$oid = hex.toLowerCase();
  }
  toHexString() {
    return this.$oid;
  }
  getTimestamp() {
    return new Date(parseInt(this.$oid.slice(0, 8), 16) * 1000);
  }
  equals(other: unknown) {
    return other instanceof ObjectIdV ? other.$oid === this.$oid : String(other) === this.$oid;
  }
  toString() {
    return this.$oid;
  }
  toJSON() {
    return { $oid: this.$oid };
  }
}

class DecimalV {
  constructor(readonly value: string) {}
  valueOf() {
    return Number(this.value);
  }
  toString() {
    return this.value;
  }
  toJSON() {
    return { $numberDecimal: this.value };
  }
}

class LongV {
  constructor(readonly value: string) {}
  valueOf() {
    return Number(this.value);
  }
  toString() {
    return this.value;
  }
  toJSON() {
    return { $numberLong: this.value };
  }
}

class IntV {
  constructor(readonly value: number) {}
  valueOf() {
    return this.value;
  }
  toString() {
    return String(this.value);
  }
  toJSON() {
    return { $numberInt: String(this.value) };
  }
}

class UuidV {
  readonly value: string;
  constructor(value?: string) {
    this.value = (value ?? crypto.randomUUID()).toLowerCase();
  }
  toString() {
    return this.value;
  }
  toJSON() {
    return { $uuid: this.value };
  }
}

/** Any other EJSON wrapper ($timestamp, $binary, $regularExpression, …): carried through untouched. */
class RawV {
  constructor(readonly ejson: Record<string, unknown>) {}
  toJSON() {
    return this.ejson;
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function hexToUuid(b64: string): string {
  const hex = Array.from(atob(b64), (c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Canonical EJSON -> script values. */
function fromEjson(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(fromEjson);
  if (!isPlainObject(v)) return v;
  const keys = Object.keys(v);
  if (keys.length === 1) {
    const k = keys[0] as string;
    const x = v[k];
    switch (k) {
      case '$oid':
        return new ObjectIdV(x as string);
      case '$date': {
        if (isPlainObject(x) && typeof x.$numberLong === 'string') return new Date(Number(x.$numberLong));
        return new Date(x as string | number);
      }
      case '$numberInt':
        return Number(x);
      case '$numberDouble':
        return Number(x);
      case '$numberLong': {
        const n = Number(x);
        return Number.isSafeInteger(n) ? n : new LongV(x as string);
      }
      case '$numberDecimal':
        return new DecimalV(x as string);
      case '$uuid':
        return new UuidV(x as string);
      case '$binary': {
        const b = x as { base64?: string; subType?: string };
        if (b.subType === '04' && b.base64) return new UuidV(hexToUuid(b.base64));
        return new RawV(v);
      }
      default:
        if (k.startsWith('$')) return new RawV(v);
    }
  }
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) out[k] = fromEjson(x);
  return out;
}

/** Script values -> canonical EJSON (for requests and for the viewers). */
function toEjson(v: unknown, forDisplay = false): unknown {
  if (v === undefined) return null;
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
  if (typeof v === 'number') {
    if (!forDisplay) return v;
    if (Number.isInteger(v) && Math.abs(v) < 2 ** 31) return { $numberInt: String(v) };
    return { $numberDouble: String(v) };
  }
  if (typeof v === 'bigint') return { $numberLong: v.toString() };
  if (v instanceof Date) return { $date: { $numberLong: String(v.getTime()) } };
  if (v instanceof RegExp) return { $regularExpression: { pattern: v.source, options: v.flags.replace(/[^imsx]/g, '') } };
  if (v instanceof ObjectIdV || v instanceof DecimalV || v instanceof LongV || v instanceof IntV || v instanceof UuidV || v instanceof RawV) {
    return v.toJSON();
  }
  if (Array.isArray(v)) return v.map((x) => toEjson(x, forDisplay));
  if (v instanceof Cursor) throw new TypeError('A cursor cannot be used as a value: call .toArray() first');
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (x !== undefined && typeof x !== 'function') out[k] = toEjson(x, forDisplay);
    }
    return out;
  }
  return String(v);
}

// ---------------------------------------------------------------------------
// Shell-style text (print / printjson)
// ---------------------------------------------------------------------------

function shellText(v: unknown, indent = 0): string {
  const pad = (n: number) => '  '.repeat(n);
  if (v === undefined) return 'undefined';
  if (v === null) return 'null';
  if (typeof v === 'string') return indent === 0 ? v : JSON.stringify(v);
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  if (v instanceof ObjectIdV) return `ObjectId('${v.$oid}')`;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? 'Invalid Date' : `ISODate('${v.toISOString()}')`;
  if (v instanceof DecimalV) return `Decimal128('${v.value}')`;
  if (v instanceof LongV) return `Long('${v.value}')`;
  if (v instanceof IntV) return `Int32(${v.value})`;
  if (v instanceof UuidV) return `UUID('${v.value}')`;
  if (v instanceof RawV) return JSON.stringify(v.ejson);
  if (v instanceof RegExp) return String(v);
  if (v instanceof Cursor) return v.describe();
  if (v instanceof Collection) return `${v.dbName}.${v.name}`;
  if (typeof v === 'function') return `[Function${v.name ? `: ${v.name}` : ''}]`;
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]';
    return `[\n${v.map((x) => `${pad(indent + 1)}${shellText(x, indent + 1)}`).join(',\n')}\n${pad(indent)}]`;
  }
  if (typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>);
    if (entries.length === 0) return '{}';
    const key = (k: string) => (/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k));
    return `{\n${entries.map(([k, x]) => `${pad(indent + 1)}${key(k)}: ${shellText(x, indent + 1)}`).join(',\n')}\n${pad(indent)}}`;
  }
  return String(v);
}

const printValue = (v: unknown) => shellText(v);

// ---------------------------------------------------------------------------
// Server calls (synchronous)
// ---------------------------------------------------------------------------

interface OpResponse {
  result: unknown;
  hasMore?: boolean;
  ms: number;
}

function call(dbName: string, collection: string | null, op: string, args: Record<string, unknown>): OpResponse {
  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/shell/op', false);
  xhr.setRequestHeader('Content-Type', 'application/json');
  xhr.setRequestHeader('X-Mongo-URI', conn.uri);
  xhr.setRequestHeader('X-Read-Only', conn.readOnly ? 'true' : 'false');
  try {
    xhr.send(JSON.stringify({ db: dbName, collection, op, args: toEjson(args) }));
  } catch {
    throw new Error('Cannot reach the LiteMongo server');
  }
  let body: { message?: string } & Partial<OpResponse> = {};
  try {
    body = JSON.parse(xhr.responseText || '{}');
  } catch {
    // non-JSON error page
  }
  if (xhr.status < 200 || xhr.status >= 300) {
    throw new Error(body.message ?? `${op} failed: HTTP ${xhr.status}`);
  }
  const res = body as OpResponse;
  const count = Array.isArray(res.result) ? res.result.length : undefined;
  post({ type: 'op', op, collection, ms: res.ms, ...(count !== undefined ? { count } : {}) });
  return res;
}

// ---------------------------------------------------------------------------
// Cursor / Collection / Database
// ---------------------------------------------------------------------------

type Doc = Record<string, unknown>;

class Cursor {
  private opts: { sort?: Doc; skip?: number; limit?: number; projection?: Doc } = {};
  private buffer: unknown[] | null = null;
  private pos = 0;

  constructor(
    private readonly coll: Collection,
    private readonly kind: 'find' | 'aggregate',
    private readonly filterOrPipeline: Doc | Doc[],
    projection?: Doc,
  ) {
    if (projection) this.opts.projection = projection;
  }

  private chain(patch: Partial<Cursor['opts']>): this {
    if (this.buffer) throw new Error('Cursor already iterated: cannot change it any more');
    if (this.kind === 'aggregate') throw new Error(`aggregate() cursors do not support ${Object.keys(patch)[0]}(): add a pipeline stage instead`);
    Object.assign(this.opts, patch);
    return this;
  }
  sort(sort: Doc) {
    return this.chain({ sort });
  }
  skip(n: number) {
    return this.chain({ skip: n });
  }
  limit(n: number) {
    return this.chain({ limit: Math.abs(n) });
  }
  project(projection: Doc) {
    return this.chain({ projection });
  }
  projection(projection: Doc) {
    return this.project(projection);
  }
  pretty() {
    return this;
  }
  batchSize() {
    return this;
  }
  maxTimeMS() {
    return this;
  }
  hint() {
    return this;
  }
  allowDiskUse() {
    return this;
  }

  /** Raw canonical EJSON page (used for display and for iteration). */
  fetchRaw(maxDocs: number): { docs: Doc[]; hasMore: boolean } {
    if (this.kind === 'aggregate') {
      const res = call(this.coll.dbName, this.coll.name, 'aggregate', { pipeline: this.filterOrPipeline });
      const docs = res.result as Doc[];
      return { docs: docs.slice(0, maxDocs), hasMore: docs.length > maxDocs || !!res.hasMore };
    }
    const wanted = this.opts.limit && this.opts.limit > 0 ? Math.min(this.opts.limit, maxDocs) : maxDocs;
    const out: Doc[] = [];
    let skip = this.opts.skip ?? 0;
    let hasMore = false;
    while (out.length < wanted) {
      const page = Math.min(PAGE, wanted - out.length);
      const res = call(this.coll.dbName, this.coll.name, 'find', {
        filter: this.filterOrPipeline,
        projection: this.opts.projection ?? {},
        sort: this.opts.sort ?? {},
        skip,
        limit: page,
      });
      const docs = res.result as Doc[];
      out.push(...docs);
      skip += docs.length;
      hasMore = !!res.hasMore;
      if (!hasMore || docs.length < page) break;
    }
    const capped = !!this.opts.limit && this.opts.limit <= out.length;
    return { docs: out, hasMore: hasMore && !capped };
  }

  private load(): unknown[] {
    if (!this.buffer) {
      const { docs, hasMore } = this.fetchRaw(MAX_ITERATE);
      if (hasMore) post({ type: 'print', level: 'warn', text: `Iteration stopped at ${MAX_ITERATE} documents (add .limit() or a filter)` });
      this.buffer = fromEjson(docs) as unknown[];
    }
    return this.buffer;
  }

  toArray() {
    return this.load().slice(this.pos);
  }
  forEach(fn: (doc: unknown, i: number) => unknown) {
    this.toArray().forEach((d, i) => fn(d, i));
  }
  map<T>(fn: (doc: unknown, i: number) => T): T[] {
    return this.toArray().map((d, i) => fn(d, i));
  }
  filter(fn: (doc: unknown, i: number) => boolean) {
    return this.toArray().filter((d, i) => fn(d, i));
  }
  hasNext() {
    return this.pos < this.load().length;
  }
  next() {
    const docs = this.load();
    if (this.pos >= docs.length) throw new Error('Cursor exhausted');
    return docs[this.pos++];
  }
  tryNext() {
    return this.hasNext() ? this.next() : null;
  }
  itcount() {
    return this.toArray().length;
  }
  size() {
    return this.itcount();
  }
  count() {
    if (this.kind === 'aggregate') return this.itcount();
    return call(this.coll.dbName, this.coll.name, 'countDocuments', { filter: this.filterOrPipeline }).result as number;
  }
  close() {
    this.buffer = [];
  }
  [Symbol.iterator]() {
    return this.toArray()[Symbol.iterator]();
  }
  describe() {
    return `${this.kind === 'find' ? 'FindCursor' : 'AggregationCursor'} on ${this.coll.dbName}.${this.coll.name}`;
  }
  get label() {
    return `${this.coll.name}.${this.kind}()`;
  }
}

function argDoc(v: unknown, what: string): Doc {
  if (v === undefined || v === null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) throw new TypeError(`${what} must be an object`);
  return v as Doc;
}

class Collection {
  constructor(
    readonly dbName: string,
    readonly name: string,
  ) {}
  private op(op: string, args: Doc = {}) {
    return fromEjson(call(this.dbName, this.name, op, args).result);
  }
  getName() {
    return this.name;
  }
  getFullName() {
    return `${this.dbName}.${this.name}`;
  }
  find(filter?: Doc, projection?: Doc) {
    return new Cursor(this, 'find', argDoc(filter, 'filter'), projection ? argDoc(projection, 'projection') : undefined);
  }
  findOne(filter?: Doc, projection?: Doc) {
    return this.op('findOne', { filter: argDoc(filter, 'filter'), projection: argDoc(projection, 'projection') });
  }
  aggregate(pipeline: Doc[] | Doc, ...more: Doc[]) {
    const stages = Array.isArray(pipeline) ? pipeline : [pipeline, ...more];
    return new Cursor(this, 'aggregate', stages);
  }
  countDocuments(filter?: Doc) {
    return this.op('countDocuments', { filter: argDoc(filter, 'filter') });
  }
  count(filter?: Doc) {
    return this.countDocuments(filter);
  }
  estimatedDocumentCount() {
    return this.op('estimatedDocumentCount');
  }
  distinct(field: string, filter?: Doc) {
    return this.op('distinct', { field, filter: argDoc(filter, 'filter') });
  }
  getIndexes() {
    return this.op('getIndexes');
  }
  insertOne(document: Doc) {
    return this.op('insertOne', { document: argDoc(document, 'document') });
  }
  insertMany(documents: Doc[]) {
    if (!Array.isArray(documents)) throw new TypeError('insertMany expects an array');
    return this.op('insertMany', { documents });
  }
  updateOne(filter: Doc, update: Doc | Doc[], options?: Doc) {
    return this.op('updateOne', { filter: argDoc(filter, 'filter'), update, options: argDoc(options, 'options') });
  }
  updateMany(filter: Doc, update: Doc | Doc[], options?: Doc) {
    return this.op('updateMany', { filter: argDoc(filter, 'filter'), update, options: argDoc(options, 'options') });
  }
  replaceOne(filter: Doc, replacement: Doc, options?: Doc) {
    return this.op('replaceOne', { filter: argDoc(filter, 'filter'), replacement: argDoc(replacement, 'replacement'), options: argDoc(options, 'options') });
  }
  deleteOne(filter: Doc) {
    return this.op('deleteOne', { filter: argDoc(filter, 'filter') });
  }
  deleteMany(filter: Doc) {
    return this.op('deleteMany', { filter: argDoc(filter, 'filter') });
  }
  toString() {
    return this.getFullName();
  }
}

const DB_METHODS = new Set(['getName', 'getCollection', 'getCollectionNames', 'getSiblingDB', 'toString', 'valueOf', 'toJSON']);

function makeDb(name: string): unknown {
  const target = {
    getName: () => name,
    getCollection: (coll: string) => new Collection(name, coll),
    getCollectionNames: () => fromEjson(call(name, null, 'listCollections', {}).result),
    getSiblingDB: (other: string) => makeDb(other),
    toString: () => name,
    valueOf: () => name,
    toJSON: () => name,
  };
  return new Proxy(target, {
    get(t, prop) {
      if (typeof prop === 'symbol') return undefined;
      if (DB_METHODS.has(prop)) return t[prop as keyof typeof t];
      if (prop === 'then') return undefined; // never look like a promise
      return new Collection(name, prop);
    },
  });
}

// ---------------------------------------------------------------------------
// Globals available to scripts
// ---------------------------------------------------------------------------

function printArgs(level: 'log' | 'warn' | 'error') {
  return (...args: unknown[]) => post({ type: 'print', level, text: args.map(printValue).join(' ') });
}

const toDate = (v?: string | number) => (v === undefined ? new Date() : new Date(v));

/** Shell helper callable with or without `new` (a plain function returning an object works for both). */
function helper<A extends unknown[], T extends object>(make: (...args: A) => T, proto?: object) {
  const fn = function (...args: A): T {
    return make(...args);
  };
  if (proto) fn.prototype = proto;
  return fn;
}

Object.assign(scope, {
  print: printArgs('log'),
  printjson: (v: unknown) => post({ type: 'print', level: 'log', text: shellText(v) }),
  console: { log: printArgs('log'), info: printArgs('log'), debug: printArgs('log'), warn: printArgs('warn'), error: printArgs('error') },
  ObjectId: helper((hex?: string) => new ObjectIdV(hex), ObjectIdV.prototype),
  ISODate: toDate,
  NumberDecimal: helper((v: string | number) => new DecimalV(String(v)), DecimalV.prototype),
  Decimal128: helper((v: string | number) => new DecimalV(String(v)), DecimalV.prototype),
  NumberLong: helper((v: string | number) => new LongV(String(v)), LongV.prototype),
  Long: helper((v: string | number) => new LongV(String(v)), LongV.prototype),
  NumberInt: helper((v: string | number) => new IntV(Number(v)), IntV.prototype),
  Int32: helper((v: string | number) => new IntV(Number(v)), IntV.prototype),
  UUID: helper((v?: string) => new UuidV(v), UuidV.prototype),
  tojson: (v: unknown) => shellText(v),
  sleep: (ms: number) => {
    const until = Date.now() + Math.min(ms, 10_000);
    while (Date.now() < until) {
      // busy wait (workers have no synchronous sleep)
    }
  },
});

/** mongosh conveniences that are not JavaScript. */
function preprocess(script: string): string {
  return script
    .replace(/^\s*use\s+([\w-]+)\s*;?\s*$/gm, (_m, name: string) => `db = db.getSiblingDB(${JSON.stringify(name)});`)
    .replace(/^\s*show\s+(collections|tables)\s*;?\s*$/gm, 'db.getCollectionNames();');
}

// ---------------------------------------------------------------------------
// Result -> viewer
// ---------------------------------------------------------------------------

function toResult(value: unknown, displayLimit: number): ShellResult {
  if (value === undefined || value === null) return { kind: 'none' };
  if (value instanceof Cursor) {
    const { docs, hasMore } = value.fetchRaw(displayLimit);
    return { kind: 'docs', docs, hasMore, label: value.label };
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return { kind: 'value', text: '[ ]' };
    const docs = value.map((x) => {
      const e = toEjson(x, true);
      return isPlainObject(x) ? (e as Doc) : { value: e };
    });
    return { kind: 'docs', docs, hasMore: false, label: `array [${value.length}]` };
  }
  if (isPlainObject(value)) return { kind: 'docs', docs: [toEjson(value, true) as Doc], hasMore: false, label: 'document' };
  return { kind: 'value', text: shellText(value) };
}

function errorLine(err: unknown): number | undefined {
  const stack = (err as Error)?.stack ?? '';
  const m = /<anonymous>:(\d+):\d+/.exec(stack) ?? /eval.*?:(\d+):\d+/.exec(stack);
  return m ? Number(m[1]) : undefined;
}

scope.onmessage = (e: MessageEvent<RunRequest>) => {
  const req = e.data;
  if (req.type !== 'run') return;
  conn = { uri: req.uri, readOnly: req.readOnly };
  scope.db = makeDb(req.db);
  const started = performance.now();
  try {
    // Indirect eval: global scope, and its completion value is the last expression.
    const value: unknown = (0, eval)(preprocess(req.script));
    const result = toResult(value, req.displayLimit);
    post({ type: 'done', result, ms: Math.round(performance.now() - started) });
  } catch (err) {
    const line = errorLine(err);
    post({ type: 'error', message: err instanceof Error ? `${err.name}: ${err.message}` : String(err), ...(line ? { line } : {}) });
  }
};
