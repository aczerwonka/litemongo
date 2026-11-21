import type { Db, Document, Sort } from 'mongodb';
import type { RelationBlueprint } from '../lib/config.js';
import { getPathValues, toMongoPath, typedKey } from '../lib/paths.js';

/**
 * Application-level Master-Detail engine.
 *
 * Instead of a server-side $lookup, each level costs exactly ONE indexed query:
 *   L1: find(filter).limit(N) on the root collection
 *   L2: find({ [foreignField]: { $in: <unique L1 localField values> } })
 *   L3: find({ [foreignField]: { $in: <unique L2 localField values> } })
 * and the hierarchy is stitched in memory.
 */

export const DEFAULT_ROOT_LIMIT = 100;
export const MAX_ROOT_LIMIT = 1_000;
export const DEFAULT_CHILD_LIMIT = 5_000;

export interface MasterDetailRequest {
  blueprint: RelationBlueprint;
  filter?: Document;
  projection?: Document;
  sort?: Sort;
  skip?: number;
  limit?: number;
  /** Max documents fetched per child level (protects the jump host). */
  childLimit?: number;
}

export interface MasterDetailNode {
  collection: string;
  doc: Document;
  /** Child nodes grouped by child collection name. */
  children: Record<string, MasterDetailNode[]>;
}

export interface LevelStats {
  level: number;
  collection: string;
  parentCollection: string;
  localField: string;
  foreignField: string;
  keyCount: number;
  docCount: number;
  truncated: boolean;
  ms: number;
}

export interface MasterDetailResult {
  blueprintId: string;
  roots: MasterDetailNode[];
  /** Flat, de-duplicated documents per collection (used for EJSON export bundles). */
  collections: Record<string, Document[]>;
  stats: {
    queries: number;
    totalMs: number;
    levels: LevelStats[];
  };
}

interface LevelState {
  collection: string;
  nodes: MasterDetailNode[];
}

/**
 * True for a projection inclusion flag: `1`, `true`, or a BSON numeric wrapper
 * (canonical EJSON parsing turns `1` into Int32(1)).
 */
function isInclusionFlag(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (v !== null && typeof v === 'object' && '_bsontype' in v) {
    const t = (v as { _bsontype: string })._bsontype;
    if (t === 'Int32' || t === 'Double' || t === 'Long') return Number(v.valueOf()) !== 0;
  }
  return false;
}

/** If the projection is inclusion-style, make sure `field` survives it. */
export function ensureProjected(projection: Document | undefined, field: string): Document | undefined {
  if (!projection || Object.keys(projection).length === 0) return projection;
  const isInclusion = Object.entries(projection).some(([k, v]) => k !== '_id' && isInclusionFlag(v));
  if (!isInclusion) return projection;
  const path = toMongoPath(field);
  const covered = Object.entries(projection).some(
    ([k, v]) => isInclusionFlag(v) && (k === path || path.startsWith(`${k}.`)),
  );
  if (covered) return projection;
  // Drop any narrower inclusions under `path` to avoid a MongoDB path collision,
  // and override an explicit exclusion (e.g. `_id: 0`) of the join key.
  const next: Document = {};
  for (const [k, v] of Object.entries(projection)) {
    if (k !== path && !k.startsWith(`${path}.`)) next[k] = v;
  }
  next[path] = 1;
  return next;
}

function uniqueValues(docs: Document[], path: string): unknown[] {
  const seen = new Map<string, unknown>();
  for (const doc of docs) {
    for (const value of getPathValues(doc, path)) {
      const key = typedKey(value);
      if (key !== undefined && !seen.has(key)) seen.set(key, value);
    }
  }
  return [...seen.values()];
}

