import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OllamaEmbeddingAdapter, EmbeddingError, validateVector } from './embedding.js';
import { fakeVector } from './test-helpers.js';
const config = { baseUrl: 'http://127.0.0.1:11434', model: 'qwen3-embedding:0.6b', timeoutMs: 1000 };
function fakeFetch(overrides: Record<string, unknown> = {}, calls: string[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url=String(input), path=new URL(url).pathname; calls.push(path);
    const values: Record<string, unknown> = { '/api/tags': { models:[{name:config.model,digest:'local-digest'}] }, '/api/show': {capabilities:['embedding'],model_info:{'qwen3.embedding_length':1024}}, '/api/embed': {embeddings:[fakeVector('market data')]} };
    if (path === '/api/embed') { const body=JSON.parse(init?.body as string); assert.equal(body.truncate,false); assert.ok(!('dimensions' in body)); }
    return new Response(JSON.stringify(path in overrides ? overrides[path] : values[path]), {status:200});
  }) as typeof fetch;
}
const code = (name: string) => (e: unknown) => e instanceof EmbeddingError && e.code === name;
test('embedding readiness checks installed local model and dimension without inference; valid output accepted', async () => {
  const calls: string[]=[];const a=new OllamaEmbeddingAdapter(config,fakeFetch({},calls));
  assert.equal((await a.ready()).dimension,1024);assert.deepEqual(calls,['/api/tags','/api/show']);
  const e=await a.embed('market data',true); assert.equal(e.vector.length,1024);assert.equal(e.model,`${config.model}@local-digest`);
  assert.deepEqual(calls,['/api/tags','/api/show','/api/embed']);
});
test('wrong metadata/output dimension, NaN and zero vector rejected without padding', async () => {
  await assert.rejects(new OllamaEmbeddingAdapter(config,fakeFetch({'/api/show':{capabilities:['embedding'],model_info:{'qwen3.embedding_length':768}}})).ready(),code('dimension'));
  await assert.rejects(new OllamaEmbeddingAdapter(config,fakeFetch({'/api/embed':{embeddings:[[1,2]]}})).embed('query'),code('dimension'));
  assert.throws(() => validateVector(Array(1024).fill(0)),code('dimension'));
  const v=fakeVector('query');v[50]=NaN;assert.throws(() => validateVector(v),code('dimension'));
});
test('absent model reports missing and never downloads or embeds', async () => {
  const calls: string[]=[];await assert.rejects(new OllamaEmbeddingAdapter(config,fakeFetch({'/api/tags':{models:[]}},calls)).embed('query'),code('model_missing'));assert.deepEqual(calls,['/api/tags']);
});
test('offline/timeout are structured and never fall back to a cloud host', async () => {
  const calls: string[]=[];
  const offline=(async (url: unknown) => { calls.push(String(url));throw new Error('connection refused'); }) as typeof fetch;
  await assert.rejects(new OllamaEmbeddingAdapter(config,offline).embed('query'),code('offline'));assert.ok(calls.every(s => s.startsWith(config.baseUrl)));
  const timeout=(async (_: unknown,init?: RequestInit) => new Promise<Response>((_,reject) => { init?.signal?.addEventListener('abort',() => reject(new Error('aborted'))); })) as typeof fetch;
  const keepAlive=setTimeout(() => {},500);
  try { await assert.rejects(new OllamaEmbeddingAdapter({...config,timeoutMs:50},timeout).ready(),code('timeout')); } finally {clearTimeout(keepAlive);}
});
test('reject remote models, nonloopback URLs, redirects and unbounded input/response', async () => {
  for (const baseUrl of ['https://127.0.0.1','http://example.com','http://localhost/path','http://user:pass@localhost','http://127.0.0.1?x=1']) assert.throws(() => new OllamaEmbeddingAdapter({...config,baseUrl}),code('configuration'));
  assert.throws(() => new OllamaEmbeddingAdapter({...config,model:'qwen-cloud'}),code('configuration'));
  await assert.rejects(new OllamaEmbeddingAdapter(config,fakeFetch({'/api/show':{capabilities:['embedding'],model_info:{'x.embedding_length':1024},remote_host:'remote'}})).ready(),code('remote_model'));
  await assert.rejects(new OllamaEmbeddingAdapter(config,fakeFetch()).embed('x'.repeat(8202)),code('configuration'));
  const huge=(async () => new Response('x'.repeat(512001))) as typeof fetch;
  await assert.rejects(new OllamaEmbeddingAdapter(config,huge).ready(),code('bad_response'));
  const redirect=(async (_:unknown, init?: RequestInit) => { assert.equal(init?.redirect,'error'); throw new Error('redirect forbidden'); }) as typeof fetch;
  await assert.rejects(new OllamaEmbeddingAdapter(config,redirect).ready(),code('offline'));
});
