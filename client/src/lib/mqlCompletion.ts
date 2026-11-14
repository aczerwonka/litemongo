import { analyzeCursor, resolveField, type CursorContext } from './queryContext';

/**
 * MQL completion engine shared by the JSON query editors (filter / projection /
 * sort) and the free-query script editor (`db.coll.find({ … })`, `aggregate([…])`,
 * `updateOne(…, { $set: … })`). Pure: produces suggestion descriptors; the Monaco
 * adapter turns them into CompletionItems.
 */

export type QueryKind = 'filter' | 'projection' | 'sort' | 'update' | 'pipeline' | 'fieldName';

export interface SchemaField {
  path: string[];
  type?: string;
  description?: string;
  enum?: string[];
  isArray: boolean;
}

export interface Suggestion {
  label: string;
  kind: 'field' | 'operator' | 'value' | 'enum' | 'stage' | 'method' | 'collection';
  insertText: string;
  snippet?: boolean;
  detail?: string;
  documentation?: string;
  sortText?: string;
  /** Re-open the suggest widget after inserting (field -> its values). */
  retrigger?: boolean;
}

export interface CompletionResult {
  suggestions: Suggestion[];
  /** Partial token typed before the cursor and its opening quote (for the replace range). */
  partial: string;
  quote: CursorContext['quote'];
}

type Op = [label: string, value: string, doc: string];

// Value templates use `$0` as the cursor stop; `$` in names is escaped later.
const COMPARISON: Op[] = [
  ['$eq', '$0', 'Equal to'],
  ['$ne', '$0', 'Not equal to'],
  ['$gt', '$0', 'Greater than'],
  ['$gte', '$0', 'Greater than or equal'],
  ['$lt', '$0', 'Less than'],
  ['$lte', '$0', 'Less than or equal'],
  ['$in', '[$0]', 'Matches any value in the array'],
  ['$nin', '[$0]', 'Matches none of the values in the array'],
  ['$exists', '${1:true}', 'Field is present (true) or missing (false)'],
  ['$type', '"${1:string}"', 'BSON type check, e.g. "string", "date", "decimal", "objectId"'],
  ['$regex', '"$0"', 'Matches a regular expression'],
  ['$options', '"${1:i}"', 'Regex options for $regex (i, m, s, x)'],
  ['$not', '{ $0 }', 'Negates an operator expression'],
  ['$mod', '[${1:divisor}, ${2:remainder}]', 'value % divisor == remainder'],
];
const ARRAY: Op[] = [
  ['$elemMatch', '{ $0 }', 'At least one array element matches ALL the given conditions'],
  ['$all', '[$0]', 'Array contains all of the values'],
  ['$size', '${1:0}', 'Array has exactly this many elements'],
];
const LOGICAL: Op[] = [
  ['$and', '[{ $0 }]', 'All clauses match'],
  ['$or', '[{ $0 }]', 'Any clause matches'],
  ['$nor', '[{ $0 }]', 'No clause matches'],
];
const ROOT_ONLY: Op[] = [
  ['$expr', '{ $0 }', 'Aggregation expression, e.g. { $gt: ["$a", "$b"] }'],
  ['$text', '{ \\$search: "$0" }', 'Full-text search (needs a text index)'],
  ['$jsonSchema', '{ $0 }', 'Validate against a JSON schema'],
  ['$comment', '"$0"', 'Comment attached to the query'],
];
const UPDATE: Op[] = [
  ['$set', '{ $0 }', 'Set field values'],
  ['$unset', '{ ${1:field}: "" }', 'Remove fields'],
  ['$inc', '{ $0 }', 'Increment numeric fields'],
  ['$mul', '{ $0 }', 'Multiply numeric fields'],
  ['$min', '{ $0 }', 'Update if the value is lower'],
  ['$max', '{ $0 }', 'Update if the value is higher'],
  ['$rename', '{ $0 }', 'Rename fields'],
  ['$push', '{ $0 }', 'Append to an array'],
  ['$addToSet', '{ $0 }', 'Append to an array unless present'],
  ['$pull', '{ $0 }', 'Remove matching array elements'],
  ['$pop', '{ ${1:field}: 1 }', 'Remove first (-1) or last (1) array element'],
  ['$currentDate', '{ ${1:field}: true }', 'Set to the current date'],
  ['$setOnInsert', '{ $0 }', 'Set only when an upsert inserts'],
];
const STAGES: Op[] = [
  ['$match', '{ $0 }', 'Filter documents (query syntax)'],
  ['$project', '{ $0 }', 'Reshape: include / exclude / compute fields'],
  ['$addFields', '{ $0 }', 'Add computed fields'],
  ['$set', '{ $0 }', 'Alias of $addFields'],
  ['$unset', '"$0"', 'Remove fields'],
  ['$group', '{ _id: "\\$${1:field}", ${2:count}: { \\$sum: 1 } }', 'Group and accumulate'],
  ['$sort', '{ ${1:field}: ${2:-1} }', 'Sort documents'],
  ['$limit', '${1:10}', 'Keep the first N documents'],
  ['$skip', '${1:0}', 'Skip N documents'],
  ['$unwind', '"\\$${1:arrayField}"', 'One output document per array element'],
  ['$lookup', '{ from: "${1:collection}", localField: "${2:_id}", foreignField: "${3:field}", as: "${4:joined}" }', 'Left outer join (heavy on jump hosts: prefer relation blueprints)'],
  ['$count', '"${1:count}"', 'Count the documents'],
  ['$facet', '{ $0 }', 'Several sub-pipelines on the same input'],
  ['$sortByCount', '"\\$${1:field}"', 'Group by value and sort by count'],
  ['$replaceRoot', '{ newRoot: "\\$${1:field}" }', 'Promote an embedded document'],
  ['$sample', '{ size: ${1:10} }', 'Random sample'],
  ['$bucket', '{ groupBy: "\\$${1:field}", boundaries: [$2], default: "other" }', 'Group into ranges'],
];
const ACCUMULATORS: Op[] = [
  ['$sum', '$0', 'Sum (use 1 to count)'],
  ['$avg', '"\\$$0"', 'Average'],
  ['$min', '"\\$$0"', 'Minimum'],
  ['$max', '"\\$$0"', 'Maximum'],
  ['$first', '"\\$$0"', 'First value in the group'],
  ['$last', '"\\$$0"', 'Last value in the group'],
  ['$push', '"\\$$0"', 'Array of all values'],
  ['$addToSet', '"\\$$0"', 'Array of distinct values'],
  ['$count', '{}', 'Number of documents in the group'],
];

