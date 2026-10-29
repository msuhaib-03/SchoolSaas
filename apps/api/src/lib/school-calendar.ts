import { prisma } from "./prisma";

/** Normalizes any Date/string to a UTC midnight Date matching how @db.Date columns compare. */
export function toDateOnly(input: string | Date): Date {
  const d = typeof input === "string" ? new Date(input) : input;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/**
 * There's no per-school timezone field yet, so Pakistan Standard Time
 * (UTC+5, no DST) is hardcoded as "the" school timezone — a documented
 * simplification, not an oversight. Every "what's today" / "what time is
 * it right now" computation in the backend must go through these two
 * helpers instead of reading the server's own UTC clock directly — a
 * server that reads `new Date().getUTCHours()` (or `getUTCFullYear()` /
 * `getUTCMonth()` / `getUTCDate()`) is answering "what's the UTC date/time
 * right now", not "what's the date/time in Pakistan right now", and the
 * two disagree for the first ~5 hours of every Pakistan calendar day
 * (roughly midnight-5am PKT is still the previous day in UTC).
 */
const PKT_OFFSET_MINUTES = 5 * 60;

function nowInPakistan(): Date {
  return new Date(Date.now() + PKT_OFFSET_MINUTES * 60_000);
}

/** "Today" as a UTC-midnight Date matching how @db.Date columns compare, but anchored to Pakistan's calendar day. */
export function todayInSchoolTimezone(): Date {
  const pk = nowInPakistan();
  return new Date(Date.UTC(pk.getUTCFullYear(), pk.getUTCMonth(), pk.getUTCDate()));
}

/** Minutes since midnight Pakistan time — for comparing against HH:MM comms-window strings. */
export function nowMinutesInSchoolTimezone(): number {
  const pk = nowInPakistan();
  return pk.getUTCHours() * 60 + pk.getUTCMinutes();
}

/**
 * The real UTC instant range covering "today" in Pakistan time — for
 * filtering genuine timestamp columns (e.g. Payment.paidAt, an actual
 * moment in time), NOT @db.Date columns. todayInSchoolTimezone() returns a
 * UTC-midnight-*labeled* Date meant only for @db.Date comparisons — using
 * that value directly as a timestamp boundary is wrong by exactly the PKT
 * offset: a payment at 00:50 AM Pakistan time is a real UTC instant of
 * 19:50 the previous day, which is *before* todayInSchoolTimezone()'s
 * "00:00 UTC today" label — so it would be silently excluded from "today"
 * for the first 5 hours of every Pakistan calendar day. This helper
 * subtracts the offset back out to get the real instant PKT midnight
 * actually falls at.
 */
export function todayRangeInSchoolTimezone(): { start: Date; end: Date } {
  const dateLabel = todayInSchoolTimezone();
  const start = new Date(dateLabel.getTime() - PKT_OFFSET_MINUTES * 60_000);
  const end = new Date(start.getTime() + 24 * 60 * 60_000);
  return { start, end };
}

/** Returns { isSchoolDay, reason } — the Mark Attendance screen shouldn't render a roster otherwise. */
export async function checkSchoolDay(
  schoolId: string,
  date: Date
): Promise<{ isSchoolDay: true } | { isSchoolDay: false; reason: string }> {
  const school = await prisma.school.findUnique({ where: { id: schoolId }, select: { weeklyOffDays: true } });
  const dayOfWeek = date.getUTCDay();

  if (school?.weeklyOffDays.includes(dayOfWeek)) {
    return { isSchoolDay: false, reason: "Weekly off day" };
  }

  const holiday = await prisma.schoolCalendarDay.findUnique({
    where: { schoolId_date: { schoolId, date } },
  });
  if (holiday) {
    return { isSchoolDay: false, reason: holiday.label ?? "Holiday" };
  }

  return { isSchoolDay: true };
}
