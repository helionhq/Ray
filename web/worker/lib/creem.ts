/**
 * Creem API helpers and webhook parsing.
 *
 * API shapes were checked against https://docs.creem.io (checkout sessions,
 * customer billing portal, webhooks). Timestamps in Creem payloads appear as
 * ISO strings in some fields and numeric epoch milliseconds in others, so
 * `toUnixMillis` / `toUnixSeconds` accept both.
 */

import type { Env } from "../env";
import {
  fetchWithTimeout,
  parseJsonObject,
  upstreamErrorMessage,
} from "../http";
import {
  hexToBytes,
  hmacSha256Hex,
  timingSafeEqualBytes,
} from "./crypto";
import {
  normalizeInterval,
  terminalStatusRank,
  type PlanInterval,
} from "./plan";

export const DEFAULT_CREEM_API_BASE = "https://api.creem.io/v1";
export const CREEM_SIGNATURE_HEADER = "creem-signature";

/** Accepts both `https://api.creem.io` and `https://api.creem.io/v1`. */
export function creemApiBase(raw: string | undefined | null): string {
  const trimmed = (raw ?? "").trim().replace(/\/+$/u, "");
  if (trimmed === "") return DEFAULT_CREEM_API_BASE;
  return /\/v1$/iu.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

interface CreemSuccess {
  ok: true;
  data: Record<string, unknown>;
}

interface CreemFailure {
  ok: false;
  message: string;
}

/** POSTs a JSON payload to the Creem API. Never throws. */
export async function creemPost(
  env: Pick<Env, "CREEM_API_BASE" | "CREEM_API_KEY">,
  path: string,
  payload: Record<string, unknown>,
): Promise<CreemSuccess | CreemFailure> {
  let response: Response;
  try {
    response = await fetchWithTimeout(
      `${creemApiBase(env.CREEM_API_BASE)}${path}`,
      {
        method: "POST",
        headers: {
          "x-api-key": env.CREEM_API_KEY,
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      },
      15_000,
    );
  } catch {
    return { ok: false, message: "Billing service is unavailable." };
  }

  const text = await response.text();
  if (!response.ok) {
    return {
      ok: false,
      message: upstreamErrorMessage(text, "Billing request failed."),
    };
  }
  const data = parseJsonObject(text);
  if (!data) {
    return { ok: false, message: "Billing returned an invalid response." };
  }
  return { ok: true, data };
}

/**
 * Creem signs the raw request body with HMAC-SHA256 and sends the lowercase
 * hex digest in `creem-signature`. Comparison is constant time.
 *
 * A missing/blank secret always fails closed.
 */
export async function verifyCreemSignature(
  rawBody: string,
  signatureHeader: string | null | undefined,
  secret: string | null | undefined,
): Promise<boolean> {
  if (!signatureHeader || !secret || secret.trim() === "") return false;
  const signature = signatureHeader.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/u.test(signature)) return false;
  const provided = hexToBytes(signature);
  if (!provided) return false;
  const expected = hexToBytes(await hmacSha256Hex(secret, rawBody));
  if (!expected) return false;
  return timingSafeEqualBytes(expected, provided);
}

export interface ParsedSubscriptionEvent {
  subscriptionId: string;
  status: string;
  productId: string | null;
  interval: PlanInterval | null;
  customerId: string | null;
  customerEmail: string | null;
  metadataUserId: string | null;
  /** Unix seconds. */
  currentPeriodEnd: number | null;
  cancelAtPeriodEnd: boolean;
  /** Unix milliseconds, used to reject out-of-order deliveries. */
  eventTimestamp: number;
}

export type ParsedWebhookEvent =
  | { kind: "subscription"; subscription: ParsedSubscriptionEvent }
  | { kind: "ignored"; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordAt(
  parent: Record<string, unknown> | null,
  key: string,
): Record<string, unknown> | null {
  if (!parent) return null;
  const value = parent[key];
  return isRecord(value) ? value : null;
}

function stringAt(
  parent: Record<string, unknown> | null,
  key: string,
): string | null {
  if (!parent) return null;
  const value = parent[key];
  return typeof value === "string" && value !== "" ? value : null;
}

/** ISO-8601 / epoch-seconds / epoch-milliseconds to unix milliseconds. */
export function toUnixMillis(value: unknown): number | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) return null;
    // 1e11 ms is 1973-03-03; anything that large is milliseconds. Real
    // epoch-seconds values stay below this until the year 5138.
    return Math.floor(value > 1e11 ? value : value * 1000);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return null;
    if (/^\d+(?:\.\d+)?$/u.test(trimmed)) {
      return toUnixMillis(Number(trimmed));
    }
    const parsed = Date.parse(trimmed);
    if (!Number.isFinite(parsed)) return null;
    return Math.floor(parsed);
  }
  return null;
}

