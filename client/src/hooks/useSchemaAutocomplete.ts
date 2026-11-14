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

async function provideScript(
  ctx: CompletionContext,
  model: monaco.editor.ITextModel,
  position: monaco.Position,
): Promise<monaco.languages.CompletionList | undefined> {
  const before = model.getValueInRange({ startLineNumber: 1, startColumn: 1, endLineNumber: position.lineNumber, endColumn: position.column });
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
      if (!kind) return undefined;
      const fields = await fieldsFor(ctx, sc.collection, true);
      const res = complete(kind, sc.argText, fields, { js: true });
      return { suggestions: toItems(res.suggestions, model, position, res.partial, res.quote) };
    }
    default:
      return undefined;
  }
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
