import { access, mkdir, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { checkOllama, getOllamaConfig, OllamaError } from "./ollama.js";
import { boundedProcess } from "./bounded-process.js";
import { openCodeConfig } from "./opencode-config.js";

export type OpenCodeConfig = { binary: string; model: string; baseUrl: string; context: number; timeoutMs: number };
export type OpenCodeErrorCode = "binary_missing" | "version_failed" | "unsupported_cli" | "ollama_unavailable" | "model_missing" | "models_failed" | "sandbox_unavailable" | "configuration";
export type OpenCodeReadiness = {
  available: boolean; version: string | null; model: string; binary: string | null;
  error: { code: OpenCodeErrorCode; message: string } | null;
};

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
    // V2 has a different security schema. Never silently use V1 permissions on it.
    if (!result.version.startsWith("1.")) return fail("unsupported_cli", "Only the V1 permission/config schema is supported by this adapter; V2 requires explicit validation.");
    const help = await boundedProcess(result.binary, ["run", "--help"], { cwd: runtime, env, timeoutMs: 5000 });
    if (help.failed || !["--model", "--format", "--agent"].every(flag => help.stdout.includes(flag)) || !help.stdout.includes("json")) {
      return fail("unsupported_cli", "Installed CLI lacks the required non-interactive model/agent/JSON interface.");
    }
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
    return { ...result, available: true };
  } catch { return fail("models_failed", "Bounded OpenCode readiness subprocess failed."); }
  finally { await rm(runtime, { recursive: true, force: true }); }
}
