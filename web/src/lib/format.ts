const number = new Intl.NumberFormat("en-US");

export function formatNumber(value: number) {
  return number.format(value);
}

export function formatDate(iso: string | null) {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    // Server timestamps are UTC; format them in UTC so a date never slips a
    // day for viewers west of Greenwich.
    timeZone: "UTC",
  });
}

/** e.g. "Monday, November 9 at 00:00 UTC" — always in UTC. */
export function formatResetAt(iso: string | null) {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
    timeZoneName: "short",
  });
}

export function initialsOf(name: string | null, email: string | null) {
  const source = (name ?? "").trim() || (email ?? "").trim();
  if (!source) return "R";
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  }
  return source.slice(0, 2).toUpperCase();
}
