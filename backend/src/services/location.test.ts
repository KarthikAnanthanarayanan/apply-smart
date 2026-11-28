import assert from "node:assert/strict";
import { test } from "node:test";
import { parseLocation } from "./ats/normalise.js";

// [input, city, state]; country is always Australia.
const IN_AUSTRALIA: [string, string | null, string | null][] = [
  ["Sydney, NSW, Australia", "Sydney", "New South Wales"],
  ["Aus, NSW", null, "New South Wales"],
  ["Melbourne, VIC", "Melbourne", "Victoria"],
  ["Richmond, Victoria", "Richmond", "Victoria"],
  ["Perth, WA", "Perth", "Western Australia"],
  ["Sydney", "Sydney", "New South Wales"],
  ["Brisbane, Australia", "Brisbane", "Queensland"],
  ["Remote, Australia", "Remote", null],
  ["Remote - Victoria", "Remote", "Victoria"],
  ["Sydney (Remote)", "Remote", "New South Wales"],
];

const OUTSIDE_AUSTRALIA = [
  "Seattle, WA",
  "San Francisco, CA",
  "Toronto, CA",
  "Berlin, DE",
  "Perth, United Kingdom",
  "Richmond",
  "London",
  "Remote",
  "Remote (US)",
  "Remote - APAC",
];

for (const [input, city, state] of IN_AUSTRALIA) {
  test(`parseLocation(${JSON.stringify(input)}) is in Australia`, () => {
    assert.deepEqual(parseLocation(input), { city, state, country: "Australia" });
  });
}

for (const input of OUTSIDE_AUSTRALIA) {
  test(`parseLocation(${JSON.stringify(input)}) is outside Australia`, () => {
    assert.equal(parseLocation(input), null);
  });
}
