/**
 * Creem webhook ingestion.
 *
 * Security and correctness requirements:
 * - signature verified over the raw body with a constant-time compare;
 * - idempotent per event id (`webhook_events`);
 * - out-of-order deliveries cannot overwrite newer subscription state;
 * - request bodies are never logged.
 */

import type { Hono } from "hono";
import type { AppContext, Env, UserRow } from "../env";
import {
  deleteOldWebhookEvents,
  deleteWebhookEvent,
  findUserByCreemCustomerId,
  findUserByEmail,
  recordWebhookEvent,
  setCreemCustomerId,
  upsertSubscriptionIfNewer,
  upsertUser,
} from "../db";
import {
  parseCreemWebhook,
  verifyCreemSignature,
  type ParsedSubscriptionEvent,
} from "../lib/creem";
import { nowSeconds, SECONDS_PER_DAY } from "../lib/weeks";
import { parseJsonObject, readBodyLimited } from "../http";

const WEBHOOK_BODY_LIMIT_BYTES = 1_048_576;
const WEBHOOK_RETENTION_DAYS = 30;

/**
 * Maps the event to a user (metadata.user_id first, then the stored Creem
 * customer id, then email) and applies the subscription snapshot.
 */
async function applySubscription(
  env: Env,
  event: ParsedSubscriptionEvent,
): Promise<boolean> {
  let user: UserRow | null = null;

  if (event.metadataUserId) {
    user = await upsertUser(env.DB, {
      id: event.metadataUserId,
      email: event.customerEmail,
      name: null,
      createdAt: nowSeconds(),
    });
  }
  if (!user && event.customerId) {
    user = await findUserByCreemCustomerId(env.DB, event.customerId);
  }
  if (!user && event.customerEmail) {
    user = await findUserByEmail(env.DB, event.customerEmail);
  }
  if (!user) return false;

  if (event.customerId) {
    await setCreemCustomerId(env.DB, user.id, event.customerId);
  }

  await upsertSubscriptionIfNewer(env.DB, {
    id: event.subscriptionId,
    user_id: user.id,
    product_id: event.productId,
    interval: event.interval,
    status: event.status,
    current_period_end: event.currentPeriodEnd,
    cancel_at_period_end: event.cancelAtPeriodEnd ? 1 : 0,
    updated_at: event.eventTimestamp,
  });
  return true;
}

export function registerWebhookRoutes(app: Hono<AppContext>): void {
  app.post("/api/webhooks/creem", async (c) => {
    const body = await readBodyLimited(c, WEBHOOK_BODY_LIMIT_BYTES);
    if (!body.ok) {
      return c.json(
        { error: "payload_too_large", message: "Webhook body is too large." },
        413,
      );
    }

    const signature = c.req.header("creem-signature");
    const valid = await verifyCreemSignature(
      body.text,
      signature,
      c.env.CREEM_WEBHOOK_SECRET,
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

    const now = nowSeconds();
    const firstDelivery = await recordWebhookEvent(c.env.DB, eventId, now);
    if (!firstDelivery) {
      return c.json({ received: true, duplicate: true });
    }

    try {
      const parsed = parseCreemWebhook(event, {
        monthlyProductId: c.env.CREEM_PRODUCT_PRO_MONTHLY,
        annualProductId: c.env.CREEM_PRODUCT_PRO_ANNUAL,
      });

      let applied = false;
      if (parsed.kind === "subscription") {
        applied = await applySubscription(c.env, parsed.subscription);
      }

      await deleteOldWebhookEvents(
        c.env.DB,
        now - WEBHOOK_RETENTION_DAYS * SECONDS_PER_DAY,
      );

      return c.json({
        received: true,
        applied,
        ...(parsed.kind === "ignored" ? { ignored: parsed.reason } : {}),
      });
    } catch {
      // Let Creem retry. Remove the idempotency marker so the retry is not
      // mistaken for a duplicate.
      try {
        await deleteWebhookEvent(c.env.DB, eventId);
      } catch {
        // Best effort; the original error is what matters.
      }
      console.error("creem webhook processing failed");
      return c.json(
        {
          error: "webhook_failed",
          message: "Could not process the event.",
        },
        500,
      );
    }
  });
}
