/**
 * DataNexus Engine — Tenant Onboarding Service
 *
 * Connects to PostgreSQL and manages tenant lifecycle state during onboarding.
 * All database access uses parameterized queries to prevent SQL injection.
 */

import { randomUUID } from "node:crypto";

import type { Pool, PoolClient, QueryResult } from "pg";
import { Pool as PgPool } from "pg";

// ---------------------------------------------------------------------------
// Domain types (mirror backend/schema.sql enums)
// ---------------------------------------------------------------------------

export const RESIDENCY_ZONES = [
  "EU",
  "EEA",
  "UK",
  "US-EAST",
  "US-WEST",
  "APAC-SOUTH",
  "APAC-NORTHEAST",
  "MENA",
  "LATAM",
] as const;

export type ResidencyZone = (typeof RESIDENCY_ZONES)[number];

export type TenantStatus =
  | "PROVISIONING"
  | "ACTIVE"
  | "SUSPENDED"
  | "OFFBOARDING"
  | "ARCHIVED";

export interface OnboardTenantInput {
  legalName: string;
  tenantCode: string;
  residencyZone: ResidencyZone;
  billingAccountId: string;
  /** Defaults to legalName when omitted. */
  displayName?: string;
  /** Operator or service account performing the onboarding action. */
  createdBy: string;
  /** GCP project used to build Pub/Sub topic resource names. */
  gcpProjectId: string;
  /** Encrypted contact payloads stored as BYTEA (required by schema). */
  primaryContactEmail?: Buffer;
  primaryContactPhone?: Buffer;
  contractStartDate?: Date;
}

export interface TenantInfrastructureConfig {
  gkeNamespace: string;
  bqDatasetId: string;
  pubsubTopicIn: string;
  pubsubTopicOut: string;
  kmsKeyRing: string;
  kmsCryptoKey: string;
}

export interface OnboardedTenant {
  tenantId: string;
  tenantCode: string;
  legalName: string;
  displayName: string;
  residencyZone: ResidencyZone;
  billingAccountId: string;
  status: TenantStatus;
  infrastructure: TenantInfrastructureConfig;
  gdprApplicable: boolean;
  ccpaApplicable: boolean;
  hipaaApplicable: boolean;
  contractStartDate: string;
  createdBy: string;
  createdAt: Date;
}

export interface TenantServiceOptions {
  pool?: Pool;
  databaseUrl?: string;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class TenantServiceError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "TenantServiceError";
  }
}

export class TenantAlreadyExistsError extends TenantServiceError {
  constructor(tenantCode: string, cause?: unknown) {
    super(
      `Tenant with code "${tenantCode}" already exists.`,
      "TENANT_ALREADY_EXISTS",
      cause,
    );
    this.name = "TenantAlreadyExistsError";
  }
}

export class TenantValidationError extends TenantServiceError {
  constructor(message: string, cause?: unknown) {
    super(message, "TENANT_VALIDATION_ERROR", cause);
    this.name = "TenantValidationError";
  }
}

// ---------------------------------------------------------------------------
// Infrastructure naming helpers
// ---------------------------------------------------------------------------

const TENANT_CODE_PATTERN = /^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$/;

/**
 * Normalizes a tenant code into a URL/GCP-safe slug segment.
 */
export function normalizeTenantSlug(tenantCode: string): string {
  const slug = tenantCode.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-");
  const trimmed = slug.replace(/^-+|-+$/g, "");

  if (!TENANT_CODE_PATTERN.test(trimmed)) {
    throw new TenantValidationError(
      "tenantCode must be 2–32 characters, lowercase alphanumeric with internal hyphens.",
    );
  }

  return trimmed;
}

/**
 * Derives default platform resource identifiers from the tenant slug.
 */
