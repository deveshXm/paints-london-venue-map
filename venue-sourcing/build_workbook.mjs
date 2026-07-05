import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SpreadsheetFile, Workbook } from "@oai/artifact-tool";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outputDir = path.join(__dirname, "outputs", "paints_london_venues");
const agentDir = path.join(__dirname, "agent_outputs");
const outputPath = path.join(outputDir, "PAINTS_London_Venue_Sourcing.xlsx");

const venueHeaders = [
  "Venue name",
  "District",
  "Neighbourhood / nearest station",
  "Category",
  "Tier",
  "Price",
  "PAINTS-Fit Score",
  "Aesthetic /25",
  "Category fit /20",
  "Story /15",
  "Operational /15",
  "Press /15",
  "Geography /10",
  "Obviousness penalty /-10",
  "Google Maps location",
  "Latitude",
  "Longitude",
  "Opening hours",
  "Walk-in policy",
  "Group suitability for 8-12 people",
  "Capacity notes",
  "Best time slot",
  "Why this venue fits PAINTS",
  "Anecdote / story",
  "What they serve or what's on view",
  "Safety notes",
  "Backup venue",
  "Backup walk time",
  "Backup score",
  "Risks / watch-outs",
  "Source URLs / citations",
];

const rejectedHeaders = [
  "Venue name",
  "District",
  "Category",
  "Reason rejected",
  "Source URLs / citations",
];

const districts = [
  "Barking and Dagenham",
  "Barnet",
  "Bexley",
  "Brent",
  "Bromley",
  "Camden",
  "City of London",
  "Croydon",
  "Ealing",
  "Enfield",
  "Greenwich",
  "Hackney",
  "Hammersmith and Fulham",
  "Haringey",
  "Harrow",
  "Havering",
  "Hillingdon",
  "Hounslow",
  "Islington",
  "Kensington and Chelsea",
  "Kingston upon Thames",
  "Lambeth",
  "Lewisham",
  "Merton",
  "Newham",
  "Redbridge",
  "Richmond upon Thames",
  "Southwark",
  "Sutton",
  "Tower Hamlets",
  "Waltham Forest",
  "Wandsworth",
  "Westminster",
];

const categories = [
  "Show & Tell Drinks",
  "Market Days",
  "Creative Walks",
  "Museum & Gallery Days",
  "Books & Coffee",
];

function asText(value) {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.join(" ");
  return String(value);
}

function asNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function venueRow(v) {
  return [
    asText(v.venue_name),
    asText(v.district),
    asText(v.neighbourhood_station),
    asText(v.category),
    asText(v.tier),
    asText(v.price),
    asNumber(v.paints_fit_score),
    asNumber(v.score_aesthetic_25),
    asNumber(v.score_category_fit_20),
    asNumber(v.score_story_15),
    asNumber(v.score_operational_15),
    asNumber(v.score_press_15),
    asNumber(v.score_geography_10),
    asNumber(v.score_obviousness_penalty_minus10),
    asText(v.google_maps_location),
    asNumber(v.latitude),
    asNumber(v.longitude),
    asText(v.opening_hours),
    asText(v.walk_in_policy),
    asText(v.group_suitability_8_12),
    asText(v.capacity_notes),
    asText(v.best_time_slot),
    asText(v.why_fits_paints),
    asText(v.anecdote_story),
    asText(v.serve_or_on_view),
    asText(v.safety_notes),
    asText(v.backup_venue),
    asText(v.backup_walk_time),
    asNumber(v.backup_score),
    asText(v.risks_watchouts),
    asText(v.source_urls_citations),
  ];
}

function rejectedRow(r) {
  return [
    asText(r.venue_name),
    asText(r.district),
    asText(r.category),
    asText(r.reason_rejected),
    asText(r.source_urls_citations),
  ];
}

async function loadAgentData() {
  let files = [];
  try {
    files = (await fs.readdir(agentDir)).filter((file) => file.endsWith(".json")).sort();
  } catch {
    files = [];
  }

  const venues = [];
  const rejected = [];
  const notes = [];
  const errors = [];

  for (const file of files) {
    const fullPath = path.join(agentDir, file);
    try {
      const parsed = JSON.parse(await fs.readFile(fullPath, "utf8"));
      for (const venue of parsed.venues ?? []) venues.push(venueRow(venue));
      for (const candidate of parsed.rejected_candidates ?? []) rejected.push(rejectedRow(candidate));
      for (const note of parsed.agent_notes ?? []) notes.push([asText(parsed.district), asText(note), file]);
    } catch (error) {
      errors.push([file, error.message]);
    }
  }

  return { files, venues, rejected, notes, errors };
}

