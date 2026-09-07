import { prisma } from "./prisma";
import { todayInSchoolTimezone } from "./school-calendar";

/**
 * Fee structures are scoped to an academic year, but this MVP doesn't yet
 * have a dedicated Academic Year setup screen (P2 in the plan's roadmap —
 * only matters at year-end rollover). Rather than block Fee Structure setup
 * on that missing screen, lazily provision a single "current" academic year
 * per school the first time one is needed, spanning the calendar year the
 * request happens in. A future Settings screen can let admins rename/split
 * this without any data migration — it's just a normal AcademicYear row.
 */
export async function getOrCreateCurrentAcademicYear(schoolId: string) {
  const existing = await prisma.academicYear.findFirst({
    where: { schoolId, isCurrent: true },
  });
  if (existing) return existing;

  const year = todayInSchoolTimezone().getUTCFullYear();
  return prisma.academicYear.create({
    data: {
      schoolId,
      label: String(year),
      startDate: new Date(Date.UTC(year, 0, 1)),
      endDate: new Date(Date.UTC(year, 11, 31)),
      isCurrent: true,
    },
  });
}
