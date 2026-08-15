"use strict";
/**
 * DataNexus Engine — Tenant Onboarding Service
 *
 * Connects to PostgreSQL and manages tenant lifecycle state during onboarding.
 * All database access uses parameterized queries to prevent SQL injection.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.TenantValidationError = exports.TenantAlreadyExistsError = exports.TenantServiceError = exports.RESIDENCY_ZONES = void 0;
exports.normalizeTenantSlug = normalizeTenantSlug;
exports.buildTenantInfrastructureConfig = buildTenantInfrastructureConfig;
exports.onboardTenant = onboardTenant;
exports.closeTenantServicePool = closeTenantServicePool;
exports.getTenantServicePool = getPool;
const node_crypto_1 = require("node:crypto");
const pg_1 = require("pg");
// ---------------------------------------------------------------------------
// Domain types (mirror backend/schema.sql enums)
// ---------------------------------------------------------------------------
exports.RESIDENCY_ZONES = [
    "EU",
    "EEA",
    "UK",
    "US-EAST",
    "US-WEST",
    "APAC-SOUTH",
    "APAC-NORTHEAST",
    "MENA",
    "LATAM",
];
// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------
class TenantServiceError extends Error {
    code;
    cause;
    constructor(message, code, cause) {
        super(message);
        this.code = code;
        this.cause = cause;
        this.name = "TenantServiceError";
    }
}
exports.TenantServiceError = TenantServiceError;
class TenantAlreadyExistsError extends TenantServiceError {
    constructor(tenantCode, cause) {
        super(`Tenant with code "${tenantCode}" already exists.`, "TENANT_ALREADY_EXISTS", cause);
        this.name = "TenantAlreadyExistsError";
    }
}
exports.TenantAlreadyExistsError = TenantAlreadyExistsError;
class TenantValidationError extends TenantServiceError {
    constructor(message, cause) {
        super(message, "TENANT_VALIDATION_ERROR", cause);
        this.name = "TenantValidationError";
    }
}
exports.TenantValidationError = TenantValidationError;
// ---------------------------------------------------------------------------
// Infrastructure naming helpers
// ---------------------------------------------------------------------------
const TENANT_CODE_PATTERN = /^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$/;
/**
 * Normalizes a tenant code into a URL/GCP-safe slug segment.
 */
function normalizeTenantSlug(tenantCode) {
    const slug = tenantCode.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-");
    const trimmed = slug.replace(/^-+|-+$/g, "");
    if (!TENANT_CODE_PATTERN.test(trimmed)) {
        throw new TenantValidationError("tenantCode must be 2–32 characters, lowercase alphanumeric with internal hyphens.");
    }
    return trimmed;
}
/**
 * Derives default platform resource identifiers from the tenant slug.
 */
function buildTenantInfrastructureConfig(tenantCode, gcpProjectId) {
    const slug = normalizeTenantSlug(tenantCode);
    const bqSlug = slug.replace(/-/g, "_");
    return {
        gkeNamespace: `tenant-${slug}`,
        bqDatasetId: `tenant_${bqSlug}`,
        pubsubTopicIn: `projects/${gcpProjectId}/topics/tenant-${slug}-in`,
        pubsubTopicOut: `projects/${gcpProjectId}/topics/tenant-${slug}-out`,
        kmsKeyRing: `datanexus-${slug}-keyring`,
        kmsCryptoKey: `datanexus-${slug}-cmek`,
    };
}
function deriveComplianceFlags(residencyZone) {
    const gdprApplicable = residencyZone === "EU" || residencyZone === "EEA" || residencyZone === "UK";
    const ccpaApplicable = residencyZone === "US-EAST" || residencyZone === "US-WEST";
    return {
        gdprApplicable,
        ccpaApplicable,
        hipaaApplicable: false,
    };
}
// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------
let sharedPool;
function getPool(options = {}) {
    if (options.pool) {
        return options.pool;
    }
    if (!sharedPool) {
        const connectionString = options.databaseUrl ?? process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
        if (!connectionString) {
            throw new TenantServiceError("Database connection string is required. Set DATABASE_URL or pass pool/databaseUrl.", "DATABASE_CONFIG_MISSING");
        }
        sharedPool = new pg_1.Pool({
            connectionString,
            max: 10,
            idleTimeoutMillis: 30_000,
            connectionTimeoutMillis: 5_000,
        });
    }
    return sharedPool;
}
function mapTenantRow(row, infrastructure) {
    return {
        tenantId: String(row.tenant_id),
        tenantCode: String(row.tenant_code),
        legalName: String(row.legal_name),
        displayName: String(row.display_name),
        residencyZone: row.residency_zone,
        billingAccountId: String(row.billing_account_id),
        status: row.status,
        infrastructure,
        gdprApplicable: Boolean(row.gdpr_applicable),
        ccpaApplicable: Boolean(row.ccpa_applicable),
        hipaaApplicable: Boolean(row.hipaa_applicable),
        contractStartDate: String(row.contract_start_date),
        createdBy: String(row.created_by),
        createdAt: new Date(String(row.created_at)),
    };
}
function handleDatabaseError(error, tenantCode) {
    if (typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "23505") {
        throw new TenantAlreadyExistsError(tenantCode, error);
    }
    throw new TenantServiceError("Failed to onboard tenant due to a database error.", "TENANT_ONBOARDING_FAILED", error);
}
/**
 * Creates a new tenant row in PROVISIONING state and returns the provisioned
 * configuration bundle for downstream infrastructure automation.
 */
