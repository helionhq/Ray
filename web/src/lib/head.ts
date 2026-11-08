import { useEffect } from "react";
import { SITE_ORIGIN } from "../content";

export const DEFAULT_TITLE = "Ray — Fast, clean dictation for Windows";
export const DEFAULT_DESCRIPTION =
  "Press a shortcut, speak, and polished text appears wherever you're typing. Ray is fast, clean dictation for Windows 10 and 11.";

const DEFAULT_OG_IMAGE = "/og.png";

function absoluteUrl(path: string) {
  return new URL(path, `${SITE_ORIGIN.replace(/\/$/, "")}/`).href;
}

function setMetaAttribute(
  attribute: "name" | "property",
  key: string,
  content: string,
) {
  let element = document.head.querySelector<HTMLMetaElement>(
    `meta[${attribute}="${key}"]`,
  );
  if (!element) {
    element = document.createElement("meta");
    element.setAttribute(attribute, key);
    document.head.appendChild(element);
  }
  element.setAttribute("content", content);
}

function setCanonical(href: string) {
  let element = document.head.querySelector<HTMLLinkElement>(
    'link[rel="canonical"]',
  );
  if (!element) {
    element = document.createElement("link");
    element.setAttribute("rel", "canonical");
    document.head.appendChild(element);
  }
  element.setAttribute("href", href);
}

function setRobots(noindex: boolean) {
  const content = noindex ? "noindex, nofollow" : "index, follow";
  const existing = document.head.querySelector<HTMLMetaElement>(
    'meta[name="robots"]',
  );
  if (existing) {
    existing.setAttribute("content", content);
    return;
  }
  const element = document.createElement("meta");
  element.setAttribute("name", "robots");
  element.setAttribute("content", content);
  document.head.appendChild(element);
}

export interface PageMeta {
  /** Omit for the landing page's default title. */
  title?: string;
  description?: string;
  /** Route path used for canonical/OG URLs. Defaults to "/". */
  path?: string;
  noindex?: boolean;
}

/**
 * Keeps `<title>`, the description, canonical, Open Graph/Twitter tags, and
 * robots in sync with the client-side route. The static tags in `index.html`
 * are the landing-page defaults (and what a crawler that doesn't run JS sees).
 */
export function usePageMeta({
  title,
  description = DEFAULT_DESCRIPTION,
  path = "/",
  noindex = false,
}: PageMeta = {}) {
  useEffect(() => {
    const fullTitle = title ? `${title} — Ray` : DEFAULT_TITLE;
    const canonical = absoluteUrl(path);
    const image = absoluteUrl(DEFAULT_OG_IMAGE);

    document.title = fullTitle;
    setMetaAttribute("name", "description", description);
    setCanonical(canonical);

    setMetaAttribute("property", "og:type", "website");
    setMetaAttribute("property", "og:site_name", "Ray");
    setMetaAttribute("property", "og:url", canonical);
    setMetaAttribute("property", "og:title", fullTitle);
    setMetaAttribute("property", "og:description", description);
    setMetaAttribute("property", "og:image", image);

    setMetaAttribute("name", "twitter:card", "summary_large_image");
    setMetaAttribute("name", "twitter:title", fullTitle);
    setMetaAttribute("name", "twitter:description", description);
    setMetaAttribute("name", "twitter:image", image);

    setRobots(noindex);
  }, [title, description, path, noindex]);
}
