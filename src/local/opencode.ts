import { access, mkdir, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { checkOllama, getOllamaConfig, OllamaError } from "./ollama.js";
import { boundedProcess } from "./bounded-process.js";
import { openCodeConfig } from "./opencode-config.js";
import { openCodeSandboxProfile } from "./opencode-sandbox.js";

export type OpenCodeConfig = { binary: string; model: string; baseUrl: string; context: number; timeoutMs: number };
export type OpenCodeErrorCode = "binary_missing" | "version_failed" | "unsupported_cli" | "ollama_unavailable" | "model_missing" | "models_failed" | "sandbox_unavailable" | "configuration";
export type OpenCodeReadiness = {
  available: boolean; version: string | null; model: string; binary: string | null;
  error: { code: OpenCodeErrorCode; message: string } | null;
  outputFormat?: "json" | "text";
};

export type OpenCodeInterface = { outputFormat: "json" | "text"; agentFlag: boolean; titleFlag: boolean };

// Help may be written to either stream. Match option tokens, not wording/layout.
export function detectOpenCodeInterface(help: string): OpenCodeInterface {
  const flags = new Set(help.match(/--[a-z][a-z-]*(?=[\s,=]|$)/g));
  if (!flags.has("--model")) throw new Error("Explicit model selection is unavailable.");
  return { outputFormat: flags.has("--format") && /\bjson\b/i.test(help) ? "json" : "text",
    agentFlag: flags.has("--agent"), titleFlag: flags.has("--title") };
}

// Extra resolved fields are harmless; every required security/config value must survive.
export function containsOpenCodeConfig(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) return JSON.stringify(actual) === JSON.stringify(expected);
  if (expected !== null && typeof expected === "object") {
    if (actual === null || typeof actual !== "object" || Array.isArray(actual)) return false;
    // Empty maps such as MCP must remain empty, not merely contain zero required keys.
    if (Object.keys(expected).length === 0) return Object.keys(actual).length === 0;
    return Object.entries(expected).every(([key, value]) =>
      containsOpenCodeConfig((actual as Record<string, unknown>)[key], value));
  }
  return actual === expected;
}

export async function inspectOpenCodeInterface(binary: string, runtime: string, config: OpenCodeConfig): Promise<OpenCodeInterface> {
  const env = openCodeEnvironment(runtime, config);
  const help = await boundedProcess(binary, ["run", "--help"], { cwd: runtime, env, timeoutMs: 5000 });
  if (help.failed) throw new Error("Non-interactive run interface unavailable.");
  const cli = detectOpenCodeInterface(`${help.stdout}\n${help.stderr}`);
  const resolved = await boundedProcess(binary, ["debug", "config"], { cwd: runtime, env, timeoutMs: 5000 });
  if (resolved.failed || !containsOpenCodeConfig(JSON.parse(resolved.stdout), openCodeConfig(config.model, config.baseUrl, config.context))) {
    throw new Error("Required isolated provider/agent/permissions were not retained by the CLI.");
  }
  return cli;
}

export function getOpenCodeConfig(): OpenCodeConfig {
  const local = getOllamaConfig();
  const model = process.env.LOCAL_CODING_MODEL ?? local.model;
  const context = Number(process.env.LOCAL_CODING_CONTEXT ?? 16384);
  const timeoutMs = Number(process.env.LOCAL_CODING_TIMEOUT_MS ?? 180000);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(model) || /(?:^|[-:])cloud(?:$|[-:])/i.test(model) ||
    !Number.isInteger(context) || context < 4096 || context > 16384 ||
    !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000) {
    throw new Error("Invalid local coding model/context/timeout configuration (context 4096–16384, timeout 1000–300000).");
  }
  return { binary: process.env.OPENCODE_BIN ?? "opencode", model, baseUrl: local.baseUrl, context, timeoutMs };
}

export async function resolveBinary(binary: string): Promise<string | null> {
  const paths = isAbsolute(binary) ? [binary] : binary.includes("/") ? [] :
    (process.env.PATH ?? "").split(delimiter).filter(Boolean).map(path => resolve(path, binary));
  for (const path of paths) {
    try { await access(path, constants.X_OK); if ((await stat(path)).isFile()) return await realpath(path); } catch { /* Try next PATH entry. */ }
  }
  return null;
}

