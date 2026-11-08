import {
  useCallback,
  useEffect,
  useSyncExternalStore,
  type AnchorHTMLAttributes,
  type MouseEvent,
} from "react";

export interface Location {
  pathname: string;
  search: string;
  hash: string;
}

type Listener = () => void;

const listeners = new Set<Listener>();

function readLocation(): Location {
  return {
    pathname: window.location.pathname,
    search: window.location.search,
    hash: window.location.hash,
  };
}

let current: Location = readLocation();

function emit() {
  for (const listener of listeners) listener();
}

function sync() {
  const next = readLocation();
  if (
    next.pathname === current.pathname &&
    next.search === current.search &&
    next.hash === current.hash
  ) {
    return;
  }
  current = next;
  emit();
}

// One listener for the whole app. Removing a shared callback per-hook would
// tear down routing for every still-mounted consumer of useLocation.
window.addEventListener("popstate", sync);
window.addEventListener("hashchange", sync);

function subscribe(listener: Listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot() {
  return current;
}

export function useLocation(): Location {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Client-side navigation. External URLs fall back to a normal page load. */
export function navigate(
  to: string,
  options: { replace?: boolean; state?: unknown } = {},
) {
  const url = new URL(to, window.location.href);
  if (url.origin !== window.location.origin) {
    window.location.assign(url.href);
    return;
  }
  if (
    url.pathname === window.location.pathname &&
    url.search === window.location.search &&
    url.hash === window.location.hash
  ) {
    // Same URL: still honor the intent (usually a logo click going home).
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (url.hash) {
      const id = decodeURIComponent(url.hash.slice(1));
      document
        .getElementById(id)
        ?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
    } else {
      window.scrollTo({
        top: 0,
        left: 0,
        behavior: reduce ? "auto" : "smooth",
      });
    }
    return;
  }
  window.history[options.replace ? "replaceState" : "pushState"](
    options.state ?? null,
    "",
    url,
  );
  current = readLocation();
  emit();
}

/** Clerk's router hooks. Clerk needs these to keep its own state in the URL. */
export function clerkRouterPush(to: string) {
  navigate(to);
}

export function clerkRouterReplace(to: string) {
  navigate(to, { replace: true });
}

export function useNavigate() {
  return useCallback(
    (to: string, options?: { replace?: boolean; state?: unknown }) =>
      navigate(to, options),
    [],
  );
}

type LinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
  to: string;
  replace?: boolean;
};

/**
 * An anchor that uses the history API for same-origin links. Modified clicks,
 * new-tab links, external origins, and in-page `#anchors` keep native behavior.
 */
export function Link({ to, replace, onClick, ...rest }: LinkProps) {
  function handleClick(event: MouseEvent<HTMLAnchorElement>) {
    onClick?.(event);
    if (event.defaultPrevented) return;
    if (event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (rest.target && rest.target !== "_self") return;
    if (to.startsWith("#")) return;
    const url = new URL(to, window.location.href);
    if (url.origin !== window.location.origin) return;
    event.preventDefault();
    navigate(to, { replace });
  }

  return <a href={to} {...rest} onClick={handleClick} />;
}

export function isPath(pathname: string, route: string) {
  const normalized =
    pathname.length > 1 && pathname.endsWith("/")
      ? pathname.slice(0, -1)
      : pathname;
  return normalized === route || normalized.startsWith(`${route}/`);
}

/** Scrolls to the top on route changes, or to the named anchor. */
let firstRoute = true;

export function useRouteScroll() {
  const location = useLocation();
  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const id = location.hash
      ? decodeURIComponent(location.hash.slice(1))
      : "";
    const smooth = !firstRoute && !reduce;
    firstRoute = false;

    if (!id) {
      window.scrollTo({ top: 0, left: 0, behavior: "auto" });
      return;
    }

    let cancelled = false;
    let frame = 0;

    const jump = (behavior: ScrollBehavior) => {
      if (cancelled) return;
      const target = document.getElementById(id);
      target?.scrollIntoView({ behavior, block: "start" });
    };

    // Land immediately (or smooth-scroll for a deliberate click), then land
    // again if webfonts are still loading. Font swap can reflow everything
    // above the target and leave the viewport short of the section.
    frame = requestAnimationFrame(() => jump(smooth ? "smooth" : "auto"));
    if (document.fonts?.status === "loading") {
      void document.fonts.ready.then(() => jump("auto"));
    }

    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, [location]);
}
