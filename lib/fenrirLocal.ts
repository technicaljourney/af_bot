/**
 * Resolves prepared Fenrir submission artifacts from the local folder so the
 * auto-handler can patch findings without manual file-picking.
 *
 * Layout (observed in ../Fenrir):
 *   Fenrir/
 *     <repo>_submission/
 *       b1_*.patch  b2_*.patch  …      # one patch per bug (also q1_/f1_/fix_*)
 *       poc_b1.bin  …                  # crashing inputs
 *       fenrir.map.json                # OPTIONAL override (see below)
 *     <repo>_task_description.txt|md    # shared description (optional)
 *
 * A Fenrir finding's id is "<submissionId>:<index>". We map finding `index`
 * (0-based) to bug number `index + 1` and pick the patch whose leading number
 * matches (e.g. index 0 → b1_*.patch). Because positional mapping can be wrong,
 * a repo may include an OPTIONAL `fenrir.map.json` that pins it explicitly:
 *
 *   { "0": { "patch": "b1_overflow_v2.patch", "descriptionFile": "d0.txt" },
 *     "1": { "patch": "b2_record.patch", "description": "An OOB read in …" } }
 */

import { promises as fs } from "fs";
import path from "path";
import { createHash } from "crypto";

/** The Fenrir server keys a finding by the first 16 hex of its PoC's sha256
 *  (finding id "<sub>:poc:<hash16>"). We compute the same so already-submitted
 *  PoCs can be recognised and skipped instead of re-submitted (→ 409). */
function pocHash16(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex").slice(0, 16);
}

export interface FenrirFolder {
  key: string;
  label: string;
  dir: string;
}

/**
 * Work folders shown as tabs. Override with FENRIR_DIRS as a ";"-separated list
 * of "Label=/abs/path" pairs; otherwise defaults to the two sibling folders
 * Fenrir/ and Fenrir_Project/.
 */
export function getFenrirDirs(): FenrirFolder[] {
  const env = process.env.FENRIR_DIRS;
  if (env && env.trim()) {
    const out: FenrirFolder[] = [];
    env.split(";").forEach((pair, i) => {
      const eq = pair.indexOf("=");
      if (eq < 0) return;
      const label = pair.slice(0, eq).trim();
      const dir = pair.slice(eq + 1).trim();
      if (label && dir) out.push({ key: `f${i}`, label, dir });
    });
    if (out.length) return out;
  }
  const base = path.resolve(process.cwd(), "..");
  return [
    { key: "fenrir", label: "Fenrir", dir: path.join(base, "Fenrir") },
    { key: "project", label: "Fenrir_Project", dir: path.join(base, "Fenrir_Project") },
  ];
}

/** Resolve a folder key to its absolute dir (defaults to the first folder). */
export function fenrirDirByKey(key?: string): string {
  const dirs = getFenrirDirs();
  return (dirs.find((d) => d.key === key) || dirs[0]).dir;
}

/** Legacy single-folder accessor (FENRIR_DIR, else the first configured folder). */
export function getFenrirDir(): string {
  const env = process.env.FENRIR_DIR;
  if (env && env.trim()) return env.trim();
  return getFenrirDirs()[0].dir;
}

async function listDir(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}

// Different PoC/patch builders lay out a `<repo>_submission/` folder differently
// — flat files, or `pocs/` + `patches/by_bug/`, or other nestings. So we DISCOVER
// artifacts by walking the folder rather than assuming one layout.
const WALK_SKIP = /^(node_modules|\.git|target|build|dist|\.next|\.venv|__pycache__)$/i;

/** Recursively list every file under `root` (dir-relative paths, "/"-joined),
 *  skipping heavy/irrelevant directories and bounding the depth. */
async function walkFiles(root: string, maxDepth = 5): Promise<string[]> {
  const out: string[] = [];
  const rec = async (rel: string, depth: number): Promise<void> => {
    let entries: import("fs").Dirent[];
    try {
      entries = await fs.readdir(path.join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (depth < maxDepth && !WALK_SKIP.test(e.name)) await rec(childRel, depth + 1);
      } else if (e.isFile()) {
        out.push(childRel);
      }
    }
  };
  await rec("", 0);
  return out;
}

