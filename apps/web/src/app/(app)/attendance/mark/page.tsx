"use client";

import { useMemo, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { useClasses } from "@/features/classes/use-classes";
import { useMarkAttendance, useRoster } from "@/features/attendance/use-attendance";
import { NotifyAbsenceButton } from "@/features/attendance/notify-absence-button";
import { useAuthStore } from "@/store/auth-store";
import { toastError, toastSuccess } from "@/store/toast-store";
import { ApiError } from "@/lib/api-client";
import { cn } from "@/lib/cn";
import { toLocalIsoDate } from "@/lib/format";
import type { AttendanceStatus } from "@/types/attendance";

const STATUS_OPTIONS: { value: AttendanceStatus; label: string }[] = [
  { value: "PRESENT", label: "Present" },
  { value: "ABSENT", label: "Absent" },
  { value: "LATE", label: "Late" },
  { value: "LEAVE", label: "Leave" },
];

const STATUS_STYLES: Record<AttendanceStatus, string> = {
  PRESENT: "bg-success-500 text-white border-success-500",
  ABSENT: "bg-danger-500 text-white border-danger-500",
  LATE: "bg-warning-500 text-white border-warning-500",
  LEAVE: "bg-gray-400 text-white border-gray-400",
};

function todayIso() {
  return toLocalIsoDate(new Date());
}

export default function MarkAttendancePage() {
  const user = useAuthStore((s) => s.user);
  const isTeacher = user?.role === "TEACHER";
  const teacherAssignments = user?.teacherAssignments ?? [];

  const { data: classes } = useClasses();

  // Teachers get their single assignment auto-selected via a lazy initial
  // state (user/teacherAssignments are already available by the time this
  // page mounts, since AppLayout blocks render until auth resolves).
  const [classId, setClassId] = useState(() =>
    isTeacher && teacherAssignments.length > 0 ? teacherAssignments[0].classId : ""
  );
  const [sectionId, setSectionId] = useState(() =>
    isTeacher && teacherAssignments.length > 0 ? teacherAssignments[0].sectionId : ""
  );
  const [date] = useState(todayIso());

  const selectedClass = useMemo(() => classes?.find((c) => c.id === classId), [classes, classId]);

  const { data: roster, isPending, isError, refetch } = useRoster({ classId, sectionId, date });
  const markAttendance = useMarkAttendance();

  const [draft, setDraft] = useState<Record<string, AttendanceStatus>>({});
  const [syncedRosterKey, setSyncedRosterKey] = useState<string | null>(null);

  // Reset the editable draft whenever a different roster loads. Adjusting
  // state during render (React's documented pattern for this) instead of in
  // an effect avoids an extra cascading re-render.
  const rosterKey = roster && roster.isSchoolDay ? `${classId}:${sectionId}:${roster.date}` : null;
  if (roster && roster.isSchoolDay && rosterKey !== syncedRosterKey) {
    setSyncedRosterKey(rosterKey);
    const next: Record<string, AttendanceStatus> = {};
    roster.students.forEach((s) => (next[s.id] = s.status));
    setDraft(next);
  }

  function setStatus(studentId: string, status: AttendanceStatus) {
    setDraft((d) => ({ ...d, [studentId]: status }));
  }

  function markAllPresent() {
    if (!roster || !roster.isSchoolDay) return;
    const next: Record<string, AttendanceStatus> = {};
    roster.students.forEach((s) => (next[s.id] = "PRESENT"));
    setDraft(next);
  }

  async function handleSubmit() {
    if (!roster || !roster.isSchoolDay) return;
    try {
      const result = await markAttendance.mutateAsync({
        date,
        classId,
        sectionId,
        records: roster.students.map((s) => ({ studentId: s.id, status: draft[s.id] ?? "PRESENT" })),
      });
      toastSuccess(`Attendance saved for ${result.marked} student(s)`);
    } catch (err) {
      toastError(err instanceof ApiError ? err.message : "Failed to save attendance");
    }
  }

  const absentStudents =
    roster && roster.isSchoolDay ? roster.students.filter((s) => draft[s.id] === "ABSENT") : [];

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
        <h1 className="text-lg font-semibold text-gray-900">Mark Attendance</h1>
        <span className="text-sm text-gray-500">
          {new Date(date).toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}
        </span>
      </div>

      <Card>
        <div className="flex flex-wrap items-end gap-4">
          <div>
            <label className="mb-1.5 block text-sm font-medium text-gray-700">Class</label>
            {isTeacher ? (
              <Input value={selectedClass?.name ?? ""} disabled className="w-48" />
            ) : (
              <Select
                value={classId}
                onChange={(e) => {
                  setClassId(e.target.value);
                  setSectionId("");
                }}
                className="w-48"
              >
                <option value="">Select a class</option>
                {classes?.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            )}
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium text-gray-700">Section</label>
            {isTeacher ? (
              <Input
                value={teacherAssignments.find((a) => a.sectionId === sectionId)?.sectionName ?? ""}
                disabled
                className="w-32"
              />
            ) : (
              <Select
                value={sectionId}
                onChange={(e) => setSectionId(e.target.value)}
                disabled={!selectedClass}
                className="w-32"
              >
                <option value="">Section</option>
                {selectedClass?.sections.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            )}
          </div>
          {isTeacher && teacherAssignments.length > 1 && (
            <div>
              <label className="mb-1.5 block text-sm font-medium text-gray-700">Your sections</label>
              <Select
                value={sectionId}
                onChange={(e) => {
                  const a = teacherAssignments.find((t) => t.sectionId === e.target.value);
                  if (a) {
                    setClassId(a.classId);
                    setSectionId(a.sectionId);
                  }
                }}
                className="w-48"
              >
                {teacherAssignments.map((a) => (
                  <option key={a.sectionId} value={a.sectionId}>
                    {a.className} - {a.sectionName}
                  </option>
                ))}
              </Select>
            </div>
          )}
        </div>
      </Card>

      {!classId || !sectionId ? (
        <EmptyState title="Select a class and section to mark attendance" />
      ) : isPending ? (
        <Skeleton className="h-64 w-full" />
      ) : isError ? (
        <ErrorState message="Couldn't load the roster." onRetry={() => refetch()} />
      ) : roster && !roster.isSchoolDay ? (
        <EmptyState title={`No attendance needed — ${roster.reason} (${roster.date})`} />
      ) : roster && roster.students.length === 0 ? (
        <EmptyState title="No students in this class" />
      ) : roster ? (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            {roster.alreadySubmitted && (
              <span className="text-sm text-gray-500">Attendance already submitted today — edits are saved as corrections.</span>
            )}
            <Button variant="secondary" size="sm" onClick={markAllPresent} className="ml-auto">
              Mark all present
            </Button>
          </div>

          <div className="overflow-x-auto rounded-lg border border-surface-border bg-surface">
            <table className="w-full text-sm">
              <thead className="border-b border-surface-border bg-gray-50 text-left text-xs font-medium uppercase text-gray-500">
                <tr>
                  <th className="px-4 py-3">Student</th>
                  <th className="px-4 py-3">Roll No.</th>
                  <th className="px-4 py-3">Status</th>
                </tr>
              </thead>
              <tbody>
                {roster.students.map((s) => (
                  <tr key={s.id} className="border-b border-surface-border last:border-0">
                    <td className="px-4 py-3 font-medium text-gray-900">{s.fullName}</td>
                    <td className="px-4 py-3 tabular-nums text-gray-600">{s.rollNumber}</td>
                    <td className="px-4 py-3">
                      <div className="inline-flex overflow-hidden rounded-lg border border-gray-300">
                        {STATUS_OPTIONS.map((opt, i) => (
                          <button
                            key={opt.value}
                            type="button"
                            onClick={() => setStatus(s.id, opt.value)}
                            className={cn(
                              "px-3 py-1.5 text-xs font-medium transition-colors",
                              i > 0 && "border-l border-gray-300",
                              draft[s.id] === opt.value
                                ? STATUS_STYLES[opt.value]
                                : "bg-white text-gray-500 hover:bg-gray-50"
                            )}
                          >
                            {opt.label}
                          </button>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex justify-end">
            <Button onClick={handleSubmit} disabled={markAttendance.isPending}>
              {markAttendance.isPending ? "Saving…" : "Submit Attendance"}
            </Button>
          </div>

          {absentStudents.length > 0 && (
            <Card>
              <h2 className="mb-3 text-sm font-semibold text-gray-700">
                Absent today ({absentStudents.length}) — notify a parent
              </h2>
              <div className="space-y-2">
                {absentStudents.map((s) => (
                  <div key={s.id} className="flex items-center justify-between rounded-md bg-gray-50 px-3 py-2">
                    <span className="text-sm text-gray-900">{s.fullName}</span>
                    {s.attendanceRecordId ? (
                      <NotifyAbsenceButton attendanceRecordId={s.attendanceRecordId} notification={s.notification} />
                    ) : (
                      <span className="text-xs text-gray-400">Submit attendance first</span>
                    )}
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>
      ) : null}
    </div>
  );
}