function countRows(rows, district, category) {
  return rows.filter((row) => row[1] === district && row[3] === category).length;
}

function avgScore(rows, category) {
  const scores = rows
    .filter((row) => row[3] === category)
    .map((row) => row[6])
    .filter((score) => typeof score === "number");
  if (!scores.length) return null;
  return scores.reduce((sum, score) => sum + score, 0) / scores.length;
}

function safeRange(sheet, startRow, startCol, rows, cols) {
  return sheet.getRangeByIndexes(startRow, startCol, Math.max(rows, 1), Math.max(cols, 1));
}

function writeTable(sheet, startRow, startCol, headers, rows) {
  sheet.getRangeByIndexes(startRow, startCol, 1, headers.length).values = [headers];
  if (rows.length) {
    sheet.getRangeByIndexes(startRow + 1, startCol, rows.length, headers.length).values = rows;
  }
}

function styleHeader(range) {
  range.format.fill.color = "#1F2933";
  range.format.font.color = "#FFFFFF";
  range.format.font.bold = true;
  range.format.wrapText = true;
}

function styleSheet(sheet, headerRange, usedRange) {
  sheet.showGridLines = false;
  styleHeader(headerRange);
  usedRange.format.font.name = "Aptos";
  usedRange.format.font.size = 10;
  usedRange.format.borders = { preset: "inside", style: "thin", color: "#E5E7EB" };
  usedRange.format.wrapText = true;
  usedRange.format.autofitColumns();
  usedRange.format.autofitRows();
}

function setColumnWidths(sheet, rowCount, widths) {
  widths.forEach((width, col) => {
    sheet.getRangeByIndexes(0, col, Math.max(rowCount, 1), 1).format.columnWidth = width;
  });
}