// A file is NOT a PoC crashing-input if it's a patch, a source file, a doc, an
// archive or a script.
const NON_POC_FILE = /\.(patch|c|cc|cpp|cxx|h|hpp|hh|rs|go|py|js|ts|tsx|java|rb|kt|swift|md|json|ya?ml|toml|lock|txt|zip|tar|gz|tgz|bz2|xz|sh|bat|ps1|cfg|ini|html?|css)$/i;
// A file that looks like a crashing input: in a poc/crash/input dir, or named as
// one, or a bare/binary blob under the submission folder.
// NOTE: deliberately NOT `corpus|inputs|seeds|testcases` — those are a fuzzer's
// accumulated corpus (thousands of seeds), not the curated PoCs we submit.
const POC_DIR = /(^|\/)(pocs?|crashes?|repro)(\/|$)/i;
const POC_NAME = /(^|[_./-])(poc|crash|iso|spoc|repro)([_.\-0-9]|$)/i;

/** Does this discovered file look like a submittable PoC crashing input? */
function looksLikePoc(rel: string): boolean {
  const base = rel.split("/").pop() || rel;
  if (NON_POC_FILE.test(base)) return false;
  if (base.startsWith(".") || base === "README" || /readme|bugmap|notes|status/i.test(base)) return false;
  return POC_DIR.test(rel) || POC_NAME.test(base);
}

/** A curated submission-artifacts folder (`<repo>_submission`), as opposed to a
 *  bare repo checkout. We only auto-DISCOVER PoCs/patches inside one of these —
 *  never inside a source tree (which has a fuzz corpus, tests, build output). */
function isSubmissionDir(dir: string): boolean {
  return /_submission$/i.test(path.basename(dir));
}

/** Find the prepared-artifacts dir for a repo. Case-insensitive, and always
 *  prefers the `<repo>_submission` dir (which holds the patches/PoCs) over the
 *  bare repo checkout — important when the GitHub name differs in case
 *  (e.g. repoName "Folio" vs folder "folio_submission"). */
async function matchRepoDir(
  repoName: string,
  root = getFenrirDir(),
  submissionOnly = false
): Promise<string | null> {
  const name = repoName.toLowerCase();
  const dirs: string[] = [];
  for (const e of await listDir(root)) {
    try {
      if ((await fs.stat(path.join(root, e))).isDirectory()) dirs.push(e);
    } catch {
      /* skip */
    }
  }
  const lc = (e: string) => e.toLowerCase();
  const base = (e: string) => lc(e).replace(/_submission$/, "");
  const pick =
    // 1. exact "<name>_submission"
    dirs.find((e) => lc(e) === `${name}_submission`) ||
    // 2. any "<prefix>_submission" where prefix == name or name starts with it
    dirs.find((e) => lc(e).endsWith("_submission") && (base(e) === name || name.startsWith(base(e)))) ||
    // 3/4. bare repo dir / prefix — only when not restricted to _submission dirs
    (submissionOnly
      ? undefined
      : dirs.find((e) => lc(e) === name) ||
        dirs
          .filter((e) => lc(e).startsWith(name))
          .sort((a, b) => Number(lc(b).includes("_submission")) - Number(lc(a).includes("_submission")))[0]);
  return pick ? path.join(root, pick) : null;
}

/** Find a repo's prepared-artifacts dir across ALL work folders (preferred
 *  folder first), so actions work regardless of which tab is active. */
async function matchRepoDirAny(
  repoName: string,
  preferred?: string
): Promise<string | null> {
  const dirs = getFenrirDirs().map((f) => f.dir);
  const ordered = preferred ? [preferred, ...dirs.filter((d) => d !== preferred)] : dirs;
  // Phase 1: a "<repo>_submission" dir in ANY folder (it holds the patches/PoCs)
  // wins over a bare repo checkout in the active folder.
  for (const d of ordered) {
    const hit = await matchRepoDir(repoName, d, true);
    if (hit) return hit;
  }
  // Phase 2: fall back to a bare repo dir / prefix match.
  for (const d of ordered) {
    const hit = await matchRepoDir(repoName, d, false);
    if (hit) return hit;
  }
  return null;
}