export function buildTenantInfrastructureConfig(
  tenantCode: string,
  gcpProjectId: string,
): TenantInfrastructureConfig {
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

function deriveComplianceFlags(residencyZone: ResidencyZone): {
  gdprApplicable: boolean;
  ccpaApplicable: boolean;
  hipaaApplicable: boolean;
} {
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

let sharedPool: Pool | undefined;

function getPool(options: TenantServiceOptions = {}): Pool {
  if (options.pool) {
    return options.pool;
  }

  if (!sharedPool) {
    const connectionString =
      options.databaseUrl ?? process.env.DATABASE_URL ?? process.env.POSTGRES_URL;

    if (!connectionString) {
      throw new TenantServiceError(
        "Database connection string is required. Set DATABASE_URL or pass pool/databaseUrl.",
        "DATABASE_CONFIG_MISSING",
      );
    }

    sharedPool = new PgPool({
      connectionString,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
  }

  return sharedPool;
}

function mapTenantRow(
  row: Record<string, unknown>,
  infrastructure: TenantInfrastructureConfig,
): OnboardedTenant {
  return {
    tenantId: String(row.tenant_id),
    tenantCode: String(row.tenant_code),
    legalName: String(row.legal_name),
    displayName: String(row.display_name),
    residencyZone: row.residency_zone as ResidencyZone,
    billingAccountId: String(row.billing_account_id),
    status: row.status as TenantStatus,
    infrastructure,
    gdprApplicable: Boolean(row.gdpr_applicable),
    ccpaApplicable: Boolean(row.ccpa_applicable),
    hipaaApplicable: Boolean(row.hipaa_applicable),
    contractStartDate: String(row.contract_start_date),
    createdBy: String(row.created_by),
    createdAt: new Date(String(row.created_at)),
  };
}

function handleDatabaseError(error: unknown, tenantCode: string): never {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: string }).code === "23505"
  ) {
    throw new TenantAlreadyExistsError(tenantCode, error);
  }

  throw new TenantServiceError(
    "Failed to onboard tenant due to a database error.",
    "TENANT_ONBOARDING_FAILED",
    error,
  );
}

/**
 * Creates a new tenant row in PROVISIONING state and returns the provisioned
 * configuration bundle for downstream infrastructure automation.
 */
export async function onboardTenant(
  input: OnboardTenantInput,
  options: TenantServiceOptions = {},
): Promise<OnboardedTenant> {
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
  if (!RESIDENCY_ZONES.includes(input.residencyZone)) {
    throw new TenantValidationError(
      `residencyZone must be one of: ${RESIDENCY_ZONES.join(", ")}`,
    );
  }

  const tenantCode = normalizeTenantSlug(input.tenantCode);
  const displayName = input.displayName?.trim() || legalName;
  const tenantId = randomUUID();
  const infrastructure = buildTenantInfrastructureConfig(tenantCode, gcpProjectId);
  const compliance = deriveComplianceFlags(input.residencyZone);
  const contractStartDate = input.contractStartDate ?? new Date();

  const primaryContactEmail = input.primaryContactEmail ?? Buffer.alloc(0);
  const primaryContactPhone = input.primaryContactPhone ?? Buffer.alloc(0);

  const pool = getPool(options);
  let client: PoolClient | undefined;

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
    "PROVISIONING" satisfies TenantStatus,
    contractStartDate,
    createdBy,
  ];

  try {
    client = await pool.connect();

    const result: QueryResult<Record<string, unknown>> = await client.query(
      insertQuery,
      params,
    );

    if (result.rowCount !== 1 || !result.rows[0]) {
      throw new TenantServiceError(
        "Tenant insert did not return a row.",
        "TENANT_ONBOARDING_EMPTY_RESULT",
      );
    }

    return mapTenantRow(result.rows[0], infrastructure);
  } catch (error) {
    if (
      error instanceof TenantServiceError ||
      error instanceof TenantValidationError
    ) {
      throw error;
    }

    handleDatabaseError(error, tenantCode);
  } finally {
    client?.release();
  }
}

/**
 * Gracefully closes the shared connection pool (for scripts/tests).
 */
export async function closeTenantServicePool(): Promise<void> {
  if (sharedPool) {
    await sharedPool.end();
    sharedPool = undefined;
  }
}

export { getPool as getTenantServicePool };
