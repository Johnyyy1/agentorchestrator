import { OllamaEmbeddingAdapter, EmbeddingError } from './embedding.js';
import { EMBEDDING_DIMENSION } from './constants.js';
import { memoryScore } from './retrieval.js';
import { syncProjectTaskMemories } from './outcome-sync.js';
const [command, projectId, afterTaskId] = process.argv.slice(2);
let pool: (typeof import('../db/index.js'))['pool'] | undefined;
try {
  if (!['check', 'smoke', 'sync', 'index'].includes(command ?? '')) throw new Error('Use memory:check, memory:smoke, memory:sync -- <project UUID> [cursor] or memory:index -- <project UUID>.');
  if (command === 'check') {
    pool = (await import('../db/index.js')).pool;
    const db = await pool.query(`select current_setting('server_version_num') as version,(select extversion from pg_extension where extname='vector') as vector,to_regclass('public.project_memories') as memories, (select atttypmod from pg_attribute where attrelid=to_regclass('public.project_memories') and attname='embedding' and not attisdropped) as dimension, (select format_type(atttypid,atttypmod) from pg_attribute where attrelid=to_regclass('public.project_memories') and attname='embedding' and not attisdropped) as embedding_type`);
    if (!db.rows[0].vector || !db.rows[0].memories) throw new Error('Apply migrations and install the vector extension.');
    if (db.rows[0].dimension !== EMBEDDING_DIMENSION || db.rows[0].embedding_type !== `vector(${EMBEDDING_DIMENSION})`) throw new EmbeddingError('dimension', `Database embedding column must be vector(${EMBEDDING_DIMENSION}).`);
    const ready = await new OllamaEmbeddingAdapter().ready();
    console.log(JSON.stringify({ ready: true, database: db.rows[0], embedding: ready, expectedDimension: EMBEDDING_DIMENSION, inference: false }, null, 2));
  } else if (command === 'smoke') {
    const adapter = new OllamaEmbeddingAdapter(); await adapter.ready();
    const query = await adapter.embed('market data architecture', true);
    const texts = ['MarketDataService is server-only', 'User prefers dark mode', 'Historical chart uses split-adjusted close'];
    const results = [];
    for (const content of texts) {
      const e = await adapter.embed(content), dot = e.vector.reduce((sum, v, i) => sum + v * query.vector[i]!,0);
      const norm = (v: number[]) => Math.sqrt(v.reduce((sum, x) => sum + x*x,0));
      const similarity = dot / (norm(e.vector)*norm(query.vector));
      results.push({ content, similarity, score: memoryScore(similarity,2,new Date().toISOString()) });
    }
    results.sort((a,b) => b.score-a.score);
    if (results[2]?.content !== texts[1]) throw new Error('Unrelated UI preference did not rank below both domain memories.');
    console.log(JSON.stringify({ dimension: query.vector.length, model: query.model, results, success: true },null,2));
  } else {
    if (!projectId) throw new Error('Project UUID is required.');
    pool = (await import('../db/index.js')).pool;
    if (command === 'sync') console.log(JSON.stringify(await syncProjectTaskMemories(projectId, { ...(afterTaskId ? { afterTaskId } : {}) }),null,2));
    else console.log(JSON.stringify(await (await import('../projects/store.js')).projectStore().then(s => s.indexPending(projectId)),null,2));
  }
} catch (error) { console.error(JSON.stringify({ ready: false, code: error instanceof EmbeddingError ? error.code : 'readiness_failed', message: error instanceof Error ? error.message : 'Memory operation failed.' })); process.exitCode=1; }
finally { await pool?.end(); }