/** Union of repo base names across every work folder. */
export async function listAllLocalRepoNames(): Promise<string[]> {
  const names = new Set<string>();
  for (const f of getFenrirDirs()) {
    for (const n of await listLocalRepoNames(f.dir)) names.add(n);
  }
  return [...names];
}

/** Base names of repos present in the work folder (e.g. "strata" from both
 *  `strata/` and `strata_submission/`), lowercased — for filtering the task
 *  list to only repos you have locally. */
export async function listLocalRepoNames(root = getFenrirDir()): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch {
    return [];
  }
  const names = new Set<string>();
  for (const e of entries) {
    try {
      if (!(await fs.stat(path.join(root, e))).isDirectory()) continue;
    } catch {
      continue;
    }
    const base = e.replace(/_(submission|pocs)$/i, "").replace(/\.bak$/i, "");
    if (base) names.add(base.toLowerCase());
  }
  return [...names];
}

/** Leading bug number in a patch filename: b1_… / q1_… / f1_… / 1_… → 1. */
function bugNumber(file: string): number | null {
  const m = file.match(/^[a-z]*?(\d+)/i);
  return m ? Number(m[1]) : null;
}

/** The descriptive part of a patch filename, for signature-matching against a
 *  crash text: strip the dir, extension, a leading patch/fix/bug tag and the bug
 *  number. `patches/by_bug/patch_25_oob_lget.patch` → "oob_lget". */
function patchDescriptor(file: string): string {
  const base = (file.split("/").pop() || file).replace(/\.patch$/i, "");
  return base
    .replace(/^(patch|fix|bug|diff|golden)[_-]?/i, "")
    .replace(/^\d+[_-]?/, "")
    .toLowerCase();
}

interface MapEntry {
  patch?: string;
  poc?: string;
  description?: string;
  descriptionFile?: string;
  /** Substring(s) that must all appear in the finding's crash text (sanitizer
   *  class + function names) to bind this entry — robust against list order. */
  match?: string | string[];
}

/**
 * Load fenrir.map.json, distinguishing "no map" from "broken map".
 *   - file absent  → { map: null, error: null }   (discovery + filename-signature
 *                     handle map-less repos, whatever the builder's layout)
 *   - invalid JSON → { map: null, error: "…" }     (must NOT submit)
 *   - ok           → { map, error: null }
 * Accepts a flat index map or a `{ findings: {…} }` wrapper.
 */
async function loadMap(
  dir: string
): Promise<{ map: Record<string, MapEntry> | null; error: string | null }> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(dir, "fenrir.map.json"), "utf8");
  } catch {
    return { map: null, error: null }; // no explicit map → discover artifacts
  }
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch (e) {
    return { map: null, error: `fenrir.map.json is not valid JSON: ${(e as Error).message}` };
  }
  if (!o || typeof o !== "object") {
    return { map: null, error: "fenrir.map.json is not a JSON object" };
  }
  const wrap = o as { findings?: unknown; bugs?: unknown };
  // Array schema — { repo?, bugs: [ {poc, fix|patch, match, description?}, … ] },
  // { findings: [...] }, or a bare top-level array. Normalize to an index-keyed
  // record so finding index N ↔ element N, accepting `fix` as an alias for
  // `patch`. The object-form `{findings:{…}}` maps fall through untouched.
  const arr: unknown[] | null = Array.isArray(o)
    ? (o as unknown[])
    : Array.isArray(wrap.bugs)
    ? (wrap.bugs as unknown[])
    : Array.isArray(wrap.findings)
    ? (wrap.findings as unknown[])
    : null;
  if (arr) {
    const map: Record<string, MapEntry> = {};
    arr.forEach((b, i) => {
      if (!b || typeof b !== "object") return;
      const e = b as Record<string, unknown>;
      const entry: MapEntry = {};
      const patch = e.patch ?? e.fix;
      if (typeof patch === "string") entry.patch = patch;
      if (typeof e.poc === "string") entry.poc = e.poc;
      if (typeof e.description === "string") entry.description = e.description;
      const df = e.descriptionFile ?? e.descFile;
      if (typeof df === "string") entry.descriptionFile = df;
      if (typeof e.match === "string" || Array.isArray(e.match))
        entry.match = e.match as string | string[];
      map[String(i)] = entry;
    });
    return { map, error: null };
  }
  const map = (wrap.findings && typeof wrap.findings === "object" ? wrap.findings : o) as Record<
    string,
    MapEntry
  >;
  return { map, error: null };
}

