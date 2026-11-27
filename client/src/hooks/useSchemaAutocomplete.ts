import { useEffect } from 'react';
import type { ConnectionContext } from '../lib/api';
import { collectionNames, peekSampledFields, sampledFields } from '../lib/fieldCatalog';
import { monaco } from '../lib/monaco';
import {
  analyzeScript,
  argumentKind,
  COLLECTION_METHODS,
  complete,
  CURSOR_METHODS,
  DB_METHODS,
  type QueryKind,
  type SchemaField,
  type Suggestion,
} from '../lib/mqlCompletion';
import { fieldMapOf, mergeFields, type FieldMap } from '../lib/schema';
import { analyzeCursor } from '../lib/queryContext';
import { describeType, referencedCollections, ScriptTyper, type ScriptType } from '../lib/scriptTypes';
import { useWorkspaceStore } from '../store/useWorkspaceStore';

/**
 * Monaco completion for MQL, driven by the application-level schema registry
 * (litemongo.config.json `schemas[collection].coreFields`) merged with fields
 * sampled from real documents (first / last / random by _id), so it also works
 * for collections nobody documented yet.
 *
 *  - JSON editors (filter / projection / sort): field paths, query operators
 *    ($elemMatch for arrays first), `{ $in: [] }`-style value templates, enum codes.
 *  - Script editor: `db.` → collections, `db.coll.` → methods, `….find({}).` →
 *    cursor methods, and the query engine inside find / aggregate / update / … args.
 *
 * Monaco providers are global per language, so one provider per language is
 * registered and each editor model is mapped to its context.
 */

export type EditorKind = 'filter' | 'projection' | 'sort' | 'script';