/** ISO-8601 / epoch-seconds / epoch-milliseconds to integer unix seconds. */
export function toUnixSeconds(value: unknown): number | null {
  const milliseconds = toUnixMillis(value);
  return milliseconds === null ? null : Math.floor(milliseconds / 1000);
}

function fallbackStatus(eventType: string): string | null {
  switch (eventType) {
    case "subscription.active":
    case "subscription.paid":
      return "active";
    case "subscription.trialing":
      return "trialing";
    case "subscription.canceled":
      return "canceled";
    case "subscription.scheduled_cancel":
      return "scheduled_cancel";
    case "subscription.past_due":
      return "past_due";
    case "subscription.unpaid":
      return "unpaid";
    case "subscription.paused":
      return "paused";
    case "subscription.expired":
      return "expired";
    default:
      return null;
  }
}

interface BuildOptions {
  monthlyProductId?: string;
  annualProductId?: string;
}

function inferInterval(
  productId: string | null,
  product: Record<string, unknown> | null,
  options: BuildOptions,
): PlanInterval | null {
  return (
    normalizeInterval(stringAt(product, "recurring_interval")) ??
    normalizeInterval(stringAt(product, "billing_period")) ??
    (productId !== null && productId === options.monthlyProductId
      ? "monthly"
      : null) ??
    (productId !== null && productId === options.annualProductId
      ? "annual"
      : null)
  );
}

interface BuildParams {
  raw: Record<string, unknown>;
  eventType: string;
  envelopeTimestamp: number | null;
  customer: Record<string, unknown> | null;
  product: Record<string, unknown> | null;
  productId: string | null;
  metadata: Record<string, unknown> | null;
  statusFallback: string | null;
  options: BuildOptions;
}

function buildSubscriptionEvent(
  params: BuildParams,
): ParsedWebhookEvent {
  const subscriptionId = stringAt(params.raw, "id");
  if (!subscriptionId) {
    return { kind: "ignored", reason: "missing_subscription_id" };
  }

  // Creem's expired event reports the previous status in `object`; the
  // entitlement meaning is "expired", so make it explicit.
  const status =
    params.eventType === "subscription.expired"
      ? "expired"
      : (stringAt(params.raw, "status") ?? params.statusFallback);
  if (!status) {
    return { kind: "ignored", reason: "missing_subscription_status" };
  }

  const timestamp =
    toUnixMillis(params.raw["updated_at"]) ??
    toUnixMillis(params.raw["created_at"]) ??
    params.envelopeTimestamp ??
    0;

  return {
    kind: "subscription",
    subscription: {
      subscriptionId,
      status,
      productId: params.productId,
      interval: inferInterval(
        params.productId,
        params.product,
        params.options,
      ),
      customerId: stringAt(params.customer, "id"),
      customerEmail: stringAt(params.customer, "email"),
      metadataUserId:
        stringAt(params.metadata, "user_id") ??
        stringAt(params.metadata, "userId"),
      currentPeriodEnd: toUnixSeconds(
        params.raw["current_period_end_date"] ??
          params.raw["current_period_end"],
      ),
      cancelAtPeriodEnd: status === "scheduled_cancel",
      eventTimestamp: timestamp,
    },
  };
}

/**
 * `refund.created` and `dispute.created` carry the subscription nested under
 * `object.subscription` (the transaction only repeats its id). Both revoke
 * entitlement immediately: status `revoked`, never entitled.
 *
 * Payload shape verified against https://docs.creem.io/code/webhooks:
 * object = { id, object, status, transaction: {...}, subscription: {id,
 * product, customer, current_period_end_date, updated_at, metadata?},
 * checkout?: {metadata?}, customer: {id, email}, created_at }.
 */
