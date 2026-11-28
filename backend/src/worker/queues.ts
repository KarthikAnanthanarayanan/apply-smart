import path from "node:path";
import dotenv from "dotenv";
import { PgBoss } from "pg-boss";

dotenv.config({ path: path.resolve(import.meta.dirname, "../../.env") });

export const INGEST_JOBS = "ingest-jobs"; // Queue that loads the ~3,600 companies and fans out one INGEST_COMPANY job each.
export const INGEST_SINGLETON_KEY = "ingest-jobs"; // Shared by the nightly and backfill fan-outs so two never run at once.
export const INGEST_COMPANY = "ingest-company"; // Queue of one job per company: fetch its board and save its Australian jobs.

// Starts pg-boss and makes sure both ingest queues exist. Callers must call boss.stop().
export async function startBoss(): Promise<PgBoss> {
  const { DATABASE_URL } = process.env;
  if (!DATABASE_URL) {
    throw new Error(
      "Missing required environment variable: DATABASE_URL. " +
        "Set it in backend/.env (see backend/.env.example).",
    );
  }

  const boss = new PgBoss(DATABASE_URL); // converts db into a queue thats held within boss.
  boss.on("error", (err) => console.error("pg-boss error:", err));
  await boss.start();

  await boss.createQueue(INGEST_JOBS, {
    policy: "exclusive",
    retryLimit: 1,
    retryDelay: 15 * 60,
  });

  // singleton + singletonKey = company id: any number of jobs per company can be queued,
  // but only one per company is ever active, so a company is never fetched twice at once.
  await boss.createQueue(INGEST_COMPANY, {
    policy: "singleton",
    retryLimit: 1,
    retryDelay: 15 * 60,
  });

  return boss;
}