export interface CompletionContext {
  /** Collection of a query editor (scripts name their collections themselves). */
  collection: string | null;
  kind: EditorKind;
  /** Where to sample fields / list collections from. */
  conn?: ConnectionContext | undefined;
  db?: string | null | undefined;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Flatten a field tree (array `items` and embedded-object `fields`) into dotted paths. */
export function flattenSchema(coreFields: unknown): SchemaField[] {
  const out: SchemaField[] = [];
  const walk = (fields: unknown, prefix: string[]) => {
    if (!isRecord(fields)) return;
    for (const [name, def] of Object.entries(fields)) {
      const path = [...prefix, name];
      const d = isRecord(def) ? def : {};
      const enumValues = Array.isArray(d.enum) ? d.enum.filter((v): v is string => typeof v === 'string') : undefined;
      out.push({
        path,
        ...(typeof d.type === 'string' ? { type: d.type } : {}),
        ...(typeof d.description === 'string' ? { description: d.description } : {}),
        ...(enumValues ? { enum: enumValues } : {}),
        isArray: d.type === 'array',
      });
      if (isRecord(d.items)) walk(d.items, path);
      if (isRecord(d.fields)) walk(d.fields, path);
    }
  };
  walk(coreFields, []);
  return out;
}

const contexts = new Map<string, CompletionContext>();
const registered = new Set<string>();

/** Documented fields merged with sampled ones (documented definitions win). */
async function fieldsFor(ctx: CompletionContext, collection: string | null, wait: boolean): Promise<SchemaField[]> {
  if (!collection) return [];
  const documented = fieldMapOf(useWorkspaceStore.getState().config.schemas?.[collection]);
  let sampled: FieldMap | undefined;
  if (ctx.conn && ctx.db) {
    sampled = peekSampledFields(ctx.conn, ctx.db, collection);
    if (!sampled) {
      const pending = sampledFields(ctx.conn, ctx.db, collection);
      // Wait briefly the first time so the very first suggestion list already has the fields.
      sampled = wait ? await Promise.race([pending, new Promise<undefined>((r) => setTimeout(r, 1500))]) : undefined;
    }
  }
  const merged = sampled ? mergeFields(documented, sampled).fields : documented;
  return flattenSchema(merged);
}

function toItems(
  suggestions: Suggestion[],
  model: monaco.editor.ITextModel,
  position: monaco.Position,
  partial: string,
  quote: '"' | "'" | null,
): monaco.languages.CompletionItem[] {
  // Replace the partial token, including its opening quote and an auto-closed quote after the cursor.
  const startColumn = position.column - partial.length - (quote ? 1 : 0);
  const lineText = model.getLineContent(position.lineNumber);
  const closing = quote && lineText[position.column - 1] === quote ? 1 : 0;
  const range = new monaco.Range(position.lineNumber, Math.max(1, startColumn), position.lineNumber, position.column + closing);
  const K = monaco.languages.CompletionItemKind;
  const kinds: Record<Suggestion['kind'], monaco.languages.CompletionItemKind> = {
    field: K.Field,
    operator: K.Operator,
    value: K.Value,
    enum: K.EnumMember,
    stage: K.Keyword,
    method: K.Method,
    collection: K.Module,
  };
  return suggestions.map((s) => ({
    label: s.label,
    kind: kinds[s.kind],
    insertText: s.insertText,
    ...(s.snippet ? { insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet } : {}),
    ...(s.detail ? { detail: s.detail } : {}),
    ...(s.documentation ? { documentation: s.documentation } : {}),
    filterText: `${quote ?? ''}${s.label}`,
    sortText: s.sortText ?? s.label,
    range,
    ...(s.retrigger ? { command: { id: 'editor.action.triggerSuggest', title: 'Suggest values' } } : {}),
  }));
}

function memberItems(
  methods: [string, string, string][],
  extra: Suggestion[],
  model: monaco.editor.ITextModel,
  position: monaco.Position,
  partial: string,
): monaco.languages.CompletionList {
  const suggestions: Suggestion[] = [
    ...extra,
    ...methods.map(([label, insertText, documentation]) => ({ label, kind: 'method' as const, insertText, snippet: true, documentation, sortText: `1${label}` })),
  ];
  return { suggestions: toItems(suggestions, model, position, partial, null) };
}

/** Typer over the fields of every collection the script mentions (documented + sampled). */
async function typerFor(ctx: CompletionContext, script: string, wait: boolean): Promise<ScriptTyper> {
  const names = referencedCollections(script);
  const lists = await Promise.all(names.map((n) => fieldsFor(ctx, n, wait)));
  const map = new Map(names.map((n, i) => [n, lists[i] as SchemaField[]]));
  return new ScriptTyper((c) => map.get(c) ?? []);
}

/** `policies` → `policy`, `claim_items` → `claim_item` (callback parameter names). */
function singular(name: string): string {
  const base = name.replace(/\d+$/, '').split(/[._]/).pop() || name;
  if (/ies$/.test(base)) return base.replace(/ies$/, 'y');
  if (/(ss|us)$/.test(base)) return base;
  if (/s$/.test(base)) return base.slice(0, -1);
  return base === name ? 'item' : base;
}

function elementName(t: ScriptType): string {
  if (t.t === 'cursor') return t.coll ? singular(t.coll) : 'doc';
  if (t.t === 'value') return t.path.length ? singular(t.path[t.path.length - 1] as string) : singular(t.coll);
  return 'x';
}

function arrayMethods(x: string): [string, string, string][] {
  return [
    ['length', 'length', 'Number of elements'],
    ['forEach', `forEach((\${1:${x}}) => {\n\t$0\n})`, 'Run a function for each element'],
    ['map', `map((\${1:${x}}) => \${1:${x}}.$0)`, 'New array of mapped values'],
    ['filter', `filter((\${1:${x}}) => \${1:${x}}.$0)`, 'Elements matching a condition'],
    ['find', `find((\${1:${x}}) => \${1:${x}}.$0)`, 'First element matching a condition'],
    ['some', `some((\${1:${x}}) => \${1:${x}}.$0)`, 'Does any element match?'],
    ['every', `every((\${1:${x}}) => \${1:${x}}.$0)`, 'Do all elements match?'],
    ['flatMap', `flatMap((\${1:${x}}) => \${1:${x}}.$0)`, 'Map and flatten one level'],
    ['includes', 'includes($0)', 'Contains the value?'],
    ['slice', 'slice(${1:0}, ${2:10})', 'Part of the array'],
    ['join', 'join("${1:, }")', 'Join into a string'],
  ];
}

function fieldDoc(f: SchemaField): string | undefined {
  return [f.description, f.enum?.length ? `Codes: ${f.enum.join(', ')}` : ''].filter(Boolean).join('\n\n') || undefined;
}

function fieldDetail(f: SchemaField): string | undefined {
  return f.isArray ? 'array' : f.type;
}

/** Members of an inferred value: document fields, or array methods for arrays. */
function valueMembers(typer: ScriptTyper, t: ScriptType & { t: 'value' }): Suggestion[] {
  if (t.array) {
    return arrayMethods(elementName(t)).map(([label, insertText, documentation]) => ({
      label,
      kind: 'method',
      insertText,
      snippet: true,
      detail: describeType(t),
      documentation,
      sortText: `1${label}`,
    }));
  }
  return typer.children(t).map((f) => {
    const name = f.path[f.path.length - 1] as string;
    const detail = fieldDetail(f);
    const documentation = fieldDoc(f);
    return {
      label: name,
      kind: 'field',
      insertText: name,
      ...(detail ? { detail } : {}),
      ...(documentation ? { documentation } : {}),
      sortText: `0${name}`,
    };
  });
}

/** Cursor methods whose callbacks are named after the collection (`forEach((policy) => …)`). */
function cursorMethods(t: ScriptType): [string, string, string][] {
  const x = elementName(t);
  return CURSOR_METHODS.map(([label, insert, doc]) => [label, insert.replace('(doc)', `(\${1:${x}})`), doc]);
}

const GLOBALS: [string, string, string][] = [
  ['db', 'db', 'Current database (db.<collection>.find(…))'],
  ['print', 'print($0)', 'Print values to the console'],
  ['printjson', 'printjson($0)', 'Print a value as shell JSON'],
  ['console', 'console', 'console.log / warn / error'],
  ['ObjectId', 'ObjectId("$0")', 'ObjectId from a 24-character hex string'],
  ['ISODate', 'ISODate("${1:2026-01-01}")', 'Date from an ISO string'],
  ['NumberDecimal', 'NumberDecimal("$0")', 'Decimal128 value'],
  ['NumberLong', 'NumberLong("$0")', 'Int64 value'],
  ['NumberInt', 'NumberInt($0)', 'Int32 value'],
  ['UUID', 'UUID("$0")', 'UUID value'],
  ['tojson', 'tojson($0)', 'Shell JSON text of a value'],
  ['sleep', 'sleep(${1:100})', 'Pause (ms, max 10 s)'],
];

function globalItems(typer: ScriptTyper, before: string): Suggestion[] {
  const vars: Suggestion[] = typer.variables(before).map((v) => {
    const t = typer.binding(v, before);
    const detail = describeType(t);
    return { label: v, kind: 'value', insertText: v, ...(detail ? { detail } : {}), sortText: `0${v}` };
  });
  const globals: Suggestion[] = GLOBALS.map(([label, insertText, documentation]) => ({
    label,
    kind: 'method',
    insertText,
    snippet: true,
    documentation,
    sortText: `2${label}`,
  }));
  return [...vars, ...globals];
}

/** Cursor inside an unfinished string on the current line? */
function inStringOnLine(before: string): boolean {
  const line = before.slice(before.lastIndexOf('\n') + 1);
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] as string;
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
    } else if (ch === '/' && line[i + 1] === '/') return false;
    else if (ch === '"' || ch === "'" || ch === '`') quote = ch;
  }
  return quote !== null;
}

