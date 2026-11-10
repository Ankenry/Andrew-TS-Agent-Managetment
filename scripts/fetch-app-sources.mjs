#!/usr/bin/env node
/**
 * Tải source code các app Solar từ TS Elite 2 (GET /api/v1/code/archive) vào apps_doc/<slug>/.
 *
 * Prerequisite: `.env_my` chứa BEARER_Auth=<token TS Elite 2> (admin / scope code:archive).
 * Run:  node scripts/fetch-app-sources.mjs                 # tải tất cả app trong APPS
 *       node scripts/fetch-app-sources.mjs joy-subs aem    # chỉ tải các slug này
 *       node scripts/fetch-app-sources.mjs --keep-archive  # giữ lại file .tar.gz sau khi giải nén
 *       node scripts/fetch-app-sources.mjs --list          # chỉ in danh sách slug
 *
 * Mỗi app: tải <slug>-<ref>.tar.gz (tên file lấy từ header content-disposition) vào apps_doc/.archives/,
 * kiểm tra mọi đường dẫn trong tar không thoát ra ngoài, giải nén bỏ lớp thư mục gốc
 * <repo>-<ref>-<commit>/ vào apps_doc/<slug>/ (xóa bản cũ của chính slug đó trước khi ghi lại),
 * rồi ghi apps_doc/README.md và apps_doc/manifest.json (ngày tải, slug, file archive, commit).
 * Script chỉ tải và giải nén; không chạy bất kỳ mã nào trong source tải về. Không ghi token ra file/log.
 */

import { readFile, writeFile, mkdir, rm, stat, readdir, rename } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { resolve, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const BASE_URL = process.env.TS_ELITE_BASE_URL || "https://ts2.avada.net";
const ROOT = process.cwd();
const OUT_DIR = resolve(ROOT, "apps_doc");
const ARCHIVE_DIR = join(OUT_DIR, ".archives");
const MANIFEST_PATH = join(OUT_DIR, "manifest.json");
const README_PATH = join(OUT_DIR, "README.md");

// Slug phía API TS Elite 2 (GITLAB_APPS trong TS Elite/src/lib/agent/tools.ts).
// `eliteSlug` là slug trong TS Elite/src/config/apps.json khi khác slug API.
const APPS = [
  { slug: "joy-subs", eliteSlug: "joy-subscriptions", name: "Joy Sub" },
  { slug: "air-reviews", name: "Air Reviews" },
  { slug: "aem", name: "AEM" },
  { slug: "shopvid", name: "ShopVid" },
  { slug: "booking", name: "Booking" },
  { slug: "order-limits", name: "Order Limits" },
  { slug: "cookie-bar", name: "Cookie Bar" },
  { slug: "pdf-invoice", name: "PDF Invoice" },
  { slug: "survey", name: "Survey" },
  { slug: "accessibility", name: "Accessibility" },
  { slug: "age-verification", name: "Age Verification" },
  { slug: "air-edd", name: "Air EDD" },
  { slug: "order-tracking", name: "SUN Order Tracking" },
  { slug: "affily", name: "Affily" },
  { slug: "fraud-filter", name: "SEA Fraud Filter" },
  { slug: "online-course", name: "SEA Online Course" },
  { slug: "shipping-labels", name: "Shipping Labels" },
  { slug: "backups-restore", name: "Backups & Restore" },
  // Đang disabled trong apps.json của Elite; thử tải, không có thì ghi thiếu.
  { slug: "withdrawal-forms", name: "Withdrawal Forms", optional: true },
  { slug: "order-editing", name: "Order Editing", optional: true },
  // Không thuộc Solar nhưng ticket vẫn về (JOY-, WISH-, CHAT-); Hanlead duyệt tải 09/10/2026.
  { slug: "joy", name: "Joy Loyalty", group: "other" },
  { slug: "wishlist", name: "Joy Wishlist", group: "other" },
  { slug: "chatty", name: "Chatty", group: "other" },
];

function parseEnvFile(contents) {
  const out = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

async function loadToken() {
  let contents;
  try {
    contents = await readFile(resolve(ROOT, ".env_my"), "utf8");
  } catch {
    throw new Error("Không đọc được .env_my. Cần BEARER_Auth=<token TS Elite 2>.");
  }
  const token = parseEnvFile(contents).BEARER_Auth;
  if (!token) throw new Error("Thiếu BEARER_Auth trong .env_my.");
  return token;
}

function filenameFromDisposition(header, fallback) {
  if (!header) return fallback;
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(header);
  const name = m ? decodeURIComponent(m[1]) : fallback;
  // Chỉ nhận tên file đơn giản, không nhận đường dẫn.
  return /^[A-Za-z0-9._-]+$/.test(name) ? name : fallback;
}

async function download(app, token) {
  const url = `${BASE_URL}/api/v1/code/archive?app=${encodeURIComponent(app.slug)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    let detail = "";
    try {
      const body = await res.text();
      try {
        const json = JSON.parse(body);
        detail = json.error || body.slice(0, 200);
      } catch {
        detail = body.slice(0, 200);
      }
    } catch {
      /* ignore */
    }
    throw new Error(`HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
  }
  if (!res.body) throw new Error("Phản hồi không có body.");
  const filename = filenameFromDisposition(res.headers.get("content-disposition"), `${app.slug}.tar.gz`);
  const archivePath = join(ARCHIVE_DIR, filename);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(archivePath));
  const { size } = await stat(archivePath);
  return { filename, archivePath, size };
}

