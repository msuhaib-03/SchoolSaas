import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { AppError } from "@/lib/app-error";
import { getTeacherSectionIds } from "@/lib/teacher-scope";
import { CreateStudentInput, GuardianInput, ListStudentsQuery, UpdateStudentInput } from "./students.validation";
import { RawImportRow, validateImportRows } from "./students.import";
import { generateOneTimeInvoicesForStudent } from "../fees/fees.service";

const studentInclude = {
  class: { select: { id: true, name: true } },
  section: { select: { id: true, name: true } },
  guardians: {
    include: { guardian: true },
  },
} satisfies Prisma.StudentInclude;

async function assertClassSectionBelongToSchool(schoolId: string, classId: string, sectionId: string) {
  const section = await prisma.section.findFirst({
    where: { id: sectionId, classId },
    include: { class: true },
  });

  if (!section || section.class.schoolId !== schoolId) {
    throw AppError.badRequest("Selected class/section is invalid for this school");
  }
  if (section.isArchived || section.class.isArchived) {
    throw AppError.badRequest("Cannot assign students to an archived class/section");
  }
  return section;
}

/** Guardians are deduped by phone within a school (siblings share a guardian record). */
async function findOrCreateGuardian(
  tx: Prisma.TransactionClient,
  schoolId: string,
  input: GuardianInput
) {
  const existing = await tx.guardian.findUnique({
    where: { schoolId_phoneE164: { schoolId, phoneE164: input.phoneE164 } },
  });
  if (existing) return existing;

  try {
    return await tx.guardian.create({
      data: {
        schoolId,
        fullName: input.fullName,
        relationship: input.relationship,
        phoneE164: input.phoneE164,
        whatsappOptIn: input.whatsappOptIn,
      },
    });
  } catch (err) {
    // Race: another concurrent request created the same phone number first.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const created = await tx.guardian.findUnique({
        where: { schoolId_phoneE164: { schoolId, phoneE164: input.phoneE164 } },
      });
      if (created) return created;
    }
    throw err;
  }
}

function assertTeacherCanAccessSection(role: string, sectionId: string, teacherSectionIds: string[]) {
  if (role === "TEACHER" && !teacherSectionIds.includes(sectionId)) {
    throw AppError.forbidden("You can only view students in your assigned class/section");
  }
}

