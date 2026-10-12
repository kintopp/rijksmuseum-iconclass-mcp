#!/usr/bin/env node
// build-fixture-db.mjs — small iconclass.db + iconclass-counts.db pair for hermetic tool tests.
//
// Build (default):  node scripts/tests/build-fixture-db.mjs [name]
// Capture schema:   node scripts/tests/build-fixture-db.mjs --capture
//
// Capture (maintainer only) dumps the real DBs' DDL to the committed fixtures/*.sql.
// Re-run it after every main- or counts-DB rebuild and review the diff. Build replays
// that DDL into fixtures/.generated/ and seeds the rows below. It never reads data/,
// so it runs in CI.
//
// Every notation, text and keyword row is copied from the real DB (Iconclass is CC0).
// children[] is trimmed to the seeded set. refs[] and path[] keep their real values,
// so unresolved references and parents occur exactly as they do in production.
// Collection counts are real for rijksmuseum. "testmuseum" is invented: a second
// collection gives coverage two tiers and gives find_artworks a search_url_template.

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const FIXTURE_DIR = path.join(__dirname, "fixtures");
const GENERATED_DIR = path.join(FIXTURE_DIR, ".generated");
const MAIN_SCHEMA = path.join(FIXTURE_DIR, "iconclass-schema.sql");
const COUNTS_SCHEMA = path.join(FIXTURE_DIR, "counts-schema.sql");

// FTS5 shadow tables are recreated by their virtual table. The vec0 table and
// iconclass_embeddings stay out, so the server never enables semantic search and
// never loads the embedding model.
const EXCLUDED = /^(sqlite_|vec_iconclass|iconclass_embeddings$)|(_data|_idx|_docsize|_config|_content)$/;

// ── Capture ──────────────────────────────────────────────────────────────────

function captureOne(dbFile, outFile, label) {
  const src = path.join(PROJECT_ROOT, "data", dbFile);
  if (!fs.existsSync(src)) {
    console.error(`[capture] ${src} not found — capture runs on the maintainer's machine.`);
    process.exit(2);
  }
  const db = new Database(src, { readonly: true });
  const rows = db.prepare(
    `SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL
     ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END, name`
  ).all().filter((r) => !EXCLUDED.test(r.name));
  const version = db.prepare("SELECT key, value FROM version_info").all();
  db.close();
  const header = [
    `-- ${label} schema for the fixture DB. Regenerate after a rebuild and review the diff:`,
    "--   node scripts/tests/build-fixture-db.mjs --capture",
    "-- version_info at capture:",
    ...version.filter((v) => !v.key.startsWith("embedding")).map((v) => `--   ${v.key} = ${v.value}`),
    "", "",
  ].join("\n");
  fs.writeFileSync(outFile, header + rows.map((r) => `${r.sql.trim()};`).join("\n\n") + "\n");
  console.log(`[capture] wrote ${path.relative(PROJECT_ROOT, outFile)} (${rows.length} statements)`);
}

function capture() {
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  captureOne("iconclass.db", MAIN_SCHEMA, "iconclass.db");
  captureOne("iconclass-counts.db", COUNTS_SCHEMA, "iconclass-counts.db");
}

// ── Seed ─────────────────────────────────────────────────────────────────────

