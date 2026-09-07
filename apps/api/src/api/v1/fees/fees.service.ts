import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { AppError } from "@/lib/app-error";
import { toAppError } from "@/lib/prisma-errors";
import { getOrCreateCurrentAcademicYear } from "@/lib/academic-year";
import { todayInSchoolTimezone } from "@/lib/school-calendar";
import { ensureDefaultTemplate, resolveTemplate } from "@/lib/notification-template";
import { assertCanSendNow } from "@/lib/notification-rules";
import {
  CreateFeeCategoryInput,
  DefaultersQuery,
  ListInvoicesQuery,
  RecordPaymentInput,
  SetStructureAmountInput,
  UpdateFeeCategoryInput,
} from "./fees.validation";

function currentPeriodLabel(): string {
  const now = todayInSchoolTimezone();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

function dueDateForPeriod(period: string): Date {
  const [year, month] = period.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, 10));
}

function toMoney(value: Prisma.Decimal | number): number {
  return Number(value);
}

const invoiceInclude = {
  student: {
    select: {
      id: true,
      fullName: true,
      rollNumber: true,
      class: { select: { id: true, name: true } },
      section: { select: { id: true, name: true } },
    },
  },
  feeCategory: { select: { id: true, name: true, type: true } },
  payments: {
    include: { receivedByUser: { select: { id: true, name: true } } },
    orderBy: { paidAt: "desc" as const },
  },
} satisfies Prisma.InvoiceInclude;

function serializeInvoice(invoice: Prisma.InvoiceGetPayload<{ include: typeof invoiceInclude }>) {
  const amountDue = toMoney(invoice.amountDue);
  const amountPaid = toMoney(invoice.amountPaid);
  return {
    ...invoice,
    amountDue,
    amountPaid,
    balance: Math.max(0, Math.round((amountDue - amountPaid) * 100) / 100),
    payments: invoice.payments.map((p) => ({ ...p, amount: toMoney(p.amount) })),
  };
}

// ---------- Fee categories ----------

export async function listFeeCategories(schoolId: string) {
  return prisma.feeCategory.findMany({ where: { schoolId }, orderBy: { name: "asc" } });
}

export async function createFeeCategory(schoolId: string, input: CreateFeeCategoryInput) {
  try {
    return await prisma.feeCategory.create({
      data: {
        schoolId,
        name: input.name,
        type: input.type,
        isRecurring: input.isRecurring ?? input.type === "MONTHLY",
      },
    });
  } catch (err) {
    toAppError(err, `A fee category named "${input.name}" already exists`);
  }
}

export async function updateFeeCategory(schoolId: string, id: string, input: UpdateFeeCategoryInput) {
  const existing = await prisma.feeCategory.findFirst({ where: { id, schoolId } });
  if (!existing) throw AppError.notFound("Fee category not found");
  try {
    return await prisma.feeCategory.update({ where: { id }, data: input });
  } catch (err) {
    toAppError(err, `A fee category named "${input.name}" already exists`);
  }
}

// ---------- Fee structure ----------

export async function listStructure(schoolId: string) {
  const academicYear = await getOrCreateCurrentAcademicYear(schoolId);
  const items = await prisma.feeStructureItem.findMany({
    where: { schoolId, academicYearId: academicYear.id },
    include: { class: { select: { id: true, name: true } }, feeCategory: true },
  });
  return {
    academicYear,
    items: items.map((i) => ({ ...i, amount: toMoney(i.amount) })),
  };
}

