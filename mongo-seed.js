db = db.getSiblingDB("insurance_dev");

const policy1Id = new ObjectId("673400000000000000000001");
const policy2Id = new ObjectId("673400000000000000000002");

db.policies.insertMany([
  {
    _id: policy1Id,
    policyNumber: "POL-2026-0001",
    productCode: "MOTOR_COMP",
    status: "ACTIVE",
    holderName: "Jan Kowalski",
    effectiveDate: new Date("2026-01-15T00:00:00Z"),
    totalPremium: NumberDecimal("1450.50"),
    covers: [
      {
        coverId: "COV-1001-A",
        code: "COVER_COLLISION",
        sumInsured: NumberDecimal("45000.00"),
        loadings: [
          { code: "LOAD_YOUNG_DRIVER", value: NumberDecimal("25.00") },
          { code: "LOAD_URBAN_ZONE", value: NumberDecimal("10.00") }
        ]
      },
      {
        coverId: "COV-1001-B",
        code: "COVER_GLASS",
        sumInsured: NumberDecimal("3000.00"),
        loadings: [
          { code: "DISC_NO_CLAIM", value: NumberDecimal("-5.00") }
        ]
      }
    ]
  },
  {
    _id: policy2Id,
    policyNumber: "POL-2026-0002",
    productCode: "HOME_SHIELD",
    status: "ACTIVE",
    holderName: "Anna Nowak",
    effectiveDate: new Date("2026-03-01T00:00:00Z"),
    totalPremium: NumberDecimal("890.00"),
    covers: [
      {
        coverId: "COV-2001-A",
        code: "COVER_FIRE",
        sumInsured: NumberDecimal("350000.00"),
        loadings: [
          { code: "LOAD_HIGH_POWER", value: NumberDecimal("12.50") }
        ]
      }
    ]
  }
]);

const claim1Id = new ObjectId("673400000000000000000101");
const claim2Id = new ObjectId("673400000000000000000102");

db.claims.insertMany([
  {
    _id: claim1Id,
    claimNumber: "CLM-2026-8801",
    policyId: policy1Id,
    incidentDate: new Date("2026-06-10T14:30:00Z"),
    status: "APPROVED",
    description: "Front bumper collision in Poznan city center"
  },
  {
    _id: claim2Id,
    claimNumber: "CLM-2026-8802",
    policyId: policy1Id,
    incidentDate: new Date("2026-09-02T09:15:00Z"),
    status: "OPEN",
    description: "Windshield stone chip replacement"
  }
]);

db.claim_items.insertMany([
  {
    _id: new ObjectId("673400000000000000000201"),
    claimId: claim1Id,
    coverId: "COV-1001-A",
    code: "ITEM_REPAIR",
    approvedAmount: NumberDecimal("3200.00")
  },
  {
    _id: new ObjectId("673400000000000000000202"),
    claimId: claim1Id,
    coverId: "COV-1001-A",
    code: "ITEM_TOWING",
    approvedAmount: NumberDecimal("350.00")
  },
  {
    _id: new ObjectId("673400000000000000000203"),
    claimId: claim2Id,
    coverId: "COV-1001-B",
    code: "ITEM_REPLACEMENT",
    approvedAmount: NumberDecimal("1100.00")
  }
]);

db.policies.createIndex({ policyNumber: 1 }, { unique: true });
db.policies.createIndex({ "covers.code": 1 });
db.claims.createIndex({ policyId: 1 });
db.claim_items.createIndex({ claimId: 1 });