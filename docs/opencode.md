# Lokální coding worker a capability routing

Chief přes Ollama navrhuje **capability** a `workerBrief`; nemá nástroje a nevybírá
providera. OpenCode je samostatný execution worker: v izolovaném worktree čte
a upravuje soubory pomocí stejného lokálního Qwen. Chiefův brief je task data,
pevná pravidla a oprávnění vlastní TypeScript. Neexistuje automatická smyčka.

## Směrování

| Doporučení | Policy |
| --- | --- |
| `local-coding` | OpenCode, pokud coding má repository, risk low/medium a difficulty ≤ `LOCAL_CODING_MAX_DIFFICULTY` |
| `strong-coding` | Codex |
| `strong-general` | Antigravity pro |
| `research` | Antigravity; původní volba flash/pro podle risk/difficulty |
| `local-utility` | Původní category route; lokální utility execution adapter zatím neexistuje |
| `independent-review` | Zachované abstraktní doporučení; samostatný reviewer není implementovaný |
| Bez doporučení | Beze změny původní `routeTask()` |

Coding category má přednost před neslučitelnou capability. High risk nebo
difficulty nad limitem vždy použije Codex. Non-coding nikdy nepoužije OpenCode.
Coding bez repository zůstává Codex read-only, žádná write execution nevznikne.

## Konfigurace a readiness

OpenCode CLI musíš mít již nainstalované. Jonas OS nic neinstaluje, nestahuje
modely ani nespouští trvalou OpenCode službu. Binárku přidej do `PATH` nebo
nastav `OPENCODE_BIN` na její absolutní cestu. Desktop aplikace sama o sobě
nezaručuje dostupnost CLI. Ollama musí běžet s lokálním completion modelem.

| Proměnná | Default | Omezení |
| --- | --- | --- |
| `LOCAL_CODING_MODEL` | `LOCAL_CHIEF_MODEL`, jinak `qwen3.5:9b-q4_K_M` | Nainstalovaný lokální model; cloud odmítnut |
| `OPENCODE_BIN` | `opencode` | Název v PATH nebo absolutní cesta |
| `LOCAL_CODING_CONTEXT` | `16384` | 4096–16384 |
| `LOCAL_CODING_TIMEOUT_MS` | `180000` | 1000–300000 ms |
| `LOCAL_CODING_MAX_DIFFICULTY` | `2` | 1–3, včetně hranice |
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | Sdílená validovaná loopback konfigurace Chief |

```sh
opencode --version
opencode run --help
opencode models
npm run opencode:check
```

`checkOpenCode()` vrací strukturovaný stav: binary, version, model a error code.
Ověří binárku, verzi, flags model/agent/json, Ollama readiness, model inventory
OpenCode a přítomnost macOS sandbox launcheru. Subprocess readiness má limity
5/10 sekund, Ollama request maximálně 5 sekund. Nevolá AI.