// Liệt kê tar, kiểm tra an toàn đường dẫn và xác định thư mục gốc duy nhất.
async function inspectArchive(archivePath) {
  const { stdout } = await execFileAsync("tar", ["-tzf", archivePath], { maxBuffer: 256 * 1024 * 1024 });
  const entries = stdout.split("\n").filter(Boolean);
  if (!entries.length) throw new Error("Archive rỗng.");
  const roots = new Set();
  for (const entry of entries) {
    if (entry.startsWith("/") || entry.split("/").includes("..")) {
      throw new Error(`Đường dẫn không an toàn trong tar: ${entry}`);
    }
    roots.add(entry.split("/")[0]);
  }
  if (roots.size !== 1) throw new Error(`Archive có ${roots.size} thư mục gốc, mong đợi 1: ${[...roots].slice(0, 5).join(", ")}`);
  const root = [...roots][0];
  // GitLab đặt tên <repo>-<ref>-<sha>; lấy sha ở cuối nếu có.
  const sha = /-([0-9a-f]{7,40})$/.exec(root)?.[1] || null;
  return { root, sha, entryCount: entries.length };
}

async function extract(app, archivePath, root) {
  const target = join(OUT_DIR, app.slug);
  const tmp = join(OUT_DIR, `.${app.slug}.extracting`);
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true });
  // --strip-components=1 bỏ lớp <repo>-<ref>-<sha>/ (GNU tar mặc định đã bỏ "/" đầu; inspectArchive đã chặn "..").
  await execFileAsync("tar", [
    "-xzf", archivePath,
    "-C", tmp,
    "--strip-components=1",
    "--no-same-owner",
    "--no-same-permissions",
  ], { maxBuffer: 64 * 1024 * 1024 });
  // Đổi tên nguyên tử: bản cũ dời sang .<slug>.old rồi bản mới đổi vào chỗ, nên một lượt check đang đọc apps_doc/<slug>
  // không bao giờ gặp thư mục trống/nửa chừng; bản cũ xóa sau cùng.
  const old = join(OUT_DIR, `.${app.slug}.old`);
  await rm(old, { recursive: true, force: true });
  let hadOld = false;
  try { await rename(target, old); hadOld = true; } catch (err) { if (err.code !== "ENOENT") throw err; }
  await rename(tmp, target);
  if (hadOld) await rm(old, { recursive: true, force: true });
  void root;
  return target;
}

async function dirSize(dir) {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) total += await dirSize(p);
    else if (entry.isFile()) total += (await stat(p)).size;
  }
  return total;
}

