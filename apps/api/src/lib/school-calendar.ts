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