Adapter používá **V1 permission/config schema**; V2 bezpečně odmítne. Model se
musí objevit přes native Ollama discovery v izolované konfiguraci. Není přidaný
custom provider SDK. Provider endpoint a model budget pouze přepisují nativní
provider. Při nepodporovaném discovery vrací `model_missing`; bezpečnostní
nastavení se neuvolňuje. Rozdíl V1/V2 popisuje [OpenCode permissions](https://opencode.ai/v2/docs/permissions).

## Execution a bezpečnost

V1 strategie je nový subprocess `opencode run --model ollama/<model> --agent
jonas-local-coding --format json` pro každý task; bez attach, resume, auto nebo
sdílené služby. Aktuální flags se kontrolují při readiness. Jejich [CLI dokumentace](https://opencode.ai/docs/cli/)
nenahrazuje ověření konkrétní instalace.

Manager vytvoří jediný worktree a callback uloží `runs.workspace` před workerem.
Pak proběhne capability policy a uložení skutečného selected workeru. Codex i
OpenCode pokračují stejným `executeTask()` pipeline: worker → nezměněný
`verifyWorktree()` → `inspectTaskWorktree()` → queue persistence.
Completion vyžaduje worker success **i** verifier success. Všechny dostupné
test/typecheck/lint/build skripty mají stejný standard pro oba workery.

OpenCode ověřuje cwd přes `assertTaskWorktree()`, včetně kontrolovaného rootu,
UUID, větve, symlinků a Git registrace. Dedicated agent povolí jen repository
read/edit/glob/grep/list. Shell, network tools, external_directory, subagents,
skills, questions a LSP jsou zakázané; také auto formatters, snapshots a sharing.
Agent nemůže změnit `.git` ani OpenCode configuration přes edit nástroje.

Navíc macOS `sandbox-exec` povoluje data cílového worktree, read-only Git metadata,
potřebné systémové runtime soubory a vlastní disposable runtime. Zápisy jsou
omezené na worktree/runtime; `.git` pointer nelze přepsat. Symlink na source
checkout nezpřístupní jeho obsah. Síť směřuje jen na loopback port Ollama.
Unsupported OS execution je odmítnuta. Nástroje nikdy neobdrží uživatelův HOME,
auth ani credentials environment; projektové/global plugins a config jsou
izolované. Runtime se uklidí, úspěšný i neúspěšný task worktree zůstane.

## Fallback a metadata

Pokud před execution není dostupný OpenCode/Ollama/model nebo kompatibilní
rozhraní/sandbox, policy zvolí Codex a uloží důvod. Codex/Antigravity mají původní
execution-time health behavior; readiness pro ně nevolá model.

Jakmile OpenCode invocation začne, failure/timeout/malformed output je terminální.
Není lokální retry ani předání změněného worktree Codexu. Repository queue jobs
mají původní `retryLimit: 0`. Výjimka adaptéru také zachová worktree a Git metadata.

Migrace `0002_absurd_madame_masque.sql` přidává nullable JSON `tasks.chief`
(`capability`, `workerBrief`) a `runs.routing` (`requestedCapability`,
`selectedWorker`, `fallbackReason`, `model`, `reason`). Staré tasky mají null.
`runs.result` uchovává worker result, routing, workspace, verification a Git diff
metadata. OpenCode result obsahuje success, exitCode, public message, sessionId,
explicit model, whitelisted token counts, durationMs, bounded stderr a error.
Reasoning/tool input/output events se nepersistují. Cloud model ID je null,
pokud ho původní CLI path nehlásí a používá default; žádný ID se nevymýšlí.

## Testy a aktuální stav ověření

```sh
npm run typecheck
npm test
npm run executor:integration
npm run opencode:test
```

První tři používají fake coding adapters/CLI; verifier launcher je lokální
`codex sandbox`, nikoli AI inference. Integration ověřuje oba workery, ukládání
route před editací, čtyři checks, failure po editaci bez handoff a unavailable
fallback. `opencode:unit` také skutečně ověřuje OS odmítnutí external read/write,
symlink escape a `.git` write, JSON parser a timeout.

`opencode:test` je jediný skutečný bounded OpenCode/Qwen smoke: vytvoří disposable
TypeScript Git repo, upraví pouze jeho worktree, spustí stejný verifier a ověří
nezměněný source checkout. Fixture explicitně použije již nainstalovaný TypeScript
compiler; neinstaluje dependencies. Všechny vlastní fixture změny uklidí.
Při readiness failure test skončí s chybou; nikdy nespadne na cloud AI.

Na tomto hostu dne 30. 9. 2026 je Qwen/Ollama readiness ověřené. OpenCode CLI
nebylo nalezeno, takže jeho skutečná verze, native discovery, resource options
a OpenCode/Qwen execution **zůstávají neověřené**. `opencode:check` a real smoke
hlásí `binary_missing`; fake CLI úspěch není důkaz funkční inference. Milestone
vyžaduje dokončení real smoke po zpřístupnění existující CLI binárky. Nové SDK
ani custom provider nelze správně volit bez inspekce skutečné instalace.
