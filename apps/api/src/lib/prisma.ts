import { PrismaClient } from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

// Default 5s interactive-transaction timeout is too tight once a request
// does 2-3 round trips against a remote pooled connection (e.g. Supabase's
// pooler) — bump it so a normal multi-step transaction (guardian dedupe +
// student create, for example) doesn't get killed mid-flight under latency.
export const prisma =
  global.__prisma ??
  new PrismaClient({
    transactionOptions: { timeout: 15_000, maxWait: 10_000 },
  });

if (process.env.NODE_ENV !== "production") {
  global.__prisma = prisma;
}
