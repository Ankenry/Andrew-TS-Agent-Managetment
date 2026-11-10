// Gemini text embeddings (768 dims to match document_chunks.embedding).
import { loadEnv } from './hachimi-db.mjs';

export const EMBEDDING_DIMENSIONS = 768;
// Free tier: 100 embed requests/minute, each batch item counts as one request.
export const FREE_TIER_REQUESTS_PER_MINUTE = 100;
const MODEL = 'gemini-embedding-001';
const BATCH_SIZE = 50;
const MAX_RETRY_WAIT_MS = 90_000;
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:batchEmbedContents`;

export class QuotaExhaustedError extends Error {
  constructor(message, { retryAfterMs, daily }) { super(message); this.retryAfterMs = retryAfterMs; this.daily = daily; }
}

export function embeddingKey() {
  return process.env.API_KEY_GEMINI || loadEnv().API_KEY_GEMINI?.trim() || '';
}

function quotaInfo(bodyText) {
  const retrySeconds = Number(bodyText.match(/retry in ([\d.]+)s/i)?.[1]);
  const daily = /PerDay/i.test(bodyText);
  return { retryAfterMs: Number.isFinite(retrySeconds) ? Math.ceil(retrySeconds * 1000) + 1000 : 30_000, daily };
}

async function embedBatch(texts, taskType, key) {
  const body = JSON.stringify({
    requests: texts.map(text => ({
      model: `models/${MODEL}`,
      content: { parts: [{ text: text.slice(0, 8000) }] },
      taskType,
      outputDimensionality: EMBEDDING_DIMENSIONS,
    })),
  });
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body,
      signal: AbortSignal.timeout(60_000),
    });
    if (response.ok) return (await response.json()).embeddings.map(item => item.values);
    const text = await response.text();
    if (response.status === 429) {
      const quota = quotaInfo(text);
      if (quota.daily || quota.retryAfterMs > MAX_RETRY_WAIT_MS || attempt >= 3) {
        throw new QuotaExhaustedError(`Gemini embeddings quota exceeded (${quota.daily ? 'daily' : 'per-minute'} limit)`, quota);
      }
      await new Promise(done => setTimeout(done, quota.retryAfterMs));
      continue;
    }
    if ([500, 502, 503, 504].includes(response.status) && attempt < 3) {
      await new Promise(done => setTimeout(done, 2000 * (attempt + 1)));
      continue;
    }
    throw new Error(`Gemini embeddings HTTP ${response.status}: ${text.replace(/\s+/g, ' ').slice(0, 300)}`);
  }
}

export async function embedDocuments(texts) {
  const key = embeddingKey();
  if (!key) throw new Error('Thiếu API_KEY_GEMINI trong .env_my');
  const vectors = [];
  for (let start = 0; start < texts.length; start += BATCH_SIZE) {
    vectors.push(...await embedBatch(texts.slice(start, start + BATCH_SIZE), 'RETRIEVAL_DOCUMENT', key));
  }
  return vectors;
}

export async function embedQuery(text) {
  const key = embeddingKey();
  if (!key) throw new Error('Thiếu API_KEY_GEMINI trong .env_my');
  const [vector] = await embedBatch([text], 'RETRIEVAL_QUERY', key);
  return vector;
}