function inComment(before: string): boolean {
  const line = before.slice(before.lastIndexOf('\n') + 1);
  return /^[^"'`]*\/\//.test(line) || before.lastIndexOf('/*') > before.lastIndexOf('*/');
}

async function provideScript(
  ctx: CompletionContext,
  model: monaco.editor.ITextModel,
  position: monaco.Position,
): Promise<monaco.languages.CompletionList | undefined> {
  const before = model.getValueInRange({ startLineNumber: 1, startColumn: 1, endLineNumber: position.lineNumber, endColumn: position.column });
  if (inComment(before)) return undefined;
  const typer = await typerFor(ctx, model.getValue(), true);

  // `p.status === "` → the field's codes.
  const cmp = /(?:===|!==|==|!=)\s*(["'])([^"'\n]*)$/.exec(before);
  if (cmp) {
    const left = before.slice(0, cmp.index).trimEnd();
    const def = typer.fieldOf(typer.resolveBefore(left, left.length));
    if (def?.enum?.length) {
      const quote = cmp[1] as '"' | "'";
      const items: Suggestion[] = def.enum.map((code) => ({
        label: code,
        kind: 'enum',
        insertText: `${quote}${code}${quote}`,
        detail: def.path.join('.'),
        sortText: `0${code}`,
      }));
      return { suggestions: toItems(items, model, position, cmp[2] as string, quote) };
    }
  }

  // Member access on an inferred value: `p.`, `p.covers.`, `cover.`, `const c = db.policies; c.`
  const member = /\??\.\s*([A-Za-z_$][\w$]*)?$/.exec(before);
  if (member && !inStringOnLine(before) && !/\d$/.test(before.slice(0, member.index))) {
    const t = typer.resolveBefore(before, member.index);
    const partial = member[1] ?? '';
    if (t.t === 'value') return { suggestions: toItems(valueMembers(typer, t), model, position, partial, null) };
    if (t.t === 'cursor') return memberItems(cursorMethods(t), [], model, position, partial);
    if (t.t === 'collection') return memberItems(COLLECTION_METHODS, [], model, position, partial);
  }

  const sc = analyzeScript(before);
  switch (sc.type) {
    case 'dbMember': {
      const names = ctx.conn && ctx.db ? await collectionNames(ctx.conn, ctx.db) : [];
      const extra: Suggestion[] = names.map((n) => ({
        label: n,
        kind: 'collection',
        insertText: /^[A-Za-z_$][\w$]*$/.test(n) ? n : `getCollection(${JSON.stringify(n)})`,
        detail: 'collection',
        sortText: `0${n}`,
      }));
      return memberItems(DB_METHODS, extra, model, position, sc.partial);
    }
    case 'collectionMember':
      return memberItems(COLLECTION_METHODS, [], model, position, sc.partial);
    case 'cursorMember':
      return memberItems(CURSOR_METHODS, [], model, position, sc.partial);
    case 'argument': {
      const kind = argumentKind(sc.method, sc.argIndex);
      if (kind) {
        const fields = await fieldsFor(ctx, sc.collection, true);
        const res = complete(kind, sc.argText, fields, { js: true });
        // Values inside a query also accept variables and shell helpers (ObjectId, ISODate, …).
        const word = /(?:^|[^\w$.])([A-Za-z_$][\w$]*)$/.exec(before);
        const extra = word && !res.quote && analyzeCursor(sc.argText).position === 'value' ? globalItems(typer, before) : [];
        return { suggestions: toItems([...res.suggestions, ...extra], model, position, res.partial, res.quote) };
      }
      break;
    }
    default:
      break;
  }
  // Bare identifier: variables (with their inferred type) and shell globals.
  const word = /(?:^|[^\w$.])([A-Za-z_$][\w$]*)$/.exec(before);
  if (word && !inStringOnLine(before)) {
    return { suggestions: toItems(globalItems(typer, before), model, position, word[1] as string, null) };
  }
  return undefined;
}

/** Hover on a script identifier: inferred type, field type, description and codes. */
async function provideHover(model: monaco.editor.ITextModel, position: monaco.Position): Promise<monaco.languages.Hover | undefined> {
  const ctx = contexts.get(model.uri.toString());
  if (ctx?.kind !== 'script') return undefined;
  const word = model.getWordAtPosition(position);
  if (!word) return undefined;
  const text = model.getValue();
  const end = model.getOffsetAt({ lineNumber: position.lineNumber, column: word.endColumn });
  const typer = await typerFor(ctx, text, false);
  const t = typer.resolveBefore(text, end);
  if (t.t === 'unknown' || t.t === 'db') return undefined;
  const def = typer.fieldOf(t);
  const lines = [`\`${describeType(t)}\`${def?.type && !def.isArray ? ` : ${def.type}` : ''}`];
  if (def?.description) lines.push(def.description);
  if (def?.enum?.length) lines.push(`Codes: ${def.enum.map((c) => `\`${c}\``).join(', ')}`);
  if (t.t === 'value') {
    const kids = typer.children({ ...t, array: false });
    if (kids.length) lines.push(`Fields: ${kids.map((f) => f.path[f.path.length - 1]).join(', ')}`);
  }
  return {
    range: new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn),
    contents: lines.map((value) => ({ value })),
  };
}

async function provide(model: monaco.editor.ITextModel, position: monaco.Position): Promise<monaco.languages.CompletionList | undefined> {
  const ctx = contexts.get(model.uri.toString());
  if (!ctx) return undefined;
  if (ctx.kind === 'script') return provideScript(ctx, model, position);
  if (!ctx.collection) return undefined;
  const fields = await fieldsFor(ctx, ctx.collection, true);
  const before = model.getValueInRange({ startLineNumber: 1, startColumn: 1, endLineNumber: position.lineNumber, endColumn: position.column });
  const res = complete(ctx.kind as QueryKind, before, fields, { js: false });
  return { suggestions: toItems(res.suggestions, model, position, res.partial, res.quote) };
}

function ensureRegistered(language: 'json' | 'javascript'): void {
  if (registered.has(language)) return;
  registered.add(language);
  monaco.languages.registerCompletionItemProvider(language, {
    triggerCharacters: ['"', "'", '$', '.', ':', '{', '[', ',', '('],
    provideCompletionItems: (model, position) => provide(model, position),
  });
  if (language === 'javascript') monaco.languages.registerHoverProvider('javascript', { provideHover: (model, position) => provideHover(model, position) });
}

/** Attach MQL completion to the Monaco model at `path` (the Editor `path` prop). */
export function useSchemaAutocomplete(path: string, context: CompletionContext | undefined): void {
  const collection = context?.collection ?? null;
  const kind = context?.kind;
  const conn = context?.conn;
  const db = context?.db ?? null;
  const uri = conn?.uri;
  const readOnly = conn?.readOnly;
  useEffect(() => {
    if (!kind) return;
    ensureRegistered(kind === 'script' ? 'javascript' : 'json');
    const key = monaco.Uri.parse(path).toString();
    const c: CompletionContext = { collection, kind, db };
    if (uri !== undefined) c.conn = { uri, readOnly: readOnly ?? true };
    contexts.set(key, c);
    // Warm the field sample for query editors so the first suggestions are complete.
    if (c.conn && db && collection) void sampledFields(c.conn, db, collection);
    return () => {
      contexts.delete(key);
    };
  }, [path, collection, kind, db, uri, readOnly]);
}
