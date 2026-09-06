import { NotificationTriggerType, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { AppError } from "@/lib/app-error";
import { toDateOnly } from "@/lib/school-calendar";
import * as rules from "@/lib/notification-rules";
import { LogQuery, UpdateRuleInput, UpdateTemplateInput } from "./notifications.validation";

export async function getLog(schoolId: string, role: string, query: LogQuery) {
  // Accountants only see fee-related delivery logs, per the permissions
  // table — not the full attendance/absence log.
  const triggerTypeFilter: NotificationTriggerType[] | undefined =
    role === "ACCOUNTANT" ? ["FEE_REMINDER", "FEE_OVERDUE"] : undefined;
  if (role === "ACCOUNTANT" && query.triggerType && query.triggerType === "ABSENCE") {
    throw AppError.forbidden("Accountants can only view fee-related notification logs");
  }

  const where: Prisma.NotificationJobWhereInput = {
    schoolId,
    ...(query.triggerType
      ? { triggerType: query.triggerType }
      : triggerTypeFilter
        ? { triggerType: { in: triggerTypeFilter } }
        : {}),
    ...(query.from || query.to
      ? {
          scheduledFor: {
            ...(query.from ? { gte: toDateOnly(query.from) } : {}),
            ...(query.to ? { lte: new Date(toDateOnly(query.to).getTime() + 86_400_000 - 1) } : {}),
          },
        }
      : {}),
    ...(query.status ? { deliveries: { some: { status: query.status } } } : {}),
  };

  const [total, jobs] = await Promise.all([
    prisma.notificationJob.count({ where }),
    prisma.notificationJob.findMany({
      where,
      include: {
        student: { select: { id: true, fullName: true, rollNumber: true } },
        template: { select: { name: true, category: true } },
        deliveries: { orderBy: { updatedAt: "desc" }, take: 1 },
      },
      orderBy: { scheduledFor: "desc" },
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
  ]);

  return {
    data: jobs.map((j) => ({
      id: j.id,
      triggerType: j.triggerType,
      status: j.status,
      scheduledFor: j.scheduledFor,
      student: j.student,
      templateName: j.template?.name ?? null,
      delivery: j.deliveries[0]
        ? {
            status: j.deliveries[0].status,
            recipientPhone: j.deliveries[0].recipientPhone,
            updatedAt: j.deliveries[0].updatedAt,
            error: j.deliveries[0].error,
          }
        : null,
    })),
    meta: { total, page: query.page, pageSize: query.pageSize },
  };
}

// ---------- Templates ----------

export async function listTemplates(schoolId: string) {
  return prisma.messageTemplate.findMany({ where: { schoolId }, orderBy: { category: "asc" } });
}

export async function updateTemplate(schoolId: string, id: string, input: UpdateTemplateInput) {
  const existing = await prisma.messageTemplate.findFirst({ where: { id, schoolId } });
  if (!existing) throw AppError.notFound("Template not found");
  return prisma.messageTemplate.update({ where: { id }, data: input });
}

// ---------- Notification rules ----------

export async function listRules(schoolId: string) {
  return rules.listRules(schoolId);
}

export async function updateRule(schoolId: string, triggerType: string, input: UpdateRuleInput) {
  if (!["ABSENCE", "FEE_REMINDER", "FEE_OVERDUE"].includes(triggerType)) {
    throw AppError.badRequest("Invalid trigger type");
  }
  return rules.updateRule(schoolId, triggerType as NotificationTriggerType, input);
}
