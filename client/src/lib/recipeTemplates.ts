import type { Recipe } from '../types';

/**
 * Built-in fetch recipes ("templates"). They target the sample data
 * (mongo-seed.js / mongo-seed-rich.js) and double as examples of each fetch
 * algorithm; "Duplicate" turns one into an editable recipe in the workspace config.
 */
export const BUILTIN_RECIPES: Recipe[] = [
  {
    id: 'builtin.policy-dossier',
    name: 'Policy dossier',
    description:
      'policies2 → contractors (batched $in, packets of 25) → persons ($in); plus the latest 3 claims of every policy (nested loop).',
    params: [
      { name: 'policyNumber', label: 'Policy number', default: '' },
      { name: 'status', label: 'Status', default: 'ACTIVE', options: ['ACTIVE', 'PENDING', 'CANCELLED', 'EXPIRED', 'LAPSED'] },
      { name: 'product', label: 'Product', options: ['MOTOR_COMP', 'HOME_SHIELD', 'LIFE_TERM'] },
    ],
    steps: [
      {
        id: 'policy',
        label: 'Policy',
        collection: 'policies2',
        filter: { policyNumber: '{{policyNumber}}', status: '{{status}}', productCode: '{{product}}' },
        sort: { issueDate: -1 },
        limit: 20,
        display: {
          title: 'policyNumber',
          subtitle: 'agent.name',
          badge: 'productCode',
          fields: ['status', 'channel', 'effectiveDate', 'expiryDate', 'premium.gross', 'covers'],
        },
      },
      {
        id: 'contractor',
        label: 'Contractors',
        collection: 'contractors',
        parent: 'policy',
        strategy: 'batched',
        batchSize: 25,
        concurrency: 2,
        localField: 'contractors.contractorId',
        foreignField: '_id',
        display: { title: 'displayName', badge: 'type', fields: ['contractorCode', 'roles', 'riskClass', 'status'], layout: 'table' },
      },
      {
        id: 'person',
        label: 'Linked persons',
        collection: 'persons',
        parent: 'contractor',
        strategy: 'in',
        localField: 'persons.personId',
        foreignField: '_id',
        projection: { firstName: 1, lastName: 1, personCode: 1, birthDate: 1, email: 1, tags: 1 },
        display: { title: 'lastName', subtitle: 'firstName', fields: ['personCode', 'birthDate', 'email', 'tags'], layout: 'chips' },
      },
      {
        id: 'claim',
        label: 'Latest 3 claims',
        collection: 'claims2',
        parent: 'policy',
        strategy: 'nested-loop',
        localField: '_id',
        foreignField: 'policyId',
        sort: { incidentDate: -1 },
        limit: 3,
        concurrency: 4,
        projection: { claimNumber: 1, status: 1, lossType: 1, incidentDate: 1, 'totals.claimed': 1, handler: 1 },
        display: { title: 'claimNumber', badge: 'lossType', fields: ['status', 'incidentDate', 'totals.claimed', 'handler.name'], layout: 'table' },
      },
    ],
    view: { mode: 'dossier' },
  },
  {
    id: 'builtin.claims-board',
    name: 'Claims board',
    description: 'claims2 as a board with one column per status; each card pulls its policy with a single $in.',
    params: [
      { name: 'lossType', label: 'Loss type', options: ['COLLISION', 'THEFT', 'GLASS_DAMAGE', 'FIRE', 'FLOOD', 'BURGLARY', 'PIPE_LEAK', 'STORM'] },
      { name: 'team', label: 'Handler team', options: ['MOTOR', 'PROPERTY', 'LIFE', 'FAST_TRACK'] },
      { name: 'since', label: 'Reported since', type: 'date', default: '' },
    ],
    steps: [
      {
        id: 'claim',
        label: 'Claim',
        collection: 'claims2',
        filter: { lossType: '{{lossType}}', 'handler.team': '{{team}}', reportedDate: { $gte: '{{since}}' } },
        sort: { reportedDate: -1 },
        limit: 150,
        projection: { claimNumber: 1, status: 1, lossType: 1, reportedDate: 1, policyId: 1, 'totals.claimed': 1, 'handler.name': 1 },
        display: { title: 'claimNumber', badge: 'lossType', fields: ['reportedDate', 'totals.claimed', 'handler.name'] },
      },
      {
        id: 'policy',
        label: 'Policy',
        collection: 'policies2',
        strategy: 'in',
        localField: 'policyId',
        foreignField: '_id',
        projection: { policyNumber: 1, productCode: 1, status: 1 },
        display: { title: 'policyNumber', badge: 'productCode', fields: ['status'], layout: 'chips' },
      },
    ],
    view: { mode: 'board', groupBy: 'status' },
  },
  {
    id: 'builtin.person-360',
    name: 'Person 360°',
    description:
      'persons by last name → contractors they belong to ($in on an array field) → their policies (batched) → claims of those policies (batched, 2 packets in parallel).',
    params: [{ name: 'lastName', label: 'Last name starts with', default: 'Now', required: true }],
    steps: [
      {
        id: 'person',
        label: 'Person',
        collection: 'persons',
        filter: { lastName: { $regex: '^{{lastName}}', $options: 'i' } },
        sort: { lastName: 1, firstName: 1 },
        limit: 15,
        display: { title: 'lastName', subtitle: 'firstName', badge: 'personCode', fields: ['birthDate', 'email', 'addresses', 'tags'] },
      },
      {
        id: 'contractor',
        label: 'Contractors',
        collection: 'contractors',
        strategy: 'in',
        localField: '_id',
        foreignField: 'persons.personId',
        display: { title: 'displayName', badge: 'type', fields: ['contractorCode', 'roles', 'status'], layout: 'table' },
      },
      {
        id: 'policy',
        label: 'Policies',
        collection: 'policies2',
        strategy: 'batched',
        batchSize: 20,
        localField: '_id',
        foreignField: 'contractors.contractorId',
        projection: { policyNumber: 1, productCode: 1, status: 1, effectiveDate: 1, 'premium.gross': 1 },
        display: { title: 'policyNumber', badge: 'productCode', fields: ['status', 'effectiveDate', 'premium.gross'], layout: 'table' },
      },
      {
        id: 'claim',
        label: 'Claims',
        collection: 'claims2',
        strategy: 'batched',
        batchSize: 30,
        concurrency: 2,
        localField: '_id',
        foreignField: 'policyId',
        projection: { claimNumber: 1, status: 1, lossType: 1, incidentDate: 1, policyId: 1 },
        display: { title: 'claimNumber', badge: 'lossType', fields: ['status', 'incidentDate'], layout: 'chips' },
      },
    ],
    view: { mode: 'dossier' },
  },
  {
    id: 'builtin.policy-claim-items',
    name: 'Policies → claims → items',
    description: 'The basic sample (mongo-seed.js): policies, their claims ($in) and claim items (nested loop, 5 per claim).',
    params: [{ name: 'policyNumber', label: 'Policy number', default: '' }],
    steps: [
      {
        id: 'policy',
        label: 'Policy',
        collection: 'policies',
        filter: { policyNumber: '{{policyNumber}}' },
        limit: 50,
        display: { title: 'policyNumber', subtitle: 'holderName', badge: 'productCode', fields: ['status', 'effectiveDate', 'totalPremium', 'covers'] },
      },
      {
        id: 'claim',
        label: 'Claims',
        collection: 'claims',
        strategy: 'in',
        localField: '_id',
        foreignField: 'policyId',
        display: { title: 'claimNumber', badge: 'status', fields: ['incidentDate', 'description'] },
      },
      {
        id: 'item',
        label: 'Items',
        collection: 'claim_items',
        strategy: 'nested-loop',
        filter: { claimId: '{{parent._id}}' },
        limit: 5,
        display: { title: 'code', fields: ['coverId', 'approvedAmount'], layout: 'chips' },
      },
    ],
    view: { mode: 'dossier' },
  },
];

/** A blank recipe skeleton for "New recipe". */
export function blankRecipe(collection: string | null): Recipe {
  return {
    id: `recipe-${Math.random().toString(36).slice(2, 8)}`,
    name: 'New recipe',
    params: [],
    steps: [{ id: 'root', label: collection ?? 'Root', collection: collection ?? 'collection', filter: {}, limit: 50 }],
    view: { mode: 'dossier' },
  };
}

export const isBuiltin = (id: string | null | undefined) => !!id && id.startsWith('builtin.');