// notation, path, children, refs, base_notation, key_id, is_key_expanded
const NOTATIONS = [
  ["1", [], ["12"], [], null, null, 0],
  ["12", ["1"], ["12A"], [], null, null, 0],
  ["12A", ["1","12"], ["12A2"], [], null, null, 0],
  ["12A2", ["1","12","12A"], ["12A27"], [], null, null, 0],
  ["12A27", ["1","12","12A","12A2"], [], [], null, null, 0],
  ["12A27(...)", ["1","12","12A","12A2","12A27"], ["12A27(Deut. 21:22-23)","12A27(Deut. 25:2-3)"], [], null, null, 0],
  ["12A27(Deut. 21:22-23)", ["1","12","12A","12A2","12A27","12A27(...)"], [], [], null, null, 0],
  ["12A27(Deut. 21:22-23)(+0)", ["1","12","12A","12A2","12A27","12A27(...)","12A27(Deut. 21:22-23)"], [], [], "12A27(Deut. 21:22-23)", "+0", 1],
  ["12A27(Deut. 25:2-3)", ["1","12","12A","12A2","12A27","12A27(...)"], [], [], null, null, 0],
  ["11D35", ["1","11","11D","11D3"], [], ["11D326","11H(JOSEPH OF ARIMATHAEA)41","11P118","11Q651","73D6"], null, null, 0],
  ["11H(VINCENT FERRER)(+3)", ["1","11","11H","11H(...)","11H(VINCENT FERRER)"], [], [], "11H(VINCENT FERRER)", "+3", 1],
  ["3", [], ["31"], [], null, null, 0],
  ["31", ["3"], ["31E"], [], null, null, 0],
  ["31E", ["3","31"], ["31E2"], ["31F"], null, null, 0],
  ["31E2", ["3","31","31E"], ["31E23"], [], null, null, 0],
  ["31E23", ["3","31","31E","31E2"], ["31E235"], [], null, null, 0],
  ["31E235", ["3","31","31E","31E2","31E23"], ["31E2356"], [], null, null, 0],
  ["31E2356", ["3","31","31E","31E2","31E23","31E235"], [], ["44G321(CROSS)"], null, null, 0],
  ["7", [], ["73"], [], null, null, 0],
  ["73", ["7"], ["73D"], ["11H","11HH","11I7"], null, null, 0],
  ["73D", ["7","73"], ["73D1","73D2","73D3","73D4","73D5","73D6","73D7","73D8","73D9"], [], null, null, 0],
  ["73D1", ["7","73","73D"], [], [], null, null, 0],
  ["73D2", ["7","73","73D"], ["73D24"], [], null, null, 0],
  ["73D24", ["7","73","73D","73D2"], [], ["11D3341"], null, null, 0],
  ["73D3", ["7","73","73D"], [], [], null, null, 0],
  ["73D4", ["7","73","73D"], [], ["73D54"], null, null, 0],
  ["73D5", ["7","73","73D"], [], [], null, null, 0],
  ["73D6", ["7","73","73D"], ["73D64","73D67"], ["11D35"], null, null, 0],
  ["73D64", ["7","73","73D","73D6"], [], [], null, null, 0],
  ["73D67", ["7","73","73D","73D6"], ["73D671"], ["11B3231"], null, null, 0],
  ["73D671", ["7","73","73D","73D6","73D67"], ["73D6712"], [], null, null, 0],
  ["73D6712", ["7","73","73D","73D6","73D67","73D671"], [], [], null, null, 0],
  ["73D7", ["7","73","73D"], [], [], null, null, 0],
  ["73D8", ["7","73","73D"], ["73D81","73D82","73D83"], [], null, null, 0],
  ["73D81", ["7","73","73D","73D8"], [], [], null, null, 0],
  ["73D82", ["7","73","73D","73D8"], [], ["11D312"], null, null, 0],
  ["73D82(...)", ["7","73","73D","73D8","73D82"], ["73D82(CROSS)","73D82(NAILS)"], [], null, null, 0],
  ["73D82(CROSS)", ["7","73","73D","73D8","73D82","73D82(...)"], [], [], null, null, 0],
  ["73D82(NAILS)", ["7","73","73D","73D8","73D82","73D82(...)"], [], [], null, null, 0],
  ["73D83", ["7","73","73D","73D8"], [], [], null, null, 0],
  ["73D9", ["7","73","73D"], [], ["73C1351"], null, null, 0],
  ["2", [], ["25"], [], null, null, 0],
  ["25", ["2"], ["25F"], [], null, null, 0],
  ["25F", ["2","25"], ["25F2"], ["34"], null, null, 0],
  ["25F2", ["2","25","25F"], ["25F23"], [], null, null, 0],
  ["25F23", ["2","25","25F","25F2"], [], ["34B11","34B12"], null, null, 0],
  ["25F23(+0)", ["2","25","25F","25F2","25F23"], [], ["34B11","34B12"], "25F23", "+0", 1],
  ["25F23(+1)", ["2","25","25F","25F2","25F23"], ["25F23(+11)","25F23(+12)","25F23(+13)","25F23(+14)","25F23(+15)"], ["34B11","34B12"], "25F23", "+1", 1],
  ["25F23(+11)", ["2","25","25F","25F2","25F23","25F23(+1)"], [], ["34B11","34B12"], "25F23", "+11", 1],
  ["25F23(+12)", ["2","25","25F","25F2","25F23","25F23(+1)"], [], ["34B11","34B12"], "25F23", "+12", 1],
  ["25F23(+13)", ["2","25","25F","25F2","25F23","25F23(+1)"], [], ["34B11","34B12"], "25F23", "+13", 1],
  ["25F23(+14)", ["2","25","25F","25F2","25F23","25F23(+1)"], [], ["34B11","34B12"], "25F23", "+14", 1],
  ["25F23(+15)", ["2","25","25F","25F2","25F23","25F23(+1)"], ["25F23(+151)","25F23(+152)","25F23(+153)","25F23(+154)"], ["34B11","34B12"], "25F23", "+15", 1],
  ["25F23(+151)", ["2","25","25F","25F2","25F23","25F23(+1)","25F23(+15)"], [], ["34B11","34B12"], "25F23", "+151", 1],
  ["25F23(+152)", ["2","25","25F","25F2","25F23","25F23(+1)","25F23(+15)"], [], ["34B11","34B12"], "25F23", "+152", 1],
  ["25F23(+153)", ["2","25","25F","25F2","25F23","25F23(+1)","25F23(+15)"], [], ["34B11","34B12"], "25F23", "+153", 1],
  ["25F23(+154)", ["2","25","25F","25F2","25F23","25F23(+1)","25F23(+15)"], [], ["34B11","34B12"], "25F23", "+154", 1],
  ["25F23(+2)", ["2","25","25F","25F2","25F23"], ["25F23(+21)","25F23(+22)","25F23(+23)","25F23(+24)"], ["34B11","34B12"], "25F23", "+2", 1],
  ["25F23(+21)", ["2","25","25F","25F2","25F23","25F23(+2)"], [], ["34B11","34B12"], "25F23", "+21", 1],
  ["25F23(+22)", ["2","25","25F","25F2","25F23","25F23(+2)"], [], ["34B11","34B12"], "25F23", "+22", 1],
  ["25F23(+23)", ["2","25","25F","25F2","25F23","25F23(+2)"], [], ["34B11","34B12"], "25F23", "+23", 1],
  ["25F23(+24)", ["2","25","25F","25F2","25F23","25F23(+2)"], [], ["34B11","34B12"], "25F23", "+24", 1],
  ["25F23(+3)", ["2","25","25F","25F2","25F23"], ["25F23(+31)","25F23(+32)","25F23(+33)"], ["34B11","34B12"], "25F23", "+3", 1],
  ["25F23(+31)", ["2","25","25F","25F2","25F23","25F23(+3)"], [], ["34B11","34B12"], "25F23", "+31", 1],
  ["25F23(+32)", ["2","25","25F","25F2","25F23","25F23(+3)"], ["25F23(+321)","25F23(+322)","25F23(+323)"], ["34B11","34B12"], "25F23", "+32", 1],
  ["25F23(+321)", ["2","25","25F","25F2","25F23","25F23(+3)","25F23(+32)"], ["25F23(+3211)","25F23(+3212)"], ["34B11","34B12"], "25F23", "+321", 1],
  ["25F23(+3211)", ["2","25","25F","25F2","25F23","25F23(+3)","25F23(+32)","25F23(+321)"], [], ["34B11","34B12"], "25F23", "+3211", 1],
  ["25F23(+3212)", ["2","25","25F","25F2","25F23","25F23(+3)","25F23(+32)","25F23(+321)"], [], ["34B11","34B12"], "25F23", "+3212", 1],
  ["25F23(+322)", ["2","25","25F","25F2","25F23","25F23(+3)","25F23(+32)"], [], ["34B11","34B12"], "25F23", "+322", 1],
  ["25F23(+323)", ["2","25","25F","25F2","25F23","25F23(+3)","25F23(+32)"], [], ["34B11","34B12"], "25F23", "+323", 1],
  ["25F23(+33)", ["2","25","25F","25F2","25F23","25F23(+3)"], ["25F23(+331)","25F23(+332)","25F23(+333)"], ["34B11","34B12"], "25F23", "+33", 1],
  ["25F23(+331)", ["2","25","25F","25F2","25F23","25F23(+3)","25F23(+33)"], [], ["34B11","34B12"], "25F23", "+331", 1],
  ["25F23(+332)", ["2","25","25F","25F2","25F23","25F23(+3)","25F23(+33)"], [], ["34B11","34B12"], "25F23", "+332", 1],
  ["25F23(+333)", ["2","25","25F","25F2","25F23","25F23(+3)","25F23(+33)"], [], ["34B11","34B12"], "25F23", "+333", 1],
  ["25F23(+4)", ["2","25","25F","25F2","25F23"], ["25F23(+46)"], ["34B11","34B12"], "25F23", "+4", 1],
  ["25F23(+46)", ["2","25","25F","25F2","25F23","25F23(+4)"], [], ["34B11","34B12"], "25F23", "+46", 1],
];