const LOGICAL_KEYS = new Set(['$and', '$or', '$nor']);

function escapeName(name: string): string {
  return name.replace(/\$/g, '\\$');
}

export interface EngineOptions {
  /** Script editor: bare keys (`status:`) instead of JSON keys (`"status":`). */
  js: boolean;
}

/** `"key": ` for JSON, `key: ` / `'a.b': ` for scripts. Partial typing inside quotes keeps the quote style. */
function keyText(name: string, quote: CursorContext['quote'], opts: EngineOptions, snippet: boolean): string {
  const n = snippet ? escapeName(name) : name;
  if (quote) return `${quote}${n}${quote}: `;
  if (!opts.js) return `"${n}": `;
  return /^[A-Za-z_$][\w$]*$/.test(name) ? `${n}: ` : `'${n}': `;
}

function opItems(ops: Op[], cursor: CursorContext, opts: EngineOptions, sort: string): Suggestion[] {
  return ops.map(([label, value, doc]) => ({
    label,
    kind: 'operator',
    insertText: `${keyText(label, cursor.quote, opts, true)}${value}`,
    snippet: true,
    documentation: doc,
    sortText: `${sort}${label}`,
  }));
}

function fieldItems(fields: SchemaField[], under: string[], cursor: CursorContext, opts: EngineOptions, valueTemplate?: string): Suggestion[] {
  const out: Suggestion[] = [];
  for (const f of fields) {
    if (f.path.length <= under.length || under.some((seg, i) => f.path[i] !== seg)) continue;
    const label = f.path.slice(under.length).join('.');
    const depth = f.path.length - under.length;
    out.push({
      label,
      kind: 'field',
      insertText: `${keyText(label, cursor.quote, opts, !!valueTemplate)}${valueTemplate ?? ''}`,
      snippet: !!valueTemplate,
      detail: f.isArray ? 'array' : f.type,
      documentation: [f.description, f.enum ? `Codes: ${f.enum.join(', ')}` : ''].filter(Boolean).join('\n\n') || undefined,
      sortText: `${depth === 1 ? '0' : '1'}${label}`,
      retrigger: !valueTemplate,
    });
  }
  return out;
}

