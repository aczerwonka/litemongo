import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Document } from 'mongodb';
import { ObjectId } from '../src/lib/bson.js';
import { getPathValues, typedKey } from '../src/lib/paths.js';
import { convertParams, runRecipe, type RecipeDb } from '../src/db/recipeRunner.js';
import { parseRecipe } from '../src/lib/recipe.js';

/** In-memory find() supporting equality, $in and $and — enough for the runner. */
function fakeDb(data: Record<string, Document[]>): RecipeDb & { calls: { collection: string; filter: Document }[] } {
  const calls: { collection: string; filter: Document }[] = [];
  const matches = (doc: Document, filter: Document): boolean =>
    Object.entries(filter).every(([key, cond]) => {
      if (key === '$and') return (cond as Document[]).every((f) => matches(doc, f));
      const values = getPathValues(doc, key).map(typedKey);
      if (cond && typeof cond === 'object' && '$in' in cond) {
        const wanted = new Set((cond.$in as unknown[]).map(typedKey));
        return values.some((v) => wanted.has(v));
      }
      return values.includes(typedKey(cond));
    });
  return {
    calls,
    async find(collection, filter, { sort, limit }) {
      calls.push({ collection, filter });
      let docs = (data[collection] ?? []).filter((d) => matches(d, filter));
      const [field, dir] = Object.entries((sort ?? {}) as Record<string, number>)[0] ?? [];
      if (field) docs = [...docs].sort((a, b) => (a[field] > b[field] ? 1 : -1) * (dir as number));
      return docs.slice(0, limit);
    },
  };
}

const p1 = new ObjectId();
const p2 = new ObjectId();
const data = {
  policies: [
    { _id: p1, policyNumber: 'P-1', status: 'ACTIVE' },
    { _id: p2, policyNumber: 'P-2', status: 'ACTIVE' },
  ],
  claims: [1, 2, 3, 4, 5].map((n) => ({ _id: new ObjectId(), policyId: n <= 4 ? p1 : p2, n })),
};

describe('parseRecipe', () => {
  it('defaults parent to the previous step and strategy to $in', () => {
    const r = parseRecipe({
      id: 'r',
      steps: [
        { id: 'pol', collection: 'policies' },
        { id: 'clm', collection: 'claims', localField: '_id', foreignField: 'policyId' },
      ],
    });
    assert.equal(r.steps[1]?.parent, 'pol');
    assert.equal(r.steps[1]?.strategy, 'in');
  });

  it('rejects parent placeholders outside nested loops and unknown params', () => {
    assert.throws(
      () =>
        parseRecipe({
          steps: [
            { id: 'a', collection: 'a' },
            { id: 'b', collection: 'b', localField: '_id', foreignField: 'aId', filter: { x: '{{parent.y}}' } },
          ],
        }),
      /only available in nested-loop/,
    );
    assert.throws(() => parseRecipe({ steps: [{ id: 'a', collection: 'a', filter: { x: '{{nope}}' } }] }), /unknown parameter/);
  });
});

describe('runRecipe', () => {
  it('in: one query for all parents, stitched per parent', async () => {
    const db = fakeDb(data);
    const res = await runRecipe(
      db,
      parseRecipe({
        id: 'r',
        steps: [
          { id: 'pol', collection: 'policies' },
          { id: 'clm', collection: 'claims', localField: '_id', foreignField: 'policyId' },
        ],
      }),
    );
    assert.equal(res.queries, 2);
    assert.equal(res.roots[0]?.children.clm?.length, 4);
    assert.equal(res.roots[1]?.children.clm?.length, 1);
  });

  it('batched: keys go out in packets', async () => {
    const db = fakeDb(data);
    const res = await runRecipe(
      db,
      parseRecipe({
        steps: [
          { id: 'pol', collection: 'policies' },
          { id: 'clm', collection: 'claims', strategy: 'batched', batchSize: 1, localField: '_id', foreignField: 'policyId' },
        ],
      }),
    );
    assert.equal(res.steps[1]?.queries, 2);
    assert.deepEqual(res.trace.filter((t) => t.step === 'clm').map((t) => t.label).sort(), ['batch 1/2', 'batch 2/2']);
    assert.equal(res.roots[0]?.children.clm?.length, 4);
  });

  it('nested-loop: one query per parent with its own limit and sort', async () => {
    const db = fakeDb(data);
    const res = await runRecipe(
      db,
      parseRecipe({
        steps: [
          { id: 'pol', collection: 'policies' },
          { id: 'clm', collection: 'claims', strategy: 'nested-loop', filter: { policyId: '{{parent._id}}' }, sort: { n: -1 }, limit: 2 },
        ],
      }),
    );
    assert.equal(res.steps[1]?.queries, 2);
    assert.deepEqual(res.roots[0]?.children.clm?.map((c) => c.doc.n), [4, 3]);
    assert.equal(res.steps[1]?.truncated, true);
  });

  it('params: typed substitution, optional empty params drop their key', async () => {
    const db = fakeDb(data);
    const recipe = parseRecipe({
      params: [
        { name: 'num', type: 'string' },
        { name: 'status' },
      ],
      steps: [{ id: 'pol', collection: 'policies', filter: { policyNumber: '{{num}}', status: '{{status}}' } }],
    });
    const res = await runRecipe(db, recipe, { params: { num: 'P-2', status: '' } });
    assert.deepEqual(db.calls[0]?.filter, { policyNumber: 'P-2' });
    assert.equal(res.roots.length, 1);
  });

  it('fills placeholders before EJSON parsing ($regex, ObjectId params)', async () => {
    const db = fakeDb(data);
    const recipe = parseRecipe({
      params: [{ name: 'q' }, { name: 'id', type: 'objectId' }],
      steps: [{ id: 'pol', collection: 'policies', filter: { policyNumber: { $regex: '^{{q}}', $options: 'i' }, _id: '{{id}}' } }],
    });
    await runRecipe(db, recipe, { params: { q: 'P-', id: p1.toHexString() } });
    const filter = db.calls[0]?.filter as { policyNumber: { pattern: string }; _id: ObjectId };
    assert.equal(filter.policyNumber.pattern, '^P-');
    assert.ok(filter._id instanceof ObjectId && filter._id.equals(p1));
  });

  it('convertParams validates types', () => {
    assert.throws(() => convertParams([{ name: 'id', type: 'objectId' }], { id: 'xyz' }), /ObjectId/);
    assert.throws(() => convertParams([{ name: 'q', required: true }], {}), /required/);
    assert.ok(convertParams([{ name: 'd', type: 'date' }], { d: '2026-01-01' }).get('d') instanceof Date);
  });

  it('stops at the query budget', async () => {
    const db = fakeDb(data);
    const res = await runRecipe(
      db,
      parseRecipe({
        steps: [
          { id: 'pol', collection: 'policies' },
          { id: 'clm', collection: 'claims', strategy: 'nested-loop', localField: '_id', foreignField: 'policyId' },
        ],
      }),
      { maxQueries: 2 },
    );
    assert.equal(res.queries, 2);
    assert.match(res.warnings.join(), /budget/);
  });
});