// notation, lang, text. English everywhere; every language for 73D and 73D6.
const TEXTS = [
  ["1", "en", "Religion and Magic"],
  ["12", "en", "non-Christian religions (including institutions, customs and antiquities)"],
  ["12A", "en", "Jewish religion and culture"],
  ["12A2", "en", "biblical laws, justice and government ~ Jewish religion"],
  ["12A27", "en", "other Jewish laws"],
  ["12A27(...)", "en", "other Jewish laws (with BOOK CHAPTER:VERSE)"],
  ["12A27(Deut. 21:22-23)", "en", "Jewish law of the burial of hanged sinners"],
  ["12A27(Deut. 21:22-23)(+0)", "en", "Jewish law of the burial of hanged sinners (+ variant)"],
  ["12A27(Deut. 25:2-3)", "en", "Jewish law of the forty stripes for a guilty man"],
  ["11D35", "en", "specific types of crucified Christ (in non-narrative context)"],
  ["11H(VINCENT FERRER)(+3)", "en", "the Dominican friar Vincent Ferrer of Valencia (or Vannes); possible attributes: book, baptismal font, cardinal's hat at feet, flames, flaming sword, IHS monogram, lily, sun, trumpet of the Last Judgement (+ angel(s))"],
  ["3", "en", "Human Being, Man in General"],
  ["31", "en", "man in a general biological sense"],
  ["31E", "en", "death of human being"],
  ["31E2", "en", "causes of death"],
  ["31E23", "en", "violent death, being killed; being mishandled and maltreated; seeking death"],
  ["31E235", "en", "violent death ~ maltreatment, torture"],
  ["31E2356", "en", "violent death by crucifixion"],
  ["7", "en", "Bible"],
  ["73", "en", "New Testament"],
  ["73D", "de", "die Passion Christi"],
  ["73D", "en", "Passion of Christ"],
  ["73D", "es", "la Pasión de Jesucristo"],
  ["73D", "fi", "Kristuksen kärsimys"],
  ["73D", "fr", "la Passion de Jésus-Christ"],
  ["73D", "it", "Passione di Cristo"],
  ["73D", "jp", "キリストの受難"],
  ["73D", "nl", "Passie van Christus"],
  ["73D", "pl", "męka Chrystusa"],
  ["73D", "pt", "Paixão de Cristo"],
  ["73D1", "en", "prelude to Christ's Passion"],
  ["73D2", "en", "the episode of the Last Supper"],
  ["73D24", "en", "Last Supper (in general) (Matthew 26:21-35; Mark 14:18-31; Luke 22:3, 22:15-23; John 13:21-38)"],
  ["73D3", "en", "Christ's arrest, trial, and torture"],
  ["73D4", "en", "from Pilate's palace to Golgotha: the procession to Calvary (Matthew 27:31-33; Mark 15:20-22; Luke 23:26-33; John 19:17)"],
  ["73D5", "en", "the crucifixion of Christ: prelude to Christ's death on the cross (Matthew 27:34-44; Mark 15:23-32; Luke 23:33-43; John 19:18-24)"],
  ["73D6", "de", "die Kreuzigung Christi: der Kreuzestod; Golgatha (Matthäus 27:45-58; Markus 15:33-45; Lukas 23:44-52; Johannes 19:25-38)"],
  ["73D6", "en", "the crucifixion of Christ: Christ's death on the cross; Golgotha (Matthew 27:45-58; Mark 15:33-45; Luke 23:44-52; John 19:25-38)"],
  ["73D6", "es", "la crucifixión de Cristo: muerte de Cristo en la cruz; Gólgota (Mateo 27:45-58; Marcos 15:33-45; Lucas 23:44-52; Juan 19:25-38)"],
  ["73D6", "fi", "ristiinnaulittu Kristus: Kristuksen kuolema ristillä; Golgata (Matt. 27:45-58; Mark. 15:33-45; Luuk. 23:44-52; Joh. 19:25-38)"],
  ["73D6", "fr", "la crucifixion de Jésus-Christ : mort de Jésus-Christ sur la croix; Golgotha (Matthieu 27:45-58; Marc 15:33-45; Luc 23:44-52; Jean 19:25-38)"],
  ["73D6", "it", "crocifissione di Cristo: morte di Cristo sulla croce; Golgota (Mt. 27, 45-58; Mc. 15, 33-45; Lc. 23, 44-52; Gv. 19, 25-38)"],
  ["73D6", "jp", "キリストの磔刑: 十字架上のキリストの死; ゴルゴタ (マタイによる福音書 27:45-58; マルコによる福音書 15:33-45; ルカによる福音書 23:44-52; ヨハネによる福音書 19:25-38)"],
  ["73D6", "nl", "kruisdood"],
  ["73D6", "pt", "a crucificação de Cristo: morte de Cristo na cruz; Gólgota (Mateus 27, 45-58; Marcos 15, 33-45; Lucas 23, 44-52; João 19, 25-38)"],
  ["73D64", "en", "crucified Christ, with particular persons under the cross"],
  ["73D67", "en", "iconographic particularities of crucifixion scenes (to be used as additional notation only)"],
  ["73D671", "en", "particularities of crucifixion scenes ~ Christ himself (additional notation only)"],
  ["73D6712", "en", "loin-cloth ~ particularities of crucifixion scenes"],
  ["73D7", "en", "from Christ's deposition to his entombment (Matthew 27:58-66; Mark 15:46-47; Luke 23:53-56; John 19:39-42)"],
  ["73D8", "en", "the instruments of the Passion and the five wounded limbs"],
  ["73D81", "en", "'Arma Christi'"],
  ["73D82", "en", "single instruments of the Passion"],
  ["73D82(...)", "en", "single instruments of the Passion (with NAME)"],
  ["73D82(CROSS)", "en", "cross ~ instruments of the Passion"],
  ["73D82(NAILS)", "en", "nails ~ instruments of the Passion"],
  ["73D83", "en", "the five wounded limbs of Christ: heart (side-wound), hands, and feet"],
  ["73D9", "en", "Christ in the underworld, harrowing of hell, Christ in Limbo, 'descensus ad inferos', 'Anastasis'"],
  ["2", "en", "Nature"],
  ["25", "en", "earth, world as celestial body"],
  ["25F", "en", "animals"],
  ["25F2", "en", "mammals"],
  ["25F23", "en", "beasts of prey, predatory animals"],
  ["25F23(+0)", "en", "beasts of prey, predatory animals (+ variant)"],
  ["25F23(+1)", "en", "beasts of prey, predatory animals (+ animals used symbolically)"],
  ["25F23(+11)", "en", "beasts of prey, predatory animals (+ bestiaries, 'Physiologus')"],
  ["25F23(+12)", "en", "beasts of prey, predatory animals (+ heraldic animals)"],
  ["25F23(+13)", "en", "beasts of prey, predatory animals (+ animals as attributes)"],
  ["25F23(+14)", "en", "beasts of prey, predatory animals (+ animals in caricature)"],
  ["25F23(+15)", "en", "beasts of prey, predatory animals (+ ornamental variants of animals)"],
  ["25F23(+151)", "en", "beasts of prey, predatory animals (+ symmetrically placed ornamental animals)"],
  ["25F23(+152)", "en", "beasts of prey, predatory animals (+ ornamental animals, partly joined)"],
  ["25F23(+153)", "en", "beasts of prey, predatory animals (+ ornamental animals, partly interlaced)"],
  ["25F23(+154)", "en", "beasts of prey, predatory animals (+ symmetrically placed ornamental animals, divided by a (human) figure or an object)"],
  ["25F23(+2)", "en", "beasts of prey, predatory animals (+ sex and age of animals; propagation of animals)"],
  ["25F23(+21)", "en", "beasts of prey, predatory animals (+ young animal)"],
  ["25F23(+22)", "en", "beasts of prey, predatory animals (+ male animal)"],
  ["25F23(+23)", "en", "beasts of prey, predatory animals (+ female animal)"],
  ["25F23(+24)", "en", "beasts of prey, predatory animals (+ very old animal)"],
  ["25F23(+3)", "en", "beasts of prey, predatory animals (+ anatomy of animals)"],
  ["25F23(+31)", "en", "beasts of prey, predatory animals (+ skeleton of an animal)"],
  ["25F23(+32)", "en", "beasts of prey, predatory animals (+ trunk of an animal)"],
  ["25F23(+321)", "en", "beasts of prey, predatory animals (+ sexual organs of an animal)"],
  ["25F23(+3211)", "en", "beasts of prey, predatory animals (+ sexual organs of a male animal)"],
  ["25F23(+3212)", "en", "beasts of prey, predatory animals (+ sexual organs of a female animal)"],
  ["25F23(+322)", "en", "beasts of prey, predatory animals (+ buttocks of an animal)"],
  ["25F23(+323)", "en", "beasts of prey, predatory animals (+ entrails, internal organs of an animal)"],
  ["25F23(+33)", "en", "beasts of prey, predatory animals (+ head of an animal)"],
  ["25F23(+331)", "en", "beasts of prey, predatory animals (+ skull of an animal)"],
  ["25F23(+332)", "en", "beasts of prey, predatory animals (+ antlers; horn)"],
  ["25F23(+333)", "en", "beasts of prey, predatory animals (+ ears of an animal)"],
  ["25F23(+4)", "en", "beasts of prey, predatory animals (+ animal behaviour)"],
  ["25F23(+46)", "en", "beasts of prey, predatory animals (+ sleeping animal(s))"],
];

