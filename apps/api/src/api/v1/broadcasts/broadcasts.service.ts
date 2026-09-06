import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { AppError } from "@/lib/app-error";
import { toDateOnly } from "@/lib/school-calendar";
import { resolveTemplate } from "@/lib/notification-template";
import { AudiencePreviewQuery, CreateBroadcastInput, ListBroadcastsQuery } from "./broadcasts.validation";

type ResolvedRecipient = {
  recipientPhone: string;
  variables: Record<string, string>;
  studentId?: string;
};

function currentPeriodLabel(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Resolves an audience definition into recipients live, at read/send time —
 * never from a stored snapshot (Section 13's explicit design goal: "Absent
 * students' parents" and "fee defaulters" change every day). Dedupes by
 * phone number since one guardian can have multiple children in the same
 * audience — a documented simplification, same spirit as the guardian-dedupe
 * logic in Student Management: the first matching student's info is used
 * for that phone's message variables.
 */
async function resolveAudience(
  schoolId: string,
  audienceType: string,
  filters: { classId?: string; sectionId?: string; studentIds?: string[]; period?: string }
): Promise<ResolvedRecipient[]> {
  if (audienceType === "STAFF") {
    const staff = await prisma.user.findMany({
      where: { schoolId, status: "ACTIVE", phone: { not: null } },
    });
    return staff
      .filter((u): u is typeof u & { phone: string } => !!u.phone)
      .map((u) => ({ recipientPhone: u.phone, variables: { staff_name: u.name } }));
  }

  let studentWhere: Prisma.StudentWhereInput = { schoolId, status: "ACTIVE" };

  if (audienceType === "CLASS") {
    if (!filters.classId) throw AppError.badRequest("classId is required for a CLASS audience");
    studentWhere = { ...studentWhere, classId: filters.classId };
  } else if (audienceType === "SECTION") {
    if (!filters.sectionId) throw AppError.badRequest("sectionId is required for a SECTION audience");
    studentWhere = { ...studentWhere, sectionId: filters.sectionId };
  } else if (audienceType === "STUDENTS") {
    if (!filters.studentIds || filters.studentIds.length === 0) {
      throw AppError.badRequest("studentIds is required for a STUDENTS audience");
    }
    studentWhere = { ...studentWhere, id: { in: filters.studentIds } };
  } else if (audienceType === "ABSENT_TODAY") {
    const today = toDateOnly(new Date());
    studentWhere = {
      ...studentWhere,
      attendanceRecords: { some: { date: today, status: "ABSENT" } },
    };
  } else if (audienceType === "DEFAULTERS") {
    const period = filters.period ?? currentPeriodLabel();
    studentWhere = {
      ...studentWhere,
      invoices: { some: { periodLabel: period, status: { not: "PAID" } } },
    };
  } else if (audienceType !== "ALL") {
    throw AppError.badRequest("Unknown audience type");
  }

  const students = await prisma.student.findMany({
    where: studentWhere,
    include: {
      class: true,
      section: true,
      guardians: { include: { guardian: true } },
    },
  });

  const byPhone = new Map<string, ResolvedRecipient>();
  for (const student of students) {
    const link = student.guardians.find((g) => g.isPrimary) ?? student.guardians[0];
    if (!link || !link.guardian.whatsappOptIn) continue;
    const phone = link.guardian.phoneE164;
    if (byPhone.has(phone)) continue;
    byPhone.set(phone, {
      recipientPhone: phone,
      studentId: student.id,
      variables: {
        parent_name: link.guardian.fullName,
        student_name: student.fullName,
        class: student.class.name,
        section: student.section.name,
      },
    });
  }

  return Array.from(byPhone.values());
}

export async function previewAudience(schoolId: string, query: AudiencePreviewQuery) {
  const recipients = await resolveAudience(schoolId, query.audienceType, query);
  return {
    count: recipients.length,
    sample: recipients[0] ? { recipientPhone: recipients[0].recipientPhone, variables: recipients[0].variables } : null,
  };
}

export async function createBroadcast(schoolId: string, userId: string, role: string, input: CreateBroadcastInput) {
  if (role === "ACCOUNTANT" && input.audienceType !== "DEFAULTERS") {
    throw AppError.forbidden("Accountants can only broadcast to fee defaulters");
  }

  let bodyText = input.rawBody;
  if (input.templateId) {
    const template = await prisma.messageTemplate.findFirst({ where: { id: input.templateId, schoolId } });
    if (!template) throw AppError.notFound("Template not found");
    bodyText = template.bodyText;
  }
  if (!bodyText) throw AppError.badRequest("A message is required");

  const recipients = await resolveAudience(schoolId, input.audienceType, input);
  if (recipients.length === 0) {
    throw AppError.badRequest("This audience has no recipients — nothing was sent");
  }

  const campaign = await prisma.$transaction(async (tx) => {
    const campaign = await tx.broadcastCampaign.create({
      data: {
        schoolId,
        createdBy: userId,
        audienceType: input.audienceType,
        audienceFilter: {
          classId: input.classId,
          sectionId: input.sectionId,
          studentIds: input.studentIds,
          period: input.period,
        },
        templateId: input.templateId,
        rawBody: input.rawBody,
        sentAt: new Date(),
      },
    });

    // Simulated — same as the attendance/fee notifiers: no live WhatsApp
    // provider connected yet, but every recipient gets a real, personalized
    // resolved message recorded in the audit trail.
    await tx.messageDelivery.createMany({
      data: recipients.map((r) => ({
        campaignId: campaign.id,
        recipientPhone: r.recipientPhone,
        status: "SENT",
        providerMessageId: `simulated-${campaign.id}-${r.recipientPhone}`,
      })),
    });

    return campaign;
  });

  return {
    id: campaign.id,
    recipientCount: recipients.length,
    sampleMessage: resolveTemplate(bodyText, recipients[0].variables),
  };
}

export async function listBroadcasts(schoolId: string, query: ListBroadcastsQuery) {
  const [total, campaigns] = await Promise.all([
    prisma.broadcastCampaign.count({ where: { schoolId } }),
    prisma.broadcastCampaign.findMany({
      where: { schoolId },
      include: {
        createdByUser: { select: { name: true } },
        template: { select: { name: true } },
        deliveries: { select: { status: true } },
      },
      orderBy: { createdAt: "desc" },
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
  ]);

  return {
    data: campaigns.map((c) => {
      const counts = { SENT: 0, DELIVERED: 0, READ: 0, FAILED: 0, QUEUED: 0 };
      c.deliveries.forEach((d) => {
        counts[d.status] = (counts[d.status] ?? 0) + 1;
      });
      return {
        id: c.id,
        audienceType: c.audienceType,
        templateName: c.template?.name ?? null,
        rawBody: c.rawBody,
        sentBy: c.createdByUser.name,
        sentAt: c.sentAt,
        recipientCount: c.deliveries.length,
        statusCounts: counts,
      };
    }),
    meta: { total, page: query.page, pageSize: query.pageSize },
  };
}

export async function getBroadcast(schoolId: string, id: string) {
  const campaign = await prisma.broadcastCampaign.findFirst({
    where: { id, schoolId },
    include: {
      createdByUser: { select: { name: true } },
      template: { select: { name: true } },
      deliveries: { orderBy: { updatedAt: "desc" } },
    },
  });
  if (!campaign) throw AppError.notFound("Broadcast not found");

  return {
    id: campaign.id,
    audienceType: campaign.audienceType,
    audienceFilter: campaign.audienceFilter,
    templateName: campaign.template?.name ?? null,
    rawBody: campaign.rawBody,
    sentBy: campaign.createdByUser.name,
    sentAt: campaign.sentAt,
    deliveries: campaign.deliveries.map((d) => ({
      id: d.id,
      recipientPhone: d.recipientPhone,
      status: d.status,
      updatedAt: d.updatedAt,
      error: d.error,
    })),
  };
}
