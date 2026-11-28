import { createRequire } from "node:module";
import allCities from "all-the-cities";
import countries from "i18n-iso-countries";

// Apply Smart only covers Australian jobs for now.
interface AustralianLocation {
  city: string | null;
  state: string | null;
  country: "Australia";
}

interface State {
  name: string; // "New South Wales"
  adminCode: string; // GeoNames code that cities use for their state: "02"
}

interface City {
  name: string;
  adminCode: string;
  population: number;
}

export const REMOTE_CITY = "Remote";

// Australian states, by full name or abbreviation: "nsw" and "new south wales" -> New South Wales.
const statesByName = new Map<string, State>();
const statesByAdminCode = new Map<string, State>();
const require = createRequire(import.meta.url);
const stateRows = require("iso3166-2-db/regions/AU/en.json") as {
  name: string;
  iso: string;
  admin: string;
}[];
for (const row of stateRows) {
  const state = { name: row.name, adminCode: row.admin };
  statesByName.set(toKey(row.name), state);
  statesByName.set(toKey(row.iso), state);
  statesByAdminCode.set(row.admin, state);
}

// Australian cities by name, biggest first: "perth" -> [Perth WA, Perth TAS].
// For every other city name, the population of the biggest one outside Australia:
// "richmond" -> 220,289 (Richmond, Virginia).
const australianCities = new Map<string, City[]>();
const biggestElsewhere = new Map<string, number>();
for (const row of allCities) {
  for (const key of new Set([toKey(row.name), toKey(row.altName)])) {
    if (!key) continue;
    if (row.country === "AU") {
      const city = {
        name: row.name,
        adminCode: row.adminCode,
        population: row.population,
      };
      australianCities.set(key, [...(australianCities.get(key) ?? []), city]);
    } else {
      biggestElsewhere.set(
        key,
        Math.max(biggestElsewhere.get(key) ?? 0, row.population),
      );
    }
  }
}
for (const cities of australianCities.values()) {
  cities.sort((a, b) => b.population - a.population);
}

// Returns the job's Australian city and state, or null when the job isn't in Australia.
//   "Sydney, NSW"       -> Sydney, New South Wales
//   "Aus, NSW"          -> no city, New South Wales
//   "Remote - Victoria" -> Remote, Victoria
//   "Seattle, WA" / "London, UK" / "Remote" -> null
export function parseLocation(text: string | null): AustralianLocation | null {
  if (!text) return null;

  // "Sydney (Hybrid), NSW" -> ["Sydney", "NSW"]
  const parts = text
    .split(/[,()]/)
    .map((part) =>
      part
        .trim()
        .replace(/^(remote|hybrid)\b[\s\-–:/]*/i, "")
        .replace(/[\s\-–:/]*\b(remote|hybrid)$/i, "")
        .trim(),
    )
    .filter((part) => part !== "");

  // 1. Go through the parts. Anything that points outside Australia drops the job.
  let state: State | undefined;
  let namesAustralia = false;
  const cityKeys: string[] = [];
  for (const part of parts) {
    const key = toKey(part);
    const countryCode = countryCodeOf(part);

    if (statesByName.has(key)) {
      state ??= statesByName.get(key);
      namesAustralia = true;
    } else if (countryCode === "AU") {
      namesAustralia = true;
    } else if (countryCode) {
      return null; // another country: "UK", "United States"
    } else if (australianCities.has(key)) {
      cityKeys.push(key);
    } else if (biggestElsewhere.has(key)) {
      return null; // a city that only exists outside Australia: "Seattle"
    }
  }

  // 2. Pick the city: the one in the named state if there is one, otherwise the biggest.
  //    With no state or "Australia" in the text, the Australian city must be the biggest
  //    place with that name: "Perth" stays, "Richmond" (Virginia is bigger) goes.
  let city: City | undefined;
  for (const key of cityKeys) {
    const cities = australianCities.get(key)!;
    const candidate = state
      ? cities.find((c) => c.adminCode === state!.adminCode)
      : cities[0];
    const outnumbered =
      candidate && candidate.population < (biggestElsewhere.get(key) ?? 0);
    if (candidate && (namesAustralia || !outnumbered)) {
      city = candidate;
      break;
    }
  }

  // 3. Keep the job only if something placed it in Australia (here there isn't enough data to justify).
  if (!namesAustralia && !city) return null;

  return {
    city: /\bremote\b/i.test(text) ? REMOTE_CITY : (city?.name ?? null),
    state:
      (state ?? (city && statesByAdminCode.get(city.adminCode)))?.name ?? null,
    country: "Australia",
  };
}

// Country names and aliases ("UK", "USA", "Aus"), alpha-2 and alpha-3 codes, in any case.
function countryCodeOf(value: string): string | null {
  return (
    countries.getAlpha2Code(value, "en") ??
    (value.length === 3 ? countries.toAlpha2(value) : undefined) ??
    (value.length === 2 && countries.isValid(value)
      ? value.toUpperCase()
      : undefined) ??
    null
  );
}

// Lowercase, without accents or full stops: "Zürich" -> "zurich", "D.C." -> "dc".
function toKey(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/\./g, "")
    .trim()
    .toLowerCase();
}