async function main() {
  const { files, venues, rejected, notes, errors } = await loadAgentData();
  const workbook = Workbook.create();

  const venuesSheet = workbook.worksheets.add("Venues");
  writeTable(venuesSheet, 0, 0, venueHeaders, venues);
  venuesSheet.freezePanes.freezeRows(1);
  venuesSheet.freezePanes.freezeColumns(2);
  const venueUsed = safeRange(venuesSheet, 0, 0, Math.max(venues.length + 1, 2), venueHeaders.length);
  styleSheet(venuesSheet, venuesSheet.getRangeByIndexes(0, 0, 1, venueHeaders.length), venueUsed);
  setColumnWidths(venuesSheet, venues.length + 1, [
    26, 20, 28, 22, 8, 8, 12, 10, 12, 10, 12, 10, 10, 14, 34, 11, 11, 34, 30, 30, 30, 24, 45, 42, 38, 34, 28, 18, 12, 38, 55,
  ]);
  venuesSheet.getRangeByIndexes(1, 0, Math.max(venues.length, 1), venueHeaders.length).format.rowHeight = 52;
  venuesSheet.getRangeByIndexes(1, 6, Math.max(venues.length, 1), 8).format.horizontalAlignment = "right";
  venuesSheet.getRangeByIndexes(1, 15, Math.max(venues.length, 1), 2).format.numberFormat = [["0.000000", "0.000000"]];

  const districtSheet = workbook.worksheets.add("District Summary");
  const districtHeaders = ["District", "Total venues", ...categories];
  const districtRows = districts.map((district) => [
    district,
    venues.filter((row) => row[1] === district).length,
    ...categories.map((category) => countRows(venues, district, category)),
  ]);
  writeTable(districtSheet, 0, 0, districtHeaders, districtRows);
  districtSheet.freezePanes.freezeRows(1);
  styleSheet(
    districtSheet,
    districtSheet.getRangeByIndexes(0, 0, 1, districtHeaders.length),
    safeRange(districtSheet, 0, 0, districtRows.length + 1, districtHeaders.length),
  );
  setColumnWidths(districtSheet, districtRows.length + 1, [26, 12, 18, 14, 14, 22, 16]);

  const categorySheet = workbook.worksheets.add("Category Summary");
  const categoryHeaders = ["Category", "Count", "Average PAINTS score", "Tier A count", "Tier B count"];
  const categoryRows = categories.map((category) => [
    category,
    venues.filter((row) => row[3] === category).length,
    avgScore(venues, category),
    venues.filter((row) => row[3] === category && row[4] === "A").length,
    venues.filter((row) => row[3] === category && row[4] === "B").length,
  ]);
  writeTable(categorySheet, 0, 0, categoryHeaders, categoryRows);
  categorySheet.freezePanes.freezeRows(1);
  styleSheet(
    categorySheet,
    categorySheet.getRangeByIndexes(0, 0, 1, categoryHeaders.length),
    safeRange(categorySheet, 0, 0, categoryRows.length + 1, categoryHeaders.length),
  );
  setColumnWidths(categorySheet, categoryRows.length + 1, [24, 10, 18, 12, 12]);
  categorySheet.getRangeByIndexes(1, 2, Math.max(categoryRows.length, 1), 1).format.numberFormat = [["0.0"]];

  const rejectedSheet = workbook.worksheets.add("Rejected Candidates");
  writeTable(rejectedSheet, 0, 0, rejectedHeaders, rejected);
  rejectedSheet.freezePanes.freezeRows(1);
  styleSheet(
    rejectedSheet,
    rejectedSheet.getRangeByIndexes(0, 0, 1, rejectedHeaders.length),
    safeRange(rejectedSheet, 0, 0, Math.max(rejected.length + 1, 2), rejectedHeaders.length),
  );
  setColumnWidths(rejectedSheet, rejected.length + 1, [28, 22, 22, 55, 55]);
  rejectedSheet.getRangeByIndexes(1, 0, Math.max(rejected.length, 1), rejectedHeaders.length).format.rowHeight = 44;

  const notesSheet = workbook.worksheets.add("Source / Notes");
  const completedDistricts = new Set(venues.map((row) => row[1]).filter(Boolean));
  const missingDistricts = districts.filter((district) => !completedDistricts.has(district));
  const noteRows = [
    ["Run date", "2026-07-04", ""],
    ["Workbook generated", new Date().toISOString(), ""],
    ["Agent output files found", files.length, files.join(", ")],
    ["Included venue rows", venues.length, ""],
    ["Rejected candidate rows", rejected.length, ""],
    ["Missing districts", missingDistricts.length, missingDistricts.join(", ")],
    ["Verification caveat", "Operational details may include UNVERIFIED - host must confirm where live hours, group walk-ins, capacity, or date-specific availability could not be verified from public sources.", ""],
    ["Scoring caveat", "Rows below score 65 should not be present; scores are source-assisted PAINTS scout judgments and require final host review before publishing.", ""],
    ["Creative Walks caveat", "Creative Walk rows should use only PAINTS-approved parks/routes from v6 safety list.", ""],
    ...notes.map(([district, note, file]) => [`Agent note - ${district}`, note, file]),
    ...errors.map(([file, error]) => [`Parse error - ${file}`, error, ""]),
  ];
  writeTable(notesSheet, 0, 0, ["Item", "Detail", "Source file"], noteRows);
  notesSheet.freezePanes.freezeRows(1);
  styleSheet(
    notesSheet,
    notesSheet.getRangeByIndexes(0, 0, 1, 3),
    safeRange(notesSheet, 0, 0, noteRows.length + 1, 3),
  );
  setColumnWidths(notesSheet, noteRows.length + 1, [28, 90, 34]);
  notesSheet.getRangeByIndexes(1, 0, Math.max(noteRows.length, 1), 3).format.rowHeight = 36;

  await fs.mkdir(outputDir, { recursive: true });
  const preview = await workbook.render({ sheetName: "District Summary", autoCrop: "all", scale: 1, format: "png" });
  await fs.writeFile(path.join(outputDir, "district_summary_preview.png"), new Uint8Array(await preview.arrayBuffer()));

  const errorsScan = await workbook.inspect({
    kind: "match",
    searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A",
    options: { useRegex: true, maxResults: 300 },
    summary: "final formula error scan",
  });
  console.log(errorsScan.ndjson);

  const output = await SpreadsheetFile.exportXlsx(workbook);
  await output.save(outputPath);
  console.log(JSON.stringify({ outputPath, venueRows: venues.length, rejectedRows: rejected.length, files: files.length }, null, 2));
}

await main();