export async function createOpenCodeRuntime(parent = tmpdir()): Promise<string> {
  const runtime = await realpath(await mkdtemp(join(parent, ".jonas-opencode-")));
  await Promise.all(["config", "data", "cache", "state", "tmp"].map(dir => mkdir(join(runtime, dir), { mode: 0o700 })));
  return runtime;
}

export function openCodeEnvironment(runtime: string, config: OpenCodeConfig): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "", HOME: runtime, XDG_CONFIG_HOME: join(runtime, "config"),
    XDG_DATA_HOME: join(runtime, "data"), XDG_CACHE_HOME: join(runtime, "cache"), XDG_STATE_HOME: join(runtime, "state"),
    TMPDIR: join(runtime, "tmp"), TMP: join(runtime, "tmp"), TEMP: join(runtime, "tmp"),
    OPENCODE_CONFIG_CONTENT: JSON.stringify(openCodeConfig(config.model, config.baseUrl, config.context)),
    OPENCODE_DISABLE_PROJECT_CONFIG: "true", OPENCODE_DISABLE_CLAUDE_CODE: "true",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "true", OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
    OPENCODE_DISABLE_MODELS_FETCH: "true", OPENCODE_DISABLE_AUTOUPDATE: "true",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0",
    NO_COLOR: "1", CI: "true",
  };
}

export async function checkOpenCode(): Promise<OpenCodeReadiness> {
  let config: OpenCodeConfig;
  try { config = getOpenCodeConfig(); }
  catch { return { available: false, version: null, model: "unconfigured", binary: null,
    error: { code: "configuration", message: "Invalid OpenCode/Ollama configuration." } }; }
  const result: OpenCodeReadiness = { available: false, version: null, model: config.model, binary: null, error: null };
  const fail = (code: OpenCodeErrorCode, message: string) => ({ ...result, error: { code, message } });
  result.binary = await resolveBinary(config.binary);
  if (!result.binary) return fail("binary_missing", "OpenCode binary is unavailable. Set OPENCODE_BIN to an installed CLI; nothing was installed.");
  const runtime = await createOpenCodeRuntime();
  try {
    const env = openCodeEnvironment(runtime, config);
    const version = await boundedProcess(result.binary, ["--version"], { cwd: runtime, env, timeoutMs: 5000 });
    if (version.failed || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version.stdout.trim())) return fail("version_failed", "OpenCode version could not be retrieved.");
    result.version = version.stdout.trim();
    try { result.outputFormat = (await inspectOpenCodeInterface(result.binary, runtime, config)).outputFormat; }
    catch { return fail("unsupported_cli", "Installed CLI lacks explicit model selection or cannot retain the required isolated security configuration."); }
    try { await checkOllama({ ...getOllamaConfig(), model: config.model }); }
    catch (error) { return fail(error instanceof OllamaError && error.code === "model_missing" ? "model_missing" : "ollama_unavailable",
      error instanceof OllamaError ? error.message : "Local Ollama readiness failed."); }
    const models = await boundedProcess(result.binary, ["models", "ollama"], { cwd: runtime, env, timeoutMs: 10000 });
    if (models.failed) return fail("models_failed", "OpenCode model discovery failed.");
    if (!models.stdout.split(/\r?\n/).map(line => line.trim()).includes(`ollama/${config.model}`)) {
      return fail("model_missing", "Local model is not discoverable by OpenCode's native Ollama provider. No provider SDK or model was installed.");
    }
    if (process.platform !== "darwin" || !await resolveBinary("/usr/bin/sandbox-exec")) {
      return fail("sandbox_unavailable", "The local coding OS boundary currently requires macOS sandbox-exec; execution is refused on unsupported hosts.");
    }
    const sandbox = await boundedProcess("/usr/bin/sandbox-exec", ["-p",
      openCodeSandboxProfile(runtime, runtime, result.binary, config.baseUrl), result.binary, "--version"],
    { cwd: runtime, env, timeoutMs: 5000 });
    if (sandbox.failed) return fail("sandbox_unavailable", "Installed CLI cannot start inside the local coding OS boundary.");
    return { ...result, available: true };
  } catch { return fail("models_failed", "Bounded OpenCode readiness subprocess failed."); }
  finally { await rm(runtime, { recursive: true, force: true }); }
}