/** `{ $in: [ ] }`-style operator objects offered right after `field: `. */
function valueOperatorItems(def: SchemaField | undefined, opts: EngineOptions): Suggestion[] {
  const k = (n: string) => (opts.js ? escapeName(n) : `"${escapeName(n)}"`);
  const items: [string, string, string][] = [
    ...(def?.isArray || !def ? ([['{ $elemMatch }', `{ ${k('$elemMatch')}: { $0 } }`, 'An array element matches all conditions']] as [string, string, string][]) : []),
    ['{ $in }', `{ ${k('$in')}: [$0] }`, 'Any of the values'],
    ['{ $nin }', `{ ${k('$nin')}: [$0] }`, 'None of the values'],
    ['{ $ne }', `{ ${k('$ne')}: $0 }`, 'Not equal'],
    ['{ $gte, $lte }', `{ ${k('$gte')}: $1, ${k('$lte')}: $2 }`, 'Range (inclusive)'],
    ['{ $exists }', `{ ${k('$exists')}: \${1:true} }`, 'Present / missing'],
    ['{ $regex }', `{ ${k('$regex')}: "$1", ${k('$options')}: "i" }`, 'Regular expression (case-insensitive)'],
  ];
  return items.map(([label, insertText, doc], i) => ({
    label,
    kind: 'operator',
    insertText,
    snippet: true,
    documentation: doc,
    sortText: `5${i}`,
  }));
}

function enumItems(def: SchemaField | undefined, field: string[], cursor: CursorContext): Suggestion[] {
  const q = cursor.quote ?? '"';
  return (def?.enum ?? []).map((code) => ({
    label: code,
    kind: 'enum',
    detail: field.join('.'),
    insertText: q === "'" ? `'${code.replace(/'/g, "\\'")}'` : JSON.stringify(code),
    sortText: `0${code}`,
  }));
}

/** Filter / query semantics: `keys` as produced by analyzeCursor, relative to the filter root. */
function filterSuggestions(fields: SchemaField[], cursor: CursorContext, opts: EngineOptions, isRoot = true): Suggestion[] {
  const { field, innermost, operator } = resolveField(cursor.keys);
  const find = (path: string[]) => fields.find((f) => f.path.join('.') === path.join('.'));
  if (cursor.position === 'key') {
    const inOperatorObject = innermost !== null && innermost !== '$elemMatch' && !LOGICAL_KEYS.has(innermost);
    if (inOperatorObject) {
      // { status: { | } } or { x: { $not: { | } } }
      const def = find(field);
      const items = opItems(COMPARISON, cursor, opts, '1');
      // Arrays first get $elemMatch & co; unknown fields get them too (lower).
      if (def?.isArray) items.unshift(...opItems(ARRAY, cursor, opts, '0'));
      else items.push(...opItems(ARRAY, cursor, opts, '2'));
      return items;
    }
    // Root, $and/$or element, or inside $elemMatch: field paths relative to `field`.
    const items = fieldItems(fields, field, cursor, opts);
    items.push(...opItems(LOGICAL, cursor, opts, '3'));
    if (field.length === 0 && isRoot) items.push(...opItems(ROOT_ONLY, cursor, opts, '4'));
    if (field.length > 0) items.push(...opItems(COMPARISON, cursor, opts, '4')); // $elemMatch over scalar arrays
    return items;
  }
  // Value position.
  if (operator && !['$in', '$nin', '$ne', '$eq', '$all'].includes(operator)) return [];
  const def = find(field);
  const items = enumItems(def, field, cursor);
  if (!operator && !cursor.quote && field.length > 0 && cursor.keys[cursor.keys.length - 1] !== null) {
    items.push(...valueOperatorItems(def, opts));
  }
  return items;
}

