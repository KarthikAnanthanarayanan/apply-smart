import path from "node:path";
import dotenv from "dotenv";
import { PgBoss } from "pg-boss";
import type { JobBoard } from "../services/ats/index.js";

dotenv.config({ path: path.resolve(import.meta.dirname, "../../.env") });

// Initial Queue: one message at 2am -> worker then reads db and fans out 3600 for all companies.
export const DISPATCH_JOB_SYNCS = "dispatch-job-syncs";
// Shared by the nightly and backfill messages so two dispatches never run at once, for deduping runs using a base key.
export const DISPATCH_SINGLETON_KEY = "dispatch-job-syncs";

// Board-specific Queues: 3 in total for each job board which actuall fetches and saves jobs.
export const SYNC_JOBS_QUEUES: Record<JobBoard, string> = {
  greenhouse: "sync-greenhouse-jobs",
  lever: "sync-lever-jobs",
  ashby: "sync-ashby-jobs",
};

// Starts the framework for creating and shutting down these queues.
export async function startBoss(): Promise<PgBoss> {
  const { DATABASE_URL } = process.env;
  if (!DATABASE_URL) {
    throw new Error(
      "Missing required environment variable: DATABASE_URL. " +
        "Set it in backend/.env (see backend/.env.example).",
    );
  }

  const boss = new PgBoss(DATABASE_URL);
  boss.on("error", (err) => console.error("pg-boss error:", err));
  await boss.start();

  // Initial queue is created to dispatch 2am message (only created on every startup / deployment).
  await boss.createQueue(DISPATCH_JOB_SYNCS, {
    policy: "exclusive",
    retryLimit: 1,
    retryDelay: 15 * 60,
  });

  // Job board specific queues are created for fetching jobs.
  for (const queue of Object.values(SYNC_JOBS_QUEUES)) {
    await boss.createQueue(queue, {
      policy: "singleton", // singleton key will be sent with the message.
      retryLimit: 1,
      retryDelay: 15 * 60,
    });
  }

  return boss;
}
