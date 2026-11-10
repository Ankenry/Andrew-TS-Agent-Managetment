// Local, read-only retrieval over the curated Markdown corpus checked out in
// the project's knowledge-base/ folder (copied from TS Elite 2). This deliberately does not use ELITE2's
// production database, API token, embeddings, or any customer data.

import { readdir, readFile } from "node:fs/promises";
import { resolve, relative, basename } from "node:path";

const MAX_RESULTS = 8;
const MAX_CHARS_PER_CHUNK = 3_200;
export const MAX_CONTEXT_CHARS = 22_000;

const APP_ALIASES = Object.freeze({
  "air reviews": "air-reviews",
  "luna booking": "booking",
  "appointment booking": "booking",
  chatty: "chatty",
  "cookie bar": "cookie-bar",
  "cookie consent": "cookie-bar",
  "email marketing": "aem",
  "avada email marketing": "aem",
  "joy loyalty": "joy",
  "joy: loyalty program": "joy",
  "joy subscription": "joy-subscriptions",
  "joy subscriptions": "joy-subscriptions",
  "shopvid shoppable video reels": "shopvid",
  shopvid: "shopvid",
  "avada order limit": "order-limits",
  "order limits": "order-limits",
  "pdf invoice": "pdf-invoice",
  "avada order printer": "pdf-invoice",
  "sea fraud filter": "fraud-filter",
  "fraud filter": "fraud-filter",
  "sea accessibility": "accessibility",
  accessibility: "accessibility",
  "sea survey": "survey",
  survey: "survey",
  "air estimated delivery date": "air-edd",
  "estimated delivery date": "air-edd",
  "avada affiliate marketing": "affily",
  "affiliate marketing": "affily",
  "avada shipping labels": "shipping-labels",
  "shipping labels": "shipping-labels",
  "order editing": "order-editing",
  "order tracking": "order-tracking",
  "withdrawal forms": "withdrawal-forms",
  wishlist: "wishlist",
});

let corpusPromise;

export function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((term) => term.length >= 3);
}

export async function markdownFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return markdownFiles(path);
    return entry.isFile() && entry.name.endsWith(".md") ? [path] : [];
  }));
  return files.flat();
}

export function splitMarkdown(content) {
  const chunks = [];
  let heading = "";
  let text = "";
  const emit = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    for (let start = 0; start < trimmed.length; start += MAX_CHARS_PER_CHUNK) {
      chunks.push({ heading, content: trimmed.slice(start, start + MAX_CHARS_PER_CHUNK) });
    }
  };
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^(#{1,3})\s+(.+)/);
    if (match && text.trim()) {
      emit(); text = "";
    }
    if (match) heading = match[2].trim();
    text += `${line}\n`;
  }
  emit();
  return chunks;
}

export function appSlugForPath(path, elite2Root) {
  const sourcePath = relative(elite2Root, path).replaceAll("\\", "/");
  if (sourcePath.startsWith("knowledge/")) return sourcePath.split("/")[1] || "";
  if (sourcePath.startsWith("app-guides/")) {
    const file = basename(sourcePath, ".md").replace(/-(brand-strategy|devzone|roadmap|pm-agent|widget-v4-components|widget-v4-schema)$/, "");
    return APP_ALIASES[file] || file;
  }
  return "";
}

async function loadCorpus(elite2Root) {
  const directories = [resolve(elite2Root, "knowledge"), resolve(elite2Root, "app-guides")];
  const paths = (await Promise.all(directories.map(markdownFiles))).flat();
  const docs = [];
  const documentFrequency = new Map();
  for (const path of paths) {
    const sourcePath = relative(elite2Root, path).replaceAll("\\", "/");
    const appSlug = appSlugForPath(path, elite2Root);
    const markdown = await readFile(path, "utf8");
    for (const chunk of splitMarkdown(markdown)) {
      const terms = tokenize(`${chunk.heading}\n${chunk.content}`);
      if (!terms.length) continue;
      const frequencies = new Map();
      for (const term of terms) frequencies.set(term, (frequencies.get(term) || 0) + 1);
      for (const term of frequencies.keys()) documentFrequency.set(term, (documentFrequency.get(term) || 0) + 1);
      docs.push({ sourcePath, appSlug, heading: chunk.heading, content: chunk.content, terms: frequencies, length: terms.length });
    }
  }
  const averageLength = docs.reduce((total, doc) => total + doc.length, 0) / docs.length || 1;
  return { docs, documentFrequency, averageLength };
}

export function inferAppSlug(text) {
  const normalized = String(text || "").toLowerCase();
  const match = Object.entries(APP_ALIASES)
    .sort(([left], [right]) => right.length - left.length)
    .find(([name]) => normalized.includes(name));
  return match?.[1] || "";
}

function scoreDocument(doc, queryTerms, corpus, appSlug) {
  const K1 = 1.5;
  const B = 0.75;
  let score = doc.appSlug && doc.appSlug === appSlug ? 0.7 : 0;
  for (const term of queryTerms) {
    const frequency = doc.terms.get(term);
    if (!frequency) continue;
    const df = corpus.documentFrequency.get(term) || 0;
    const idf = Math.log((corpus.docs.length - df + 0.5) / (df + 0.5) + 1);
    const norm = 1 - B + B * (doc.length / corpus.averageLength);
    score += (idf * frequency * (K1 + 1)) / (frequency + K1 * norm);
  }
  return score;
}

/**
 * Retrieves cited ELITE2 knowledge chunks for a Helpdesk question. The corpus
 * is lazy-loaded once per bridge process and then remains read-only in memory.
 */
export async function retrieveElite2Knowledge(query, elite2Root) {
  const root = resolve(elite2Root);
  if (!corpusPromise) corpusPromise = loadCorpus(root);
  const corpus = await corpusPromise;
  const appSlug = inferAppSlug(query);
  const queryTerms = [...new Set(tokenize(query))];
  if (!queryTerms.length) return { appSlug, chunks: [] };
  const appDocs = appSlug ? corpus.docs.filter((doc) => doc.appSlug === appSlug) : [];
  const candidates = appDocs.length >= 3 ? appDocs : corpus.docs;
  const chunks = candidates
    .map((doc) => ({ ...doc, score: scoreDocument(doc, queryTerms, corpus, appSlug) }))
    .filter((doc) => doc.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, MAX_RESULTS);

  let usedChars = 0;
  const withinBudget = chunks.filter((chunk) => {
    if (usedChars + chunk.content.length > MAX_CONTEXT_CHARS) return false;
    usedChars += chunk.content.length;
    return true;
  });
  return { appSlug, chunks: withinBudget };
}