export async function listStudents(
  schoolId: string,
  query: ListStudentsQuery,
  role: string,
  userId: string
) {
  const where: Prisma.StudentWhereInput = {
    schoolId,
    ...(query.classId ? { classId: query.classId } : {}),
    ...(query.sectionId ? { sectionId: query.sectionId } : {}),
    status: query.status ?? "ACTIVE",
    ...(query.q
      ? {
          OR: [
            { fullName: { contains: query.q, mode: "insensitive" } },
            { rollNumber: { contains: query.q, mode: "insensitive" } },
          ],
        }
      : {}),
  };

  if (role === "TEACHER") {
    const sectionIds = await getTeacherSectionIds(userId);
    where.sectionId = query.sectionId
      ? sectionIds.includes(query.sectionId)
        ? query.sectionId
        : "__none__"
      : { in: sectionIds.length ? sectionIds : ["__none__"] };
  }

  const [total, students] = await Promise.all([
    prisma.student.count({ where }),
    prisma.student.findMany({
      where,
      include: studentInclude,
      orderBy: [{ class: { orderIndex: "asc" } }, { fullName: "asc" }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
  ]);

  return { data: students, meta: { total, page: query.page, pageSize: query.pageSize } };
}

export async function getStudentById(schoolId: string, studentId: string, role: string, userId: string) {
  const student = await prisma.student.findFirst({
    where: { id: studentId, schoolId },
    include: studentInclude,
  });
  if (!student) throw AppError.notFound("Student not found");

  if (role === "TEACHER") {
    const sectionIds = await getTeacherSectionIds(userId);
    assertTeacherCanAccessSection(role, student.sectionId, sectionIds);
  }

  return student;
}

export async function createStudent(schoolId: string, input: CreateStudentInput) {
  await assertClassSectionBelongToSchool(schoolId, input.classId, input.sectionId);

  try {
    return await prisma.$transaction(async (tx) => {
      const guardians = await Promise.all(
        input.guardians.map((g) => findOrCreateGuardian(tx, schoolId, g))
      );

      const student = await tx.student.create({
        data: {
          schoolId,
          classId: input.classId,
          sectionId: input.sectionId,
          rollNumber: input.rollNumber,
          fullName: input.fullName,
          dob: input.dob,
          gender: input.gender,
          admissionDate: input.admissionDate ?? new Date(),
          guardians: {
            create: guardians.map((guardian, i) => ({
              guardianId: guardian.id,
              isPrimary: input.guardians[i].isPrimary,
            })),
          },
        },
        include: studentInclude,
      });

      await generateOneTimeInvoicesForStudent(
        tx,
        schoolId,
        student.id,
        student.classId,
        student.admissionDate
      );

      return student;
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw AppError.conflict(`Roll number "${input.rollNumber}" is already used in this class`);
    }
    throw err;
  }
}

export async function updateStudent(schoolId: string, studentId: string, input: UpdateStudentInput) {
  const existing = await prisma.student.findFirst({ where: { id: studentId, schoolId } });
  if (!existing) throw AppError.notFound("Student not found");

  const classId = input.classId ?? existing.classId;
  const sectionId = input.sectionId ?? existing.sectionId;
  if (input.classId || input.sectionId) {
    await assertClassSectionBelongToSchool(schoolId, classId, sectionId);
  }

  try {
    return await prisma.$transaction(async (tx) => {
      if (input.guardians) {
        const guardians = await Promise.all(
          input.guardians.map((g) => findOrCreateGuardian(tx, schoolId, g))
        );
        await tx.studentGuardian.deleteMany({ where: { studentId } });
        await tx.studentGuardian.createMany({
          data: guardians.map((guardian, i) => ({
            studentId,
            guardianId: guardian.id,
            isPrimary: input.guardians![i].isPrimary,
          })),
        });
      }

      return tx.student.update({
        where: { id: studentId },
        data: {
          rollNumber: input.rollNumber,
          fullName: input.fullName,
          dob: input.dob,
          gender: input.gender,
          classId: input.classId,
          sectionId: input.sectionId,
          status: input.status,
        },
        include: studentInclude,
      });
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw AppError.conflict(`Roll number "${input.rollNumber}" is already used in this class`);
    }
    throw err;
  }
}

export async function previewImport(schoolId: string, rows: RawImportRow[]) {
  const results = await validateImportRows(schoolId, rows);
  const validCount = results.filter((r) => r.errors.length === 0).length;
  return {
    rows: results,
    summary: { total: results.length, valid: validCount, invalid: results.length - validCount },
  };
}

/**
 * Re-validates every row from scratch (never trusts a client-supplied
 * "valid" flag from an earlier preview call) and creates only the
 * currently-valid rows, one at a time, so one bad row doesn't roll back
 * an otherwise-good batch. Returns a partial-success summary.
 */
export async function commitImport(schoolId: string, rows: RawImportRow[]) {
  const results = await validateImportRows(schoolId, rows);
  let created = 0;
  const failed: typeof results = [];

  for (const row of results) {
    if (row.errors.length > 0 || !row.resolved) {
      failed.push(row);
      continue;
    }

    try {
      await prisma.$transaction(async (tx) => {
        const guardian = await findOrCreateGuardian(tx, schoolId, {
          fullName: row.resolved!.guardian.fullName,
          relationship: row.resolved!.guardian.relationship,
          phoneE164: row.resolved!.guardian.phoneE164,
          whatsappOptIn: row.resolved!.guardian.whatsappOptIn,
          isPrimary: true,
        });

        const student = await tx.student.create({
          data: {
            schoolId,
            classId: row.resolved!.classId,
            sectionId: row.resolved!.sectionId,
            rollNumber: row.resolved!.rollNumber,
            fullName: row.resolved!.fullName,
            dob: row.resolved!.dob,
            gender: row.resolved!.gender,
            guardians: { create: { guardianId: guardian.id, isPrimary: true } },
          },
        });

        await generateOneTimeInvoicesForStudent(
          tx,
          schoolId,
          student.id,
          student.classId,
          student.admissionDate
        );
      });
      created += 1;
    } catch (err) {
      const message =
        err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002"
          ? `Roll number "${row.resolved.rollNumber}" was just taken by another row`
          : "Unexpected error creating this student";
      failed.push({ ...row, errors: [message] });
    }
  }

  return { created, failed, totalRows: results.length };
}

export async function deactivateStudent(schoolId: string, studentId: string) {
  const existing = await prisma.student.findFirst({ where: { id: studentId, schoolId } });
  if (!existing) throw AppError.notFound("Student not found");

  return prisma.student.update({ where: { id: studentId }, data: { status: "INACTIVE" } });
}
