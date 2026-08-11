CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TYPE tenant_status       AS ENUM ('PROVISIONING','ACTIVE','SUSPENDED','OFFBOARDING','ARCHIVED');
CREATE TYPE residency_zone      AS ENUM ('EU','EEA','UK','US-EAST','US-WEST','APAC-SOUTH','APAC-NORTHEAST','MENA','LATAM');
CREATE TYPE pipeline_stage      AS ENUM ('INGESTION','REFINERY','PUBLICATION','AI_TRAINING','ARCHIVED');
CREATE TYPE pipeline_status     AS ENUM ('DRAFT','SCHEDULED','RUNNING','SUCCEEDED','FAILED','PAUSED');
CREATE TYPE log_severity        AS ENUM ('DEBUG','INFO','WARN','ERROR','CRITICAL');

CREATE TABLE tenants (
    tenant_id              UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_code            VARCHAR(32)  UNIQUE NOT NULL,
    legal_name             VARCHAR(255) NOT NULL,
    display_name           VARCHAR(255) NOT NULL,
    residency_zone         residency_zone NOT NULL,
    mirrored_zones         residency_zone[]   NOT NULL DEFAULT '{}',
    gdpr_applicable        BOOLEAN      NOT NULL DEFAULT FALSE,
    ccpa_applicable        BOOLEAN      NOT NULL DEFAULT FALSE,
    hipaa_applicable       BOOLEAN      NOT NULL DEFAULT FALSE,
    primary_contact_email  BYTEA        NOT NULL,
    primary_contact_phone  BYTEA        NOT NULL,
    billing_account_id     VARCHAR(64)  NOT NULL,
    kms_key_ring           VARCHAR(128) NOT NULL,
    kms_crypto_key         VARCHAR(128) NOT NULL,
    gke_namespace          VARCHAR(64)  UNIQUE NOT NULL,
    bq_dataset_id          VARCHAR(128) UNIQUE NOT NULL,
    pubsub_topic_in        VARCHAR(256) NOT NULL,
    pubsub_topic_out       VARCHAR(256) NOT NULL,
    dlp_inspect_template   VARCHAR(256),
    dlp_deidentify_template VARCHAR(256),
    status                 tenant_status NOT NULL DEFAULT 'PROVISIONING',
    contract_start_date    DATE         NOT NULL,
    contract_end_date      DATE,
    data_retention_days    INTEGER      NOT NULL DEFAULT 365,
    last_audit_at          TIMESTAMPTZ,
    created_at             TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at             TIMESTAMPTZ  NOT NULL DEFAULT now(),
    created_by             VARCHAR(128) NOT NULL,
    schema_version         INTEGER      NOT NULL DEFAULT 1
);

CREATE INDEX idx_tenants_status ON tenants (status);
CREATE INDEX idx_tenants_residency ON tenants (residency_zone);

CREATE TABLE data_pipelines (
    pipeline_id            UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id              UUID         NOT NULL REFERENCES tenants(tenant_id) ON DELETE RESTRICT ON UPDATE CASCADE,
    pipeline_name          VARCHAR(128) NOT NULL,
    stage                  pipeline_stage NOT NULL,
    status                 pipeline_status NOT NULL DEFAULT 'DRAFT',
    source_kind            VARCHAR(32)  NOT NULL,
    source_ref             VARCHAR(512) NOT NULL,
    destination_dataset    VARCHAR(128) NOT NULL,
    destination_table      VARCHAR(128) NOT NULL,
    schema_json            JSONB        NOT NULL,
    dlp_template_ref       VARCHAR(256),
    kms_key_resource       VARCHAR(256) NOT NULL,
    schedule_type          VARCHAR(32)  NOT NULL DEFAULT 'STREAMING',
    schedule_cron          VARCHAR(64),
    max_workers            INTEGER      NOT NULL DEFAULT 4,
    machine_type           VARCHAR(64)  NOT NULL DEFAULT 'n2-standard-4',
    autoscaling_enabled    BOOLEAN      NOT NULL DEFAULT TRUE,
    config_json            JSONB        NOT NULL DEFAULT '{}'::jsonb,
    version                INTEGER      NOT NULL DEFAULT 1,
    last_run_at            TIMESTAMPTZ,
    last_run_status        pipeline_status,
    total_records_processed BIGINT      NOT NULL DEFAULT 0,
    created_at             TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at             TIMESTAMPTZ  NOT NULL DEFAULT now(),
    created_by             VARCHAR(128) NOT NULL,
    UNIQUE (tenant_id, pipeline_name, version)
);

CREATE TABLE processing_logs (
    log_id                 UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id              UUID         NOT NULL REFERENCES tenants(tenant_id) ON DELETE RESTRICT ON UPDATE CASCADE,
    pipeline_id            UUID         NOT NULL REFERENCES data_pipelines(pipeline_id) ON DELETE RESTRICT ON UPDATE CASCADE,
    event_id               UUID         NOT NULL,
    dataflow_job_id        VARCHAR(128),
    residency_zone         residency_zone NOT NULL,
    severity               log_severity NOT NULL DEFAULT 'INFO',
    records_received       BIGINT       NOT NULL DEFAULT 0,
    records_deduplicated   BIGINT       NOT NULL DEFAULT 0,
    records_masked         BIGINT       NOT NULL DEFAULT 0,
    records_dropped_null   BIGINT       NOT NULL DEFAULT 0,
    records_failed         BIGINT       NOT NULL DEFAULT 0,
    records_published      BIGINT       NOT NULL DEFAULT 0,
    dlp_findings_summary   JSONB        NOT NULL DEFAULT '[]'::jsonb,
    kms_key_version        VARCHAR(64),
    bytes_processed        BIGINT,
    started_at             TIMESTAMPTZ  NOT NULL DEFAULT now(),
    completed_at           TIMESTAMPTZ,
    error_code             VARCHAR(64),
    error_message          TEXT,
    CONSTRAINT chk_records_consistency CHECK (records_received = records_published + records_failed + records_dropped_null + records_deduplicated)
);

CREATE OR REPLACE VIEW v_tenant_data_volume AS
SELECT  t.tenant_id, t.tenant_code, t.residency_zone,
        COUNT(DISTINCT p.pipeline_id) AS pipeline_count,
        COALESCE(SUM(l.records_received),0) AS total_records_received,
        COALESCE(SUM(l.records_published),0) AS total_records_published,
        COALESCE(SUM(l.records_masked),0) AS total_records_masked
FROM tenants t
LEFT JOIN data_pipelines p ON p.tenant_id = t.tenant_id
LEFT JOIN processing_logs l ON l.tenant_id = t.tenant_id AND l.started_at >= now() - INTERVAL '30 days'
GROUP BY t.tenant_id, t.tenant_code, t.residency_zone;
