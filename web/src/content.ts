/**
 * Every price, limit, and public URL shown on the site comes from here.
 * Change a plan once and the landing page, pricing cards, account page, and
 * FAQ stay in step.
 */

export type BillingInterval = "monthly" | "annual";

export const PLANS = {
  starter: {
    name: "Starter",
    price: 0,
    weeklyWords: 1000,
    resetDay: "Monday",
    resetTime: "00:00 UTC",
    blurb: "For trying Ray out.",
  },
  pro: {
    name: "Pro",
    blurb: "For people who would rather talk than type.",
    monthly: {
      interval: "monthly" as const,
      price: 8,
      period: "/month",
      billing: "Billed monthly",
      total: 8,
    },
    annual: {
      interval: "annual" as const,
      price: 6,
      period: "/month",
      billing: "Billed $72 yearly",
      total: 72,
      savings: "Save 25%",
    },
  },
} as const;

export const BILLING_INTERVALS: BillingInterval[] = ["monthly", "annual"];

/** Every reset sentence on the site uses this, always in UTC. */
export const RESET_LABEL = `${PLANS.starter.resetDay} ${PLANS.starter.resetTime}`;

export function proPrice(interval: BillingInterval) {
  return PLANS.pro[interval];
}

export const DOWNLOAD_URL = "https://github.com/helionhq/Ray/releases/latest";

/**
 * The public origin, used for canonical/OG URLs. It MUST match the Worker's
 * `SITE_URL` var in `wrangler.jsonc` (and `web/.dev.vars` locally): the
 * Worker derives Clerk's authorized parties from `SITE_URL`, so a mismatch
 * makes sign-in fail.
 */
export const SITE_ORIGIN = "https://ray.helionhq.com";
export const BILLING_SUCCESS_DEEPLINK = "ray://billing/success";
export const REPOSITORY_URL = "https://github.com/helionhq/Ray";
export const CONTACT_EMAIL = "privacy@helionhq.com";

/** App-wide, so the answer is written once. */
export const PRIVACY_LINE =
  "Audio and transcripts are never stored on our servers.";

export const NAV_LINKS = [
  { label: "How it works", href: "/#how-it-works" },
  { label: "Features", href: "/#features" },
  { label: "Pricing", href: "/#pricing" },
  { label: "FAQ", href: "/#faq" },
] as const;
