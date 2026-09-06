import { prisma } from "./prisma";
import { MessageTemplateCategory } from "@prisma/client";

const DEFAULT_BODIES: Record<"ABSENCE" | "FEE_REMINDER" | "FEE_OVERDUE", { name: string; body: string }> = {
  ABSENCE: {
    name: "Absence Notice (Default)",
    body: "Dear {{parent_name}}, this is to inform you that {{student_name}} ({{class}} - {{section}}) was marked ABSENT today, {{date}}. If this is unexpected, please contact the school office.",
  },
  FEE_REMINDER: {
    name: "Fee Reminder (Default)",
    body: "Dear {{parent_name}}, a reminder that {{student_name}}'s {{fee_category}} fee of Rs {{amount}} for {{period}} is due on {{due_date}}. Please arrange payment at your earliest convenience.",
  },
  FEE_OVERDUE: {
    name: "Fee Overdue Notice (Default)",
    body: "Dear {{parent_name}}, {{student_name}}'s {{fee_category}} fee of Rs {{amount}} for {{period}} was due on {{due_date}} and remains unpaid. Please contact the school office to settle this at the earliest.",
  },
};

/**
 * A Message Template management screen now exists (Phase 5), but a school
 * shouldn't be blocked from using the manual "Send Notification" buttons
 * before ever visiting it. Each category gets one sensible default template
 * lazily provisioned on first use — editable afterward from the Templates
 * screen, never re-created once it exists.
 */
export async function ensureDefaultTemplate(
  schoolId: string,
  category: "ABSENCE" | "FEE_REMINDER" | "FEE_OVERDUE"
) {
  const existing = await prisma.messageTemplate.findFirst({
    where: { schoolId, category: category as MessageTemplateCategory },
  });
  if (existing) return existing;

  const defaults = DEFAULT_BODIES[category];
  return prisma.messageTemplate.create({
    data: {
      schoolId,
      name: defaults.name,
      category: category as MessageTemplateCategory,
      bodyText: defaults.body,
      approvalStatus: "APPROVED",
    },
  });
}

export async function ensureDefaultAbsenceTemplate(schoolId: string) {
  return ensureDefaultTemplate(schoolId, "ABSENCE");
}

export function resolveTemplate(bodyText: string, variables: Record<string, string>) {
  return bodyText.replace(/{{\s*(\w+)\s*}}/g, (match, key) => variables[key] ?? match);
}
