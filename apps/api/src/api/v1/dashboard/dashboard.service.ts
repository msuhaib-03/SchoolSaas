import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { toDateOnly, todayInSchoolTimezone } from "@/lib/school-calendar";
import { getTeacherSectionIds } from "@/lib/teacher-scope";
import {
  AdmissionsQuery,
  AlertsQuery,
  AttendanceByClassQuery,
  FeeTrendQuery,
  SummaryQuery,
  TodayCollectionsQuery,
} from "./dashboard.validation";

function currentPeriodLabel(): string {
  const now = todayInSchoolTimezone();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

function previousPeriodLabel(period: string): string {
  const [year, month] = period.split("-").map(Number);
  const d = new Date(Date.UTC(year, month - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** [start of month, start of next month) — a half-open range for "admitted during this period". */
function monthDateRange(period: string): { gte: Date; lt: Date } {
  const [year, month] = period.split("-").map(Number);
  return {
    gte: toDateOnly(`${period}-01`),
    lt: new Date(Date.UTC(year, month, 1)),
  };
}

function toMoney(value: Prisma.Decimal | number): number {
  return Number(value);
}

function todayDateOnly(): Date {
  return todayInSchoolTimezone();
}

function yesterdayDateOnly(): Date {
  const d = todayDateOnly();
  return new Date(d.getTime() - 86_400_000);
}

async function attendanceCountsForDate(where: Prisma.AttendanceRecordWhereInput, date: Date) {
  const records = await prisma.attendanceRecord.findMany({
    where: { ...where, date },
    select: { status: true },
  });
  const total = records.length;
  const present = records.filter((r) => r.status === "PRESENT" || r.status === "LATE").length;
  const absent = records.filter((r) => r.status === "ABSENT").length;
  return { total, present, absent, presentPercent: total > 0 ? Math.round((present / total) * 1000) / 10 : null };
}

async function feeTotalsForPeriod(schoolId: string, period: string, classId?: string) {
  const invoices = await prisma.invoice.findMany({
    where: { schoolId, periodLabel: period, ...(classId ? { student: { classId } } : {}) },
    select: { amountDue: true, amountPaid: true },
  });
  let collected = 0;
  let outstanding = 0;
  for (const inv of invoices) {
    collected += toMoney(inv.amountPaid);
    outstanding += toMoney(inv.amountDue) - toMoney(inv.amountPaid);
  }
  return {
    collected: Math.round(collected * 100) / 100,
    outstanding: Math.round(outstanding * 100) / 100,
  };
}

// ---------- Summary (role-scoped) ----------

export async function getSummary(schoolId: string, role: string, userId: string, query: SummaryQuery) {
  const period = query.month ?? currentPeriodLabel();
  const previousPeriod = previousPeriodLabel(period);
  const isCurrentMonth = period === currentPeriodLabel();

  if (role === "TEACHER") {
    const sectionIds = await getTeacherSectionIds(userId);
    if (sectionIds.length === 0) {
      return { role, totalStudents: 0, presentToday: 0, absentToday: 0, presentTodayPercent: null };
    }
    const studentWhere: Prisma.StudentWhereInput = { schoolId, status: "ACTIVE", sectionId: { in: sectionIds } };
    const totalStudents = await prisma.student.count({ where: studentWhere });
    const todayCounts = await attendanceCountsForDate({ schoolId, student: studentWhere }, todayDateOnly());
    const yesterdayCounts = isCurrentMonth
      ? await attendanceCountsForDate({ schoolId, student: studentWhere }, yesterdayDateOnly())
      : null;

    return {
      role,
      totalStudents,
      presentToday: todayCounts.present,
      absentToday: todayCounts.absent,
      presentTodayPercent: todayCounts.presentPercent,
      absentYesterday: yesterdayCounts?.absent ?? null,
    };
  }

  const studentWhere: Prisma.StudentWhereInput = {
    schoolId,
    status: "ACTIVE",
    ...(query.classId ? { classId: query.classId } : {}),
  };

  const [totalStudents, newAdmissionsThisMonth, feeThisMonth, feeLastMonth] = await Promise.all([
    prisma.student.count({ where: studentWhere }),
    prisma.student.count({
      where: { ...studentWhere, admissionDate: monthDateRange(period) },
    }),
    feeTotalsForPeriod(schoolId, period, query.classId),
    feeTotalsForPeriod(schoolId, previousPeriod, query.classId),
  ]);

  if (role === "ACCOUNTANT") {
    return {
      role,
      totalStudents,
      newAdmissionsThisMonth,
      feeCollectedThisMonth: feeThisMonth.collected,
      feeCollectedLastMonth: feeLastMonth.collected,
      feeOutstandingThisMonth: feeThisMonth.outstanding,
      feeOutstandingLastMonth: feeLastMonth.outstanding,
    };
  }

  // SCHOOL_ADMIN / PRINCIPAL — the full dashboard.
  const [todayCounts, yesterdayCounts] = await Promise.all([
    attendanceCountsForDate({ schoolId, student: studentWhere }, todayDateOnly()),
    isCurrentMonth
      ? attendanceCountsForDate({ schoolId, student: studentWhere }, yesterdayDateOnly())
      : Promise.resolve(null),
  ]);

  return {
    role,
    totalStudents,
    newAdmissionsThisMonth,
    presentToday: todayCounts.present,
    absentToday: todayCounts.absent,
    presentTodayPercent: todayCounts.presentPercent,
    presentYesterdayPercent: yesterdayCounts?.presentPercent ?? null,
    absentYesterday: yesterdayCounts?.absent ?? null,
    feeCollectedThisMonth: feeThisMonth.collected,
    feeCollectedLastMonth: feeLastMonth.collected,
    feeOutstandingThisMonth: feeThisMonth.outstanding,
    feeOutstandingLastMonth: feeLastMonth.outstanding,
  };
}

// ---------- Class-wise attendance table (SCHOOL_ADMIN/PRINCIPAL only) ----------

export async function getAttendanceByClass(schoolId: string, query: AttendanceByClassQuery) {
  const period = query.month ?? currentPeriodLabel();
  const classes = await prisma.class.findMany({
    where: { schoolId, isArchived: false, ...(query.classId ? { id: query.classId } : {}) },
    orderBy: { orderIndex: "asc" },
    include: { students: { where: { status: "ACTIVE" }, select: { id: true } } },
  });

  const today = todayDateOnly();

  return Promise.all(
    classes.map(async (cls) => {
      const studentIds = cls.students.map((s) => s.id);
      if (studentIds.length === 0) {
        return { classId: cls.id, className: cls.name, total: 0, present: 0, absent: 0, late: 0, feePaid: 0, feeUnpaid: 0 };
      }

      const [records, paidInvoiceStudentIds] = await Promise.all([
        prisma.attendanceRecord.findMany({
          where: { schoolId, date: today, studentId: { in: studentIds } },
          select: { status: true },
        }),
        prisma.invoice.findMany({
          where: {
            schoolId,
            periodLabel: period,
            status: "PAID",
            studentId: { in: studentIds },
            feeCategory: { isRecurring: true },
          },
          select: { studentId: true },
          distinct: ["studentId"],
        }),
      ]);

      const present = records.filter((r) => r.status === "PRESENT").length;
      const absent = records.filter((r) => r.status === "ABSENT").length;
      const late = records.filter((r) => r.status === "LATE").length;
      const feePaid = paidInvoiceStudentIds.length;

      return {
        classId: cls.id,
        className: cls.name,
        total: studentIds.length,
        present,
        absent,
        late,
        feePaid,
        feeUnpaid: Math.max(0, studentIds.length - feePaid),
      };
    })
  );
}

// ---------- Fee trend (SCHOOL_ADMIN/PRINCIPAL/ACCOUNTANT) ----------

export async function getFeeTrend(schoolId: string, query: FeeTrendQuery) {
  const now = todayInSchoolTimezone();
  const periods: string[] = [];
  for (let i = query.months - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    periods.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }

  const results = await Promise.all(periods.map((p) => feeTotalsForPeriod(schoolId, p, query.classId)));
  return periods.map((period, i) => ({ period, ...results[i] }));
}

// ---------- Alerts (SCHOOL_ADMIN/PRINCIPAL only) ----------

export async function getAlerts(schoolId: string, query: AlertsQuery) {
  const alerts: { id: string; message: string; href: string }[] = [];
  const period = currentPeriodLabel();
  const monthStart = toDateOnly(`${period}-01`);
  const today = todayDateOnly();

  // 1. Students absent 3+ days this month with an unpaid balance.
  const studentWhere: Prisma.StudentWhereInput = {
    schoolId,
    status: "ACTIVE",
    ...(query.classId ? { classId: query.classId } : {}),
  };
  const students = await prisma.student.findMany({ where: studentWhere, select: { id: true } });
  const studentIds = students.map((s) => s.id);

  if (studentIds.length > 0) {
    const [absenceCounts, unpaidStudentIds] = await Promise.all([
      prisma.attendanceRecord.groupBy({
        by: ["studentId"],
        where: { schoolId, studentId: { in: studentIds }, date: { gte: monthStart }, status: "ABSENT" },
        _count: { _all: true },
        having: { studentId: { _count: { gte: 3 } } },
      }),
      prisma.invoice.findMany({
        where: { schoolId, studentId: { in: studentIds }, periodLabel: period, status: { not: "PAID" } },
        select: { studentId: true },
        distinct: ["studentId"],
      }),
    ]);
    const unpaidSet = new Set(unpaidStudentIds.map((i) => i.studentId));
    const atRiskCount = absenceCounts.filter((a) => unpaidSet.has(a.studentId)).length;
    if (atRiskCount > 0) {
      alerts.push({
        id: "absent-and-unpaid",
        message: `${atRiskCount} student(s) absent 3+ days this month with no payment on file`,
        href: "/fees/defaulters",
      });
    }
  }

  // 2. Any class with today's attendance below 70%.
  const classes = await prisma.class.findMany({
    where: { schoolId, isArchived: false, ...(query.classId ? { id: query.classId } : {}) },
    include: { students: { where: { status: "ACTIVE" }, select: { id: true } } },
  });
  for (const cls of classes) {
    const ids = cls.students.map((s) => s.id);
    if (ids.length === 0) continue;
    const counts = await attendanceCountsForDate({ schoolId, studentId: { in: ids } }, today);
    if (counts.total > 0 && counts.presentPercent !== null && counts.presentPercent < 70) {
      alerts.push({
        id: `low-attendance-${cls.id}`,
        message: `${cls.name} attendance is at ${counts.presentPercent}% today`,
        href: `/attendance/register?classId=${cls.id}`,
      });
    }
  }

  // 3. WhatsApp delivery failures today.
  const failedToday = await prisma.messageDelivery.count({
    where: { status: "FAILED", updatedAt: { gte: today } },
  });
  if (failedToday > 0) {
    alerts.push({
      id: "delivery-failures",
      message: `${failedToday} message(s) failed to send today`,
      href: "/communication/log",
    });
  }

  return alerts;
}

// ---------- New admissions (SCHOOL_ADMIN/PRINCIPAL only) ----------

export async function getAdmissions(schoolId: string, query: AdmissionsQuery) {
  const period = query.month ?? currentPeriodLabel();
  const students = await prisma.student.findMany({
    where: {
      schoolId,
      status: "ACTIVE",
      admissionDate: monthDateRange(period),
      ...(query.classId ? { classId: query.classId } : {}),
    },
    include: { class: { select: { name: true } }, section: { select: { name: true } } },
    orderBy: { admissionDate: "desc" },
  });

  return {
    count: students.length,
    students: students.map((s) => ({
      id: s.id,
      fullName: s.fullName,
      className: s.class.name,
      sectionName: s.section.name,
      admissionDate: s.admissionDate,
    })),
  };
}

// ---------- Class-wise student strength (SCHOOL_ADMIN/PRINCIPAL only) ----------

export async function getClassStrength(schoolId: string) {
  const classes = await prisma.class.findMany({
    where: { schoolId, isArchived: false },
    orderBy: { orderIndex: "asc" },
    include: { _count: { select: { students: { where: { status: "ACTIVE" } } } } },
  });

  return classes.map((c) => ({ classId: c.id, className: c.name, studentCount: c._count.students }));
}

// ---------- Today's fee collection (SCHOOL_ADMIN/PRINCIPAL/ACCOUNTANT) ----------

export async function getTodayCollections(schoolId: string, query: TodayCollectionsQuery) {
  const start = todayDateOnly();
  const end = new Date(start.getTime() + 86_400_000);

  const payments = await prisma.payment.findMany({
    where: {
      schoolId,
      paidAt: { gte: start, lt: end },
      ...(query.classId ? { invoice: { student: { classId: query.classId } } } : {}),
    },
    include: {
      invoice: {
        select: {
          studentId: true,
          feeCategory: { select: { name: true } },
          student: {
            select: {
              fullName: true,
              rollNumber: true,
              class: { select: { name: true } },
              section: { select: { name: true } },
            },
          },
        },
      },
      receivedByUser: { select: { name: true } },
    },
    orderBy: { paidAt: "desc" },
  });

  const totalCollected = payments.reduce((sum, p) => sum + toMoney(p.amount), 0);
  const studentIds = new Set(payments.map((p) => p.invoice.studentId));

  return {
    totalCollected: Math.round(totalCollected * 100) / 100,
    studentCount: studentIds.size,
    payments: payments.map((p) => ({
      id: p.id,
      studentId: p.invoice.studentId,
      studentName: p.invoice.student.fullName,
      rollNumber: p.invoice.student.rollNumber,
      className: p.invoice.student.class.name,
      sectionName: p.invoice.student.section.name,
      feeCategory: p.invoice.feeCategory.name,
      amount: toMoney(p.amount),
      method: p.method,
      paidAt: p.paidAt,
      receivedBy: p.receivedByUser.name,
    })),
  };
}