function parseRevocationEvent(
  eventType: string,
  object: Record<string, unknown>,
  envelopeTimestamp: number | null,
  options: BuildOptions,
): ParsedWebhookEvent {
  const subscription = recordAt(object, "subscription");
  if (!subscription) {
    return { kind: "ignored", reason: "revocation_without_subscription" };
  }
  const transaction = recordAt(object, "transaction");
  const subscriptionId =
    stringAt(subscription, "id") ??
    stringAt(transaction, "subscription");
  if (!subscriptionId) {
    return { kind: "ignored", reason: "missing_subscription_id" };
  }

  const checkout = recordAt(object, "checkout");
  const order = recordAt(object, "order");
  const customer = recordAt(object, "customer");
  const productId =
    stringAt(subscription, "product") ??
    stringAt(checkout, "product") ??
    stringAt(order, "product");

  const checkoutMetadata = recordAt(checkout, "metadata");
  const subscriptionMetadata = recordAt(subscription, "metadata");
  const metadata =
    checkoutMetadata || subscriptionMetadata
      ? {
          ...(checkoutMetadata ?? {}),
          ...(subscriptionMetadata ?? {}),
        }
      : null;

  return {
    kind: "subscription",
    subscription: {
      subscriptionId,
      status: "revoked",
      productId,
      interval: inferInterval(productId, null, options),
      customerId:
        stringAt(customer, "id") ??
        stringAt(transaction, "customer") ??
        stringAt(subscription, "customer"),
      customerEmail: stringAt(customer, "email"),
      metadataUserId:
        stringAt(metadata, "user_id") ??
        stringAt(metadata, "userId"),
      currentPeriodEnd: toUnixSeconds(
        subscription["current_period_end_date"] ??
          subscription["current_period_end"],
      ),
      cancelAtPeriodEnd: false,
      eventTimestamp:
        toUnixMillis(subscription["updated_at"]) ??
        toUnixMillis(object["created_at"]) ??
        envelopeTimestamp ??
        0,
    },
  };
}

/**
 * Turns a verified Creem webhook envelope into the state we persist.
 * Unknown event types are acknowledged and ignored.
 */
export function parseCreemWebhook(
  event: unknown,
  options: BuildOptions = {},
): ParsedWebhookEvent {
  if (!isRecord(event)) {
    return { kind: "ignored", reason: "invalid_envelope" };
  }
  const eventType =
    stringAt(event, "eventType") ??
    stringAt(event, "event_type") ??
    "";
  const object = recordAt(event, "object");
  if (!object) {
    return { kind: "ignored", reason: "missing_object" };
  }
  const envelopeTimestamp = toUnixMillis(event["created_at"]);

  if (eventType === "checkout.completed") {
    const subscription = recordAt(object, "subscription");
    if (!subscription) {
      return { kind: "ignored", reason: "checkout_without_subscription" };
    }
    const product =
      recordAt(subscription, "product") ?? recordAt(object, "product");
    const checkoutMetadata = recordAt(object, "metadata");
    const subscriptionMetadata = recordAt(subscription, "metadata");
    const metadata =
      checkoutMetadata || subscriptionMetadata
        ? {
            ...(checkoutMetadata ?? {}),
            ...(subscriptionMetadata ?? {}),
          }
        : null;
    return buildSubscriptionEvent({
      raw: subscription,
      eventType,
      envelopeTimestamp,
      customer:
        recordAt(subscription, "customer") ?? recordAt(object, "customer"),
      product,
      productId:
        stringAt(product, "id") ?? stringAt(subscription, "product"),
      metadata,
      statusFallback: "active",
      options,
    });
  }

  if (eventType === "refund.created" || eventType === "dispute.created") {
    return parseRevocationEvent(eventType, object, envelopeTimestamp, options);
  }

  if (eventType.startsWith("subscription.")) {
    const product = recordAt(object, "product");
    return buildSubscriptionEvent({
      raw: object,
      eventType,
      envelopeTimestamp,
      customer: recordAt(object, "customer"),
      product,
      productId: stringAt(product, "id"),
      metadata: recordAt(object, "metadata"),
      statusFallback: fallbackStatus(eventType),
      options,
    });
  }

  return { kind: "ignored", reason: `unhandled_event:${eventType}` };
}

/**
 * Out-of-order protection: only apply an event whose state timestamp is at
 * least as new as the stored one (`updated_at` is unix milliseconds).
 *
 * Equal timestamps are normally allowed because different event types for one
 * transition share an `updated_at`. Terminal statuses (revoked/expired/unpaid)
 * win ties so an `active` event can never overwrite a refund or dispute that
 * carries the same timestamp.
 */
export function shouldApplyUpdate(
  existingUpdatedAt: number | null | undefined,
  incomingUpdatedAt: number,
  existingStatus?: string | null,
  incomingStatus?: string | null,
): boolean {
  if (existingUpdatedAt === null || existingUpdatedAt === undefined) {
    return true;
  }
  if (incomingUpdatedAt > existingUpdatedAt) return true;
  if (incomingUpdatedAt < existingUpdatedAt) return false;
  return (
    terminalStatusRank(incomingStatus) >= terminalStatusRank(existingStatus)
  );
}