export async function queryMasterDetail(db: Db, req: MasterDetailRequest): Promise<MasterDetailResult> {
  const started = performance.now();
  const { blueprint } = req;
  const limit = Math.min(req.limit ?? DEFAULT_ROOT_LIMIT, MAX_ROOT_LIMIT);
  const childLimit = req.childLimit ?? DEFAULT_CHILD_LIMIT;

  // Root projection must keep every localField that a level 2 relation reads from the root.
  let rootProjection = req.projection;
  for (const lvl of blueprint.levels) {
    if ((lvl.parentCollection ?? blueprint.rootCollection) === blueprint.rootCollection) {
      rootProjection = ensureProjected(rootProjection, lvl.localField);
    }
  }

  let cursor = db.collection(blueprint.rootCollection).find(req.filter ?? {});
  if (rootProjection && Object.keys(rootProjection).length > 0) cursor = cursor.project(rootProjection);
  if (req.sort) cursor = cursor.sort(req.sort);
  if (req.skip) cursor = cursor.skip(req.skip);
  const rootDocs = await cursor.limit(limit).toArray();

  const roots: MasterDetailNode[] = rootDocs.map((doc) => ({
    collection: blueprint.rootCollection,
    doc,
    children: {},
  }));
  const states: LevelState[] = [{ collection: blueprint.rootCollection, nodes: roots }];
  const collections: Record<string, Document[]> = { [blueprint.rootCollection]: rootDocs };
  const levelStats: LevelStats[] = [];
  let queries = 1;

  for (const lvl of blueprint.levels) {
    const levelStart = performance.now();
    // Resolve the parent level: explicit parentCollection, else the previous level.
    const parent = lvl.parentCollection
      ? [...states].reverse().find((s) => s.collection === lvl.parentCollection)
      : states[states.length - 1];
    if (!parent) {
      throw new Error(
        `Blueprint level ${lvl.level}: parentCollection "${lvl.parentCollection}" is not an earlier level`,
      );
    }

    const keys = uniqueValues(
      parent.nodes.map((n) => n.doc),
      lvl.localField,
    );
    const foreignPath = toMongoPath(lvl.foreignField);
    let childDocs: Document[] = [];
    if (keys.length > 0) {
      // Fetch one extra document to detect truncation without a separate count query.
      childDocs = await db
        .collection(lvl.collection)
        .find({ [foreignPath]: { $in: keys } })
        .limit(childLimit + 1)
        .toArray();
      queries += 1;
    }
    const truncated = childDocs.length > childLimit;
    if (truncated) childDocs = childDocs.slice(0, childLimit);

    // Index children by every key they carry at foreignField (handles array FKs).
    const byKey = new Map<string, Document[]>();
    for (const child of childDocs) {
      for (const value of getPathValues(child, lvl.foreignField)) {
        const key = typedKey(value);
        if (key === undefined) continue;
        const bucket = byKey.get(key);
        if (bucket) bucket.push(child);
        else byKey.set(key, [child]);
      }
    }

    // Stitch. One child document is represented by one node object even if it
    // hangs under several parents, so a level 3 query attaches to it once.
    const nodeByChild = new Map<Document, MasterDetailNode>();
    const levelNodes: MasterDetailNode[] = [];
    for (const parentNode of parent.nodes) {
      const attached = new Set<Document>();
      const list: MasterDetailNode[] = [];
      for (const value of getPathValues(parentNode.doc, lvl.localField)) {
        const key = typedKey(value);
        if (key === undefined) continue;
        for (const child of byKey.get(key) ?? []) {
          if (attached.has(child)) continue;
          attached.add(child);
          let node = nodeByChild.get(child);
          if (!node) {
            node = { collection: lvl.collection, doc: child, children: {} };
            nodeByChild.set(child, node);
            levelNodes.push(node);
          }
          list.push(node);
        }
      }
      parentNode.children[lvl.collection] = list;
    }

    states.push({ collection: lvl.collection, nodes: levelNodes });
    collections[lvl.collection] = [...(collections[lvl.collection] ?? []), ...childDocs];
    levelStats.push({
      level: lvl.level,
      collection: lvl.collection,
      parentCollection: parent.collection,
      localField: lvl.localField,
      foreignField: lvl.foreignField,
      keyCount: keys.length,
      docCount: childDocs.length,
      truncated,
      ms: Math.round(performance.now() - levelStart),
    });
  }

  return {
    blueprintId: blueprint.id,
    roots,
    collections,
    stats: { queries, totalMs: Math.round(performance.now() - started), levels: levelStats },
  };
}
