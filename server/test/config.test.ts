import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseBlueprint } from '../src/lib/config.js';

const link = (collection: string, parentCollection: string) => ({
  collection,
  parentCollection,
  localField: '_id',
  foreignField: `${parentCollection}Id`,
});

describe('parseBlueprint', () => {
  it('accepts sibling collections under the same parent', () => {
    const bp = parseBlueprint({
      rootCollection: 'policies',
      levels: [link('claims', 'policies'), link('payments', 'policies'), link('claim_items', 'claims')],
    });
    assert.equal(bp.id, 'adhoc');
    assert.deepEqual(bp.levels.map((l) => l.level), [2, 3, 4]);
  });

  it('rejects a fourth level', () => {
    assert.throws(
      () =>
        parseBlueprint({
          rootCollection: 'policies',
          levels: [link('claims', 'policies'), link('claim_items', 'claims'), link('notes', 'claim_items')],
        }),
      /at most 3 levels/,
    );
  });

  it('rejects a parent that is not part of the tree', () => {
    assert.throws(() => parseBlueprint({ rootCollection: 'policies', levels: [link('claim_items', 'claims')] }), /not the root or an earlier level/);
  });
});