// notation, lang, keyword
const KEYWORDS = [
  ["73D6", "de", "Golgatha"], ["73D6", "de", "Johannes 19"], ["73D6", "de", "Kalvarienberg"],
  ["73D6", "de", "Kreuzigung"], ["73D6", "de", "Lukas 23"], ["73D6", "de", "Markus 15"],
  ["73D6", "de", "Matthaeus 27"], ["73D6", "de", "Tod"], ["73D6", "de", "letzte Stunden"],
  ["73D6", "en", "Calvary"], ["73D6", "en", "Golgotha"], ["73D6", "en", "John 19"],
  ["73D6", "en", "Luke 23"], ["73D6", "en", "Mark 15"], ["73D6", "en", "Matthew 27"],
  ["73D6", "en", "crucifixion"], ["73D6", "en", "death"], ["73D6", "en", "last hours"],
  ["73D", "de", "Christus"], ["73D", "de", "Passion Christi"],
  ["73D", "en", "Christ"], ["73D", "en", "Passion of Christ"],
  ["73D24", "de", "Johannes 13"], ["73D24", "de", "Lukas 22"], ["73D24", "de", "Markus 14"], ["73D24", "de", "Matthaeus 26"],
  ["73D24", "en", "John 13"], ["73D24", "en", "Luke 22"], ["73D24", "en", "Mark 14"], ["73D24", "en", "Matthew 26"],
  ["25F23", "de", "Raubtier"], ["25F23", "en", "predatory animal"],
];

