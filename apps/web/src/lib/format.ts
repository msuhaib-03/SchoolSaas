/**
 * "Today" as YYYY-MM-DD in the *browser's own* local timezone — NOT
 * `date.toISOString().slice(0, 10)`, which converts to UTC first and
 * silently returns yesterday's date for anyone west of UTC (or, for a
 * Pakistan UTC+5 user, would only bite between midnight and 5am — but the
 * bug is the same class of mistake and easy to reintroduce by habit).
 * Date's plain getters (getFullYear/getMonth/getDate) already read the
 * browser's local calendar day, so no UTC conversion belongs here at all.
 */
export function toLocalIsoDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function formatMoney(amount: number) {
  return new Intl.NumberFormat("en-PK", { style: "currency", currency: "PKR", maximumFractionDigits: 0 }).format(
    amount
  );
}

export function currentPeriod() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

export function formatPeriodLabel(period: string) {
  if (!/^\d{4}-\d{2}$/.test(period)) return period;
  const [year, month] = period.split("-").map(Number);
  return new Date(year, month - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

/** Compact "Jan '26" form for chart axis ticks, where the full label is too wide. */
export function formatPeriodShortLabel(period: string) {
  if (!/^\d{4}-\d{2}$/.test(period)) return period;
  const [year, month] = period.split("-").map(Number);
  const monthName = new Date(year, month - 1, 1).toLocaleDateString("en-US", { month: "short" });
  return `${monthName} '${String(year).slice(-2)}`;
}