async function readOverrideMap(dir: string): Promise<Record<string, MapEntry> | null> {
  return (await loadMap(dir)).map;
}

async function exists(p: string): Promise<boolean> {
  return fs.stat(p).then(
    () => true,
    () => false
  );
}

/** Validate a repo's fenrir.map.json: valid JSON + every referenced
 *  patch/poc/descriptionFile present. No map file → ok (convention used). */
export async function validateRepoMap(
  repoName: string,
  root = getFenrirDir()
): Promise<{ ok: boolean; error?: string }> {
  const dir = await matchRepoDirAny(repoName, root);
  if (!dir) return { ok: true }; // no local folder; resolvers report separately
  const { map, error } = await loadMap(dir);
  if (error) return { ok: false, error };
  if (!map) return { ok: true }; // no map → convention
  const base = path.basename(dir);
  for (const [k, e] of Object.entries(map)) {
    if (!e.patch && !e.poc) return { ok: false, error: `fenrir.map.json[${k}] has no patch or poc` };
    for (const [field, val] of [
      ["patch", e.patch],
      ["poc", e.poc],
      ["descriptionFile", e.descriptionFile],
    ] as const) {
      if (val && !(await exists(path.join(dir, val))))
        return { ok: false, error: `fenrir.map.json[${k}] ${field} not found: ${val} (in ${base})` };
    }
  }
  return { ok: true };
}

async function readText(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return null;
  }
}

// Sanitizer crash-class tokens — treated as SECONDARY (disambiguation-only)
// match terms, since the same bug's class can differ from what the map recorded
// (e.g. a "heap-use-after-free" entry that actually surfaces as a double-free).
// Every other token in a `match` array is an IDENTIFIER term (function/symbol)
// and must be present for the entry to bind.
const SANITIZER_CLASS =
  /^(heap-use-after-free|heap-buffer-overflow|stack-buffer-overflow|global-buffer-overflow|use-of-uninitialized-value|use-of-uninitialized|double-free|free-on-non-malloced|alloc-dealloc-mismatch|stack-overflow|out-of-memory|negative-size-param|segv|null-deref|deadly-signal)$/i;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whole-word (identifier-boundary) presence of `term` in `hay`, so a short
 *  symbol like "op_xref" does NOT spuriously match "op_xref_delta". */
function termInText(term: string, hay: string): boolean {
  const t = term.toLowerCase();
  if (!t) return false;
  const left = /\w/.test(t[0]) ? "\\b" : "";
  const right = /\w/.test(t[t.length - 1]) ? "\\b" : "";
  return new RegExp(left + escapeRe(t) + right).test(hay);
}

/** Does this map bind findings by crash signature (any entry has `match`)? */
function isSignatureMap(override: Record<string, MapEntry> | null): boolean {
  if (!override) return false;
  return Object.values(override).some((e) => (Array.isArray(e.match) ? e.match.length > 0 : !!e.match));
}

interface SigCandidate {
  key: string;
  entry: MapEntry;
  idTerms: string[];
  classTerms: string[];
}

