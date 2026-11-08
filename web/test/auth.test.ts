import { describe, expect, it } from "vitest";
import {
  authorizedParties,
  clerkIssuer,
  siteOrigin,
} from "../worker/auth";

function publishableKey(frontendApi: string, live = false): string {
  return `pk_${live ? "live" : "test"}_${btoa(`${frontendApi}$`).replace(/=+$/u, "")}`;
}

describe("siteOrigin (decision 12)", () => {
  it("returns the normalized origin for valid http(s) URLs", () => {
    expect(siteOrigin("https://ray.helionhq.com")).toBe(
      "https://ray.helionhq.com",
    );
    expect(siteOrigin("http://localhost:5173/some/path")).toBe(
      "http://localhost:5173",
    );
  });

  it("returns null for empty, malformed or non-http URLs", () => {
    expect(siteOrigin("")).toBeNull();
    expect(siteOrigin(undefined)).toBeNull();
    expect(siteOrigin(null)).toBeNull();
    expect(siteOrigin("not a url")).toBeNull();
    expect(siteOrigin("javascript:alert(1)")).toBeNull();
    expect(siteOrigin("ftp://example.com")).toBeNull();
  });
});

describe("authorizedParties (decision 12)", () => {
  it("fails closed with null, never an empty list, for invalid SITE_URL", () => {
    expect(authorizedParties("")).toBeNull();
    expect(authorizedParties(undefined)).toBeNull();
    expect(authorizedParties("nonsense")).toBeNull();
  });

  it("allows only the configured origin in production", () => {
    expect(authorizedParties("https://ray.helionhq.com")).toEqual([
      "https://ray.helionhq.com",
    ]);
  });

  it("adds loopback dev ports when SITE_URL is loopback", () => {
    const parties = authorizedParties("http://localhost:5173");
    expect(parties).not.toBeNull();
    expect(new Set(parties)).toEqual(
      new Set([
        "http://localhost:5173",
        "http://localhost:8787",
        "http://127.0.0.1:5173",
        "http://127.0.0.1:8787",
      ]),
    );
  });
});

describe("clerkIssuer", () => {
  it("derives the Frontend API issuer from a publishable key", () => {
    expect(clerkIssuer(publishableKey("clerk.example.com"))).toBe(
      "https://clerk.example.com",
    );
    expect(
      clerkIssuer(publishableKey("your-app.clerk.accounts.dev")),
    ).toBe("https://your-app.clerk.accounts.dev");
    expect(clerkIssuer(publishableKey("clerk.example.com", true))).toBe(
      "https://clerk.example.com",
    );
    // Some Clerk setups encode a full proxy URL in the key.
    expect(clerkIssuer(publishableKey("https://clerk.example.com"))).toBe(
      "https://clerk.example.com",
    );
  });

  it("returns null for placeholders and malformed keys", () => {
    expect(clerkIssuer("pk_test_placeholder")).toBeNull();
    expect(clerkIssuer("sk_test_secret")).toBeNull();
    expect(clerkIssuer("")).toBeNull();
    expect(clerkIssuer(undefined)).toBeNull();
    expect(clerkIssuer("pk_test_!!!not-base64!!!")).toBeNull();
    expect(clerkIssuer(`pk_test_${btoa("no-dollar-sign")}`)).toBeNull();
  });
});
