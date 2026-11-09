/**
 * Webhook ingestion.
 *
 * Creem (subscriptions, refunds, disputes):
 * - signature verified over the raw body with a constant-time compare; a
 *   missing secret fails closed (401);
 * - state changes and the idempotency marker are written in the SAME D1
 *   batch, with the marker last: a failure rolls the state back and a retry
 *   applies it (decision 8 / M4);
 * - out-of-order deliveries cannot overwrite newer state and terminal
 *   statuses win equal-timestamp ties;
 * - users are mapped by metadata.user_id, then creem_customer_id only (never
 *   email); only the two configured products grant Pro.
 *
 * Clerk (optional): Svix-verified `user.deleted` cancels the user's renewing
 * Creem subscriptions (best effort), revokes every device, clears the user's
 * email/name/Creem customer id, and soft-deletes the user. Disabled (503)
 * when CLERK_WEBHOOK_SECRET is unset.
 *
 * Request bodies are never logged.
 */

import type { Hono } from "hono";
import type { AppContext, Env } from "../env";
import {
  clearPendingCheckoutStatement,
  deleteOldWebhookEvents,
  deleteUserAuthCodesStatement,
  findUserByCreemCustomerId,
  getSubscription,
  insertWebhookEventStatement,
  listSubscriptions,
  markUserDeletedStatement,
  revokeAllDevicesStatement,
  setCreemCustomerIdStatement,
  upsertSubscriptionStatement,
  upsertUserStatement,
} from "../db";
import {
  creemPost,
  parseCreemWebhook,
  verifyCreemSignature,
  type ParsedSubscriptionEvent,
} from "../lib/creem";
import { entitledProductIds } from "../lib/plan";
import { rateLimitIp } from "../lib/rate-limit";
import { svixHeadersFrom, verifySvixSignature } from "../lib/svix";
import { nowSeconds, SECONDS_PER_DAY } from "../lib/weeks";
import { parseJsonObject, readBodyLimited } from "../http";

const WEBHOOK_BODY_LIMIT_BYTES = 1_048_576;
const CLERK_WEBHOOK_BODY_LIMIT_BYTES = 256 * 1024;
const WEBHOOK_RETENTION_DAYS = 30;

/**
 * Statuses that will not renew or charge again. Every other stored status is
 * canceled immediately when the Clerk user is deleted, so the card cannot
 * keep being charged after the user loses portal access.
 */
const NON_RENEWING_SUBSCRIPTION_STATUSES = new Set([
  "canceled",
  "scheduled_cancel",
  "expired",
  "revoked",
]);

