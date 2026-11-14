import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Decimal128, ObjectId } from '../src/lib/bson.js';
import type { Document } from 'mongodb';
import type { RelationBlueprint, WorkspaceConfig } from '../src/lib/config.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export const exampleConfig = JSON.parse(
  readFileSync(path.resolve(here, '../../litemongo.config.example.json'), 'utf8'),
) as WorkspaceConfig;

export const blueprint = exampleConfig.relationBlueprints?.[0] as RelationBlueprint;

/** In-memory mirror of mongo-seed.js. */
export function seedCollections(): Record<string, Document[]> {
  const p1 = new ObjectId('673400000000000000000001');
  const p2 = new ObjectId('673400000000000000000002');
  const c1 = new ObjectId('673400000000000000000101');
  const c2 = new ObjectId('673400000000000000000102');
  const d = (s: string) => Decimal128.fromString(s);
  return {
    policies: [
      {
        _id: p1,
        policyNumber: 'POL-2026-0001',
        productCode: 'MOTOR_COMP',
        status: 'ACTIVE',
        effectiveDate: new Date('2026-01-15T00:00:00Z'),
        totalPremium: d('1450.50'),
        covers: [
          {
            coverId: 'COV-1001-A',
            code: 'COVER_COLLISION',
            sumInsured: d('45000.00'),
            loadings: [{ code: 'LOAD_YOUNG_DRIVER', value: d('25.00') }],
          },
          { coverId: 'COV-1001-B', code: 'COVER_GLASS', sumInsured: d('3000.00'), loadings: [] },
        ],
      },
      {
        _id: p2,
        policyNumber: 'POL-2026-0002',
        productCode: 'HOME_SHIELD',
        status: 'ACTIVE',
        covers: [{ coverId: 'COV-2001-A', code: 'COVER_FIRE', loadings: [] }],
      },
    ],
    claims: [
      { _id: c1, claimNumber: 'CLM-2026-8801', policyId: p1, status: 'APPROVED' },
      { _id: c2, claimNumber: 'CLM-2026-8802', policyId: p1, status: 'OPEN' },
    ],
    claim_items: [
      { _id: new ObjectId('673400000000000000000201'), claimId: c1, coverId: 'COV-1001-A', code: 'ITEM_REPAIR', approvedAmount: d('3200.00') },
      { _id: new ObjectId('673400000000000000000202'), claimId: c1, coverId: 'COV-1001-A', code: 'ITEM_TOWING', approvedAmount: d('350.00') },
      { _id: new ObjectId('673400000000000000000203'), claimId: c2, coverId: 'COV-1001-B', code: 'ITEM_REPLACEMENT', approvedAmount: d('1100.00') },
    ],
  };
}
