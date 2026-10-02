import 'dotenv/config';
import { z } from 'zod';
import { EMBEDDING_DIMENSION, MEMORY_CONTENT_LIMIT } from './constants.js';
export type EmbeddingErrorCode = 'configuration' | 'offline' | 'timeout' | 'model_missing' | 'remote_model' | 'dimension' | 'bad_response' | 'http';
export class EmbeddingError extends Error {
  readonly name = 'EmbeddingError';
  constructor(public readonly code: EmbeddingErrorCode, message: string) { super(message); }
}
export type Embedding = { vector: number[]; model: string };
export interface EmbeddingAdapter { ready(): Promise<{ model: string; dimension: number }>; embed(input: string, query?: boolean): Promise<Embedding> }
export type EmbeddingConfig = { baseUrl: string; model: string; timeoutMs: number };
export function embeddingConfig(): EmbeddingConfig {
  return validateConfig({ baseUrl: process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434', model: process.env.MEMORY_EMBEDDING_MODEL ?? 'qwen3-embedding:0.6b',
    timeoutMs: Number(process.env.MEMORY_EMBEDDING_TIMEOUT_MS ?? 30000) });
}
function validateConfig(config: EmbeddingConfig) {
  let url: URL;
  try { url = new URL(config.baseUrl); } catch { throw new EmbeddingError('configuration', 'Ollama must use a loopback HTTP URL.'); }
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    throw new EmbeddingError('configuration', 'Ollama must use loopback HTTP without credentials, path or query.');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(config.model) || /(?:^|[-:])cloud(?:$|[-:])/i.test(config.model)) throw new EmbeddingError('configuration', 'A local embedding model is required.');
  if (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 50 || config.timeoutMs > 120000) throw new EmbeddingError('configuration', 'Embedding timeout must be 50–120000 ms.');
  return { ...config, baseUrl: url.origin };
}
export function validateVector(value: unknown): number[] {
  if (!Array.isArray(value) || value.length !== EMBEDDING_DIMENSION || value.some(v => typeof v !== 'number' || !Number.isFinite(v)) || !value.some(v => v !== 0))
    throw new EmbeddingError('dimension', `Expected ${EMBEDDING_DIMENSION} finite dimensions and a nonzero vector; no truncation or padding is allowed.`);
  return value;
}
export class OllamaEmbeddingAdapter implements EmbeddingAdapter {
  private config: EmbeddingConfig;
  private readiness?: Promise<{ model: string; dimension: number }>;
  constructor(config = embeddingConfig(), private fetcher: typeof fetch = fetch) { this.config = validateConfig(config); }
  private async request(path: string, body?: unknown, readiness = false): Promise<unknown> {
    const signal = AbortSignal.timeout(readiness ? Math.min(this.config.timeoutMs, 5000) : this.config.timeoutMs);
    try {
      const response = await this.fetcher(`${this.config.baseUrl}${path}`, { method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal,
        ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
      if (!response.ok) { await response.body?.cancel(); throw new EmbeddingError('http', `Local Ollama returned HTTP ${response.status}.`); }
      const reader = response.body?.getReader();
      if (!reader) throw new EmbeddingError('bad_response', 'Ollama returned an empty body.');
      const chunks: Uint8Array[] = []; let size = 0;
      try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength;
        if (size > 512000) throw new EmbeddingError('bad_response', 'Embedding response too large.'); chunks.push(value); }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new EmbeddingError('bad_response', 'Ollama returned invalid JSON.'); }
    } catch (error) {
      if (error instanceof EmbeddingError) throw error;
      if (signal.aborted) throw new EmbeddingError('timeout', 'Local embedding timed out.');
      throw new EmbeddingError('offline', 'Local Ollama is unavailable. No remote fallback was attempted.');
    }
  }
  ready(): Promise<{ model: string; dimension: number }> {
    // One inventory/show check per short-lived adapter; no embedding inference in readiness.
    this.readiness ??= this.check(); return this.readiness;
  }
  private async check() {
    const tags = z.object({ models: z.array(z.object({ name: z.string(), digest: z.string().min(1).max(100) })).max(1000) }).safeParse(await this.request('/api/tags', undefined, true));
    if (!tags.success) throw new EmbeddingError('bad_response', 'Invalid Ollama model inventory.');
    const model = tags.data.models.find(m => m.name === this.config.model || m.name === `${this.config.model}:latest`);
    if (!model) throw new EmbeddingError('model_missing', `Model ${this.config.model} is missing; install manually with ollama pull ${this.config.model}.`);
    const info = z.object({ capabilities: z.array(z.string()), model_info: z.record(z.string(), z.unknown()), remote_host: z.string().optional(), remote_model: z.string().optional() }).safeParse(await this.request('/api/show', { model: this.config.model }, true));
    if (!info.success) throw new EmbeddingError('bad_response', 'Invalid embedding model metadata.');
    if (info.data.remote_host || info.data.remote_model) throw new EmbeddingError('remote_model', 'Remote Ollama models are forbidden.');
    if (!info.data.capabilities.includes('embedding')) throw new EmbeddingError('configuration', 'Model does not support embeddings.');
    const dims = Object.entries(info.data.model_info).filter(([key]) => key.endsWith('.embedding_length')).map(([, value]) => value);
    if (dims.length !== 1 || dims[0] !== EMBEDDING_DIMENSION) throw new EmbeddingError('dimension', `Model metadata must declare ${EMBEDDING_DIMENSION} dimensions.`);
    return { model: `${model.name}@${model.digest}`, dimension: EMBEDDING_DIMENSION };
  }
  async embed(input: string, query = false): Promise<Embedding> {
    if (!input.trim() || input.length > MEMORY_CONTENT_LIMIT + 201) throw new EmbeddingError('configuration', 'Embedding input is empty or too large.');
    const ready = await this.ready();
    const response = z.object({ embeddings: z.array(z.array(z.number())).length(1) }).safeParse(await this.request('/api/embed', {
      model: this.config.model, input: query ? `Instruct: Given a project goal, retrieve relevant project knowledge.\nQuery: ${input}` : input,
      truncate: false, keep_alive: '5m',
    }));
    if (!response.success) throw new EmbeddingError('bad_response', 'Invalid embedding output.');
    return { vector: validateVector(response.data.embeddings[0]), model: ready.model };
  }
}
