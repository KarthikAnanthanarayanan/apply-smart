import { fetchJobs as fetchAshbyJobs } from './ashby.js';
import { fetchJobs as fetchGreenhouseJobs } from './greenhouse.js';
import { fetchJobs as fetchLeverJobs } from './lever.js';
import type { FetchJobsResult, JobBoard } from './http.js';

export type { AtsJob, JobBoard } from './http.js';

export function fetchJobs(jobBoard: JobBoard, companyBoardId: string): Promise<FetchJobsResult> {
  switch (jobBoard) {
    case 'greenhouse':
      return fetchGreenhouseJobs(companyBoardId);
    case 'lever':
      return fetchLeverJobs(companyBoardId);
    case 'ashby':
      return fetchAshbyJobs(companyBoardId);
    default: {
      const unknownBoard: never = jobBoard;
      return Promise.resolve({ ok: false, reason: `unsupported job board: ${String(unknownBoard)}` });
    }
  }
}