async function onboardTenant(input, options = {}) {
    const legalName = input.legalName?.trim();
    const billingAccountId = input.billingAccountId?.trim();
    const createdBy = input.createdBy?.trim();
    const gcpProjectId = input.gcpProjectId?.trim();
    if (!legalName) {
        throw new TenantValidationError("legalName is required.");
    }
    if (!billingAccountId) {
        throw new TenantValidationError("billingAccountId is required.");
    }
    if (!createdBy) {
        throw new TenantValidationError("createdBy is required.");
    }
    if (!gcpProjectId) {
        throw new TenantValidationError("gcpProjectId is required.");
    }
    if (!exports.RESIDENCY_ZONES.includes(input.residencyZone)) {
        throw new TenantValidationError(`residencyZone must be one of: ${exports.RESIDENCY_ZONES.join(", ")}`);
    }
    const tenantCode = normalizeTenantSlug(input.tenantCode);
    const displayName = input.displayName?.trim() || legalName;
    const tenantId = (0, node_crypto_1.randomUUID)();
    const infrastructure = buildTenantInfrastructureConfig(tenantCode, gcpProjectId);
    const compliance = deriveComplianceFlags(input.residencyZone);
    const contractStartDate = input.contractStartDate ?? new Date();
    const primaryContactEmail = input.primaryContactEmail ?? Buffer.alloc(0);
    const primaryContactPhone = input.primaryContactPhone ?? Buffer.alloc(0);
    const pool = getPool(options);
    let client;
    const insertQuery = `
    INSERT INTO tenants (
      tenant_id,
      tenant_code,
      legal_name,
      display_name,
      residency_zone,
      gdpr_applicable,
      ccpa_applicable,
      hipaa_applicable,
      primary_contact_email,
      primary_contact_phone,
      billing_account_id,
      kms_key_ring,
      kms_crypto_key,
      gke_namespace,
      bq_dataset_id,
      pubsub_topic_in,
      pubsub_topic_out,
      status,
      contract_start_date,
      created_by
    )
    VALUES (
      $1, $2, $3, $4, $5,
      $6, $7, $8, $9, $10,
      $11, $12, $13, $14, $15,
      $16, $17, $18, $19, $20
    )
    RETURNING
      tenant_id,
      tenant_code,
      legal_name,
      display_name,
      residency_zone,
      billing_account_id,
      status,
      gdpr_applicable,
      ccpa_applicable,
      hipaa_applicable,
      contract_start_date,
      created_by,
      created_at
  `;
    const params = [
        tenantId,
        tenantCode,
        legalName,
        displayName,
        input.residencyZone,
        compliance.gdprApplicable,
        compliance.ccpaApplicable,
        compliance.hipaaApplicable,
        primaryContactEmail,
        primaryContactPhone,
        billingAccountId,
        infrastructure.kmsKeyRing,
        infrastructure.kmsCryptoKey,
        infrastructure.gkeNamespace,
        infrastructure.bqDatasetId,
        infrastructure.pubsubTopicIn,
        infrastructure.pubsubTopicOut,
        "PROVISIONING",
        contractStartDate,
        createdBy,
    ];
    try {
        client = await pool.connect();
        const result = await client.query(insertQuery, params);
        if (result.rowCount !== 1 || !result.rows[0]) {
            throw new TenantServiceError("Tenant insert did not return a row.", "TENANT_ONBOARDING_EMPTY_RESULT");
        }
        return mapTenantRow(result.rows[0], infrastructure);
    }
    catch (error) {
        if (error instanceof TenantServiceError ||
            error instanceof TenantValidationError) {
            throw error;
        }
        handleDatabaseError(error, tenantCode);
    }
    finally {
        client?.release();
    }
}
/**
 * Gracefully closes the shared connection pool (for scripts/tests).
 */
async function closeTenantServicePool() {
    if (sharedPool) {
        await sharedPool.end();
        sharedPool = undefined;
    }
}
