import allCities from "all-the-cities";
import countries from "i18n-iso-countries";

interface ParsedLocation {
  city: string | null;
  country: string | null;
}

interface CityEntry {
  name: string;
  countryCode: string;
  adminCode: string;
  population: number;
}

const COUNTRY_NAMES = new Intl.DisplayNames(["en"], { type: "region" });

export const REMOTE_CITY = "Remote";

// Built on first use from GeoNames (every city with 1,000+ people). Each list is most populous first.
let exactNames: Map<string, CityEntry[]> | null = null;
// Same cities keyed without a trailing " City", so "New York" finds "New York City".
let namesWithoutCity: Map<string, CityEntry[]> | null = null;

// e.g. "Sydney, NSW" -> { city: "Sydney", country: "Australia" },
// "Remote (US)" -> { city: "Remote", country: "United States" }.
export function parseLocation(location: string | null): ParsedLocation {
  const place = parsePlace(location ?? "");
  return /\bremote\b/i.test(location ?? "")
    ? { city: REMOTE_CITY, country: place.country }
    : place;
}

// "San Francisco, CA" -> { city: "San Francisco", country: "United States" }.
function parsePlace(location: string): ParsedLocation {
  // Parentheses separate parts too: "Remote (US)", "New York, NY (HQ)".
  const parts = location
    .split(/[,()]/)
    .map(stripWorkMode)
    .filter((part) => part !== "");

  // Two-letter parts are left undecided here: "CA" is California after a US city, Canada otherwise.
  let countryCode: string | null = null;
  const placeParts: string[] = [];
  for (const part of parts) {
    const code = isTwoLetters(part) ? null : countryCodeOf(part);
    if (code) countryCode ??= code;
    else placeParts.push(part);
  }
  const shortCodes = placeParts
    .filter(isTwoLetters)
    .map((part) => part.toUpperCase());

  for (const part of placeParts) {
    if (isTwoLetters(part)) continue;
    const city = pickCity(citiesNamed(part), countryCode, shortCodes);
    if (city) return { city: city.name, country: nameOfCountry(city.countryCode) };
  }

  countryCode ??= shortCodes.map(countryCodeOf).find((code) => code) ?? null;
  return { city: null, country: countryCode ? nameOfCountry(countryCode) : null };
}

// For a field that is known to hold a country, so two-letter values are ISO codes
// ("CA" is Canada here, not California). Unrecognised values give null.
export function countryName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const code = countryCodeOf(value.trim());
  return code ? nameOfCountry(code) : null;
}

// Takes the first non-null city and the first country found, in the order the sources are given.
export function mergeLocations(...sources: ParsedLocation[]): ParsedLocation {
  return {
    city: sources.find((source) => source.city)?.city ?? null,
    country: sources.find((source) => source.country)?.country ?? null,
  };
}

// Picks among same-named cities: the stated country ("Perth, United Kingdom"), a matching US
// state code ("Melbourne, FL"), a country code ("Perth, UK"), then the most populous
// ("Sydney" is Australia, not Nova Scotia).
function pickCity(
  candidates: CityEntry[],
  countryCode: string | null,
  shortCodes: string[],
): CityEntry | null {
  if (countryCode) {
    return candidates.find((city) => city.countryCode === countryCode) ?? null;
  }
  const byState = candidates.find((city) => shortCodes.includes(city.adminCode));
  if (byState) return byState;

  for (const code of shortCodes) {
    const country = countryCodeOf(code);
    const inCountry = candidates.find((city) => city.countryCode === country);
    if (inCountry) return inCountry;
  }
  return candidates[0] ?? null;
}

// Accepts country names and aliases ("UK", "USA"), alpha-2 and alpha-3 codes, in any case.
function countryCodeOf(value: string): string | null {
  if (value === "") return null;
  const code =
    countries.getAlpha2Code(value, "en") ??
    (value.length === 3 ? countries.toAlpha2(value) : undefined) ??
    (isTwoLetters(value) && countries.isValid(value)
      ? value.toUpperCase()
      : undefined);
  return code ?? null;
}

function nameOfCountry(code: string): string | null {
  return COUNTRY_NAMES.of(code) ?? null;
}

function citiesNamed(name: string): CityEntry[] {
  if (!exactNames || !namesWithoutCity) {
    [exactNames, namesWithoutCity] = buildCityIndexes();
  }
  const key = cityKey(name);
  return exactNames.get(key) ?? namesWithoutCity.get(key) ?? [];
}

function buildCityIndexes(): [
  Map<string, CityEntry[]>,
  Map<string, CityEntry[]>,
] {
  const exact = new Map<string, CityEntry[]>();
  const withoutCity = new Map<string, CityEntry[]>();
  const add = (
    index: Map<string, CityEntry[]>,
    key: string,
    entry: CityEntry,
  ) => {
    const list = index.get(key) ?? [];
    if (!list.includes(entry)) list.push(entry);
    index.set(key, list);
  };

  for (const city of allCities) {
    const entry: CityEntry = {
      name: city.name,
      countryCode: city.country,
      adminCode: city.adminCode,
      population: city.population,
    };
    for (const name of [city.name, city.altName]) {
      if (!name) continue;
      const key = cityKey(name);
      add(exact, key, entry);
      if (key.endsWith(" city")) {
        add(withoutCity, key.slice(0, -" city".length), entry);
      }
    }
  }

  for (const index of [exact, withoutCity]) {
    for (const list of index.values()) {
      list.sort((a, b) => b.population - a.population);
    }
  }
  return [exact, withoutCity];
}

// Lowercase without accents, so "Zurich" finds "Zürich".
function cityKey(name: string): string {
  return name
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase();
}

// "Remote - USA" -> "USA", "Sydney - Hybrid" -> "Sydney", "Remote" -> "".
function stripWorkMode(part: string): string {
  return part
    .trim()
    .replace(/^(remote|hybrid|on-?site|in-office)\b[\s\-–:/]*/i, "")
    .replace(/[\s\-–:/]*\b(remote|hybrid|on-?site|in-office)$/i, "")
    .trim();
}

function isTwoLetters(value: string): boolean {
  return /^[a-z]{2}$/i.test(value);
}