// collection_id, label, counts_as_of, search_url_template
const COLLECTIONS = [
  ["rijksmuseum", "Rijksmuseum, Amsterdam", "2026-06-13", null],
  ["testmuseum", "Test Museum", "2026-01-01", "https://collection.example.org/search?iconclass={notation}"],
];

// "99X" is in no seeded notation: totalNotations must not count it.
const RIJKS_COUNTS = [
  ["1", 6], ["12", 25], ["12A", 54], ["12A2", 6], ["11D35", 33],
  ["3", 51], ["31", 123], ["31E", 128], ["31E23", 282], ["31E235", 100], ["31E2356", 27],
  ["7", 139], ["73", 220], ["73D", 109], ["73D2", 66], ["73D24", 242], ["73D3", 16], ["73D4", 13],
  ["73D5", 41], ["73D6", 379], ["73D64", 85], ["73D67", 1], ["73D7", 8], ["73D8", 39], ["73D81", 87],
  ["73D82", 65], ["73D82(CROSS)", 17], ["73D82(NAILS)", 18], ["73D83", 3], ["73D9", 26],
  ["2", 9], ["25", 191], ["25F", 1124], ["25F2", 67], ["25F23", 182],
  ["25F23(+21)", 1], ["25F23(+331)", 1], ["25F23(+333)", 1],
  ["99X", 5],
];
const TEST_COUNTS = [
  ["73D6", 500], ["12A27(Deut. 21:22-23)", 3], ["73D82(CROSS)", 4], ["25F23(+46)", 2], ["99X", 1],
];

