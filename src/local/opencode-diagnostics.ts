import { isAbsolute, relative, resolve } from "node:path";
// Never persist arbitrary tool input/output or error payloads. Recognize public
// failure signatures and emit code-owned messages; unknown detail is omitted.
export type ToolDiagnostic = {
  eventType: "tool_use"; tool: string; status: string;
  category?: string; message?: string; code?: string;
  path?: string; pathScope?: "repository" | "external"; infrastructure?: boolean;
};
export function safeToolDiagnostic(part: unknown, repository?: string): ToolDiagnostic | null {
  if (!part || typeof part !== "object") return null;
  const value = part as { tool?: unknown; state?: { status?: unknown; error?: unknown; input?: { filePath?: unknown; path?: unknown } } };
  if (typeof value.tool !== "string" || !/^[a-z_]{1,40}$/.test(value.tool) ||
      !["pending", "running", "completed", "error"].includes(String(value.state?.status))) return null;
  const result: ToolDiagnostic = { eventType: "tool_use", tool: value.tool, status: String(value.state?.status) };
  const inputPath = value.state?.input?.filePath ?? value.state?.input?.path;
  if (repository && typeof inputPath === "string" && inputPath.length <= 1000) {
    const path = relative(repository, resolve(repository, inputPath));
    const inside = !isAbsolute(path) && path !== ".." && !path.startsWith("../");
    result.pathScope = inside ? "repository" : "external";
    if (inside && /^[a-zA-Z0-9_./-]{1,200}$/.test(path) && !/(?:env|auth|credential|token|config|\.git)/i.test(path)) result.path = path;
  }
  if (result.status !== "error") return result;
  const error = typeof value.state?.error === "string" ? value.state.error.slice(0, 8000) : "";
  if (value.tool === "glob" || value.tool === "grep") {
    if (/^(?:\(FiberFailure\) )?(?:Ripgrep\.Error: )?ripgrep execution failed(?:\n|$)|^failed to download ripgrep|^spawn.*\brg\b.*(?:ENOENT|EPERM|EACCES)/i.test(error)) {
      return { ...result, category: "tool_runtime", message: "OpenCode search executable failed to initialize or execute.", infrastructure: true };
    }
  }
  const signatures = [
    [/ENOENT|no such file|file not found|does not exist/i, "not_found", "Requested file or executable was not found."],
    [/EPERM|operation not permitted/i, "os_denied", "Operating system denied the tool operation."],
    [/EACCES|permission denied/i, "permission_denied", "Tool operation was denied access."],
    [/outside.*(?:workspace|directory)|external_directory/i, "external_path", "Tool requested an external directory."],
    [/permission.*(?:reject|den|disallow)|rejected.*permission/i, "policy_denied", "OpenCode permission policy rejected the tool operation."],
    [/invalid.*(?:argument|parameter|input)|expected.*(?:string|object)|required.*(?:parameter|argument)|schema|Invalid arguments/i, "invalid_arguments", "Tool arguments did not match its schema."],
    [/ripgrep|\brg\b|spawn|posix_spawn/i, "tool_runtime", "OpenCode reported a search/process tool error."],
  ] as const;
  for (const [pattern, category, message] of signatures) if (pattern.test(error)) {
    result.category = category; result.message = message; break;
  }
  result.category ??= "unknown";
  const code = error.match(/\b(?:ENOENT|EPERM|EACCES|ENOTDIR|EINVAL)\b/);
  if (code) result.code = code[0];
  return result;
}
