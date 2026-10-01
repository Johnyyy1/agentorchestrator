import "dotenv/config";
import { z } from "zod";

export type OllamaErrorCode = "configuration" | "offline" | "timeout" | "model_missing" | "http" | "bad_response" | "remote_model";
export class OllamaError extends Error {
  constructor(public readonly code: OllamaErrorCode, message: string) {
    super(message);
    this.name = "OllamaError";
  }
}
export type OllamaConfig = { baseUrl: string; model: string; context: number; timeoutMs: number };
export type OllamaUsage = {
  model: string; durationMs: number; inputTokens?: number; outputTokens?: number;
  totalDurationMs?: number; loadDurationMs?: number;
};
function integer(value: string | undefined, fallback: number, min: number, max: number, name: string): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new OllamaError("configuration", `${name} must be an integer from ${min} to ${max}.`);
  }
  return parsed;
}
export function getOllamaConfig(): OllamaConfig {
  return validateConfig({
    baseUrl: process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434",
    model: process.env.LOCAL_CHIEF_MODEL ?? "qwen3.5:9b-q4_K_M",
    context: integer(process.env.LOCAL_CHIEF_CONTEXT, 16384, 2048, 32768, "LOCAL_CHIEF_CONTEXT"),
    timeoutMs: integer(process.env.LOCAL_CHIEF_TIMEOUT_MS, 120000, 1000, 300000, "LOCAL_CHIEF_TIMEOUT_MS"),
  });
}
function validateConfig(config: OllamaConfig): OllamaConfig {
  let url: URL;
  try { url = new URL(config.baseUrl); }
  catch { throw new OllamaError("configuration", "OLLAMA_BASE_URL must be a local HTTP URL."); }
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new OllamaError("configuration", "OLLAMA_BASE_URL must use loopback HTTP without credentials, a path or query.");
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(config.model) || /(?:^|[-:])cloud(?:$|[-:])/i.test(config.model)) {
    throw new OllamaError("configuration", "LOCAL_CHIEF_MODEL must identify a locally installed model, not a cloud model.");
  }
  integer(String(config.context), 16384, 2048, 32768, "context");
  integer(String(config.timeoutMs), 120000, 1000, 300000, "timeoutMs");
  return { ...config, baseUrl: url.origin };
}

async function request(config: OllamaConfig, path: string, body?: unknown, readiness = false, externalSignal?: AbortSignal): Promise<unknown> {
  const signal = AbortSignal.any([AbortSignal.timeout(readiness ? Math.min(config.timeoutMs, 5000) : config.timeoutMs), ...(externalSignal ? [externalSignal] : [])]);
  try {
    const response = await fetch(`${config.baseUrl}${path}`, {
      method: body === undefined ? "GET" : "POST", redirect: "error", signal,
      ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new OllamaError("http", `Ollama returned HTTP ${response.status}; check the local server and configured model.`);
    }
    // Bound all response bodies, including diagnostics and any unwanted thinking field.
    const reader = response.body?.getReader();
    if (!reader) throw new OllamaError("bad_response", "Ollama returned an empty response.");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 2 * 1024 * 1024) throw new OllamaError("bad_response", "Ollama response exceeded the size limit.");
        chunks.push(value);
      }
    } finally { await reader.cancel(); }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw new OllamaError("bad_response", "Ollama returned an invalid API response."); }
  } catch (error) {
    if (error instanceof OllamaError) throw error;
    if (signal.aborted) throw new OllamaError("timeout", "Ollama request timed out; check local model load and server health.");
    throw new OllamaError("offline", "Cannot reach Ollama; start the local server and check OLLAMA_BASE_URL.");
  }
}
const tagsSchema = z.object({ models: z.array(z.object({ name: z.string() })) });
const showSchema = z.object({
  capabilities: z.array(z.string()),
  parameters: z.string().max(64000).optional(),
  remote_model: z.string().optional(), remote_host: z.string().optional(),
});
export async function checkOllama(config = getOllamaConfig()): Promise<{ baseUrl: string; model: string; supportsThinking: boolean; modelContext?: number }> {
  config = validateConfig(config);
  const tags = tagsSchema.safeParse(await request(config, "/api/tags", undefined, true));
  if (!tags.success) throw new OllamaError("bad_response", "Ollama model inventory is invalid.");
  const name = config.model.includes(":") ? config.model : `${config.model}:latest`;
  if (!tags.data.models.some((model) => model.name === config.model || model.name === name)) {
    throw new OllamaError("model_missing", `Configured model ${config.model} is not installed. Install it manually in Ollama; no download was attempted.`);
  }
  const info = showSchema.safeParse(await request(config, "/api/show", { model: config.model }, true));
  if (!info.success) throw new OllamaError("bad_response", "Ollama model metadata is invalid.");
  if (info.data.remote_model || info.data.remote_host) throw new OllamaError("remote_model", "Chief requires local inference; remote Ollama models are rejected.");
  if (!info.data.capabilities.includes("completion")) throw new OllamaError("configuration", "Configured Ollama model does not support text generation.");
  const modelContext = info.data.parameters?.match(/^num_ctx\s+(\d+)\s*$/m)?.[1];
  return { baseUrl: config.baseUrl, model: config.model, supportsThinking: info.data.capabilities.includes("thinking"),
    ...(modelContext ? { modelContext: Number(modelContext) } : {}) };
}
const count = z.number().int().nonnegative().optional();
const chatSchema = z.object({
  model: z.string(), done: z.literal(true), done_reason: z.string().optional(),
  message: z.object({ content: z.string().min(1), tool_calls: z.array(z.unknown()).optional() }),
  prompt_eval_count: count, eval_count: count,
  total_duration: z.number().nonnegative().optional(), load_duration: z.number().nonnegative().optional(),
});
export async function generateStructured(
  messages: Array<{ role: "system" | "user"; content: string }>,
  schema: Record<string, unknown>, config = getOllamaConfig(), signal?: AbortSignal,
): Promise<{ content: string; usage: OllamaUsage }> {
  config = validateConfig(config);
  const ready = await checkOllama(config);
  const started = performance.now();
  const response = chatSchema.safeParse(await request(config, "/api/chat", {
    model: config.model, messages, format: schema, stream: false,
    ...(ready.supportsThinking ? { think: false } : {}),
    keep_alive: "5m", options: { temperature: 0, num_ctx: config.context, num_predict: 3072 },
  }, false, signal));
  if (!response.success) throw new OllamaError("bad_response", "Ollama returned an incomplete or invalid chat response.");
  const result = response.data;
  if (result.done_reason === "length" || result.message.tool_calls?.length) {
    throw new OllamaError("bad_response", "Ollama output was truncated or requested a tool; nothing was submitted.");
  }
  return {
    content: result.message.content,
    usage: {
      model: config.model, durationMs: Math.round(performance.now() - started),
      ...(result.prompt_eval_count === undefined ? {} : { inputTokens: result.prompt_eval_count }),
      ...(result.eval_count === undefined ? {} : { outputTokens: result.eval_count }),
      ...(result.total_duration === undefined ? {} : { totalDurationMs: result.total_duration / 1e6 }),
      ...(result.load_duration === undefined ? {} : { loadDurationMs: result.load_duration / 1e6 }),
    },
  };
}
