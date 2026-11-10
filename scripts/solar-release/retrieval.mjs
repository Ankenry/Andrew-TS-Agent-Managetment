import { query } from '../hachimi-db.mjs';
import { POLICY, APP_SLUGS } from './core.mjs';

export function canonicalApp(app) {return ({'joy-subs':'joy-subscriptions'})[app]||app;}
export async function searchSolarKnowledge(text, {appSlug,limit=8}={}) {
  const app=canonicalApp(appSlug);
  if(!APP_SLUGS.includes(app)) return [];
  const terms=[...new Set(String(text||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().split(/[^\p{L}\p{N}_.-]+/u).filter(x=>x.length>=3))].slice(0,70);
  if(!terms.length) return [];
  const tsq=terms.map(t=>`'${t.replaceAll("'","''")}'`).join(' | ');
  const {rows}=await query(`WITH q AS (SELECT to_tsquery('simple',$2) tsq)
    SELECT c.id,d.source_path AS "sourcePath", f.app_slug AS "appSlug", f.feature_key AS heading,
      c.content,f.source_url AS url,f.source_ts::text AS "releaseTs",f.id AS "factId",
      ts_rank_cd(c.tsv,q.tsq,32) AS score,ARRAY['solar-current'] AS signals
    FROM solar_current p JOIN solar_facts f ON f.id=p.fact_id
    JOIN solar_batches b ON b.id=f.batch_id JOIN documents d ON d.id=f.document_id
    JOIN document_chunks c ON c.document_id=d.id, q
    WHERE p.app_slug=$1 AND c.tsv @@ q.tsq AND b.status='ingested'
    ORDER BY score DESC,f.source_ts DESC,f.id DESC LIMIT $3`,[app,tsq,Math.max(1,Math.min(30,limit))]);
  return rows;
}
export function releaseContext(chunks) {
  if(!chunks.length) return '';
  return `${POLICY}\n${chunks.map(c=>`[solar:${c.factId}] ${c.content}`).join('\n\n')}`;
}