function keyListSuggestions(fields: SchemaField[], cursor: CursorContext, opts: EngineOptions, kind: 'projection' | 'sort'): Suggestion[] {
  if (cursor.position === 'key' && cursor.keys.length === 0) return fieldItems(fields, [], cursor, opts).map((s) => ({ ...s, retrigger: true }));
  if (cursor.position === 'value' && cursor.keys.length === 1 && !cursor.quote) {
    const values = kind === 'sort' ? [['1', 'Ascending'], ['-1', 'Descending']] : [['1', 'Include'], ['0', 'Exclude']];
    return values.map(([label, doc], i) => ({ label: label as string, kind: 'value', insertText: label as string, documentation: doc, sortText: String(i) }));
  }
  return [];
}

function updateSuggestions(fields: SchemaField[], cursor: CursorContext, opts: EngineOptions): Suggestion[] {
  if (cursor.position === 'key' && cursor.keys.length === 0) return opItems(UPDATE, cursor, opts, '0');
  if (cursor.position === 'key' && cursor.keys.length === 1 && cursor.keys[0]?.startsWith('$')) {
    return fieldItems(fields, [], cursor, opts).map((s) => ({ ...s, retrigger: false }));
  }
  if (cursor.position === 'value' && cursor.keys.length === 2) {
    const def = fields.find((f) => f.path.join('.') === cursor.keys[1]);
    return enumItems(def, [cursor.keys[1] as string], cursor);
  }
  return [];
}

/** `"$field"` references inside aggregation expressions. */
function fieldRefSuggestions(fields: SchemaField[], cursor: CursorContext): Suggestion[] {
  if (!cursor.quote || !cursor.partial.startsWith('$')) return [];
  return fields.map((f) => {
    const ref = `$${f.path.join('.')}`;
    return { label: ref, kind: 'field', insertText: `${cursor.quote}${ref}${cursor.quote}`, detail: f.isArray ? 'array' : f.type, sortText: ref };
  });
}

function pipelineSuggestions(fields: SchemaField[], cursor: CursorContext, opts: EngineOptions): Suggestion[] {
  // keys[0] is the pipeline array element (null); keys[1] the stage operator.
  const refs = fieldRefSuggestions(fields, cursor);
  if (refs.length) return refs;
  const keys = cursor.keys;
  if (cursor.position === 'key' && keys.length === 1 && keys[0] === null) return opItems(STAGES, cursor, opts, '0');
  const stage = keys[1];
  if (!stage) return [];
  const inner: CursorContext = { ...cursor, keys: keys.slice(2) };
  switch (stage) {
    case '$match':
      return filterSuggestions(fields, inner, opts);
    case '$project':
    case '$sort':
    case '$addFields':
    case '$set':
      return keyListSuggestions(fields, inner, opts, stage === '$sort' ? 'sort' : 'projection');
    case '$group':
      if (inner.position === 'key' && inner.keys.length === 1) return [];
      if (inner.position === 'value' && inner.keys.length === 1 && !inner.quote) return [];
      if (inner.position === 'key' && inner.keys.length === 2) return opItems(ACCUMULATORS, inner, opts, '0');
      return [];
    default:
      return [];
  }
}