interface SubscriptionStatements {
  applied: boolean;
  ignored?: string;
  statements: D1PreparedStatement[];
  /** Index of the subscription upsert in `statements`; -1 when not applied. */
  subscriptionStatementIndex: number;
  /**
   * Set only when the event activates Pro (`active`/`trialing`): the user id
   * whose in-flight checkout this event proves completed. The claim is
   * released only if the subscription upsert also changed a row, so a late
   * event for an old subscription cannot release a newer claim.
   */
  checkoutCompletedFor: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Resolves the user and builds the state statements for a subscription
 * snapshot. Product gating happens here: a subscription for any product other
 * than the two configured Pro products is never stored as entitled.
 */
async function subscriptionStatements(
  env: Env,
  event: ParsedSubscriptionEvent,
): Promise<SubscriptionStatements> {
  let productId = event.productId;
  if (productId === null) {
    // Some lifecycle events repeat only the subscription id; trust the product
    // already stored for that subscription.
    const existing = await getSubscription(env.DB, event.subscriptionId);
    productId = existing?.product_id ?? null;
  }
  if (
    productId === null ||
    !entitledProductIds(env).includes(productId)
  ) {
    return {
      applied: false,
      ignored: "product_not_allowed",
      statements: [],
      subscriptionStatementIndex: -1,
      checkoutCompletedFor: null,
    };
  }

  let userId: string | null = null;
  let createUser = false;
  if (event.metadataUserId) {
    userId = event.metadataUserId;
    createUser = true;
  } else if (event.customerId) {
    const existing = await findUserByCreemCustomerId(
      env.DB,
      event.customerId,
    );
    userId = existing?.id ?? null;
  }
  if (userId === null) {
    return {
      applied: false,
      ignored: "user_not_found",
      statements: [],
      subscriptionStatementIndex: -1,
      checkoutCompletedFor: null,
    };
  }

  const statements: D1PreparedStatement[] = [];
  if (createUser) {
    statements.push(
      upsertUserStatement(env.DB, {
        id: userId,
        email: event.customerEmail,
        name: null,
        createdAt: nowSeconds(),
      }),
    );
  }
  if (event.customerId) {
    statements.push(
      setCreemCustomerIdStatement(env.DB, userId, event.customerId),
    );
  }
  const subscriptionStatementIndex = statements.length;
  statements.push(
    upsertSubscriptionStatement(env.DB, {
      id: event.subscriptionId,
      user_id: userId,
      product_id: productId,
      interval: event.interval,
      status: event.status,
      current_period_end: event.currentPeriodEnd,
      cancel_at_period_end: event.cancelAtPeriodEnd ? 1 : 0,
      updated_at: event.eventTimestamp,
    }),
  );
  // Only an active/trialing subscription proves a checkout completed. A
  // canceled/expired event for an old subscription, delivered late, must not
  // release a newer in-flight checkout claim.
  const activatesPro =
    event.status === "active" || event.status === "trialing";
  return {
    applied: true,
    statements,
    subscriptionStatementIndex,
    checkoutCompletedFor: activatesPro ? userId : null,
  };
}

export function registerWebhookRoutes(app: Hono<AppContext>): void {
  app.post(
    "/api/webhooks/creem",
    rateLimitIp("RATE_LIMIT_WEBHOOKS"),
    async (c) => {
      const secret = c.env.CREEM_WEBHOOK_SECRET;
      if (!secret || secret.trim() === "") {
        // Decision 8 / M8: fail closed rather than accepting unverified
        // events when the deployment forgot the secret.
        return c.json(
          {
            error: "unauthorized",
            message: "Webhook verification is not configured.",
          },
          401,
        );
      }

      const body = await readBodyLimited(c, WEBHOOK_BODY_LIMIT_BYTES);
      if (!body.ok) {
        return c.json(
          {
            error: "payload_too_large",
            message: "Webhook body is too large.",
          },
          413,
        );
      }

      const signature = c.req.header("creem-signature");
      const valid = await verifyCreemSignature(
        body.text,
        signature,
        secret,
      );
      if (!valid) {
        return c.json(
          { error: "unauthorized", message: "Invalid webhook signature." },
          401,
        );
      }

      const event = parseJsonObject(body.text);
      if (!event) {
        return c.json(
          { error: "invalid_payload", message: "Expected a JSON object." },
          400,
        );
      }
      const eventId = event["id"];
      if (typeof eventId !== "string" || eventId === "") {
        return c.json(
          { error: "invalid_payload", message: "Missing event id." },
          400,
        );
      }

      let applied = false;
      let ignored: string | undefined;
      let statements: D1PreparedStatement[] = [];
      let subscriptionStatementIndex = -1;
      let checkoutCompletedFor: string | null = null;
      try {
        const parsed = parseCreemWebhook(event, {
          monthlyProductId: c.env.CREEM_PRODUCT_PRO_MONTHLY,
          annualProductId: c.env.CREEM_PRODUCT_PRO_ANNUAL,
        });
        if (parsed.kind === "subscription") {
          const result = await subscriptionStatements(
            c.env,
            parsed.subscription,
          );
          applied = result.applied;
          ignored = result.ignored;
          statements = result.statements;
          subscriptionStatementIndex = result.subscriptionStatementIndex;
          checkoutCompletedFor = result.checkoutCompletedFor;
        } else {
          ignored = parsed.reason;
        }
      } catch {
        console.error("creem webhook processing failed");
        return c.json(
          {
            error: "webhook_failed",
            message: "Could not process the event.",
          },
          500,
        );
      }

      const now = nowSeconds();
      let duplicate = false;
      let subscriptionChanged = false;
      try {
        // State first, idempotency marker last, in one transaction. If the
        // batch fails, neither the state nor the marker is written, so
        // Creem's retry applies normally (M4).
        const results = await c.env.DB.batch([
          ...statements,
          insertWebhookEventStatement(c.env.DB, eventId, now),
        ]);
        const marker = results[results.length - 1];
        duplicate = (marker?.meta.changes ?? 0) === 0;
        // The subscription upsert is a no-op when the stored row is newer, so
        // `meta.changes` is the proof that this event really changed state.
        subscriptionChanged =
          subscriptionStatementIndex >= 0 &&
          (results[subscriptionStatementIndex]?.meta.changes ?? 0) > 0;
      } catch {
        console.error("creem webhook batch failed");
        return c.json(
          {
            error: "webhook_failed",
            message: "Could not process the event.",
          },
          500,
        );
      }

      if (duplicate) {
        return c.json({ received: true, duplicate: true });
      }

      // The slot is released only when this event was newly applied (the
      // marker above proves it was not a duplicate), it activates Pro, and
      // the subscription upsert actually changed the stored row. A late
      // activation for a subscription the store already superseded must not
      // reopen the double-checkout window this claim exists to close.
      if (checkoutCompletedFor !== null && subscriptionChanged) {
        try {
          await clearPendingCheckoutStatement(
            c.env.DB,
            checkoutCompletedFor,
          ).run();
        } catch {
          // The 15-minute TTL releases the claim; the event was applied.
        }
      }

      try {
        await deleteOldWebhookEvents(
          c.env.DB,
          now - WEBHOOK_RETENTION_DAYS * SECONDS_PER_DAY,
        );
      } catch {
        // Retention cleanup must not fail a webhook that was already applied.
      }

      return c.json({
        received: true,
        applied,
        ...(ignored === undefined ? {} : { ignored }),
      });
    },
  );

  app.post(
    "/api/webhooks/clerk",
    rateLimitIp("RATE_LIMIT_WEBHOOKS"),
    async (c) => {
      const secret = c.env.CLERK_WEBHOOK_SECRET;
      if (!secret || secret.trim() === "") {
        return c.json(
          {
            error: "not_configured",
            message: "Clerk webhooks are not configured.",
          },
          503,
        );
      }

      const body = await readBodyLimited(
        c,
        CLERK_WEBHOOK_BODY_LIMIT_BYTES,
      );
      if (!body.ok) {
        return c.json(
          {
            error: "payload_too_large",
            message: "Webhook body is too large.",
          },
          413,
        );
      }

      const headers = svixHeadersFrom(c.req.raw.headers);
      if (!(await verifySvixSignature(body.text, headers, secret))) {
        return c.json(
          { error: "unauthorized", message: "Invalid webhook signature." },
          401,
        );
      }

      const event = parseJsonObject(body.text);
      if (!event) {
        return c.json(
          { error: "invalid_payload", message: "Expected a JSON object." },
          400,
        );
      }

      const eventType = event["type"];
      if (eventType !== "user.deleted") {
        return c.json({
          received: true,
          ignored:
            typeof eventType === "string"
              ? `unhandled_event:${eventType}`
              : "missing_event_type",
        });
      }

      const data = event["data"];
      const userId = isRecord(data) ? data["id"] : null;
      if (typeof userId !== "string" || userId === "") {
        return c.json(
          { error: "invalid_payload", message: "Missing user id." },
          400,
        );
      }

      const now = nowSeconds();

      // Best effort before access is revoked: once the user is soft-deleted
      // they can no longer sign in to reach the Creem portal, so a renewing
      // subscription would keep charging a card they cannot manage. Creem's
      // cancel endpoint is POST /v1/subscriptions/{id}/cancel; `immediate`
      // stops the next renewal.
      try {
        const subscriptions = await listSubscriptions(c.env.DB, userId);
        await Promise.all(
          subscriptions
            .filter(
              (subscription) =>
                !NON_RENEWING_SUBSCRIPTION_STATUSES.has(subscription.status),
            )
            .map(async (subscription) => {
              const result = await creemPost(
                c.env,
                `/subscriptions/${encodeURIComponent(subscription.id)}/cancel`,
                { mode: "immediate" },
              );
              if (!result.ok) {
                // No user or subscription id in logs; find it by customer in
                // Creem if manual follow-up is needed.
                console.error(
                  "failed to cancel a deleted user's subscription",
                );
              }
            }),
        );
      } catch {
        // Deletion must still proceed; a missed cancellation is logged for
        // manual follow-up.
        console.error("failed to cancel a deleted user's subscriptions");
      }

      const markerId = `clerk:${headers.id ?? crypto.randomUUID()}`;
      const results = await c.env.DB.batch([
        revokeAllDevicesStatement(c.env.DB, userId, now),
        deleteUserAuthCodesStatement(c.env.DB, userId),
        markUserDeletedStatement(c.env.DB, userId, now),
        insertWebhookEventStatement(c.env.DB, markerId, now),
      ]);
      const marker = results[results.length - 1];
      return c.json({
        received: true,
        duplicate: (marker?.meta.changes ?? 0) === 0,
      });
    },
  );
}
