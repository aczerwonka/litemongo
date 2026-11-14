import { classify } from './ejson';

/**
 * Path helpers over canonical-EJSON documents in the browser. Paths are dotted
 * (`covers.loadings.code`); arrays along the way are traversed implicitly, the
 * same way MongoDB resolves `{ "covers.loadings.code": … }`.
 */

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return classify(v).kind === 'object';
}

/** Every value reachable at `path`, flattening arrays (a leaf array contributes its elements). */
export function collectPathValues(doc: unknown, path: string): unknown[] {
  const segments = path.replace(/\[\]/g, '').split('.').filter(Boolean);
  const out: unknown[] = [];
  const visit = (node: unknown, i: number): void => {
    if (node === undefined) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, i);
      return;
    }
    if (i === segments.length) {
      out.push(node);
      return;
    }
    if (!isPlainObject(node)) return;
    visit(node[segments[i] as string], i + 1);
  };
  visit(doc, 0);
  return out;
}

/**
 * Scalar leaf paths found under `path` in the given documents (e.g. for `covers`:
 * `covers.code`, `covers.loadings.code`, …). Used to offer drill-down targets for
 * fields whose values are objects or arrays of objects.
 */
export function leafPaths(docs: unknown[], path: string, maxDepth = 4, maxPaths = 40): string[] {
  const found = new Set<string>();
  const walk = (node: unknown, prefix: string, depth: number): void => {
    if (found.size >= maxPaths || depth > maxDepth) return;
    if (Array.isArray(node)) {
      for (const item of node.slice(0, 50)) walk(item, prefix, depth);
      return;
    }
    if (isPlainObject(node)) {
      for (const [k, v] of Object.entries(node)) walk(v, `${prefix}.${k}`, depth + 1);
      return;
    }
    if (prefix !== path) found.add(prefix);
  };
  for (const doc of docs.slice(0, 200)) {
    for (const value of collectPathValues(doc, path)) walk(value, path, 0);
  }
  return [...found].sort();
}

/** Stable identity for an EJSON value (type-tagged so "1" and 1 differ). */
export function valueKey(value: unknown): string {
  const c = classify(value);
  return `${c.type}:${c.kind === 'object' || c.kind === 'array' ? JSON.stringify(value) : c.text}`;
}

export interface DistinctCount {
  value: unknown;
  count: number;
}

/** Distinct values with frequency counts across documents, most frequent first. */
export function distinctCounts(docs: unknown[], path: string): { values: DistinctCount[]; missing: number } {
  const counts = new Map<string, DistinctCount>();
  let missing = 0;
  for (const doc of docs) {
    const values = collectPathValues(doc, path);
    if (values.length === 0) missing += 1;
    for (const value of values) {
      const key = valueKey(value);
      const entry = counts.get(key);
      if (entry) entry.count += 1;
      else counts.set(key, { value, count: 1 });
    }
  }
  const values = [...counts.values()].sort(
    (a, b) => b.count - a.count || classify(a.value).text.localeCompare(classify(b.value).text),
  );
  return { values, missing };
}