export function complete(kind: QueryKind, textBefore: string, fields: SchemaField[], opts: EngineOptions): CompletionResult {
  const cursor = analyzeCursor(textBefore);
  let suggestions: Suggestion[] = [];
  switch (kind) {
    case 'filter':
      suggestions = filterSuggestions(fields, cursor, opts);
      break;
    case 'projection':
    case 'sort':
      suggestions = keyListSuggestions(fields, cursor, opts, kind);
      break;
    case 'update':
      suggestions = updateSuggestions(fields, cursor, opts);
      break;
    case 'pipeline':
      suggestions = pipelineSuggestions(fields, cursor, opts);
      break;
    case 'fieldName':
      if (cursor.quote) {
        suggestions = fields.map((f) => {
          const p = f.path.join('.');
          return { label: p, kind: 'field', insertText: `${cursor.quote}${p}${cursor.quote}`, detail: f.isArray ? 'array' : f.type, sortText: p };
        });
      }
      break;
  }
  return { suggestions, partial: cursor.partial, quote: cursor.quote };
}

// ---------------------------------------------------------------------------
// Script (JavaScript) context: which call / argument is the cursor inside?
// ---------------------------------------------------------------------------

export type ScriptContext =
  | { type: 'dbMember'; partial: string }
  | { type: 'collectionMember'; collection: string; partial: string }
  | { type: 'cursorMember'; partial: string }
  | { type: 'argument'; collection: string | null; method: string; argIndex: number; argText: string }
  | { type: 'none' };

const COLLECTION_REF = String.raw`db\s*\.\s*(?:getCollection\(\s*['"]([^'"]+)['"]\s*\)|([A-Za-z_$][\w$]*)|\[\s*['"]([^'"]+)['"]\s*\])`;

interface OpenParen {
  index: number;
  argStart: number;
  argIndex: number;
}

/**
 * Forward scan (strings, comments, template literals, brackets) to find the
 * innermost unclosed call around the cursor, then name its method and collection.
 */
