import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { AppError } from "@/lib/app-error";
import { getTeacherSectionIds } from "@/lib/teacher-scope";
import { checkSchoolDay, toDateOnly, todayInSchoolTimezone } from "@/lib/school-calendar";
import { ensureDefaultAbsenceTemplate, resolveTemplate } from "@/lib/notification-template";
import { assertCanSendNow } from "@/lib/notification-rules";
import {
  AddHolidayInput,
  CorrectAttendanceInput,
  MarkAttendanceInput,
  RegisterQuery,
  RosterQuery,
  WeeklyOffDaysInput,
} from "./attendance.validation";

function todayDateOnly(): Date {
  return todayInSchoolTimezone();
}

async function assertClassSectionBelongToSchool(schoolId: string, classId: string, sectionId: string) {
  const section = await prisma.section.findFirst({ where: { id: sectionId, classId }, include: { class: true } });
  if (!section || section.class.schoolId !== schoolId) {
    throw AppError.badRequest("Selected class/section is invalid for this school");
  }
  return section;
}

function assertTeacherCanAccessSection(role: string, sectionId: string, teacherSectionIds: string[]) {
  if (role === "TEACHER" && !teacherSectionIds.includes(sectionId)) {
    throw AppError.forbidden("You can only manage attendance for your assigned class/section");
  }
}

// ---------- Roster ----------