export async function setStructureAmount(schoolId: string, input: SetStructureAmountInput) {
  const [cls, category] = await Promise.all([
    prisma.class.findFirst({ where: { id: input.classId, schoolId } }),
    prisma.feeCategory.findFirst({ where: { id: input.feeCategoryId, schoolId } }),
  ]);
  if (!cls) throw AppError.badRequest("Class not found");
  if (!category) throw AppError.badRequest("Fee category not found");

  const academicYear = await getOrCreateCurrentAcademicYear(schoolId);

  const item = await prisma.feeStructureItem.upsert({
    where: {
      classId_feeCategoryId_academicYearId: {
        classId: input.classId,
        feeCategoryId: input.feeCategoryId,
        academicYearId: academicYear.id,
      },
    },
    update: { amount: input.amount },
    create: {
      schoolId,
      classId: input.classId,
      feeCategoryId: input.feeCategoryId,
      academicYearId: academicYear.id,
      amount: input.amount,
    },
    include: { class: { select: { id: true, name: true } }, feeCategory: true },
  });

  return { ...item, amount: toMoney(item.amount) };
}

// ---------- Invoice generation ----------

/**
 * Generates this period's invoices for every recurring (MONTHLY) fee
 * category, for every active student whose class has a structure amount
 * set. Idempotent — relying on Invoice's (studentId, feeCategoryId,
 * periodLabel) unique constraint via skipDuplicates, so re-running for an
 * already-generated period is a safe no-op rather than a duplicate charge.
 */
export async function generateMonthlyInvoices(schoolId: string, period?: string) {
  const targetPeriod = period ?? currentPeriodLabel();
  const academicYear = await getOrCreateCurrentAcademicYear(schoolId);

  const [structureItems, students] = await Promise.all([
    prisma.feeStructureItem.findMany({
      where: { schoolId, academicYearId: academicYear.id, feeCategory: { isRecurring: true } },
    }),
    prisma.student.findMany({ where: { schoolId, status: "ACTIVE" }, select: { id: true, classId: true } }),
  ]);

  if (structureItems.length === 0 || students.length === 0) {
    return { period: targetPeriod, created: 0 };
  }

  const studentsByClass = new Map<string, string[]>();
  for (const s of students) {
    const list = studentsByClass.get(s.classId) ?? [];
    list.push(s.id);
    studentsByClass.set(s.classId, list);
  }

  const rows: Prisma.InvoiceCreateManyInput[] = [];
  const dueDate = dueDateForPeriod(targetPeriod);
  for (const item of structureItems) {
    const studentIds = studentsByClass.get(item.classId) ?? [];
    for (const studentId of studentIds) {
      rows.push({
        schoolId,
        studentId,
        feeCategoryId: item.feeCategoryId,
        periodLabel: targetPeriod,
        amountDue: item.amount,
        dueDate,
      });
    }
  }

  if (rows.length === 0) return { period: targetPeriod, created: 0 };

  const result = await prisma.invoice.createMany({ data: rows, skipDuplicates: true });
  return { period: targetPeriod, created: result.count };
}

/**
 * Called once when a student is created — generates their one-time
 * (ANNUAL/ADMISSION) invoices from the class's fee structure, due
 * immediately at enrollment. Safe to no-op if no structure is set yet.
 */
export async function generateOneTimeInvoicesForStudent(
  tx: Prisma.TransactionClient,
  schoolId: string,
  studentId: string,
  classId: string,
  admissionDate: Date
) {
  const academicYear = await getOrCreateCurrentAcademicYear(schoolId);
  const items = await tx.feeStructureItem.findMany({
    where: { schoolId, classId, academicYearId: academicYear.id, feeCategory: { isRecurring: false } },
  });
  if (items.length === 0) return;

  await tx.invoice.createMany({
    data: items.map((item) => ({
      schoolId,
      studentId,
      feeCategoryId: item.feeCategoryId,
      periodLabel: academicYear.label,
      amountDue: item.amount,
      dueDate: admissionDate,
    })),
    skipDuplicates: true,
  });
}

// ---------- Invoices / ledger ----------

