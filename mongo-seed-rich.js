// Rich insurance sample data: persons, contractors, policies2, claims2.
//
// Deterministic (seeded PRNG + fixed ObjectIds), idempotent (drops and re-creates
// only these four collections). Runs automatically on a fresh docker volume; on an
// existing one run it by hand:
//
//   docker exec -i litemongo-db mongosh -u admin -p localpassword \
//     --authenticationDatabase admin --quiet < mongo-seed-rich.js
//
// Highlights for testing LiteMongo:
//   - dynamic `attributes: [{ code, value, valueType }]` on persons, contractors,
//     policies2, policies2.covers[], claims2 and claims2.items[]; valueType is
//     "string" | "decimal" | "date" and value carries the matching BSON type
//     (string / Decimal128 / Date)
//   - contractors with roles[] and persons[] ({ personId, role }) -> persons._id
//   - policies2.contractors[] ({ role, contractorId }) -> contractors._id
//   - claims2.policyId -> policies2._id, claims2.coverId -> policies2.covers[].coverId

db = db.getSiblingDB('insurance_dev');

// ---------------------------------------------------------------------------
// Deterministic helpers
// ---------------------------------------------------------------------------

let seed = 20261114;
function rnd() {
  // mulberry32
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const int = (min, max) => min + Math.floor(rnd() * (max - min + 1));
const pick = (list) => list[Math.floor(rnd() * list.length)];
const chance = (p) => rnd() < p;
const pad = (n, w) => String(n).padStart(w, '0');
const dec = (n) => NumberDecimal(n.toFixed(2));
const day = 24 * 3600 * 1000;
const dateBetween = (from, to) => {
  const a = new Date(from).getTime();
  const b = new Date(to).getTime();
  return new Date(Math.floor((a + rnd() * (b - a)) / 60000) * 60000);
};
const addDays = (d, n) => new Date(d.getTime() + n * day);
const pickSome = (list, min, max) => {
  const copy = list.slice();
  const out = [];
  const n = Math.min(int(min, max), copy.length);
  for (let i = 0; i < n; i++) out.push(copy.splice(Math.floor(rnd() * copy.length), 1)[0]);
  return out;
};
/** Fixed ObjectId: 4-hex collection tag + zero-padded counter. */
const oid = (tag, n) => ObjectId(`6735${tag}${pad(n.toString(16), 16)}`);

/** Dynamic attribute with BSON value matching its valueType. */
function attr(code, valueType, raw) {
  let value = raw;
  if (valueType === 'decimal') value = dec(raw);
  if (valueType === 'date') value = raw instanceof Date ? raw : new Date(raw);
  return { code, value, valueType };
}

const FIRST_M = ['Jan', 'Piotr', 'Krzysztof', 'Andrzej', 'Tomasz', 'Paweł', 'Michał', 'Marcin', 'Jakub', 'Adam', 'Łukasz', 'Mateusz'];
const FIRST_F = ['Anna', 'Maria', 'Katarzyna', 'Małgorzata', 'Agnieszka', 'Barbara', 'Ewa', 'Magdalena', 'Joanna', 'Zofia', 'Natalia', 'Aleksandra'];
const LAST = ['Nowak', 'Kowalski', 'Wiśniewski', 'Wójcik', 'Kowalczyk', 'Kamiński', 'Lewandowski', 'Zieliński', 'Szymański', 'Woźniak', 'Dąbrowski', 'Kozłowski', 'Jankowski', 'Mazur', 'Krawczyk'];
const CITIES = [
  { city: 'Warszawa', postalCode: '00-001', lat: 52.2297, lng: 21.0122 },
  { city: 'Kraków', postalCode: '30-001', lat: 50.0647, lng: 19.945 },
  { city: 'Poznań', postalCode: '60-001', lat: 52.4064, lng: 16.9252 },
  { city: 'Gdańsk', postalCode: '80-001', lat: 54.352, lng: 18.6466 },
  { city: 'Wrocław', postalCode: '50-001', lat: 51.1079, lng: 17.0385 },
  { city: 'Łódź', postalCode: '90-001', lat: 51.7592, lng: 19.456 },
  { city: 'Lublin', postalCode: '20-001', lat: 51.2465, lng: 22.5684 },
];
const STREETS = ['Marszałkowska', 'Długa', 'Polna', 'Leśna', 'Słoneczna', 'Kwiatowa', 'Ogrodowa', 'Lipowa', 'Szkolna', 'Kościuszki'];
const COMPANY_WORDS = ['Trans', 'Bud', 'Agro', 'Med', 'Tech', 'Logistyka', 'Serwis', 'Invest', 'Energia', 'Projekt'];
const LEGAL_FORMS = ['SP_ZOO', 'SA', 'SP_J', 'JDG'];

function address(type) {
  const c = pick(CITIES);
  return {
    type,
    street: `ul. ${pick(STREETS)} ${int(1, 180)}${chance(0.4) ? `/${int(1, 60)}` : ''}`,
    city: c.city,
    postalCode: c.postalCode.replace(/\d{3}$/, pad(int(1, 999), 3)),
    country: 'PL',
  };
}
const fakePesel = (birth, female) =>
  `${pad(birth.getUTCFullYear() % 100, 2)}${pad(birth.getUTCMonth() + 1, 2)}${pad(birth.getUTCDate(), 2)}${pad(int(0, 999), 3)}${female ? pick([0, 2, 4, 6, 8]) : pick([1, 3, 5, 7, 9])}${int(0, 9)}`;
const fakeIban = () => `PL${pad(int(10, 99), 2)}${Array.from({ length: 24 }, () => int(0, 9)).join('')}`;

// ---------------------------------------------------------------------------
// persons
// ---------------------------------------------------------------------------

const PERSON_COUNT = 300;
const persons = [];
for (let i = 1; i <= PERSON_COUNT; i++) {
  const female = chance(0.5);
  const firstName = pick(female ? FIRST_F : FIRST_M);
  const lastName = pick(LAST).replace(/ski$/, female ? 'ska' : 'ski').replace(/cki$/, female ? 'cka' : 'cki');
  const birthDate = dateBetween('1950-01-01', '2006-12-31');
  birthDate.setUTCHours(0, 0, 0, 0);
  const createdAt = dateBetween('2022-01-01', '2026-06-30');
  const attributes = [attr('SMOKER', 'string', pick(['Y', 'N', 'N', 'N'])), attr('MARITAL_STATUS', 'string', pick(['SINGLE', 'MARRIED', 'DIVORCED', 'WIDOWED']))];
  if (chance(0.7)) attributes.push(attr('MONTHLY_INCOME', 'decimal', int(3500, 28000) + int(0, 99) / 100));
  if (chance(0.6)) attributes.push(attr('DRIVING_LICENSE_DATE', 'date', addDays(birthDate, int(18 * 365, 30 * 365))));
  if (chance(0.3)) attributes.push(attr('CREDIT_SCORE', 'decimal', int(300, 850)));
  persons.push({
    _id: oid('0001', i),
    personCode: `PER-${pad(i, 6)}`,
    pesel: fakePesel(birthDate, female),
    firstName,
    lastName,
    gender: female ? 'F' : 'M',
    birthDate,
    nationality: chance(0.92) ? 'PL' : pick(['DE', 'UA', 'CZ', 'LT', 'GB']),
    email: `${firstName}.${lastName}${i}@example.com`.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l'),
    phones: [
      { type: 'MOBILE', number: `+48 ${int(500, 899)} ${int(100, 999)} ${int(100, 999)}`, primary: true },
      ...(chance(0.3) ? [{ type: 'WORK', number: `+48 ${int(12, 99)} ${int(100, 999)} ${int(10, 99)} ${int(10, 99)}`, primary: false }] : []),
    ],
    addresses: [address('HOME'), ...(chance(0.35) ? [address('CORRESPONDENCE')] : [])],
    employment: chance(0.75)
      ? { employer: `${pick(COMPANY_WORDS)}${pick(COMPANY_WORDS).toLowerCase()} Sp. z o.o.`, position: pick(['Specjalista', 'Kierownik', 'Kierowca', 'Inżynier', 'Księgowa', 'Lekarz']), since: dateBetween('2005-01-01', '2025-12-31') }
      : null,
    consents: { marketing: chance(0.4), dataProcessing: true, eInvoice: chance(0.7) },
    attributes,
    tags: pickSome(['VIP', 'RETURNING', 'CROSS_SELL', 'HIGH_RISK', 'NEW'], 0, 2),
    createdAt,
    updatedAt: addDays(createdAt, int(0, 300)),
  });
}

// ---------------------------------------------------------------------------
// contractors (PERSON or COMPANY, with roles and linked persons)
// ---------------------------------------------------------------------------

const CONTRACTOR_COUNT = 220;
const contractors = [];
for (let i = 1; i <= CONTRACTOR_COUNT; i++) {
  const isCompany = chance(0.3);
  const ownerIdx = int(1, PERSON_COUNT);
  const roles = pickSome(['POLICYHOLDER', 'INSURED', 'PAYER', 'BENEFICIARY', 'BROKER'], 1, 3);
  const linked = isCompany
    ? pickSome(['REPRESENTATIVE', 'BOARD_MEMBER', 'CONTACT', 'PROXY'], 1, 3).map((role) => ({
        personId: oid('0001', int(1, PERSON_COUNT)),
        role,
        since: dateBetween('2015-01-01', '2025-12-31'),
        ...(chance(0.2) ? { validTo: dateBetween('2026-01-01', '2028-12-31') } : {}),
      }))
    : [{ personId: oid('0001', ownerIdx), role: 'SELF', since: dateBetween('2018-01-01', '2025-12-31') }];
  const name = isCompany ? `${pick(COMPANY_WORDS)}${pick(COMPANY_WORDS).toLowerCase()} ${pick(['Polska', 'Group', 'Sp. z o.o.', 'S.A.'])}` : null;
  const attributes = [attr('SEGMENT', 'string', isCompany ? pick(['SME', 'CORPORATE']) : pick(['MASS', 'AFFLUENT', 'PREMIUM']))];
  if (isCompany) attributes.push(attr('ANNUAL_REVENUE', 'decimal', int(500_000, 250_000_000)));
  if (isCompany && chance(0.8)) attributes.push(attr('REGISTRATION_DATE', 'date', dateBetween('1995-01-01', '2024-12-31')));
  attributes.push(attr('KYC_VERIFIED_AT', 'date', dateBetween('2023-01-01', '2026-10-31')));
  if (chance(0.4)) attributes.push(attr('RISK_SCORE', 'decimal', int(1, 100) / 10));
  contractors.push({
    _id: oid('0002', i),
    contractorCode: `CTR-${pad(i, 5)}`,
    type: isCompany ? 'COMPANY' : 'PERSON',
    status: pick(['ACTIVE', 'ACTIVE', 'ACTIVE', 'SUSPENDED', 'CLOSED']),
    roles,
    displayName: isCompany ? name : `${persons[ownerIdx - 1].firstName} ${persons[ownerIdx - 1].lastName}`,
    ...(isCompany
      ? {
          company: {
            name,
            legalForm: pick(LEGAL_FORMS),
            nip: Array.from({ length: 10 }, () => int(0, 9)).join(''),
            regon: Array.from({ length: 9 }, () => int(0, 9)).join(''),
            krs: chance(0.7) ? pad(int(1, 999999), 10) : null,
            pkd: pick(['49.41.Z', '41.20.A', '62.01.Z', '86.21.Z', '01.11.Z']),
          },
        }
      : { personId: oid('0001', ownerIdx) }),
    persons: linked,
    address: address(isCompany ? 'REGISTERED' : 'HOME'),
    bankAccounts: Array.from({ length: int(1, 2) }, (_, k) => ({ iban: fakeIban(), currency: k === 0 ? 'PLN' : pick(['EUR', 'USD']), primary: k === 0 })),
    riskClass: pick(['A', 'B', 'B', 'C', 'D']),
    attributes,
    createdAt: dateBetween('2020-01-01', '2026-09-30'),
  });
}

// ---------------------------------------------------------------------------
// policies2
// ---------------------------------------------------------------------------

const PRODUCTS = {
  MOTOR_COMP: {
    covers: [
      ['COVER_OC', 'Third-party liability', 1_200_000, 5_000_000],
      ['COVER_AC', 'Own damage (Autocasco)', 20_000, 250_000],
      ['COVER_NNW', 'Personal accident', 10_000, 50_000],
      ['COVER_ASSISTANCE', 'Assistance', 5_000, 15_000],
      ['COVER_GLASS', 'Glass', 2_000, 8_000],
    ],
    object: () => ({
      type: 'VEHICLE',
      vin: Array.from({ length: 17 }, () => pick('ABCDEFGHJKLMNPRSTUVWXYZ0123456789'.split(''))).join(''),
      make: pick(['Toyota', 'Skoda', 'Volkswagen', 'BMW', 'Kia', 'Ford', 'Audi']),
      model: pick(['Corolla', 'Octavia', 'Golf', 'X3', 'Ceed', 'Focus', 'A4']),
      productionYear: int(2008, 2026),
      registrationNumber: `${pick(['WA', 'KR', 'PO', 'GD', 'WR', 'EL', 'LU'])} ${int(10000, 99999)}`,
      engineCapacityCcm: int(1000, 3000),
      mileageKm: int(1000, 280000),
    }),
  },
  HOME_SHIELD: {
    covers: [
      ['COVER_FIRE', 'Fire and natural hazards', 150_000, 2_000_000],
      ['COVER_FLOOD', 'Flood', 50_000, 800_000],
      ['COVER_THEFT', 'Burglary and theft', 10_000, 200_000],
      ['COVER_LIABILITY', 'Civil liability in private life', 50_000, 500_000],
      ['COVER_GLASS', 'Glass', 1_000, 10_000],
    ],
    object: () => ({
      type: 'BUILDING',
      constructionType: pick(['BRICK', 'WOOD', 'CONCRETE', 'MIXED']),
      buildYear: int(1930, 2025),
      areaSqm: int(35, 320),
      floors: int(1, 4),
      address: address('RISK_LOCATION'),
    }),
  },
  LIFE_TERM: {
    covers: [
      ['COVER_DEATH', 'Death', 100_000, 1_500_000],
      ['COVER_DISABILITY', 'Permanent disability', 50_000, 500_000],
      ['COVER_HOSPITAL', 'Hospital stay', 5_000, 50_000],
      ['COVER_CRITICAL_ILLNESS', 'Critical illness', 20_000, 300_000],
    ],
    object: (personId) => ({ type: 'PERSON', personId }),
  },
  TRAVEL_PLUS: {
    covers: [
      ['COVER_MEDICAL', 'Medical expenses abroad', 100_000, 1_000_000],
      ['COVER_BAGGAGE', 'Baggage', 2_000, 10_000],
      ['COVER_CANCELLATION', 'Trip cancellation', 2_000, 30_000],
    ],
    object: () => ({ type: 'TRIP', destination: pick(['EUROPE', 'WORLD', 'WORLD_EXCL_USA']), travellers: int(1, 5) }),
  },
};
const LOADINGS = ['LOAD_YOUNG_DRIVER', 'LOAD_URBAN_ZONE', 'LOAD_HIGH_POWER', 'LOAD_CLAIMS_HISTORY', 'DISC_NO_CLAIM', 'DISC_MULTI_POLICY', 'DISC_ONLINE'];
const COVER_ATTRS = {
  COVER_OC: () => [attr('BONUS_MALUS_CLASS', 'string', `C${int(0, 14)}`), attr('GREEN_CARD_VALID_TO', 'date', dateBetween('2026-06-01', '2027-12-31'))],
  COVER_AC: () => [attr('REPAIR_VARIANT', 'string', pick(['ASO', 'COST_ESTIMATE', 'PARTNER_WORKSHOP'])), attr('VEHICLE_VALUE', 'decimal', int(15000, 240000)), attr('VALUATION_DATE', 'date', dateBetween('2025-01-01', '2026-10-31'))],
  COVER_NNW: () => [attr('SEATS_COVERED', 'string', String(int(2, 9)))],
  COVER_FIRE: () => [attr('REBUILD_VALUE', 'decimal', int(200000, 2500000)), attr('LAST_INSPECTION_DATE', 'date', dateBetween('2022-01-01', '2026-09-30'))],
  COVER_FLOOD: () => [attr('FLOOD_ZONE', 'string', pick(['Z0', 'Z1', 'Z2', 'Z3']))],
  COVER_THEFT: () => [attr('ALARM_SYSTEM', 'string', pick(['NONE', 'LOCAL', 'MONITORED'])), attr('SAFE_VALUE', 'decimal', int(0, 50000))],
  COVER_DEATH: () => [attr('UNDERWRITING_CLASS', 'string', pick(['STANDARD', 'PREFERRED', 'RATED'])), attr('MEDICAL_EXAM_DATE', 'date', dateBetween('2024-01-01', '2026-10-31'))],
  COVER_MEDICAL: () => [attr('DAILY_LIMIT', 'decimal', int(500, 5000))],
};
const CHANNELS = ['AGENT', 'BROKER', 'ONLINE', 'BANCASSURANCE', 'CALL_CENTER'];
const AGENTS = Array.from({ length: 25 }, (_, i) => ({ agentCode: `AG-${pad(i + 1, 4)}`, name: `${pick(FIRST_M.concat(FIRST_F))} ${pick(LAST)}`, branch: pick(CITIES).city }));

const POLICY_COUNT = 250;
const policies = [];
for (let i = 1; i <= POLICY_COUNT; i++) {
  const productCode = pick(Object.keys(PRODUCTS));
  const product = PRODUCTS[productCode];
  const issueDate = dateBetween('2024-01-01', '2026-10-31');
  const effectiveDate = addDays(issueDate, int(0, 30));
  effectiveDate.setUTCHours(0, 0, 0, 0);
  const expiryDate = addDays(effectiveDate, productCode === 'LIFE_TERM' ? 365 * int(5, 20) : productCode === 'TRAVEL_PLUS' ? int(5, 30) : 365);
  const status = expiryDate < new Date('2026-11-14') ? pick(['EXPIRED', 'EXPIRED', 'LAPSED']) : pick(['ACTIVE', 'ACTIVE', 'ACTIVE', 'ACTIVE', 'PENDING', 'CANCELLED']);

  const holder = int(1, CONTRACTOR_COUNT);
  const contractorRefs = [{ role: 'POLICYHOLDER', contractorId: oid('0002', holder) }];
  if (chance(0.5)) contractorRefs.push({ role: 'INSURED', contractorId: oid('0002', int(1, CONTRACTOR_COUNT)) });
  else contractorRefs.push({ role: 'INSURED', contractorId: oid('0002', holder) });
  if (chance(0.35)) contractorRefs.push({ role: 'PAYER', contractorId: oid('0002', int(1, CONTRACTOR_COUNT)) });
  if (productCode === 'LIFE_TERM') {
    const n = int(1, 3);
    for (let b = 0; b < n; b++) contractorRefs.push({ role: 'BENEFICIARY', contractorId: oid('0002', int(1, CONTRACTOR_COUNT)), share: dec(Math.round(100 / n)) });
  }
  if (chance(0.15)) contractorRefs.push({ role: 'LOSS_PAYEE', contractorId: oid('0002', int(1, CONTRACTOR_COUNT)) });

  const insuredObject = { objectId: `OBJ-${pad(i, 6)}-1`, ...product.object(oid('0001', int(1, PERSON_COUNT))) };
  const coverDefs = [product.covers[0], ...pickSome(product.covers.slice(1), 1, product.covers.length - 1)];
  const covers = coverDefs.map(([code, name, minSum, maxSum], k) => {
    const sumInsured = Math.round((minSum + rnd() * (maxSum - minSum)) / 100) * 100;
    const premium = Math.round(sumInsured * (0.0015 + rnd() * 0.02) * 100) / 100;
    return {
      coverId: `COV-${pad(i, 6)}-${String.fromCharCode(65 + k)}`,
      code,
      name,
      status: status === 'CANCELLED' ? 'CANCELLED' : pick(['ACTIVE', 'ACTIVE', 'ACTIVE', 'SUSPENDED']),
      insuredObjectId: insuredObject.objectId,
      sumInsured: dec(sumInsured),
      deductible: chance(0.6) ? { type: pick(['FIXED', 'PERCENT']), value: dec(pick([0, 250, 500, 1000, 2, 5, 10])) } : null,
      premium: dec(premium),
      startDate: effectiveDate,
      endDate: expiryDate,
      limits: chance(0.5) ? [{ code: 'LIMIT_PER_EVENT', amount: dec(Math.round(sumInsured * 0.5)) }, ...(chance(0.4) ? [{ code: 'LIMIT_ANNUAL_AGGREGATE', amount: dec(sumInsured) }] : [])] : [],
      loadings: pickSome(LOADINGS, 0, 3).map((c) => ({ code: c, value: dec(c.startsWith('DISC') ? -int(2, 20) : int(5, 40)), reason: chance(0.3) ? 'Underwriter decision' : null })),
      attributes: [attr('TARIFF_VERSION', 'string', pick(['T2024.1', 'T2025.2', 'T2026.1'])), ...(COVER_ATTRS[code] ? COVER_ATTRS[code]() : []), attr('PRICED_AT', 'date', issueDate)],
    };
  });
  const gross = covers.reduce((s, c) => s + Number(c.premium.toString()), 0);
  const frequency = pick(['ANNUAL', 'ANNUAL', 'SEMI_ANNUAL', 'QUARTERLY', 'MONTHLY']);
  const nInst = { ANNUAL: 1, SEMI_ANNUAL: 2, QUARTERLY: 4, MONTHLY: 12 }[frequency];
  const installments = Array.from({ length: nInst }, (_, k) => {
    const dueDate = addDays(effectiveDate, Math.round((365 / nInst) * k));
    const paid = dueDate < new Date('2026-11-14') && chance(0.9);
    return { no: k + 1, dueDate, amount: dec(gross / nInst), paid, ...(paid ? { paidAt: addDays(dueDate, int(-10, 12)) } : {}) };
  });
  const policyAttrs = [attr('SALES_CAMPAIGN', 'string', pick(['NONE', 'SPRING26', 'BLACKWEEK25', 'RENEWAL_BONUS'])), attr('SIGNED_AT', 'date', issueDate)];
  if (chance(0.5)) policyAttrs.push(attr('COMMISSION_RATE', 'decimal', int(5, 25)));
  if (chance(0.3)) policyAttrs.push(attr('PREVIOUS_INSURER', 'string', pick(['PZU', 'WARTA', 'ERGO_HESTIA', 'ALLIANZ', 'GENERALI'])));

  const createdAt = issueDate;
  policies.push({
    _id: oid('0003', i),
    policyNumber: `POL2-${issueDate.getUTCFullYear()}-${pad(i, 5)}`,
    productCode,
    productVersion: `${productCode}_V${int(1, 3)}`,
    channel: pick(CHANNELS),
    status,
    issueDate,
    effectiveDate,
    expiryDate,
    currency: 'PLN',
    premium: {
      gross: dec(gross),
      net: dec(gross / 1.0),
      tax: dec(0),
      frequency,
      installments,
    },
    contractors: contractorRefs,
    agent: pick(AGENTS),
    insuredObjects: [insuredObject],
    covers,
    attributes: policyAttrs,
    endorsements: Array.from({ length: chance(0.3) ? int(1, 3) : 0 }, (_, k) => ({
      no: k + 1,
      date: addDays(effectiveDate, int(10, 300)),
      type: pick(['ADDRESS_CHANGE', 'SUM_INSURED_CHANGE', 'COVER_ADDED', 'COVER_REMOVED', 'PAYER_CHANGE']),
      description: 'Endorsement issued on customer request',
    })),
    renewalOf: i > 40 && chance(0.25) ? oid('0003', int(1, i - 1)) : null,
    audit: { createdAt, createdBy: pick(['system', 'agent.portal', 'import.batch']), updatedAt: addDays(createdAt, int(0, 200)), version: int(1, 8) },
  });
}

// ---------------------------------------------------------------------------
// claims2
// ---------------------------------------------------------------------------

const LOSS_TYPES = {
  MOTOR_COMP: ['COLLISION', 'THEFT', 'GLASS_DAMAGE', 'VANDALISM', 'HAIL'],
  HOME_SHIELD: ['FIRE', 'FLOOD', 'BURGLARY', 'PIPE_LEAK', 'STORM'],
  LIFE_TERM: ['DEATH', 'DISABILITY', 'HOSPITALIZATION', 'CRITICAL_ILLNESS'],
  TRAVEL_PLUS: ['MEDICAL_ABROAD', 'LOST_BAGGAGE', 'TRIP_CANCELLED'],
};
const ITEM_CODES = ['ITEM_REPAIR', 'ITEM_TOWING', 'ITEM_REPLACEMENT', 'ITEM_RENTAL_CAR', 'ITEM_MEDICAL', 'ITEM_EXPERT_FEE', 'ITEM_CLEANING', 'ITEM_LOST_INCOME'];
const HANDLERS = Array.from({ length: 12 }, (_, i) => ({ userId: `U${pad(i + 1, 4)}`, name: `${pick(FIRST_M.concat(FIRST_F))} ${pick(LAST)}`, team: pick(['MOTOR', 'PROPERTY', 'LIFE', 'FAST_TRACK']) }));
const CLAIM_FLOW = ['REPORTED', 'REGISTERED', 'INVESTIGATING', 'APPROVED', 'SETTLED'];

const CLAIM_COUNT = 600;
const claims = [];
for (let i = 1; i <= CLAIM_COUNT; i++) {
  const policy = policies[int(0, POLICY_COUNT - 1)];
  const cover = pick(policy.covers);
  const incidentDate = dateBetween(policy.effectiveDate, policy.expiryDate < new Date('2026-11-10') ? policy.expiryDate : new Date('2026-11-10'));
  const reportedDate = addDays(incidentDate, int(0, 20));
  const rejected = chance(0.12);
  const steps = rejected ? int(2, 3) : int(1, CLAIM_FLOW.length);
  const statusHistory = CLAIM_FLOW.slice(0, steps).map((s, k) => ({ status: s, at: addDays(reportedDate, k * int(1, 12)), by: pick(HANDLERS).userId }));
  if (rejected) statusHistory.push({ status: 'REJECTED', at: addDays(reportedDate, steps * 10), by: pick(HANDLERS).userId, reason: pick(['NOT_COVERED', 'FRAUD_SUSPECTED', 'LATE_NOTIFICATION', 'DEDUCTIBLE_NOT_EXCEEDED']) });
  const status = statusHistory[statusHistory.length - 1].status;
  const city = pick(CITIES);
  const items = Array.from({ length: int(1, 4) }, (_, k) => {
    const claimed = int(200, 40000) + int(0, 99) / 100;
    const approved = ['APPROVED', 'SETTLED'].includes(status) ? Math.round(claimed * (0.6 + rnd() * 0.4) * 100) / 100 : null;
    const itemAttrs = [attr('INVOICE_NUMBER', 'string', `FV/${int(1, 999)}/${incidentDate.getUTCFullYear()}`), attr('INVOICE_DATE', 'date', addDays(incidentDate, int(1, 30)))];
    if (chance(0.5)) itemAttrs.push(attr('VAT_RATE', 'decimal', pick([0, 8, 23])));
    return {
      itemId: `CI-${pad(i, 6)}-${k + 1}`,
      code: pick(ITEM_CODES),
      claimedAmount: dec(claimed),
      approvedAmount: approved === null ? null : dec(approved),
      status: approved === null ? (rejected ? 'REJECTED' : 'PENDING') : 'APPROVED',
      attributes: itemAttrs,
    };
  });
  const totalClaimed = items.reduce((s, it) => s + Number(it.claimedAmount.toString()), 0);
  const totalApproved = items.reduce((s, it) => s + (it.approvedAmount ? Number(it.approvedAmount.toString()) : 0), 0);
  const nPayments = int(1, 2);
  const payments = status === 'SETTLED' ? Array.from({ length: nPayments }, (_, k) => ({
    paymentId: `PAY-${pad(i, 6)}-${k + 1}`,
    date: addDays(reportedDate, 30 + k * 14),
    amount: dec(totalApproved / nPayments),
    payeeContractorId: pick(policy.contractors).contractorId,
    method: pick(['BANK_TRANSFER', 'BANK_TRANSFER', 'CASH', 'WORKSHOP_DIRECT']),
  })) : [];
  const totalPaid = payments.reduce((s, p) => s + Number(p.amount.toString()), 0);
  const claimAttrs = [attr('NOTIFICATION_CHANNEL', 'string', pick(['PHONE', 'WEB', 'AGENT', 'APP'])), attr('FIRST_CONTACT_AT', 'date', reportedDate)];
  if (chance(0.4)) claimAttrs.push(attr('FRAUD_SCORE', 'decimal', int(0, 1000) / 10));
  if (chance(0.25)) claimAttrs.push(attr('POLICE_REPORT_NO', 'string', `RSD-${int(1000, 9999)}/${incidentDate.getUTCFullYear()}`));

  claims.push({
    _id: oid('0004', i),
    claimNumber: `CLM2-${incidentDate.getUTCFullYear()}-${pad(i, 6)}`,
    policyId: policy._id,
    policyNumber: policy.policyNumber,
    coverId: cover.coverId,
    coverCode: cover.code,
    lossType: pick(LOSS_TYPES[policy.productCode]),
    status,
    incidentDate,
    reportedDate,
    location: { city: city.city, country: 'PL', geo: { type: 'Point', coordinates: [city.lng + (rnd() - 0.5) / 10, city.lat + (rnd() - 0.5) / 10] } },
    description: pick(['Damage reported by the customer', 'Incident confirmed by police', 'Water leak from upper floor', 'Collision at intersection', 'Hospital stay after accident', 'Items stolen from the property']),
    participants: [
      { role: 'CLAIMANT', contractorId: policy.contractors[0].contractorId },
      ...Array.from({ length: int(0, 3) }, () => ({ role: pick(['WITNESS', 'DRIVER', 'INJURED', 'PERPETRATOR']), personId: oid('0001', int(1, PERSON_COUNT)) })),
    ],
    reserves: [{ type: 'INDEMNITY', amount: dec(totalClaimed), setAt: reportedDate }, ...(chance(0.3) ? [{ type: 'EXPENSE', amount: dec(int(100, 3000)), setAt: addDays(reportedDate, 3) }] : [])],
    items,
    payments,
    statusHistory,
    handler: pick(HANDLERS),
    attributes: claimAttrs,
    totals: { claimed: dec(totalClaimed), approved: dec(totalApproved), paid: dec(totalPaid) },
    createdAt: reportedDate,
  });
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

for (const name of ['persons', 'contractors', 'policies2', 'claims2']) db.getCollection(name).drop();
db.persons.insertMany(persons);
db.contractors.insertMany(contractors);
db.policies2.insertMany(policies);
db.claims2.insertMany(claims);

db.persons.createIndex({ personCode: 1 }, { unique: true });
db.persons.createIndex({ lastName: 1, firstName: 1 });
db.persons.createIndex({ 'attributes.code': 1, 'attributes.value': 1 });
db.contractors.createIndex({ contractorCode: 1 }, { unique: true });
db.contractors.createIndex({ 'persons.personId': 1 });
db.contractors.createIndex({ roles: 1 });
db.policies2.createIndex({ policyNumber: 1 }, { unique: true });
db.policies2.createIndex({ 'contractors.contractorId': 1 });
db.policies2.createIndex({ 'covers.code': 1 });
db.policies2.createIndex({ 'covers.attributes.code': 1 });
db.claims2.createIndex({ policyId: 1 });
db.claims2.createIndex({ claimNumber: 1 }, { unique: true });
db.claims2.createIndex({ status: 1, incidentDate: -1 });

print(`Seeded insurance_dev: persons ${persons.length}, contractors ${contractors.length}, policies2 ${policies.length}, claims2 ${claims.length}`);
