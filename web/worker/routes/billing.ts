/**
 * Creem checkout + customer portal. The API key never leaves the Worker and
 * the client only ever receives a redirect URL.
 */

import type { Hono } from "hono";
import type { AppContext, Env } from "../env";
import { requireEither } from "../auth";
import {
  claimPendingCheckoutStatement,
  listSubscriptions,
  releasePendingCheckoutStatement,
} from "../db";
import {
  entitledProductIds,
  resolveBillingIssue,
  resolvePlan,
} from "../lib/plan";
import { creemPost } from "../lib/creem";
import { rateLimitUser } from "../lib/rate-limit";
import { nowSeconds } from "../lib/weeks";
import { parseJsonObject, readBodyLimited } from "../http";

/**
 * How long a created checkout blocks another one. The subscription webhook
 * normally clears it within seconds; this only covers an abandoned checkout or
 * a delayed delivery, and expires so the user can try again.
 */
export const PENDING_CHECKOUT_TTL_SECONDS = 15 * 60;

function siteUrl(env: Env): string {
  return env.SITE_URL.trim().replace(/\/+$/u, "");
}

export function registerBillingRoutes(app: Hono<AppContext>): void {
  app.post(
    "/api/billing/checkout",
    requireEither,
    rateLimitUser("RATE_LIMIT_BILLING"),
    async (c) => {
      const body = await readBodyLimited(c, 1_024);
      const json = body.ok ? parseJsonObject(body.text) : null;
      const interval = json?.["interval"];
      if (interval !== "monthly" && interval !== "annual") {
        return c.json(
          {
            error: "invalid_interval",
            message: 'interval must be "monthly" or "annual".',
          },
          400,
        );
      }

      const user = c.get("user");
      const plan = resolvePlan(
        await listSubscriptions(c.env.DB, user.id),
        nowSeconds(),
        entitledProductIds(c.env),
      );
      if (plan.plan === "pro") {
        return c.json(
          {
            error: "already_subscribed",
            message: "You already have an active Pro subscription.",
          },
          409,
        );
      }
      const billingIssue = resolveBillingIssue(plan);
      if (billingIssue !== null) {
        // Decision 9: a payment issue is fixed in the portal, not by buying
        // another subscription.
        return c.json(
          {
            error: "billing_issue",
            message:
              "There is a payment issue on your account. Update your payment method to continue.",
          },
          409,
        );
      }

      const productId =
        interval === "monthly"
          ? c.env.CREEM_PRODUCT_PRO_MONTHLY
          : c.env.CREEM_PRODUCT_PRO_ANNUAL;
      if (!productId || productId.includes("REPLACE")) {
        return c.json(
          {
            error: "billing_not_configured",
            message: "Billing is not configured yet.",
          },
          500,
        );
      }

      // Record the in-flight checkout before Creem creates it. A delayed
      // subscription webhook then cannot let another tab or device start a
      // second subscription and charge the account twice.
      const claimedAt = nowSeconds();
      const claim = await claimPendingCheckoutStatement(
        c.env.DB,
        user.id,
        claimedAt,
        PENDING_CHECKOUT_TTL_SECONDS,
      ).run();
      if ((claim.meta.changes ?? 0) === 0) {
        return c.json(
          {
            error: "checkout_pending",
            message:
              "A checkout was already started for this account. Finish it, or try again in a few minutes.",
          },
          409,
        );
      }

      // The slot is cleared by the subscription webhook; this only handles a
      // Creem failure so the user can retry immediately.
      const releaseClaim = async (): Promise<void> => {
        try {
          await releasePendingCheckoutStatement(
            c.env.DB,
            user.id,
            claimedAt,
          ).run();
        } catch {
          // Best effort: the TTL releases the slot even if this fails.
        }
      };

      const payload: Record<string, unknown> = {
        product_id: productId,
        // One idempotency-ish key per attempt; retries by the user create a
        // new checkout session rather than reusing an expired one.
        request_id: crypto.randomUUID(),
        success_url: `${siteUrl(c.env)}/billing/success`,
        metadata: {
          user_id: user.id,
          interval,
        },
      };
      if (user.email) {
        payload["customer"] = { email: user.email };
      }

      const result = await creemPost(c.env, "/checkouts", payload);
      if (!result.ok) {
        await releaseClaim();
        return c.json(
          { error: "billing_unavailable", message: result.message },
          502,
        );
      }
      const url = result.data["checkout_url"];
      if (typeof url !== "string" || url === "") {
        await releaseClaim();
        return c.json(
          {
            error: "billing_unavailable",
            message: "Billing returned an invalid response.",
          },
          502,
        );
      }
      return c.json({ url });
    },
  );

  app.post(
    "/api/billing/portal",
    requireEither,
    rateLimitUser("RATE_LIMIT_BILLING"),
    async (c) => {
      const user = c.get("user");
      if (!user.creem_customer_id) {
        return c.json(
          {
            error: "no_billing_account",
            message: "No billing account yet. Start a subscription first.",
          },
          409,
        );
      }

      const result = await creemPost(c.env, "/customers/billing", {
        customer_id: user.creem_customer_id,
      });
      if (!result.ok) {
        return c.json(
          { error: "billing_unavailable", message: result.message },
          502,
        );
      }
      const url = result.data["customer_portal_link"];
      if (typeof url !== "string" || url === "") {
        return c.json(
          {
            error: "billing_unavailable",
            message: "Billing returned an invalid response.",
          },
          502,
        );
      }
      return c.json({ url });
    },
  );
}