export async function listInvoices(schoolId: string, query: ListInvoicesQuery) {
  const where: Prisma.InvoiceWhereInput = {
    schoolId,
    ...(query.studentId ? { studentId: query.studentId } : {}),
    ...(query.period ? { periodLabel: query.period } : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(query.classId ? { student: { classId: query.classId } } : {}),
  };

  const [total, invoices] = await Promise.all([
    prisma.invoice.count({ where }),
    prisma.invoice.findMany({
      where,
      include: invoiceInclude,
      orderBy: [{ periodLabel: "desc" }, { createdAt: "desc" }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
  ]);

  return { data: invoices.map(serializeInvoice), meta: { total, page: query.page, pageSize: query.pageSize } };
}

export async function getStudentLedger(schoolId: string, studentId: string) {
  const student = await prisma.student.findFirst({ where: { id: studentId, schoolId } });
  if (!student) throw AppError.notFound("Student not found");

  const invoices = await prisma.invoice.findMany({
    where: { schoolId, studentId },
    include: invoiceInclude,
    orderBy: [{ periodLabel: "desc" }, { createdAt: "desc" }],
  });

  return invoices.map(serializeInvoice);
}

// ---------- Payments ----------

export async function recordPayment(schoolId: string, userId: string, input: RecordPaymentInput) {
  const invoice = await prisma.invoice.findFirst({ where: { id: input.invoiceId, schoolId } });
  if (!invoice) throw AppError.notFound("Invoice not found");

  const amountDue = toMoney(invoice.amountDue);
  const amountPaid = toMoney(invoice.amountPaid);
  const remaining = Math.round((amountDue - amountPaid) * 100) / 100;

  if (remaining <= 0) {
    throw AppError.conflict("This invoice is already fully paid");
  }
  if (input.amount > remaining) {
    throw AppError.badRequest(`Amount exceeds the outstanding balance of ${remaining.toFixed(2)}`);
  }

  const newAmountPaid = Math.round((amountPaid + input.amount) * 100) / 100;
  const newStatus = newAmountPaid >= amountDue ? "PAID" : "PARTIAL";

  const updated = await prisma.$transaction(async (tx) => {
    await tx.payment.create({
      data: {
        schoolId,
        invoiceId: invoice.id,
        amount: input.amount,
        method: input.method,
        receivedBy: userId,
      },
    });
    return tx.invoice.update({
      where: { id: invoice.id },
      data: { amountPaid: newAmountPaid, status: newStatus },
      include: invoiceInclude,
    });
  });

  return serializeInvoice(updated);
}

// ---------- Manual fee reminder notification (no automatic sending) ----------

export async function sendFeeReminderNotification(schoolId: string, userId: string, invoiceId: string) {
  const invoice = await prisma.invoice.findFirst({
    where: { id: invoiceId, schoolId },
    include: {
      feeCategory: true,
      student: {
        include: { class: true, section: true, guardians: { include: { guardian: true } } },
      },
    },
  });
  if (!invoice) throw AppError.notFound("Invoice not found");
  if (invoice.status === "PAID") {
    throw AppError.badRequest("This invoice is already fully paid");
  }

  const primaryGuardianLink =
    invoice.student.guardians.find((g) => g.isPrimary) ?? invoice.student.guardians[0];
  if (!primaryGuardianLink) {
    throw AppError.badRequest("This student has no guardian on file to notify");
  }
  if (!primaryGuardianLink.guardian.whatsappOptIn) {
    throw AppError.badRequest("This guardian has opted out of WhatsApp notifications");
  }

  const isOverdue = invoice.dueDate < new Date();
  const triggerType = isOverdue ? "FEE_OVERDUE" : "FEE_REMINDER";
  await assertCanSendNow(schoolId, triggerType);

  const template = await ensureDefaultTemplate(schoolId, triggerType);
  const balance = Math.max(0, Math.round((toMoney(invoice.amountDue) - toMoney(invoice.amountPaid)) * 100) / 100);
  const messageText = resolveTemplate(template.bodyText, {
    parent_name: primaryGuardianLink.guardian.fullName,
    student_name: invoice.student.fullName,
    class: invoice.student.class.name,
    section: invoice.student.section.name,
    fee_category: invoice.feeCategory.name,
    amount: balance.toFixed(2),
    period: invoice.periodLabel,
    due_date: invoice.dueDate.toISOString().slice(0, 10),
  });

  const { job, delivery } = await prisma.$transaction(async (tx) => {
    const job = await tx.notificationJob.create({
      data: {
        schoolId,
        studentId: invoice.studentId,
        triggerType,
        templateId: template.id,
        scheduledFor: new Date(),
        status: "SENT",
        attempts: 1,
        createdBy: userId,
      },
    });
    // Simulated — no live WhatsApp/BSP provider connected yet, same as the
    // attendance absence notifier. Real audit trail, simulated delivery.
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
    triggerType,
  };
}

// ---------- Defaulters ----------

export async function getDefaulters(schoolId: string, query: DefaultersQuery) {
  const period = query.period ?? currentPeriodLabel();

  const invoices = await prisma.invoice.findMany({
    where: {
      schoolId,
      periodLabel: period,
      status: { not: "PAID" },
      ...(query.classId ? { student: { classId: query.classId } } : {}),
    },
    include: {
      student: {
        select: {
          id: true,
          fullName: true,
          rollNumber: true,
          class: { select: { id: true, name: true } },
          section: { select: { id: true, name: true } },
        },
      },
    },
  });

  const byStudent = new Map<
    string,
    {
      student: (typeof invoices)[number]["student"];
      outstanding: number;
      invoiceCount: number;
      earliestDueDate: Date;
      earliestInvoiceId: string;
    }
  >();

  for (const inv of invoices) {
    const outstanding = toMoney(inv.amountDue) - toMoney(inv.amountPaid);
    const existing = byStudent.get(inv.studentId);
    if (existing) {
      existing.outstanding += outstanding;
      existing.invoiceCount += 1;
      if (inv.dueDate < existing.earliestDueDate) {
        existing.earliestDueDate = inv.dueDate;
        existing.earliestInvoiceId = inv.id;
      }
    } else {
      byStudent.set(inv.studentId, {
        student: inv.student,
        outstanding,
        invoiceCount: 1,
        earliestDueDate: inv.dueDate,
        earliestInvoiceId: inv.id,
      });
    }
  }

  const now = Date.now();
  return Array.from(byStudent.values())
    .map((row) => ({
      student: row.student,
      outstandingAmount: Math.round(row.outstanding * 100) / 100,
      invoiceCount: row.invoiceCount,
      daysOverdue: Math.max(0, Math.floor((now - row.earliestDueDate.getTime()) / (1000 * 60 * 60 * 24))),
      invoiceId: row.earliestInvoiceId,
    }))
    .sort((a, b) => b.outstandingAmount - a.outstandingAmount);
}

// ---------- Dashboard ----------

export async function getFeeDashboard(schoolId: string, period?: string) {
  const targetPeriod = period ?? currentPeriodLabel();

  const invoices = await prisma.invoice.findMany({
    where: { schoolId, periodLabel: targetPeriod },
    include: { student: { select: { classId: true, class: { select: { name: true } } } } },
  });

  let collected = 0;
  let outstanding = 0;
  const defaulterStudentIds = new Set<string>();
  const byClass = new Map<string, { classId: string; className: string; collected: number; outstanding: number }>();

  for (const inv of invoices) {
    const due = toMoney(inv.amountDue);
    const paid = toMoney(inv.amountPaid);
    collected += paid;
    outstanding += due - paid;
    if (inv.status !== "PAID") defaulterStudentIds.add(inv.studentId);

    const classId = inv.student.classId;
    const row = byClass.get(classId) ?? {
      classId,
      className: inv.student.class.name,
      collected: 0,
      outstanding: 0,
    };
    row.collected += paid;
    row.outstanding += due - paid;
    byClass.set(classId, row);
  }

  return {
    period: targetPeriod,
    collected: Math.round(collected * 100) / 100,
    outstanding: Math.round(outstanding * 100) / 100,
    defaulterCount: defaulterStudentIds.size,
    classWise: Array.from(byClass.values())
      .map((c) => ({
        ...c,
        collected: Math.round(c.collected * 100) / 100,
        outstanding: Math.round(c.outstanding * 100) / 100,
      }))
      .sort((a, b) => a.className.localeCompare(b.className)),
  };
}