function fmtMB(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function loadManifest() {
  try {
    return JSON.parse(await readFile(MANIFEST_PATH, "utf8"));
  } catch {
    return { apps: {} };
  }
}

async function writeReadme(manifest) {
  const rows = Object.values(manifest.apps)
    .sort((a, b) => a.slug.localeCompare(b.slug))
    .map((a) =>
      a.ok
        ? `| ${a.slug} | ${a.name} | ${a.eliteSlug || a.slug} | \`${a.archive}\` | ${a.commit || "?"} | ${a.fetchedAt} | ${fmtMB(a.extractedBytes)} |`
        : `| ${a.slug} | ${a.name} | ${a.eliteSlug || a.slug} | — | — | ${a.fetchedAt} | thiếu: ${a.error} |`,
    );
  const text = [
    "# apps_doc — source code các app Solar",
    "",
    "Mã nguồn tải về từ TS Elite 2 (`GET /api/v1/code/archive?app=<slug>`), snapshot nhánh mặc định của từng repo, không có `.git`.",
    "Thư mục này chỉ để đọc/tra cứu; không commit (đã ghi vào `.gitignore`), không chạy mã bên trong.",
    "",
    "Tải lại: `node scripts/fetch-app-sources.mjs [slug ...] [--keep-archive]`.",
    "",
    "| Thư mục (slug API) | App | Slug Elite | File archive | Commit | Ngày tải | Dung lượng giải nén |",
    "|---|---|---|---|---|---|---|",
    ...rows,
    "",
    `Cập nhật: ${manifest.updatedAt}`,
    "",
  ].join("\n");
  await writeFile(README_PATH, text, "utf8");
}

async function main() {
  const args = process.argv.slice(2);
  const keepArchive = args.includes("--keep-archive");
  const listOnly = args.includes("--list");
  const wanted = args.filter((a) => !a.startsWith("--"));
  const apps = wanted.length ? APPS.filter((a) => wanted.includes(a.slug) || wanted.includes(a.eliteSlug)) : APPS.filter((a) => a.group !== "other");
  if (listOnly) {
    for (const a of APPS) console.log(`${a.slug}${a.eliteSlug ? ` (Elite: ${a.eliteSlug})` : ""}${a.optional ? " [optional]" : ""}${a.group === "other" ? " [ngoài Solar, chỉ tải khi nêu tên]" : ""}`);
    return;
  }
  if (!apps.length) throw new Error(`Không có slug nào khớp: ${wanted.join(", ")}`);

  const token = await loadToken();
  await mkdir(ARCHIVE_DIR, { recursive: true });
  const manifest = await loadManifest();
  const summary = { ok: [], missing: [] };

  for (const app of apps) {
    const fetchedAt = new Date().toISOString();
    process.stdout.write(`[${app.slug}] tải... `);
    try {
      const { filename, archivePath, size } = await download(app, token);
      process.stdout.write(`${fmtMB(size)} → kiểm tra tar... `);
      const { root, sha, entryCount } = await inspectArchive(archivePath);
      process.stdout.write(`${entryCount} mục, gốc ${root} → giải nén... `);
      const target = await extract(app, archivePath, root);
      const extractedBytes = await dirSize(target);
      if (!keepArchive) await rm(archivePath, { force: true });
      manifest.apps[app.slug] = {
        slug: app.slug, eliteSlug: app.eliteSlug || null, name: app.name, ok: true,
        archive: filename, archiveBytes: size, archiveKept: keepArchive, root, commit: sha,
        entryCount, extractedBytes, fetchedAt,
      };
      summary.ok.push(app.slug);
      console.log(`xong (${fmtMB(extractedBytes)})`);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      manifest.apps[app.slug] = {
        slug: app.slug, eliteSlug: app.eliteSlug || null, name: app.name, ok: false, error, fetchedAt,
      };
      summary.missing.push({ slug: app.slug, error });
      console.log(`THIẾU: ${error}`);
    }
  }

  manifest.updatedAt = new Date().toISOString();
  await writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  await writeReadme(manifest);

  console.log("");
  console.log(`Tải được ${summary.ok.length}/${apps.length} app.`);
  for (const m of summary.missing) console.log(`  thiếu ${m.slug}: ${m.error}`);
  const total = await dirSize(OUT_DIR);
  console.log(`Tổng dung lượng apps_doc/: ${fmtMB(total)}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
