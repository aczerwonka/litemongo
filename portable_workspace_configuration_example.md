{
  "version": "1.0.0",
  "workspaceName": "Insurance Core Domain (MongoDB 8)",
  "schemas": {
    "policies": {
      "description": "Core insurance policy document. Documents non-changing structural elements and nested cover/loading codes.",
      "displayBadgeField": "policyNumber",
      "idPaths": ["_id", "policyNumber", "covers[].coverId"],
      "protectedCodePaths": ["status", "productCode", "covers[].code", "covers[].loadings[].code"],
      "coreFields": {
        "_id": { "type": "ObjectId", "description": "Primary MongoDB document identifier" },
        "policyNumber": { "type": "string", "description": "Business policy number (e.g., POL-2026-0001)" },
        "productCode": {
          "type": "string",
          "enum": ["MOTOR_COMP", "HOME_SHIELD", "LIFE_TERM"],
          "description": "Insurance product line code"
        },
        "status": {
          "type": "string",
          "enum": ["ACTIVE", "PENDING", "LAPSED", "CANCELLED"]
        },
        "effectiveDate": { "type": "Date" },
        "totalPremium": { "type": "Decimal128" },
        "covers": {
          "type": "array",
          "displayBadgeField": "code",
          "description": "Selected policy coverages",
          "items": {
            "coverId": { "type": "string", "description": "Unique cover instance ID referenced by claim_items" },
            "code": {
              "type": "string",
              "enum": ["COVER_COLLISION", "COVER_THEFT", "COVER_FIRE", "COVER_LIABILITY", "COVER_GLASS"],
              "description": "Coverage type code"
            },
            "sumInsured": { "type": "Decimal128" },
            "loadings": {
              "type": "array",
              "displayBadgeField": "code",
              "description": "Risk loadings and surcharges applied to this cover",
              "items": {
                "code": {
                  "type": "string",
                  "enum": ["LOAD_YOUNG_DRIVER", "LOAD_URBAN_ZONE", "LOAD_HIGH_POWER", "LOAD_CLAIMS_HISTORY", "DISC_NO_CLAIM"],
                  "description": "Loading or discount reason code"
                },
                "value": { "type": "Decimal128", "description": "Percentage or flat loading amount" }
              }
            }
          }
        }
      }
    },
    "claims": {
      "description": "Insurance claims linked via soft relation to policies._id",
      "displayBadgeField": "claimNumber",
      "idPaths": ["_id", "claimNumber"],
      "foreignKeys": {
        "policyId": "policies._id"
      },
      "protectedCodePaths": ["status", "incidentType"],
      "coreFields": {
        "_id": { "type": "ObjectId" },
        "claimNumber": { "type": "string" },
        "policyId": { "type": "ObjectId", "description": "Soft foreign key -> policies._id" },
        "incidentDate": { "type": "Date" },
        "status": { "type": "string", "enum": ["OPEN", "INVESTIGATING", "APPROVED", "SETTLED", "REJECTED"] }
      }
    },
    "claim_items": {
      "description": "Line-item claim payouts linked to claims._id and policies.covers[].coverId",
      "displayBadgeField": "code",
      "idPaths": ["_id"],
      "foreignKeys": {
        "claimId": "claims._id",
        "coverId": "policies.covers[].coverId"
      },
      "protectedCodePaths": ["code"],
      "coreFields": {
        "_id": { "type": "ObjectId" },
        "claimId": { "type": "ObjectId", "description": "Soft foreign key -> claims._id" },
        "coverId": { "type": "string", "description": "Soft foreign key -> policies.covers[].coverId" },
        "code": { "type": "string", "enum": ["ITEM_REPAIR", "ITEM_TOWING", "ITEM_MEDICAL", "ITEM_REPLACEMENT"] },
        "approvedAmount": { "type": "Decimal128" }
      }
    }
  },
  "relationBlueprints": [
    {
      "id": "policy-claims-hierarchy",
      "name": "Policy -> Claims -> Claim Items (3-Level)",
      "rootCollection": "policies",
      "levels": [
        {
          "level": 2,
          "collection": "claims",
          "localField": "_id",
          "foreignField": "policyId",
          "displayBadgeField": "claimNumber"
        },
        {
          "level": 3,
          "collection": "claim_items",
          "parentCollection": "claims",
          "localField": "_id",
          "foreignField": "claimId",
          "displayBadgeField": "code"
        }
      ]
    }
  ],
  "queryPresets": [
    {
      "id": "active-policies-young-driver",
      "name": "Active Policies with Young Driver Loading",
      "collection": "policies",
      "filter": {
        "status": "ACTIVE",
        "covers": {
          "$elemMatch": {
            "loadings.code": "LOAD_YOUNG_DRIVER"
          }
        }
      },
      "projection": {
        "policyNumber": 1,
        "productCode": 1,
        "status": 1,
        "totalPremium": 1,
        "covers.coverId": 1,
        "covers.code": 1,
        "covers.loadings": 1
      },
      "limit": 100,
      "relationBlueprintId": "policy-claims-hierarchy"
    },
    {
      "id": "open-claims",
      "name": "Open & Investigating Claims",
      "collection": "claims",
      "filter": {
        "status": { "$in": ["OPEN", "INVESTIGATING"] }
      },
      "projection": {},
      "limit": 100
    }
  ],
  "renumberingRules": {
    "policies": {
      "policyNumber": { "strategy": "SUFFIX_TIMESTAMP", "prefix": "POL-LOCAL-" },
      "covers[].coverId": { "strategy": "UUID_SHORT", "prefix": "COV-" }
    },
    "claims": {
      "claimNumber": { "strategy": "SUFFIX_TIMESTAMP", "prefix": "CLM-LOCAL-" }
    }
  }
}