export async function getRoster(schoolId: string, role: string, userId: string, query: RosterQuery) {
  await assertClassSectionBelongToSchool(schoolId, query.classId, query.sectionId);

  if (role === "TEACHER") {
    const sectionIds = await getTeacherSectionIds(userId);
    assertTeacherCanAccessSection(role, query.sectionId, sectionIds);
  }

  const date = query.date ? toDateOnly(query.date) : todayDateOnly();

  if (role === "TEACHER" && date.getTime() !== todayDateOnly().getTime()) {
    throw AppError.forbidden("Teachers can only mark attendance for today");
  }

  const dayCheck = await checkSchoolDay(schoolId, date);
  if (!dayCheck.isSchoolDay) {
    return { isSchoolDay: false as const, reason: dayCheck.reason, date: query.date ?? isoDate(date) };
  }

  const students = await prisma.student.findMany({
    where: { schoolId, classId: query.classId, sectionId: query.sectionId, status: "ACTIVE" },
    orderBy: { fullName: "asc" },
  });

  if (students.length === 0) {
    return { isSchoolDay: true as const, date: isoDate(date), alreadySubmitted: false, students: [] };
  }

  const records = await prisma.attendanceRecord.findMany({
    where: { schoolId, date, studentId: { in: students.map((s) => s.id) } },
    include: {
      notificationJobs: {
        orderBy: { scheduledFor: "desc" },
        take: 1,
        include: { deliveries: { orderBy: { updatedAt: "desc" }, take: 1 } },
      },
    },
  });
  const recordByStudent = new Map(records.map((r) => [r.studentId, r]));

  return {
    isSchoolDay: true as const,
    date: isoDate(date),
    alreadySubmitted: records.length > 0,
    students: students.map((s) => {
      const record = recordByStudent.get(s.id);
      const delivery = record?.notificationJobs[0]?.deliveries[0];
      return {
        id: s.id,
        fullName: s.fullName,
        rollNumber: s.rollNumber,
        status: record?.status ?? "PRESENT",
        attendanceRecordId: record?.id ?? null,
        notification: delivery ? { status: delivery.status, sentAt: delivery.updatedAt } : null,
      };
    }),
  };
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ---------- Mark / correct ----------

export async function markAttendance(
  schoolId: string,
  userId: string,
  role: string,
  input: MarkAttendanceInput
) {
  await assertClassSectionBelongToSchool(schoolId, input.classId, input.sectionId);

  if (role === "TEACHER") {
    const sectionIds = await getTeacherSectionIds(userId);
    assertTeacherCanAccessSection(role, input.sectionId, sectionIds);
  }

  const date = toDateOnly(input.date);

  if (role === "TEACHER" && date.getTime() !== todayDateOnly().getTime()) {
    throw AppError.forbidden("Teachers can only mark attendance for today");
  }

  const dayCheck = await checkSchoolDay(schoolId, date);
  if (!dayCheck.isSchoolDay) {
    throw AppError.badRequest(`Cannot mark attendance on a non-school day (${dayCheck.reason})`);
  }

  const validStudents = await prisma.student.findMany({
    where: {
      schoolId,
      classId: input.classId,
      sectionId: input.sectionId,
      status: "ACTIVE",
      id: { in: input.records.map((r) => r.studentId) },
    },
    select: { id: true },
  });
  const validIds = new Set(validStudents.map((s) => s.id));
  const rows = input.records.filter((r) => validIds.has(r.studentId));

  if (rows.length === 0) {
    throw AppError.badRequest("No valid students to mark in this class/section");
  }

  const existing = await prisma.attendanceRecord.findMany({
    where: { schoolId, date, studentId: { in: rows.map((r) => r.studentId) } },
    select: { studentId: true },
  });
  const alreadyMarked = new Set(existing.map((e) => e.studentId));

  const results = await Promise.all(
    rows.map((row) =>
      prisma.attendanceRecord.upsert({
        where: { studentId_date: { studentId: row.studentId, date } },
        create: {
          schoolId,
          studentId: row.studentId,
          classId: input.classId,
          sectionId: input.sectionId,
          date,
          status: row.status,
          markedBy: userId,
        },
        update: {
          status: row.status,
          markedBy: userId,
          correctedAt: alreadyMarked.has(row.studentId) ? new Date() : undefined,
        },
      })
    )
  );

  return { date: isoDate(date), marked: results.length };
}

export async function correctAttendanceRecord(
  schoolId: string,
  userId: string,
  role: string,
  id: string,
  input: CorrectAttendanceInput
) {
  const record = await prisma.attendanceRecord.findFirst({ where: { id, schoolId } });
  if (!record) throw AppError.notFound("Attendance record not found");

  if (role === "TEACHER") {
    const sectionIds = await getTeacherSectionIds(userId);
    assertTeacherCanAccessSection(role, record.sectionId, sectionIds);
    if (record.date.getTime() !== todayDateOnly().getTime()) {
      throw AppError.forbidden("Teachers can only correct today's attendance");
    }
  }

  return prisma.attendanceRecord.update({
    where: { id },
    data: { status: input.status, markedBy: userId, correctedAt: new Date() },
  });
}

// ---------- Register ----------

export async function getRegister(schoolId: string, role: string, userId: string, query: RegisterQuery) {
  let classId = query.classId;
  let sectionId = query.sectionId;

  if (role === "TEACHER") {
    const sectionIds = await getTeacherSectionIds(userId);
    if (sectionId) {
      assertTeacherCanAccessSection(role, sectionId, sectionIds);
    } else if (sectionIds.length === 1) {
      sectionId = sectionIds[0];
    } else if (sectionIds.length === 0) {
      return { dates: [], students: [] };
    }
  }

  const from = toDateOnly(query.from);
  const to = toDateOnly(query.to);
  if (from > to) throw AppError.badRequest("'from' must be before 'to'");

  const students = await prisma.student.findMany({
    where: {
      schoolId,
      status: "ACTIVE",
      ...(classId ? { classId } : {}),
      ...(sectionId ? { sectionId } : {}),
      ...(role === "TEACHER" && !sectionId
        ? { sectionId: { in: await getTeacherSectionIds(userId) } }
        : {}),
    },
    orderBy: [{ class: { orderIndex: "asc" } }, { fullName: "asc" }],
    select: { id: true, fullName: true, rollNumber: true, class: { select: { name: true } } },
  });

  if (students.length === 0) return { dates: [], students: [] };

  const records = await prisma.attendanceRecord.findMany({
    where: { schoolId, date: { gte: from, lte: to }, studentId: { in: students.map((s) => s.id) } },
    select: { studentId: true, date: true, status: true },
  });

  const school = await prisma.school.findUnique({ where: { id: schoolId }, select: { weeklyOffDays: true } });
  const holidays = await prisma.schoolCalendarDay.findMany({
    where: { schoolId, date: { gte: from, lte: to } },
    select: { date: true },
  });
  const holidaySet = new Set(holidays.map((h) => isoDate(h.date)));

  const dates: string[] = [];
  for (let d = new Date(from); d <= to; d.setUTCDate(d.getUTCDate() + 1)) {
    const iso = isoDate(d);
    const isWeeklyOff = school?.weeklyOffDays.includes(d.getUTCDay());
    if (!isWeeklyOff && !holidaySet.has(iso)) dates.push(iso);
  }

  const byStudent = new Map<string, Record<string, string>>();
  for (const rec of records) {
    const key = rec.studentId;
    const map = byStudent.get(key) ?? {};
    map[isoDate(rec.date)] = rec.status;
    byStudent.set(key, map);
  }

  return {
    dates,
    students: students.map((s) => ({
      id: s.id,
      fullName: s.fullName,
      rollNumber: s.rollNumber,
      className: s.class.name,
      records: byStudent.get(s.id) ?? {},
    })),
  };
}

export async function getStudentAttendanceHistory(
  schoolId: string,
  role: string,
  userId: string,
  studentId: string
) {
  const student = await prisma.student.findFirst({ where: { id: studentId, schoolId } });
  if (!student) throw AppError.notFound("Student not found");

  if (role === "TEACHER") {
    const sectionIds = await getTeacherSectionIds(userId);
    assertTeacherCanAccessSection(role, student.sectionId, sectionIds);
  }

  const records = await prisma.attendanceRecord.findMany({
    where: { schoolId, studentId },
    orderBy: { date: "desc" },
    take: 60,
    include: {
      notificationJobs: {
        orderBy: { scheduledFor: "desc" },
        take: 1,
        include: { deliveries: { orderBy: { updatedAt: "desc" }, take: 1 } },
      },
    },
  });

  return records.map((r) => {
    const delivery = r.notificationJobs[0]?.deliveries[0];
    return {
      id: r.id,
      date: isoDate(r.date),
      status: r.status,
      correctedAt: r.correctedAt,
      notification: delivery ? { status: delivery.status, sentAt: delivery.updatedAt } : null,
    };
  });
}

// ---------- Calendar ----------

export async function getCalendar(schoolId: string) {
  const [school, holidays] = await Promise.all([
    prisma.school.findUnique({ where: { id: schoolId }, select: { weeklyOffDays: true } }),
    prisma.schoolCalendarDay.findMany({ where: { schoolId }, orderBy: { date: "asc" } }),
  ]);
  return { weeklyOffDays: school?.weeklyOffDays ?? [], holidays };
}

export async function addHoliday(schoolId: string, input: AddHolidayInput) {
  const date = toDateOnly(input.date);
  try {
    return await prisma.schoolCalendarDay.create({
      data: { schoolId, date, type: "HOLIDAY", label: input.label },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw AppError.conflict("A calendar entry already exists for this date");
    }
    throw err;
  }
}

export async function removeHoliday(schoolId: string, id: string) {
  const existing = await prisma.schoolCalendarDay.findFirst({ where: { id, schoolId } });
  if (!existing) throw AppError.notFound("Calendar entry not found");
  await prisma.schoolCalendarDay.delete({ where: { id } });
}

export async function setWeeklyOffDays(schoolId: string, input: WeeklyOffDaysInput) {
  return prisma.school.update({
    where: { id: schoolId },
    data: { weeklyOffDays: input.days },
    select: { weeklyOffDays: true },
  });
}

// ---------- Manual notification (no automatic sending — user-triggered only) ----------

export async function sendAbsenceNotification(schoolId: string, userId: string, attendanceRecordId: string) {
  const record = await prisma.attendanceRecord.findFirst({
    where: { id: attendanceRecordId, schoolId },
    include: {
      student: {
        include: {
          class: true,
          section: true,
          guardians: { include: { guardian: true } },
        },
      },
    },
  });
  if (!record) throw AppError.notFound("Attendance record not found");
  if (record.status !== "ABSENT") {
    throw AppError.badRequest("This student is not marked absent for this date");
  }

  const primaryGuardianLink =
    record.student.guardians.find((g) => g.isPrimary) ?? record.student.guardians[0];
  if (!primaryGuardianLink) {
    throw AppError.badRequest("This student has no guardian on file to notify");
  }
  if (!primaryGuardianLink.guardian.whatsappOptIn) {
    throw AppError.badRequest("This guardian has opted out of WhatsApp notifications");
  }
  await assertCanSendNow(schoolId, "ABSENCE");

  const template = await ensureDefaultAbsenceTemplate(schoolId);
  const messageText = resolveTemplate(template.bodyText, {
    parent_name: primaryGuardianLink.guardian.fullName,
    student_name: record.student.fullName,
    class: record.student.class.name,
    section: record.student.section.name,
    date: isoDate(record.date),
  });

  const { job, delivery } = await prisma.$transaction(async (tx) => {
    const job = await tx.notificationJob.create({
      data: {
        schoolId,
        studentId: record.studentId,
        triggerType: "ABSENCE",
        templateId: template.id,
        scheduledFor: new Date(),
        status: "SENT",
        attempts: 1,
        createdBy: userId,
        attendanceRecordId: record.id,
      },
    });
    // No real WhatsApp/BSP provider is connected yet (that's Phase 5
    // infrastructure) — this simulates a successful send so the audit
    // trail (NotificationJob + MessageDelivery) is real and ready for a
    // real provider.send() call to slot in later without a data model
    // change, matching the demo pattern the plan itself describes.
    const delivery = await tx.messageDelivery.create({
      data: {
        notificationJobId: job.id,
        recipientPhone: primaryGuardianLink.guardian.phoneE164,
        status: "SENT",
        providerMessageId: `simulated-${job.id}`,
      },
    });
    return { job, delivery };
  });

  return {
    jobId: job.id,
    deliveryId: delivery.id,
    status: delivery.status,
    sentAt: delivery.updatedAt,
    recipientPhone: delivery.recipientPhone,
    messageText,
  };
}
