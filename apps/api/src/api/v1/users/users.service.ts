import bcrypt from "bcrypt";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { AppError } from "@/lib/app-error";
import { CreateUserInput, STAFF_ROLES, UpdateUserInput, UpdateUserStatusInput } from "./users.validation";

const MAX_ACTIVE_STAFF = 5;

type Assignment = { classId: string; sectionId: string };

const userSummarySelect = {
  id: true,
  name: true,
  email: true,
  role: true,
  status: true,
  createdAt: true,
} satisfies Prisma.UserSelect;

export async function listUsers(schoolId: string) {
  const users = await prisma.user.findMany({
    where: { schoolId },
    orderBy: [{ role: "asc" }, { name: "asc" }],
    select: {
      ...userSummarySelect,
      teacherClassAssignments: {
        select: {
          classId: true,
          sectionId: true,
          class: { select: { name: true } },
          section: { select: { name: true } },
        },
      },
    },
  });

  const activeStaffCount = users.filter(
    (u) => (STAFF_ROLES as readonly string[]).includes(u.role) && u.status === "ACTIVE"
  ).length;

  return {
    users: users.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role,
      status: u.status,
      createdAt: u.createdAt,
      assignments: u.teacherClassAssignments.map((a) => ({
        classId: a.classId,
        className: a.class.name,
        sectionId: a.sectionId,
        sectionName: a.section.name,
      })),
    })),
    staffCount: activeStaffCount,
    staffLimit: MAX_ACTIVE_STAFF,
  };
}

async function assertUnderStaffLimit(schoolId: string) {
  const activeStaffCount = await prisma.user.count({
    where: { schoolId, role: { in: [...STAFF_ROLES] }, status: "ACTIVE" },
  });
  if (activeStaffCount >= MAX_ACTIVE_STAFF) {
    throw AppError.badRequest(
      `This school already has ${MAX_ACTIVE_STAFF} active staff accounts — deactivate one before adding another.`
    );
  }
}

function dedupeAssignments(assignments: Assignment[]): Assignment[] {
  const seen = new Set<string>();
  return assignments.filter((a) => {
    const key = `${a.classId}:${a.sectionId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function assertAssignmentsValid(schoolId: string, assignments: Assignment[]) {
  for (const a of assignments) {
    const section = await prisma.section.findFirst({
      where: { id: a.sectionId, classId: a.classId },
      include: { class: true },
    });
    if (!section || section.class.schoolId !== schoolId) {
      throw AppError.badRequest("One of the selected class/section assignments is invalid for this school");
    }
  }
}

export async function createUser(schoolId: string, input: CreateUserInput) {
  await assertUnderStaffLimit(schoolId);

  const assignments = input.role === "TEACHER" ? dedupeAssignments(input.assignments ?? []) : [];
  if (assignments.length > 0) {
    await assertAssignmentsValid(schoolId, assignments);
  }

  const passwordHash = await bcrypt.hash(input.password, 12);

  try {
    return await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: { schoolId, name: input.name, email: input.email, passwordHash, role: input.role },
        select: userSummarySelect,
      });

      if (assignments.length > 0) {
        await tx.teacherClassAssignment.createMany({
          data: assignments.map((a) => ({ userId: user.id, classId: a.classId, sectionId: a.sectionId })),
          skipDuplicates: true,
        });
      }

      return user;
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw AppError.conflict(`An account with email "${input.email}" already exists`);
    }
    throw err;
  }
}

export async function updateUser(schoolId: string, userId: string, input: UpdateUserInput) {
  const existing = await prisma.user.findFirst({ where: { id: userId, schoolId } });
  if (!existing) throw AppError.notFound("User not found");
  if (existing.role === "SCHOOL_ADMIN") {
    throw AppError.badRequest("The school admin account can't be edited here");
  }

  const nextRole = input.role ?? existing.role;
  const effectiveAssignments = nextRole === "TEACHER" && input.assignments ? dedupeAssignments(input.assignments) : [];
  if (effectiveAssignments.length > 0) {
    await assertAssignmentsValid(schoolId, effectiveAssignments);
  }

  const data: Prisma.UserUpdateInput = {};
  if (input.name !== undefined) data.name = input.name;
  if (input.email !== undefined) data.email = input.email;
  if (input.role !== undefined) data.role = input.role;
  if (input.password) data.passwordHash = await bcrypt.hash(input.password, 12);

  try {
    return await prisma.$transaction(async (tx) => {
      const user = await tx.user.update({ where: { id: userId }, data, select: userSummarySelect });

      const roleLeftTeacher = existing.role === "TEACHER" && nextRole !== "TEACHER";
      if (roleLeftTeacher) {
        await tx.teacherClassAssignment.deleteMany({ where: { userId } });
      } else if (nextRole === "TEACHER" && input.assignments !== undefined) {
        // Replace wholesale — simplest correct behavior for "edit the list of classes".
        await tx.teacherClassAssignment.deleteMany({ where: { userId } });
        if (effectiveAssignments.length > 0) {
          await tx.teacherClassAssignment.createMany({
            data: effectiveAssignments.map((a) => ({ userId, classId: a.classId, sectionId: a.sectionId })),
            skipDuplicates: true,
          });
        }
      }

      return user;
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw AppError.conflict(`An account with email "${input.email}" already exists`);
    }
    throw err;
  }
}

export async function updateUserStatus(schoolId: string, userId: string, input: UpdateUserStatusInput) {
  const user = await prisma.user.findFirst({ where: { id: userId, schoolId } });
  if (!user) throw AppError.notFound("User not found");
  if (user.role === "SCHOOL_ADMIN") {
    throw AppError.badRequest("The school admin account can't be deactivated here");
  }

  if (input.status === "ACTIVE" && user.status !== "ACTIVE") {
    await assertUnderStaffLimit(schoolId);
  }

  return prisma.user.update({
    where: { id: userId },
    data: { status: input.status },
    select: userSummarySelect,
  });
}

/**
 * A real, permanent delete — deliberately narrower than deactivate. Only
 * allowed when the account has no recorded activity anywhere (payments
 * taken, attendance marked, notifications/broadcasts sent); otherwise
 * hard-deleting would either violate a foreign key or silently erase real
 * history. Anyone with activity gets pointed at deactivate instead, same
 * as how Students are never hard-deleted in this app either.
 */
export async function deleteUser(schoolId: string, userId: string) {
  const user = await prisma.user.findFirst({ where: { id: userId, schoolId } });
  if (!user) throw AppError.notFound("User not found");
  if (user.role === "SCHOOL_ADMIN") {
    throw AppError.badRequest("The school admin account can't be deleted here");
  }

  const [payments, attendance, notifications, broadcasts] = await Promise.all([
    prisma.payment.count({ where: { receivedBy: userId } }),
    prisma.attendanceRecord.count({ where: { markedBy: userId } }),
    prisma.notificationJob.count({ where: { createdBy: userId } }),
    prisma.broadcastCampaign.count({ where: { createdBy: userId } }),
  ]);
  if (payments + attendance + notifications + broadcasts > 0) {
    throw AppError.conflict(
      "This account has recorded activity (payments, attendance, or messages) and can't be permanently deleted — deactivate it instead."
    );
  }

  await prisma.$transaction([
    prisma.teacherClassAssignment.deleteMany({ where: { userId } }),
    prisma.user.delete({ where: { id: userId } }),
  ]);
}
