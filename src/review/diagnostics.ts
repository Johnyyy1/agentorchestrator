import { reviewSchema, type ReviewResult } from "./schema.js";
import type { ReviewerId } from "./policy.js";
import { redact } from "../orchestration/context.js";

export type ReviewDiagnostics = {
  executable: string | null; exitCode: number | null; timedOut: boolean; signal: string | null;
  model: string | null; tier: "pro" | null; durationMs: number;
  stdoutFormat: "empty" | "oversized" | "invalid_json" | "json_object" | "json_other" | "codex_jsonl";
  envelopeFields: string[]; resultField: "structured_output" | "response" | "result" | "direct" | null; resultType: "string" | "object" | null;
  stderrPublic: string; jsonParseError: "empty_output" | "output_too_large" | "envelope_json" | "result_json" | "incomplete_turn" | null;
  schemaValidation: string | null; modelOutputReceived: boolean; terminalStatus: string | null;
  failureKind: "infrastructure" | "result" | null;
};
export function initialDiagnostics(executable: string | null, reviewer: ReviewerId): ReviewDiagnostics {
  return { executable, exitCode: null, timedOut: false, signal: null, model: reviewer === "antigravity" ? safeIdentifier(process.env.AGY_PRO_MODEL) : null,
    tier: reviewer === "antigravity" ? "pro" : null, durationMs: 0, envelopeFields: [], resultField: null, resultType: null, stdoutFormat: "empty", stderrPublic: "", jsonParseError: null,
    schemaValidation: null, modelOutputReceived: false, terminalStatus: null, failureKind: null };
}
function safeIdentifier(value: unknown): string | null {
  return typeof value === "string" && redact(value) === value && !/^(?:ya29\.|eyJ)/.test(value) && /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,100}$/.test(value) ? value : null;
}
export function publicStderr(stderr: string): string {
  // Keep CLI errors, never arbitrary logs, prompt echoes, traces or reasoning blocks.
  const publicLines = stderr.slice(0, 16000).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/<(?:think|thinking|reasoning)>[\s\S]*?(?:<\/(?:think|thinking|reasoning)>|$)/gi, "")
    .split(/\r?\n/).filter(line => /^(?:error(?:\b|:)|failed(?:\b|:)|fatal(?:\b|:)|sandbox-exec:|agy:)/i.test(line.trim()));
  const scrubbed = publicLines.join("\n")
    .replace(/(["']?(?:access_token|refresh_token|id_token|api[_-]?key|password|secret|token)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;]+)/gi, "$1[REDACTED]");
  const safe = redact(scrubbed)
    .replace(/\bya29\.[\w.-]+|\b1\/\/[\w.-]+|\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, "[REDACTED]")
    .replace(/(["']?(?:access_token|refresh_token|id_token|api[_-]?key|password|secret|token)["']?\s*[:=]\s*)["']?[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/([?&](?:key|token|access_token)=)[^&\s]+/gi, "$1[REDACTED]");
  return safe.slice(0, 1000);
}
export class ReviewFailure extends Error {
  constructor(public readonly diagnostics: ReviewDiagnostics, category: string) {
    super(`Reviewer ${diagnostics.failureKind ?? "infrastructure"} failure: ${category}.`);
    this.name = "ReviewFailure";
  }
}
function fail(diagnostics: ReviewDiagnostics, category: string, kind: "infrastructure" | "result" = "result"): never {
  diagnostics.failureKind = kind;
  throw new ReviewFailure(diagnostics, category);
}
export function processDiagnostics(diagnostics: ReviewDiagnostics, output: {
  exitCode?: number; timedOut?: boolean; signal?: string; stdout: string; stderr: string;
}, durationMs: number): void {
  diagnostics.exitCode = output.exitCode ?? null;
  diagnostics.timedOut = output.timedOut ?? false;
  diagnostics.signal = safeIdentifier(output.signal);
  diagnostics.durationMs = durationMs;
  diagnostics.stderrPublic = publicStderr(output.stderr);
  diagnostics.stdoutFormat = !output.stdout.trim() ? "empty" : output.stdout.length > 128000 ? "oversized" : "invalid_json";
}
export function parsePublicReview(stdout: string, reviewer: ReviewerId, diagnostics: ReviewDiagnostics): ReviewResult {
  if (stdout.length > 128000) { diagnostics.stdoutFormat = "oversized"; diagnostics.jsonParseError = "output_too_large"; fail(diagnostics, "output too large"); }
  if (!stdout.trim()) { diagnostics.jsonParseError = "empty_output"; fail(diagnostics, "empty output"); }
  let value: unknown;
  if (reviewer === "codex") {
    let events: Array<{ type?: string; item?: { type?: string; text?: string } }>;
    try { events = stdout.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)); }
    catch { diagnostics.jsonParseError = "envelope_json"; fail(diagnostics, "invalid event JSON"); }
    diagnostics.stdoutFormat = "codex_jsonl";
    const message = events.filter(e => e?.type === "item.completed" && e.item?.type === "agent_message").at(-1)?.item?.text;
    diagnostics.modelOutputReceived = typeof message === "string" && !!message.trim();
    if (!events.some(e => e?.type === "turn.completed") || !message) {
      diagnostics.jsonParseError = "incomplete_turn"; fail(diagnostics, "incomplete turn");
    }
    diagnostics.terminalStatus = "turn.completed";
    try { value = JSON.parse(message); } catch { diagnostics.jsonParseError = "result_json"; fail(diagnostics, "invalid result JSON"); }
  } else {
    let envelope;
    try { envelope = JSON.parse(stdout); } catch { diagnostics.jsonParseError = "envelope_json"; fail(diagnostics, "invalid envelope JSON"); }
    diagnostics.stdoutFormat = envelope && typeof envelope === "object" && !Array.isArray(envelope) ? "json_object" : "json_other";
    if (diagnostics.stdoutFormat !== "json_object") fail(diagnostics, "invalid envelope");
    const publicFields = new Set(["type", "subtype", "status", "result", "structured_output", "response", "conversation_id", "duration_seconds", "json_schema", "is_error", "error", "model", "usage", "duration_ms", "duration_api_ms", "num_turns", "session_id", "total_cost_usd", "permission_denials", "stop_reason", "decision", "summary", "severity", "findings", "humanQuestion"]);
    diagnostics.envelopeFields = Object.keys(envelope).filter(key => publicFields.has(key)).sort();
    const rawStatus = envelope.subtype ?? envelope.status;
    const status = typeof rawStatus === "string" && ["SUCCESS", "ERROR", "CANCELLED", "TIMEOUT", "INTERRUPTED", "success", "error", "failed", "cancelled", "timeout", "interrupted", "completed"].includes(rawStatus) ? rawStatus : null;
    diagnostics.terminalStatus = status;
    if (envelope.is_error === true || envelope.error || (envelope.status != null && status !== "SUCCESS" && status !== "success" && status !== "completed") || (envelope.subtype != null && status !== "success")) {
      // Error envelopes are not reviews. No provider error body or reasoning is persisted.
      fail(diagnostics, "provider reported an error", "infrastructure");
    }
    diagnostics.resultField = envelope.structured_output != null ? "structured_output" : envelope.response != null ? "response" : envelope.result != null ? "result" : "direct";
    value = envelope.structured_output ?? envelope.response ?? envelope.result ?? envelope;
    diagnostics.resultType = typeof value === "string" ? "string" : value && typeof value === "object" ? "object" : null;
    diagnostics.modelOutputReceived = (typeof value === "string" && !!value.trim())
      || (!!value && typeof value === "object" && "decision" in value);
    if (typeof value === "string") {
      try { value = JSON.parse(value); } catch { diagnostics.jsonParseError = "result_json"; fail(diagnostics, "invalid result JSON"); }
    }
  }
  const parsed = reviewSchema.safeParse(value);
  if (!parsed.success) {
    const fields = new Set(["decision", "summary", "severity", "findings", "humanQuestion", "file", "line", "category", "description", "reason", "suggestedFix"]);
    diagnostics.schemaValidation = parsed.error.issues.slice(0, 8).map(issue => `${issue.path.map(p => typeof p === "number" ? "[]" : fields.has(String(p)) ? String(p) : "[field]").join(".") || "$"}: ${issue.code}`).join("; ").slice(0, 500);
    fail(diagnostics, "structured schema validation failed");
  }
  return parsed.data;
}

export function normalizeReviewProcess(output: { exitCode?: number; failed?: boolean; timedOut?: boolean; signal?: string; stdout: string; stderr: string }, reviewer: ReviewerId, diagnostics: ReviewDiagnostics, durationMs: number): ReviewResult {
  processDiagnostics(diagnostics, output, durationMs);
  if (output.failed || output.exitCode !== 0) {
    try { parsePublicReview(output.stdout, reviewer, diagnostics); } catch { /* No process failure can approve. */ }
    diagnostics.failureKind = "infrastructure";
    throw new ReviewFailure(diagnostics, output.timedOut ? "process timed out" : "CLI invocation failed");
  }
  return parsePublicReview(output.stdout, reviewer, diagnostics);
}
