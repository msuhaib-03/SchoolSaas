import { prisma } from "./prisma";
import { AppError } from "./app-error";
import { NotificationTriggerType } from "@prisma/client";
import { nowMinutesInSchoolTimezone } from "./school-calendar";

const DEFAULT_WINDOW = { commsWindowStart: "07:00", commsWindowEnd: "18:00" };

export async function getOrCreateRule(schoolId: string, triggerType: NotificationTriggerType) {
  const existing = await prisma.notificationRule.findUnique({
    where: { schoolId_triggerType: { schoolId, triggerType } },
  });
  if (existing) return existing;

  return prisma.notificationRule.create({
    data: { schoolId, triggerType, isEnabled: true, ...DEFAULT_WINDOW },
  });
}

export async function listRules(schoolId: string) {
  const types: NotificationTriggerType[] = ["ABSENCE", "FEE_REMINDER", "FEE_OVERDUE"];
  return Promise.all(types.map((t) => getOrCreateRule(schoolId, t)));
}

export async function updateRule(
  schoolId: string,
  triggerType: NotificationTriggerType,
  input: { isEnabled?: boolean; commsWindowStart?: string; commsWindowEnd?: string }
) {
  await getOrCreateRule(schoolId, triggerType);
  return prisma.notificationRule.update({
    where: { schoolId_triggerType: { schoolId, triggerType } },
    data: input,
  });
}

function minutesSinceMidnight(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/**
 * Even though sending is manually triggered (not an automatic delayed job —
 * see Phase 4/5 notes), a school still shouldn't have staff accidentally
 * WhatsApp-ing a parent at 11pm. The same NotificationRule the plan designed
 * for automatic scheduling doubles as a guardrail on manual sends: disabled
 * or outside the window blocks the button server-side, not just cosmetically.
 * Times are compared as plain HH:MM against Pakistan local time (there's no
 * per-school timezone field yet, so PKT is hardcoded — see school-calendar.ts).
 * This used to compare against the server's raw UTC clock instead, which
 * silently shifted the whole window 5 hours from the real Pakistan-time
 * window it's named after (07:00-18:00) — blocking real mid-morning sends
 * and, worse, waving through sends until 11pm local time.
 */
export async function assertCanSendNow(schoolId: string, triggerType: NotificationTriggerType) {
  const rule = await getOrCreateRule(schoolId, triggerType);
  if (!rule.isEnabled) {
    throw AppError.badRequest(`${triggerType.replace("_", " ")} notifications are disabled for this school`);
  }

  const nowMinutes = nowMinutesInSchoolTimezone();
  const start = minutesSinceMidnight(rule.commsWindowStart);
  const end = minutesSinceMidnight(rule.commsWindowEnd);

  if (nowMinutes < start || nowMinutes > end) {
    throw AppError.badRequest(
      `Outside the communication window (${rule.commsWindowStart}–${rule.commsWindowEnd}) — try again during school hours`
    );
  }
}
