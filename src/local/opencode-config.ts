import { localCodingRules } from "../workers/local-coding-prompt.js";

export const localAgentName = "jonas-local-coding";
export function openCodeConfig(model: string, baseUrl: string, context: number) {
  const permission = {
    "*": "deny", read: { "*": "allow", "*.env": "deny", "*.env.*": "deny" },
    glob: "allow", grep: "allow", list: "allow",
    edit: { "*": "allow", "*.git*": "deny", "*.opencode*": "deny", "*opencode.json*": "deny" },
    external_directory: "deny", bash: "deny", task: "deny", skill: "deny", lsp: "deny",
    webfetch: "deny", websearch: "deny", codesearch: "deny", question: "deny", doom_loop: "deny",
  };
  return {
    model: `ollama/${model}`, small_model: `ollama/${model}`, enabled_providers: ["ollama"],
    default_agent: localAgentName,
    autoupdate: false, share: "disabled", snapshot: false, plugin: [], mcp: {}, lsp: false, formatter: false,
    permission,
    agent: { [localAgentName]: { description: "Jonas OS isolated local file-editing worker", mode: "primary",
      prompt: localCodingRules, permission, steps: 12 } },
    // Override the native provider only; do not declare a custom SDK/provider.
    provider: { ollama: { options: { baseURL: `${baseUrl}/v1`, num_ctx: context },
      models: { [model]: { limit: { context, output: 4096 }, options: { num_ctx: context, think: false } } } } },
  };
}
