import { Prisma } from "@prisma/client";
import { AppError } from "./app-error";

/** Maps a Prisma unique-constraint violation (P2002) to a 409 AppError; rethrows anything else. */
export function toAppError(err: unknown, conflictMessage: string): never {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
    throw AppError.conflict(conflictMessage, { target: err.meta?.target });
  }
  throw err;
}
