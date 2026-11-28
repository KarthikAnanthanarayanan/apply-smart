import {
  badResponse,
  getJson,
  isoDateOrNull,
  isRecord,
  stringOrNull,
  type AtsJob,
  type FetchJobsResult,
} from "./http.js";
import { parseLocation, REMOTE_CITY } from "./normalise.js";

export async function fetchJobs(
  companyBoardId: string,
): Promise<FetchJobsResult> {
  const url = `https://api.lever.co/v0/postings/${encodeURIComponent(companyBoardId)}?mode=json`;
  const res = await getJson(url);
  if (!res.ok) return res;

  if (!Array.isArray(res.body))
    return badResponse("expected an array of postings");

  // Defensive checks for no job id or title.
  const jobs: AtsJob[] = res.body
    .filter(isRecord)
    .filter((job) => typeof job.id === "string" && stringOrNull(job.text))
    .map((job) => {
      const categories = isRecord(job.categories) ? job.categories : null;
      const allLocations = Array.isArray(categories?.allLocations)
        ? categories.allLocations
        : [];
      // job.country is a structured ISO code; the location text adds the city and state.
      // null = not in Australia.
      const place = parseLocation(
        [
          stringOrNull(categories?.location) ?? stringOrNull(allLocations[0]),
          stringOrNull(job.country),
        ]
          .filter(Boolean)
          .join(", "),
      );

      return {
        boardJobId: job.id as string,
        title: stringOrNull(job.text)!,
        city:
          place && job.workplaceType === "remote"
            ? REMOTE_CITY
            : (place?.city ?? null),
        state: place?.state ?? null,
        country: place?.country ?? null,
        applyUrl: stringOrNull(job.hostedUrl),
        raw: job,
        updatedAt:
          typeof job.createdAt === "number"
            ? isoDateOrNull(job.createdAt)
            : null,
      };
    });

  return { ok: true, jobs };
}
