import { checkOllama, getOllamaConfig, OllamaError } from "./local/ollama.js";

try {
  const config = getOllamaConfig();
  console.log(`Ollama: ${config.baseUrl}\nModel: ${config.model}\nContext: ${config.context}`);
  await checkOllama(config);
  console.log("Local Chief readiness: OK (local generation model installed; no downloads).");
} catch (error) {
  console.error(error instanceof OllamaError ? `${error.code}: ${error.message}` : "Local Chief readiness failed.");
  process.exitCode = 1;
}