/**
 * Bind a finding's crash text to exactly one map entry via its `match` terms:
 *   - ALL identifier terms (non-sanitizer-class) must appear as whole words.
 *   - If several entries qualify, disambiguate by (a) sanitizer-class agreement,
 *     then (b) the most specific (longest) identifier.
 * Returns the entry, or "ambiguous"/null so the caller can REFUSE rather than
 * submit a guessed (wrong) patch.
 */
function matchBySignature(
  override: Record<string, MapEntry>,
  crashText: string
): { key: string; entry: MapEntry } | "ambiguous" | null {
  const hay = crashText.toLowerCase();
  const cands: SigCandidate[] = [];
  for (const [key, entry] of Object.entries(override)) {
    const terms = Array.isArray(entry.match) ? entry.match : entry.match ? [entry.match] : [];
    const idTerms = terms.filter((t) => !SANITIZER_CLASS.test(t));
    const classTerms = terms.filter((t) => SANITIZER_CLASS.test(t));
    if (!idTerms.length) continue; // nothing distinctive to bind on
    if (idTerms.every((t) => termInText(t, hay))) cands.push({ key, entry, idTerms, classTerms });
  }
  if (cands.length === 0) return null;
  if (cands.length === 1) return { key: cands[0].key, entry: cands[0].entry };
  // Prefer entries whose sanitizer class also agrees with the crash.
  const withClass = cands.filter((c) => c.classTerms.some((t) => hay.includes(t.toLowerCase())));
  const pool = withClass.length === 1 ? withClass : cands;
  if (pool.length === 1) return { key: pool[0].key, entry: pool[0].entry };
  // Then the most specific: strictly-longest identifier term wins.
  const len = (c: SigCandidate) => Math.max(...c.idTerms.map((t) => t.length));
  pool.sort((a, b) => len(b) - len(a));
  if (len(pool[0]) === len(pool[1])) return "ambiguous";
  return { key: pool[0].key, entry: pool[0].entry };
}

export interface ResolvedPatch {
  patchText: string;
  patchFileName: string;
  description: string | null;
  /** Where the patch came from, for the activity log. */
  via: string;
}

/**
 * Resolve the patch (and description) for a finding at `findingIndex` of `repoName`.
 * Returns null with a reason if no local patch can be found.
 */
