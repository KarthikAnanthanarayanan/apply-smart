import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { supabase } from "../src/queries/client.js";

const CSV_PATH = path.resolve(
  import.meta.dirname,
  "../data/esco/occupations_en.csv",
);
const INSERT_BATCH_SIZE = 500;

interface Synonym {
  raw_title: string;
  standard_title: string;
}

// RFC 4180 parser: quoted fields may contain commas, newlines and "" escapes.
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') inQuotes = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function splitLabels(cell: string | undefined): string[] {
  return (cell ?? "").split(/\r?\n/);
}

function buildSynonyms(csv: string): {
  synonyms: Synonym[];
  duplicatesSkipped: number;
} {
  const [header, ...rows] = parseCsv(csv.replace(/^﻿/, ""));
  if (!header) throw new Error(`${CSV_PATH} is empty`);

  const col = (name: string): number => {
    const index = header.indexOf(name);
    if (index === -1) throw new Error(`${CSV_PATH} has no "${name}" column`);
    return index;
  };
  const preferredCol = col("preferredLabel");
  const altCol = col("altLabels");
  const hiddenCol = col("hiddenLabels");

  // raw_title -> index of the occupation that claimed it first
  const owner = new Map<string, number>();
  const synonyms: Synonym[] = [];
  let duplicatesSkipped = 0;

  for (const [occupation, row] of rows.entries()) {
    const preferred = row[preferredCol]?.trim();
    if (!preferred) continue;

    const labels = [
      preferred,
      ...splitLabels(row[altCol]),
      ...splitLabels(row[hiddenCol]),
    ];
    for (const label of labels) {
      const raw = label.trim().toLowerCase();
      if (!raw) continue;

      const firstOwner = owner.get(raw);
      if (firstOwner === undefined) {
        owner.set(raw, occupation);
        synonyms.push({ raw_title: raw, standard_title: preferred });
      } else if (firstOwner !== occupation) {
        duplicatesSkipped++;
      }
    }
  }

  return { synonyms, duplicatesSkipped };
}

// ignoreDuplicates makes this ON CONFLICT (raw_title) DO NOTHING, so existing rows are kept.
async function insertSynonyms(synonyms: Synonym[]) {
  let written = 0;
  let failedRows = 0;

  for (let start = 0; start < synonyms.length; start += INSERT_BATCH_SIZE) {
    const batch = synonyms.slice(start, start + INSERT_BATCH_SIZE);
    const { data, error } = await supabase
      .from("title_synonyms")
      .upsert(batch, { onConflict: "raw_title", ignoreDuplicates: true })
      .select("raw_title");

    if (error) {
      failedRows += batch.length;
      console.error(
        `Insert rows ${start + 1}-${start + batch.length} failed: ${error.message}`,
      );
      continue;
    }
    written += data.length;
  }

  return { written, failedRows };
}

async function main(): Promise<void> {
  if (!existsSync(CSV_PATH)) {
    console.error(
      `ESCO file not found: ${CSV_PATH}\n` +
        "Download the ESCO English CSV export and place occupations_en.csv there.",
    );
    process.exitCode = 1;
    return;
  }

  const { synonyms, duplicatesSkipped } = buildSynonyms(
    readFileSync(CSV_PATH, "utf8"),
  );

  const { written, failedRows } = await insertSynonyms(synonyms);

  console.log(`Rows written: ${written}`);
  console.log(`Duplicates skipped: ${duplicatesSkipped}`);
  if (failedRows > 0) {
    console.log(`Failed to save: ${failedRows}`);
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