// ── Build ────────────────────────────────────────────────────────────────────

function freshDb(file, schemaFile) {
  for (const f of [file, `${file}-journal`, `${file}-wal`, `${file}-shm`]) fs.rmSync(f, { force: true });
  const db = new Database(file);
  // The server opens the file read-only; a WAL file would need a writable -shm.
  db.pragma("journal_mode = DELETE");
  db.exec(fs.readFileSync(schemaFile, "utf-8"));
  return db;
}

function insertAll(db, sql, rows) {
  const stmt = db.prepare(sql);
  db.transaction(() => { for (const r of rows) stmt.run(...r); })();
}

/** Build fixture-<name>.db and fixture-<name>.counts.db; returns both paths.
 *  Each test file passes its own name: a build deletes the files first. */
export function buildFixture(name = "default") {
  fs.mkdirSync(GENERATED_DIR, { recursive: true });
  const mainPath = path.join(GENERATED_DIR, `fixture-${name}.db`);
  const countsPath = path.join(GENERATED_DIR, `fixture-${name}.counts.db`);

  const main = freshDb(mainPath, MAIN_SCHEMA);
  insertAll(main,
    "INSERT INTO notations (notation, path, children, refs, base_notation, key_id, is_key_expanded) VALUES (?, ?, ?, ?, ?, ?, ?)",
    NOTATIONS.map(([n, p, c, r, b, k, e]) => [n, JSON.stringify(p), JSON.stringify(c), JSON.stringify(r), b, k, e]));
  insertAll(main, "INSERT INTO texts (notation, lang, text) VALUES (?, ?, ?)", TEXTS);
  insertAll(main, "INSERT INTO keywords (notation, lang, keyword) VALUES (?, ?, ?)", KEYWORDS);
  // External-content FTS5 indexes nothing until rebuilt; without this every search returns 0.
  main.exec("INSERT INTO texts_fts(texts_fts) VALUES('rebuild')");
  main.exec("INSERT INTO keywords_fts(keywords_fts) VALUES('rebuild')");
  insertAll(main, "INSERT INTO version_info (key, value) VALUES (?, ?)", [
    ["schema_version", "3"], ["release_tag", "fixture"],
  ]);
  main.close();

  const counts = freshDb(countsPath, COUNTS_SCHEMA);
  insertAll(counts,
    "INSERT INTO collection_info (collection_id, label, counts_as_of, search_url_template) VALUES (?, ?, ?, ?)",
    COLLECTIONS);
  insertAll(counts, "INSERT INTO collection_counts (collection_id, notation, count) VALUES ('rijksmuseum', ?, ?)", RIJKS_COUNTS);
  insertAll(counts, "INSERT INTO collection_counts (collection_id, notation, count) VALUES ('testmuseum', ?, ?)", TEST_COUNTS);
  // COUNTS_DB_SPEC rejects a counts DB whose schema_version is below 3.
  insertAll(counts, "INSERT INTO version_info (key, value) VALUES (?, ?)", [
    ["schema_version", "3"], ["release_tag", "fixture"], ["built_at", "2026-01-01T00:00:00Z"],
  ]);
  counts.close();

  return { mainPath, countsPath };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--capture")) capture();
  else {
    const { mainPath, countsPath } = buildFixture(process.argv[2]);
    console.log(`[build] ${path.relative(PROJECT_ROOT, mainPath)} (${NOTATIONS.length} notations), ${path.relative(PROJECT_ROOT, countsPath)}`);
  }
}