export async function resolveFindingPatch(
  repoName: string,
  findingIndex: number,
  root = getFenrirDir(),
  crashText?: string
): Promise<{ resolved: ResolvedPatch } | { error: string }> {
  if (!repoName) return { error: "submission has no repoName" };
  const dir = await matchRepoDirAny(repoName, root);
  if (!dir) return { error: `no local folder for "${repoName}" in any work folder` };

  const { map: override, error: mapErr } = await loadMap(dir);
  if (mapErr) return { error: mapErr }; // broken map → do NOT submit
  // Discover .patch files anywhere in the folder (patches/, patches/by_bug/, …),
  // not just the top level — but only inside a real `<repo>_submission` folder,
  // never a bare source checkout.
  const patches =
    override || isSubmissionDir(dir)
      ? (await walkFiles(dir)).filter((f) => /\.patch$/i.test(f))
      : [];
  if (!patches.length && !override)
    return { error: `no .patch files for "${repoName}" (no prepared submission folder)` };

  const key = String(findingIndex);
  let chosen: string | undefined;
  let via = "";
  let description: string | null = null;
  const useEntry = async (e: MapEntry, label: string) => {
    chosen = e.patch;
    via = label;
    if (e.description) description = e.description;
    else if (e.descriptionFile) description = await readText(path.join(dir, e.descriptionFile));
  };

  const signature = isSignatureMap(override);

  // 1) Signature match — AUTHORITATIVE for a signature map. The finding binds to
  //    the entry whose identifier terms uniquely appear in its crash text. If
  //    none (or several) match, REFUSE rather than guess by index — submitting
  //    the wrong patch just gets rejected (and risks the AfterQuery account).
  if (override && signature) {
    if (!crashText || !crashText.trim())
      return {
        error: `no crash text to match against ${path.basename(dir)}'s signature map`,
      };
    const hit = matchBySignature(override, crashText);
    if (hit === "ambiguous")
      return {
        error: `crash matches multiple patches in ${path.basename(
          dir
        )} — refine the 'match' terms in fenrir.map.json`,
      };
    if (!hit)
      return {
        error: `no local patch matches this crash in ${path.basename(dir)} (its ${
          Object.keys(override).length
        }-entry map covers different bugs, or the 'match' terms are off)`,
      };
    await useEntry(hit.entry, `fenrir.map.json match[${hit.key}]`);
  }

  // 2) Explicit index — only for a non-signature (pure index) map.
  if (!chosen && !signature && override?.[key]) {
    await useEntry(override[key], `fenrir.map.json[${key}]`);
  }

  // 3) No signature map → match a discovered patch by its filename, then by
  //    convention. Handles per-bug patches (patch_25_oob_lget.patch, etc.) laid
  //    out in any subdir, with no map at all.
  if (!chosen && !signature) {
    const hay = (crashText || "").toLowerCase();
    // (a) filename signature: the patch whose descriptive name appears in the
    //     crash text (e.g. "oob_lget" ⊂ "ext_oob_lget"). Most specific wins.
    if (hay) {
      const cands = patches
        .map((f) => ({ f, id: patchDescriptor(f) }))
        .filter((x) => x.id.length >= 4 && hay.includes(x.id))
        .sort((a, b) => b.id.length - a.id.length);
      if (cands.length && (cands.length === 1 || cands[0].id.length > cands[1].id.length)) {
        chosen = cands[0].f;
        via = `filename signature "${cands[0].id}"`;
      }
    }
    // (b) convention: bug number in the filename === findingIndex + 1.
    if (!chosen) {
      const want = findingIndex + 1;
      const numbered = patches
        .map((f) => ({ f, n: bugNumber(f.split("/").pop() || f) }))
        .filter((x): x is { f: string; n: number } => x.n != null)
        .sort((a, b) => a.n - b.n || a.f.localeCompare(b.f));
      const forNum = numbered.filter((x) => x.n === want).map((x) => x.f);
      // Prefer the highest-versioned file for that bug (…_v2 > …).
      chosen = forNum.sort((a, b) => a.localeCompare(b)).pop() || numbered[findingIndex]?.f;
      via = chosen ? `convention bug#${want}` : "";
    }
  }

  if (!chosen) return { error: `no patch maps to finding index ${findingIndex} in ${path.basename(dir)}` };

  const patchText = await readText(path.join(dir, chosen));
  if (patchText == null) return { error: `could not read ${chosen}` };

  // Description fallback: shared <repo>_task_description.{txt,md} beside the
  // matched submission folder (its parent work folder).
  if (description == null) {
    const foundRoot = path.dirname(dir);
    for (const ext of ["txt", "md"]) {
      description = await readText(path.join(foundRoot, `${repoName}_task_description.${ext}`));
      if (description != null) break;
    }
  }

  return {
    resolved: {
      patchText,
      patchFileName: chosen,
      description: description?.trim() || null,
      via,
    },
  };
}

export interface ResolvedPoc {
  base64: string;
  fileName: string;
  via: string;
}

/**
 * Resolve the PoC crashing-input file for a finding at `findingIndex`.
 * Order: fenrir.map.json[index].poc, then conventional names for bug #N
 * (poc_b<N>.bin, poc<N>.*, iso_b<N>.bin, spoc_q<N>.*). Returns base64 bytes.
 */
