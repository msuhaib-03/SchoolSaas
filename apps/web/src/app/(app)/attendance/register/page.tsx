"use client";

import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { useClasses } from "@/features/classes/use-classes";
import { useAttendanceRegister } from "@/features/attendance/use-attendance";
import { cn } from "@/lib/cn";
import { toLocalIsoDate } from "@/lib/format";
import type { AttendanceStatus } from "@/types/attendance";

const STATUS_LABEL: Record<AttendanceStatus, string> = {
  PRESENT: "P",
  ABSENT: "A",
  LATE: "L",
  LEAVE: "Lv",
};

const STATUS_CLASS: Record<AttendanceStatus, string> = {
  PRESENT: "text-success-600",
  ABSENT: "text-danger-600 font-semibold",
  LATE: "text-warning-600",
  LEAVE: "text-gray-500",
};

function isoDaysAgo(days: number) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return toLocalIsoDate(d);
}

export default function AttendanceRegisterPage() {
  const { data: classes } = useClasses();
  const [classId, setClassId] = useState("");
  const [sectionId, setSectionId] = useState("");
  const [from, setFrom] = useState(isoDaysAgo(13));
  const [to, setTo] = useState(isoDaysAgo(0));

  const selectedClass = classes?.find((c) => c.id === classId);

  const { data, isPending, isError, refetch } = useAttendanceRegister({
    classId: classId || undefined,
    sectionId: sectionId || undefined,
    from,
    to,
  });

  return (
    <div className="space-y-6">
      <h1 className="text-lg font-semibold text-gray-900">Attendance Register</h1>

      <Card>
        <div className="flex flex-wrap items-end gap-4">
          <div>
            <label className="mb-1.5 block text-sm font-medium text-gray-700">Class</label>
            <Select
              value={classId}
              onChange={(e) => {
                setClassId(e.target.value);
                setSectionId("");
              }}
              className="w-44"
            >
              <option value="">All classes</option>
              {classes?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium text-gray-700">Section</label>
            <Select value={sectionId} onChange={(e) => setSectionId(e.target.value)} disabled={!selectedClass} className="w-32">
              <option value="">All sections</option>
              {selectedClass?.sections.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium text-gray-700">From</label>
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-40" />
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium text-gray-700">To</label>
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-40" />
          </div>
        </div>
      </Card>

      {isPending && <Skeleton className="h-64 w-full" />}
      {isError && <ErrorState message="Couldn't load the register." onRetry={() => refetch()} />}

      {!isPending && !isError && data && data.students.length === 0 && (
        <EmptyState title="No attendance recorded for this range" />
      )}

      {!isPending && !isError && data && data.students.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-surface-border bg-surface">
          <table className="w-full text-sm">
            <thead className="border-b border-surface-border bg-gray-50 text-left text-xs font-medium uppercase text-gray-500">
              <tr>
                <th className="sticky left-0 z-10 bg-gray-50 px-4 py-3">Student</th>
                {data.dates.map((d) => (
                  <th key={d} className="px-2 py-3 text-center">
                    {new Date(d).getDate()}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.students.map((s) => (
                <tr key={s.id} className="border-b border-surface-border last:border-0 hover:bg-gray-50">
                  <td className="sticky left-0 z-10 bg-surface px-4 py-2 font-medium text-gray-900">
                    {s.fullName} <span className="font-normal text-gray-400">{s.rollNumber}</span>
                  </td>
                  {data.dates.map((d) => {
                    const status = s.records[d] as AttendanceStatus | undefined;
                    return (
                      <td key={d} className={cn("px-2 py-2 text-center tabular-nums", status && STATUS_CLASS[status])}>
                        {status ? STATUS_LABEL[status] : <span className="text-gray-300">—</span>}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
