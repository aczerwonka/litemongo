import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Decimal128, Int32, Long, ObjectId, UUID } from '../src/lib/bson.js';
import type { Document } from 'mongodb';
import { buildBundle, parseBundle, remapBundle, serializeBundle } from '../src/db/importer.js';
import { parseRenumberingRules, parseSchemas } from '../src/lib/config.js';
import { exampleConfig, seedCollections } from './fixtures.js';

const options = {
  schemas: parseSchemas(exampleConfig.schemas),
  renumberingRules: parseRenumberingRules(exampleConfig.renumberingRules),
  now: new Date('2026-11-13T10:00:00Z'),
};

function remapSeed(mutate?: (c: Record<string, Document[]>) => void) {
  const collections = seedCollections();
  mutate?.(collections);
  // Round-trip through the clipboard format first, like the real flow.
  const bundle = parseBundle(serializeBundle(buildBundle(collections)));
  return { original: collections, ...remapBundle(bundle, options) };
}

describe('two-pass EJSON remapper', () => {
  it('remaps root ids with the same BSON type', () => {
    const { original, bundle } = remapSeed();
    const [oldP1] = original.policies as Document[];
    const [newP1] = bundle.collections.policies as Document[];
    assert.ok(newP1?._id instanceof ObjectId);
    assert.notEqual(newP1._id.toHexString(), (oldP1?._id as ObjectId).toHexString());
  });

  it('rewrites soft foreign keys across 3 levels consistently', () => {
    const { bundle } = remapSeed();
    const { policies = [], claims = [], claim_items: items = [] } = bundle.collections;
    const p1 = policies[0] as Document;
    for (const claim of claims) assert.ok((claim.policyId as ObjectId).equals(p1._id as ObjectId));
    const claimIds = claims.map((c) => (c._id as ObjectId).toHexString());
    assert.deepEqual(
      items.map((i) => claimIds.indexOf((i.claimId as ObjectId).toHexString())),
      [0, 0, 1],
    );
  });

  it('remaps nested array ids and the string FKs that point at them', () => {
    const { bundle } = remapSeed();
    const p1 = bundle.collections.policies?.[0] as Document;
    const covers = p1.covers as Document[];
    for (const cover of covers) assert.match(cover.coverId as string, /^COV-[0-9A-F]{8}$/);
    const items = bundle.collections.claim_items as Document[];
    assert.equal(items[0]?.coverId, covers[0]?.coverId);
    assert.equal(items[2]?.coverId, covers[1]?.coverId);
  });

  it('applies renumbering rules to business ids', () => {
    const { bundle } = remapSeed();
    const numbers = (bundle.collections.policies as Document[]).map((p) => p.policyNumber);
    assert.deepEqual(numbers, ['POL-LOCAL-20261113100000-001', 'POL-LOCAL-20261113100000-002']);
    assert.match((bundle.collections.claims as Document[])[0]?.claimNumber as string, /^CLM-LOCAL-/);
  });

  it('never touches protectedCodePaths, even when a code equals a remapped id', () => {
    const { bundle } = remapSeed((c) => {
      // claim_items.code is protected; make it collide with a coverId on purpose.
      (c.claim_items as Document[])[0]!.code = 'COV-1001-A';
    });
    const items = bundle.collections.claim_items as Document[];
    assert.equal(items[0]?.code, 'COV-1001-A');
    assert.notEqual(items[0]?.coverId, 'COV-1001-A');
    const p1 = bundle.collections.policies?.[0] as Document;
    assert.equal(p1.status, 'ACTIVE');
    assert.equal(((p1.covers as Document[])[0]?.loadings as Document[])[0]?.code, 'LOAD_YOUNG_DRIVER');
  });

  it('preserves Decimal128 and Date through the EJSON round trip', () => {
    const { bundle } = remapSeed();
    const reparsed = parseBundle(serializeBundle(bundle));
    const p1 = reparsed.collections.policies?.[0] as Document;
    assert.ok(p1.totalPremium instanceof Decimal128);
    assert.equal(p1.totalPremium.toString(), '1450.50');
    assert.ok(p1.effectiveDate instanceof Date);
  });

  it('reports counts, links and their declared status', () => {
    const { summary } = remapSeed();
    assert.deepEqual(summary.collections.policies, {
      documents: 2,
      rootIdsRemapped: 2,
      nestedIdsRemapped: 5, // 2 policyNumber + 3 covers[].coverId
      foreignKeysRewritten: 0,
    });
    assert.equal(summary.collections.claims?.foreignKeysRewritten, 2);
    assert.equal(summary.collections.claim_items?.foreignKeysRewritten, 6); // claimId + coverId x3
    assert.ok(summary.links.every((l) => l.declared));
    assert.deepEqual(summary.warnings, []);
  });

  it('warns about dangling references when the parent is not in the bundle', () => {
    const { bundle, summary } = remapSeed((c) => {
      delete c.policies;
    });
    const claim = bundle.collections.claims?.[0] as Document;
    assert.equal((claim.policyId as ObjectId).toHexString(), '673400000000000000000001');
    assert.ok(summary.warnings.some((w) => w.startsWith('claims.policyId: 2 reference(s)')));
    assert.ok(summary.warnings.some((w) => w.startsWith('claim_items.coverId: 3 reference(s)')));
  });

  it('keeps UUID / Long / Int32 types, and only offsets numeric ids with a rule', () => {
    const uuid = new UUID();
    const bundle = parseBundle(
      serializeBundle(
        buildBundle({
          things: [{ _id: uuid, seq: new Long(10), small: new Int32(7) }],
          refs: [{ _id: new Int32(1), thingId: uuid }],
        }),
      ),
    );
    const { bundle: out, summary } = remapBundle(bundle, {
      schemas: { things: { idPaths: ['_id', 'seq'] } },
      renumberingRules: { things: { seq: { strategy: 'OFFSET', offset: 1000 } } },
    });
    const thing = out.collections.things?.[0] as Document;
    const ref = out.collections.refs?.[0] as Document;
    assert.equal(typedHex(thing._id).length, 32);
    assert.notEqual(typedHex(thing._id), uuid.toHexString());
    assert.equal(typedHex(ref.thingId), typedHex(thing._id));
    assert.ok(thing.seq instanceof Long);
    assert.equal(thing.seq.toString(), '1010');
    assert.ok(thing.small instanceof Int32);
    // refs._id is an Int32 without an OFFSET rule -> left unchanged, with a warning.
    assert.ok(ref._id instanceof Int32 && ref._id.value === 1);
    assert.ok(summary.warnings.some((w) => w.includes('refs._id') && w.includes('OFFSET')));
  });
});

function typedHex(value: unknown): string {
  return Buffer.from((value as UUID).buffer).toString('hex');
}