export async function resolveFindingPoc(
  repoName: string,
  findingIndex: number,
  root = getFenrirDir()
): Promise<{ resolved: ResolvedPoc } | { error: string }> {
  if (!repoName) return { error: "submission has no repoName" };
  const dir = await matchRepoDirAny(repoName, root);
  if (!dir) return { error: `no local folder for "${repoName}"` };

  const { map: override, error: mapErr } = await loadMap(dir);
  if (mapErr) return { error: mapErr };
  const files = await listDir(dir);
  const n = findingIndex + 1;
  let chosen: string | undefined;
  let via = "";

  if (override?.[String(findingIndex)]?.poc) {
    chosen = override[String(findingIndex)].poc;
    via = `fenrir.map.json[${findingIndex}].poc`;
  } else {
    // Conventional PoC names for bug #N.
    const re = new RegExp(`(^|_)(b|q|f)?0*${n}([._]|$)`, "i");
    const cands = files.filter(
      (f) => /poc|crash|iso|spoc/i.test(f) && !f.endsWith(".patch") && !f.endsWith(".c") && re.test(f)
    );
    chosen = cands.sort((a, b) => a.localeCompare(b)).pop();
    via = chosen ? `convention bug#${n}` : "";
  }

  if (!chosen) return { error: `no PoC maps to finding index ${findingIndex} in ${path.basename(dir)}` };

  try {
    const buf = await fs.readFile(path.join(dir, chosen));
    return { resolved: { base64: buf.toString("base64"), fileName: chosen, via } };
  } catch {
    return { error: `could not read ${chosen}` };
  }
}

/** A PoC crashing input ready to submit. */
export interface PreparedPoc {
  fileName: string;
  base64: string;
  via: string;
  /** First 16 hex of sha256(bytes) — matches the server's finding-id PoC key. */
  sha256: string;
}

// Things in a _submission/ dir that are NOT PoC inputs.
const NOT_POC_EXT = /\.(patch|c|cc|cpp|h|zip|tar|gz|md|json|txt|py|sh)$/i;

/**
 * List every PoC crashing input prepared for a repo, to submit each as its own
 * task. If a fenrir.map.json exists it is authoritative (only its `poc` entries
 * are used); otherwise we glob conventional PoC files (poc_*, iso_*, spoc_*,
 * crash_*) — excluding sources/archives.
 */
export async function listPreparedPocs(
  repoName: string,
  root = getFenrirDir()
): Promise<{ pocs: PreparedPoc[] } | { error: string }> {
  if (!repoName) return { error: "submission has no repoName" };
  const dir = await matchRepoDirAny(repoName, root);
  if (!dir) return { error: `no local folder for "${repoName}" under ${root}` };

  const { map: override, error: mapErr } = await loadMap(dir);
  if (mapErr) return { error: mapErr };
  const picks: { file: string; via: string }[] = [];

  const mapPocs = override
    ? Object.entries(override).filter(([, e]) => e.poc)
    : [];
  if (mapPocs.length) {
    for (const [k, e] of mapPocs) picks.push({ file: e.poc as string, via: `map[${k}].poc` });
  } else {
    // No map (or a map that lists no PoCs) → DISCOVER crashing inputs anywhere in
    // the submission folder, whatever layout the builder used (flat, pocs/, …).
    // But ONLY inside a real `<repo>_submission` folder — never a bare source
    // checkout (which has a fuzz corpus of thousands of seeds).
    if (!isSubmissionDir(dir))
      return { error: `no prepared submission folder for "${repoName}" (only a bare checkout — no PoCs)` };
    const walked = await walkFiles(dir);
    for (const f of walked) if (looksLikePoc(f)) picks.push({ file: f, via: "auto-discovered" });
    // De-dupe by basename so a repo checkout copy doesn't double-count.
    const seenBase = new Set<string>();
    for (let i = picks.length - 1; i >= 0; i--) {
      const base = picks[i].file.split("/").pop() || picks[i].file;
      if (seenBase.has(base.toLowerCase())) picks.splice(i, 1);
      else seenBase.add(base.toLowerCase());
    }
    if (!picks.length) return { error: `no PoC files found in ${path.basename(dir)}` };
  }

  const pocs: PreparedPoc[] = [];
  for (const p of picks) {
    try {
      const buf = await fs.readFile(path.join(dir, p.file));
      pocs.push({
        fileName: p.file,
        base64: buf.toString("base64"),
        via: p.via,
        sha256: pocHash16(buf),
      });
    } catch {
      /* skip unreadable */
    }
  }
  if (!pocs.length) return { error: `could not read any PoC files in ${path.basename(dir)}` };
  return { pocs };
}
