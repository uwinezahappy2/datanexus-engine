#!/usr/bin/env python3
"""
DataNexus Engine — Standard Refinery Pipeline
==============================================
Production-grade Apache Beam streaming pipeline (Python 3.11 / Dataflow).

Reads tenant-scoped events from Pub/Sub, parses and enriches them, applies
cleaning rules (null drops, deduplication keys, PII masking), routes poison
messages to a dead-letter topic, and publishes clean records to BigQuery with
regional customer-managed encryption (CMEK).

Typical launch (Dataflow):
    python pipelines/standard_refinery.py \\
        --runner=DataflowRunner \\
        --project=${GCP_PROJECT} \\
        --region=europe-west1 \\
        --temp_location=gs://${BUCKET}/tmp \\
        --staging_location=gs://${BUCKET}/staging \\
        --streaming \\
        --pubsub_subscription=projects/${GCP_PROJECT}/subscriptions/${SUB} \\
        --dead_letter_topic=projects/${GCP_PROJECT}/topics/${DLQ_TOPIC} \\
        --output_table=${GCP_PROJECT}:${DATASET}.${TABLE} \\
        --kms_key_resource=projects/${GCP_PROJECT}/locations/europe-west1/keyRings/${RING}/cryptoKeys/${KEY} \\
        --residency_zone=EU \\
        --tenant_id=${TENANT_ID} \\
        --pipeline_id=${PIPELINE_ID}
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import re
import uuid
from datetime import datetime, timezone
from typing import Any, Iterator, Optional

import apache_beam as beam
from apache_beam.io.gcp.bigquery import WriteToBigQuery
from apache_beam.io.gcp.pubsub import ReadFromPubSub, WriteToPubSub
from apache_beam.metrics import Metrics
from apache_beam.options.pipeline_options import (
    GoogleCloudOptions,
    PipelineOptions,
    SetupOptions,
    StandardOptions,
)
from apache_beam.transforms.util import Distinct

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# BigQuery destination schema (refined, tenant-scoped fact table)
# ---------------------------------------------------------------------------
REFINERY_BQ_SCHEMA: dict[str, Any] = {
    "fields": [
        {"name": "tenant_id", "type": "STRING", "mode": "REQUIRED"},
        {"name": "pipeline_id", "type": "STRING", "mode": "REQUIRED"},
        {"name": "event_id", "type": "STRING", "mode": "REQUIRED"},
        {"name": "record_hash", "type": "STRING", "mode": "REQUIRED"},
        {"name": "residency_zone", "type": "STRING", "mode": "REQUIRED"},
        {"name": "source_kind", "type": "STRING", "mode": "NULLABLE"},
        {"name": "payload", "type": "JSON", "mode": "REQUIRED"},
        {"name": "masked_field_count", "type": "INTEGER", "mode": "REQUIRED"},
        {"name": "deduplicated", "type": "BOOLEAN", "mode": "REQUIRED"},
        {"name": "ingestion_ts", "type": "TIMESTAMP", "mode": "REQUIRED"},
        {"name": "processed_at", "type": "TIMESTAMP", "mode": "REQUIRED"},
        {"name": "schema_version", "type": "INTEGER", "mode": "REQUIRED"},
        {"name": "dataflow_job_id", "type": "STRING", "mode": "NULLABLE"},
    ]
}

# Maps control-plane residency zones to preferred GCP regions for KMS/BQ locality.
RESIDENCY_ZONE_REGION_TAGS: dict[str, str] = {
    "EU": "europe-west1",
    "EEA": "europe-west3",
    "UK": "europe-west2",
    "US-EAST": "us-east1",
    "US-WEST": "us-west1",
    "APAC-SOUTH": "asia-south1",
    "APAC-NORTHEAST": "asia-northeast1",
    "MENA": "me-west1",
    "LATAM": "southamerica-east1",
}

REQUIRED_PAYLOAD_FIELDS = ("event_id", "tenant_id")
EMAIL_PATTERN = re.compile(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}")
PHONE_PATTERN = re.compile(r"\+?\d[\d\s().-]{7,}\d")


# ---------------------------------------------------------------------------
# Pipeline options
# ---------------------------------------------------------------------------
class RefineryPipelineOptions(PipelineOptions):
    """Custom CLI flags consumed by build_pipeline()."""

    @classmethod
    def _add_argparse_args(cls, parser: argparse.ArgumentParser) -> None:
        parser.add_argument(
            "--pubsub_subscription",
            required=True,
            help="Fully-qualified Pub/Sub subscription for inbound events.",
        )
        parser.add_argument(
            "--dead_letter_topic",
            required=True,
            help="Fully-qualified Pub/Sub topic for unparseable / invalid records.",
        )
        parser.add_argument(
            "--output_table",
            required=True,
            help="BigQuery table spec: PROJECT:DATASET.TABLE",
        )
        parser.add_argument(
            "--kms_key_resource",
            required=True,
            help=(
                "Regional CMEK resource name, e.g. "
                "projects/P/locations/L/keyRings/R/cryptoKeys/K"
            ),
        )
        parser.add_argument(
            "--residency_zone",
            required=True,
            choices=sorted(RESIDENCY_ZONE_REGION_TAGS.keys()),
            help="Data residency zone tag propagated to outputs and job labels.",
        )
        parser.add_argument(
            "--tenant_id",
            required=True,
            help="Tenant UUID owning this pipeline run.",
        )
        parser.add_argument(
            "--pipeline_id",
            required=True,
            help="Control-plane pipeline UUID.",
        )
        parser.add_argument(
            "--schema_version",
            type=int,
            default=1,
            help="Schema version stamped on every refined row.",
        )
        parser.add_argument(
            "--dedup_enabled",
            default="true",
            choices=("true", "false"),
            help="Enable record-hash deduplication before BigQuery write.",
        )


# ---------------------------------------------------------------------------
# Parse & enrich
# ---------------------------------------------------------------------------
class ParseAndEnrich(beam.DoFn):
    """
    Decode Pub/Sub payloads, validate structure, and attach pipeline metadata.

    Tagged outputs:
      • main (default) — successfully parsed records ready for cleaning
      • dead_letter    — poison messages that cannot be parsed or validated
      • dropped_null   — records missing all business-critical fields
    """

    OUTPUT_TAG_DEAD_LETTER = "dead_letter"
    OUTPUT_TAG_DROPPED_NULL = "dropped_null"

    def __init__(
        self,
        tenant_id: str,
        pipeline_id: str,
        residency_zone: str,
        schema_version: int,
        dataflow_job_id: Optional[str] = None,
    ) -> None:
        self._tenant_id = tenant_id
        self._pipeline_id = pipeline_id
        self._residency_zone = residency_zone
        self._schema_version = schema_version
        self._dataflow_job_id = dataflow_job_id

        self._records_received = Metrics.counter(self.__class__, "records_received")
        self._records_parsed = Metrics.counter(self.__class__, "records_parsed")
        self._records_dead_letter = Metrics.counter(self.__class__, "records_dead_letter")
        self._records_dropped_null = Metrics.counter(self.__class__, "records_dropped_null")

    def _dead_letter(self, raw: bytes, reason: str, attributes: dict[str, str]) -> dict[str, Any]:
        return {
            "tenant_id": self._tenant_id,
            "pipeline_id": self._pipeline_id,
            "residency_zone": self._residency_zone,
            "reason": reason,
            "raw_payload": raw.decode("utf-8", errors="replace"),
            "attributes": attributes,
            "failed_at": datetime.now(tz=timezone.utc).isoformat(),
        }

    def process(  # type: ignore[override]
        self,
        message: bytes,
        attributes: dict[str, str] | None = None,
        *,
        timestamp: Optional[datetime] = None,
    ) -> Iterator[beam.pvalue.TaggedOutput | dict[str, Any]]:
        self._records_received.inc()
        attrs = attributes or {}

        try:
            payload = json.loads(message.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            self._records_dead_letter.inc()
            yield beam.pvalue.TaggedOutput(
                self.OUTPUT_TAG_DEAD_LETTER,
                self._dead_letter(message, f"json_parse_error: {exc}", attrs),
            )
            return

        if not isinstance(payload, dict):
            self._records_dead_letter.inc()
            yield beam.pvalue.TaggedOutput(
                self.OUTPUT_TAG_DEAD_LETTER,
                self._dead_letter(message, "payload_not_object", attrs),
            )
            return

        event_id = str(payload.get("event_id") or attrs.get("event_id") or uuid.uuid4())
        tenant_id = str(payload.get("tenant_id") or attrs.get("tenant_id") or self._tenant_id)

        missing = [field for field in REQUIRED_PAYLOAD_FIELDS if not payload.get(field) and field not in attrs]
        if missing and not payload.get("data"):
            self._records_dropped_null.inc()
            yield beam.pvalue.TaggedOutput(
                self.OUTPUT_TAG_DROPPED_NULL,
                {
                    "tenant_id": tenant_id,
                    "event_id": event_id,
                    "reason": f"missing_fields: {','.join(missing)}",
                },
            )
            return

        ingestion_ts = (
            timestamp.isoformat()
            if timestamp
            else payload.get("ingestion_ts")
            or datetime.now(tz=timezone.utc).isoformat()
        )

        enriched: dict[str, Any] = {
            "tenant_id": tenant_id,
            "pipeline_id": self._pipeline_id,
            "event_id": event_id,
            "residency_zone": self._residency_zone,
            "source_kind": payload.get("source_kind") or attrs.get("source_kind"),
            "payload": payload,
            "masked_field_count": 0,
            "deduplicated": False,
            "ingestion_ts": ingestion_ts,
            "processed_at": datetime.now(tz=timezone.utc).isoformat(),
            "schema_version": self._schema_version,
            "dataflow_job_id": self._dataflow_job_id,
        }

        self._records_parsed.inc()
        yield enriched


# ---------------------------------------------------------------------------
# Cleaning helpers
# ---------------------------------------------------------------------------
class _MaskPiiDoFn(beam.DoFn):
    """Mask common PII patterns in-place within the payload JSON blob."""

    def __init__(self) -> None:
        self._records_masked = Metrics.counter(self.__class__, "records_masked")

    @staticmethod
    def _mask_value(value: str) -> tuple[str, int]:
        masked_count = 0
        if EMAIL_PATTERN.search(value):
            value = EMAIL_PATTERN.sub("[REDACTED_EMAIL]", value)
            masked_count += 1
        if PHONE_PATTERN.search(value):
            value = PHONE_PATTERN.sub("[REDACTED_PHONE]", value)
            masked_count += 1
        return value, masked_count

    def _walk(self, node: Any) -> tuple[Any, int]:
        total = 0
        if isinstance(node, dict):
            return {
                key: self._walk(value)[0] for key, value in node.items()
            }, sum(self._walk(value)[1] for value in node.values())
        if isinstance(node, list):
            cleaned = []
            for item in node:
                new_item, count = self._walk(item)
                cleaned.append(new_item)
                total += count
            return cleaned, total
        if isinstance(node, str):
            masked, count = self._mask_value(node)
            return masked, count
        return node, total

    def process(self, record: dict[str, Any]) -> Iterator[dict[str, Any]]:  # type: ignore[override]
        payload, masked_count = self._walk(record["payload"])
        if masked_count:
            self._records_masked.inc()
        record["payload"] = payload
        record["masked_field_count"] = masked_count
        yield record


class _ComputeRecordHashDoFn(beam.DoFn):
    """Stable SHA-256 hash over tenant + event identity for deduplication."""

    def process(self, record: dict[str, Any]) -> Iterator[dict[str, Any]]:  # type: ignore[override]
        canonical = json.dumps(
            {
                "tenant_id": record["tenant_id"],
                "event_id": record["event_id"],
                "payload": record["payload"],
            },
            sort_keys=True,
            separators=(",", ":"),
        )
        record["record_hash"] = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
        yield record


class _MarkDeduplicatedDoFn(beam.DoFn):
    """Flag rows that survived the Distinct transform."""

    def process(self, record: dict[str, Any]) -> Iterator[dict[str, Any]]:  # type: ignore[override]
        record["deduplicated"] = True
        yield record


# ---------------------------------------------------------------------------
# Composite cleaning transform
# ---------------------------------------------------------------------------
class CleaningTransform(beam.PTransform):
    """
    End-to-end refinery stage: parse → enrich → mask PII → hash → deduplicate.

    Returns a dict of PCollections:
      • clean        — rows ready for BigQuery
      • dead_letter  — poison / invalid messages
      • dropped_null — rows dropped for missing critical fields
    """

    def __init__(
        self,
        tenant_id: str,
        pipeline_id: str,
        residency_zone: str,
        schema_version: int,
        dedup_enabled: bool = True,
        dataflow_job_id: Optional[str] = None,
    ) -> None:
        super().__init__()
        self._tenant_id = tenant_id
        self._pipeline_id = pipeline_id
        self._residency_zone = residency_zone
        self._schema_version = schema_version
        self._dedup_enabled = dedup_enabled
        self._dataflow_job_id = dataflow_job_id

    def expand(self, pcoll: beam.PCollection) -> dict[str, beam.PCollection]:
        parsed = pcoll | "ParseAndEnrich" >> beam.ParDo(
            ParseAndEnrich(
                tenant_id=self._tenant_id,
                pipeline_id=self._pipeline_id,
                residency_zone=self._residency_zone,
                schema_version=self._schema_version,
                dataflow_job_id=self._dataflow_job_id,
            )
        ).with_outputs(
            ParseAndEnrich.OUTPUT_TAG_DEAD_LETTER,
            ParseAndEnrich.OUTPUT_TAG_DROPPED_NULL,
            main="clean",
        )

        cleaned = (
            parsed.clean
            | "MaskPii" >> beam.ParDo(_MaskPiiDoFn())
            | "ComputeRecordHash" >> beam.ParDo(_ComputeRecordHashDoFn())
        )

        if self._dedup_enabled:
            cleaned = (
                cleaned
                | "DistinctByRecordHash" >> Distinct(lambda row: row["record_hash"])
                | "MarkDeduplicated" >> beam.ParDo(_MarkDeduplicatedDoFn())
            )

        return {
            "clean": cleaned,
            "dead_letter": parsed[ParseAndEnrich.OUTPUT_TAG_DEAD_LETTER],
            "dropped_null": parsed[ParseAndEnrich.OUTPUT_TAG_DROPPED_NULL],
        }


# ---------------------------------------------------------------------------
# Dead-letter serialisation
# ---------------------------------------------------------------------------
class _SerializeDeadLetterDoFn(beam.DoFn):
    def process(self, record: dict[str, Any]) -> Iterator[bytes]:  # type: ignore[override]
        yield json.dumps(record, separators=(",", ":")).encode("utf-8")


# ---------------------------------------------------------------------------
# Pipeline assembly
# ---------------------------------------------------------------------------
def build_pipeline(options: RefineryPipelineOptions, pipeline: beam.Pipeline) -> beam.Pipeline:
    """
    Wire the standard refinery DAG:

        Pub/Sub ──► CleaningTransform ──┬──► BigQuery (CMEK)
                                        └──► Pub/Sub dead-letter topic
    """
    refinery_opts = options.view_as(RefineryPipelineOptions)
    gcp_opts = options.view_as(GoogleCloudOptions)

    dataflow_job_id = gcp_opts.job_name
    dedup_enabled = refinery_opts.dedup_enabled.lower() == "true"
    regional_tag = RESIDENCY_ZONE_REGION_TAGS[refinery_opts.residency_zone]

    # Propagate residency / KMS metadata as Dataflow resource labels.
    existing_labels = dict(gcp_opts.labels or {})
    existing_labels.update(
        {
            "datanexus_component": "standard-refinery",
            "datanexus_residency_zone": refinery_opts.residency_zone.lower().replace("_", "-"),
            "datanexus_regional_kms_tag": regional_tag,
            "datanexus_tenant_id": refinery_opts.tenant_id,
            "datanexus_pipeline_id": refinery_opts.pipeline_id,
        }
    )
    gcp_opts.labels = existing_labels

    messages = pipeline | "ReadFromPubSub" >> ReadFromPubSub(
        subscription=refinery_opts.pubsub_subscription,
        with_attributes=True,
        timestamp_attribute="ingestion_ts",
    )

    branches = messages | "CleaningTransform" >> CleaningTransform(
        tenant_id=refinery_opts.tenant_id,
        pipeline_id=refinery_opts.pipeline_id,
        residency_zone=refinery_opts.residency_zone,
        schema_version=refinery_opts.schema_version,
        dedup_enabled=dedup_enabled,
        dataflow_job_id=dataflow_job_id,
    )

    # ── Happy path: regional KMS-encrypted BigQuery write ──────────────────
    _ = branches["clean"] | "WriteToBigQuery" >> WriteToBigQuery(
        table=refinery_opts.output_table,
        schema=REFINERY_BQ_SCHEMA,
        write_disposition=beam.io.BigQueryDisposition.WRITE_APPEND,
        create_disposition=beam.io.BigQueryDisposition.CREATE_NEVER,
        kms_key=refinery_opts.kms_key_resource,
        additional_bq_parameters={
            "labels": {
                "datanexus_residency_zone": refinery_opts.residency_zone,
                "datanexus_regional_kms_tag": regional_tag,
                "datanexus_pipeline_id": refinery_opts.pipeline_id,
            }
        },
        method=WriteToBigQuery.Method.STREAMING_INSERTS,
    )

    # ── Dead-letter branch: route poison pills back to Pub/Sub ─────────────
    _ = (
        branches["dead_letter"]
        | "SerializeDeadLetter" >> beam.ParDo(_SerializeDeadLetterDoFn())
        | "WriteDeadLetterToPubSub"
        >> WriteToPubSub(topic=refinery_opts.dead_letter_topic)
    )

    return pipeline


def run(argv: Optional[list[str]] = None) -> None:
    logging.basicConfig(level=logging.INFO)

    options = RefineryPipelineOptions(argv)
    options.view_as(SetupOptions).save_main_session = True
    options.view_as(StandardOptions).streaming = True

    with beam.Pipeline(options=options) as pipeline:
        build_pipeline(options, pipeline)


if __name__ == "__main__":
    run()
