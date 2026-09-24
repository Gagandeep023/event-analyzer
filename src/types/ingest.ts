/** Request and response shapes for the ingestion endpoints. */

import type {
  AnalyticsEvent,
  GroupIdentification,
  Identification,
  UserAlias,
} from './event';

/** `POST /collect` body. */
export interface CollectPayload {
  events: AnalyticsEvent[];
}

/** `POST /identify` body. */
export interface IdentifyPayload {
  identification: Identification | Identification[];
}

/** `POST /group-identify` body. */
export interface GroupIdentifyPayload {
  identification: GroupIdentification | GroupIdentification[];
}

/** `POST /alias` body. */
export interface AliasPayload {
  mapping: UserAlias | UserAlias[];
}

/**
 * Why an event was rejected, addressed by its index in the submitted batch.
 *
 * This is the most valuable detail in the whole ingest contract: it lets a
 * client drop only the poison events and retry the rest, instead of losing the
 * whole batch to one bad record.
 */
export interface RejectionMap {
  events_with_missing_fields?: Record<string, number[]>;
  events_with_invalid_fields?: Record<string, number[]>;
  events_with_invalid_id_lengths?: Record<string, number[]>;
  /** Indices dropped because an identical `insert_id` was seen recently. */
  duplicate_events?: number[];
}

/** `POST /collect` success. Partial acceptance is still a success. */
export interface CollectSuccess {
  code: 200;
  events_ingested: number;
  events_rejected: number;
  payload_size_bytes: number;
  server_upload_time: number;
  /** Present only when at least one event was rejected. */
  rejected?: RejectionMap;
}

/** `POST /collect` failure: nothing in the batch was acceptable. */
export interface CollectFailure extends RejectionMap {
  code: 400;
  error: string;
}

export type CollectResponse = CollectSuccess | CollectFailure;

/** Result of applying a batch of identifications. */
export interface IdentifyResponse {
  code: 200;
  identifications_applied: number;
}

/** Every non-collect error uses this envelope. */
export interface ErrorResponse {
  code: number;
  error: string;
  details?: Record<string, unknown>;
}

/** One validation failure against a single event. */
export interface ValidationIssue {
  index: number;
  field: string;
  kind: 'missing' | 'invalid' | 'invalid_id_length' | 'duplicate';
  message: string;
}

/** Outcome of validating a batch. */
export interface ValidationResult {
  /** Events that passed, with server-side fields stamped in. */
  accepted: AnalyticsEvent[];
  issues: ValidationIssue[];
}

/** `GET /meta` response. Everything the dashboard needs to build a query. */
export interface MetaResponse {
  eventTypes: Array<{
    event_type: string;
    count: number;
    firstSeen: number;
    lastSeen: number;
  }>;
  propertyKeys: Array<{
    scope: 'event' | 'user' | 'context' | 'group';
    key: string;
    types: string[];
    sampleValues: unknown[];
  }>;
  groupTypes: string[];
  oldest: number | null;
  newest: number | null;
  totalEvents: number;
}

/** `GET /health` response. Unauthenticated and cheap. */
export interface HealthResponse {
  ok: boolean;
  store: string;
  totalEvents: number;
  oldest: number | null;
  newest: number | null;
  uptimeMs: number;
}

/** One `GET /stream` message. */
export interface StreamMessage {
  events: AnalyticsEvent[];
  receivedAt: number;
}