export function analyzeScript(text: string): ScriptContext {
  const stack: ({ ch: '(' } & OpenParen | { ch: '[' | '{' })[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i] as string;
    const next = text[i + 1];
    if (ch === '/' && next === '/') {
      const nl = text.indexOf('\n', i);
      if (nl === -1) return { type: 'none' };
      i = nl + 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end === -1) return { type: 'none' };
      i = end + 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1;
      while (j < text.length && text[j] !== ch) j += text[j] === '\\' ? 2 : 1;
      if (j >= text.length) break; // cursor inside a string: handled by the argument analysis
      i = j + 1;
      continue;
    }
    if (ch === '(') stack.push({ ch: '(', index: i, argStart: i + 1, argIndex: 0 });
    else if (ch === '[' || ch === '{') stack.push({ ch });
    else if (ch === ')' || ch === ']' || ch === '}') stack.pop();
    else if (ch === ',') {
      const top = stack[stack.length - 1];
      if (top?.ch === '(') {
        top.argIndex += 1;
        top.argStart = i + 1;
      }
    }
    i += 1;
  }

  // Member access right before the cursor: `db.`, `db.policies.`, `….find({}).`
  const member = /([\w$)\]]\s*)\.\s*([A-Za-z_$][\w$]*)?$/.exec(text);
  const inString = /(["'`])[^"'`]*$/.test(text) && (text.match(/["'`]/g)?.length ?? 0) % 2 === 1;
  if (member && !inString) {
    const partial = member[2] ?? '';
    const head = text.slice(0, member.index + (member[1] as string).length).trimEnd();
    if (/(^|[^\w$.])db$/.test(head)) return { type: 'dbMember', partial };
    const coll = new RegExp(`${COLLECTION_REF}$`).exec(head);
    if (coll) return { type: 'collectionMember', collection: (coll[1] ?? coll[2] ?? coll[3]) as string, partial };
    if (head.endsWith(')')) return { type: 'cursorMember', partial };
  }

  const open = [...stack].reverse().find((f) => f.ch === '(') as (OpenParen & { ch: '(' }) | undefined;
  if (!open) return { type: 'none' };
  // The innermost container must be inside this call (no stray `(` from arithmetic).
  const before = text.slice(0, open.index);
  const method = /\.\s*([A-Za-z_$][\w$]*)\s*$/.exec(before)?.[1];
  if (!method) return { type: 'none' };
  // Collection: the last `db.<coll>` reference of the statement before this call.
  const stmtStart = Math.max(before.lastIndexOf(';'), before.lastIndexOf('\n\n'));
  const refs = [...before.slice(stmtStart + 1).matchAll(new RegExp(COLLECTION_REF, 'g'))];
  const last = refs[refs.length - 1];
  const collection = last ? ((last[1] ?? last[2] ?? last[3]) as string) : null;
  return { type: 'argument', collection, method, argIndex: open.argIndex, argText: text.slice(open.argStart) };
}

/** What a collection-method argument holds. */
export function argumentKind(method: string, argIndex: number): QueryKind | null {
  switch (method) {
    case 'find':
    case 'findOne':
      return argIndex === 0 ? 'filter' : argIndex === 1 ? 'projection' : null;
    case 'countDocuments':
    case 'count':
    case 'deleteOne':
    case 'deleteMany':
    case 'replaceOne':
      return argIndex === 0 ? 'filter' : null;
    case 'updateOne':
    case 'updateMany':
      return argIndex === 0 ? 'filter' : argIndex === 1 ? 'update' : null;
    case 'distinct':
      return argIndex === 0 ? 'fieldName' : argIndex === 1 ? 'filter' : null;
    case 'aggregate':
      return argIndex === 0 ? 'pipeline' : null;
    case 'sort':
      return 'sort';
    case 'project':
    case 'projection':
      return 'projection';
    default:
      return null;
  }
}

type Method = [name: string, insert: string, doc: string];

export const COLLECTION_METHODS: Method[] = [
  ['find', 'find({ $0 })', 'Query documents (returns a cursor)'],
  ['findOne', 'findOne({ $0 })', 'First matching document'],
  ['aggregate', 'aggregate([\n\t{ \\$match: { $0 } }\n])', 'Aggregation pipeline'],
  ['countDocuments', 'countDocuments({ $0 })', 'Count matching documents'],
  ['estimatedDocumentCount', 'estimatedDocumentCount()', 'Fast count from metadata'],
  ['distinct', 'distinct("$1", { $0 })', 'Distinct values of a field'],
  ['getIndexes', 'getIndexes()', 'Indexes of the collection'],
  ['insertOne', 'insertOne({ $0 })', 'Insert a document (blocked when read-only)'],
  ['insertMany', 'insertMany([$0])', 'Insert documents (blocked when read-only)'],
  ['updateOne', 'updateOne({ $1 }, { \\$set: { $0 } })', 'Update one document (blocked when read-only)'],
  ['updateMany', 'updateMany({ $1 }, { \\$set: { $0 } })', 'Update documents (blocked when read-only)'],
  ['replaceOne', 'replaceOne({ $1 }, { $0 })', 'Replace a document (blocked when read-only)'],
  ['deleteOne', 'deleteOne({ $0 })', 'Delete one document (blocked when read-only)'],
  ['deleteMany', 'deleteMany({ $0 })', 'Delete documents (blocked when read-only)'],
];

export const CURSOR_METHODS: Method[] = [
  ['sort', 'sort({ $0 })', 'Sort the results'],
  ['limit', 'limit(${1:10})', 'At most N documents'],
  ['skip', 'skip(${1:0})', 'Skip N documents'],
  ['project', 'project({ $0 })', 'Projection'],
  ['toArray', 'toArray()', 'All documents as an array'],
  ['forEach', 'forEach((doc) => {\n\t$0\n})', 'Run a function for each document'],
  ['map', 'map((doc) => $0)', 'Array of mapped values'],
  ['count', 'count()', 'Count matching documents'],
  ['hasNext', 'hasNext()', 'More documents?'],
  ['next', 'next()', 'Next document'],
  ['itcount', 'itcount()', 'Iterate and count'],
  ['pretty', 'pretty()', 'No-op (mongosh compatibility)'],
];

export const DB_METHODS: Method[] = [
  ['getCollection', 'getCollection("$0")', 'Collection by name'],
  ['getCollectionNames', 'getCollectionNames()', 'Names of all collections'],
  ['getSiblingDB', 'getSiblingDB("$0")', 'Another database on the same connection'],
  ['getName', 'getName()', 'Current database name'],
];
