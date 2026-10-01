# Spolehlivost nezávislého Antigravity reviewera

Stav k 1. 10. 2026: implementace, přímé reálné GOOD/BAD reviews a deterministické
regrese prošly. Jediný repository E2E bude vyhodnocen samostatně až po této gate.
Změna navazuje na `codex/opencode-tool-reliability`, ověřené commity `d91189bf`
a `b63d92c5`. OpenCode worker, Ollama model/context, verifier, TaskSpec routing,
repair rozhodování a Control Plane design se nemění.

## Skutečné CLI a reprodukce

Nainstalovaný executable `/Users/jonas/.local/bin/agy`, Mach-O arm64,
verze **1.2.14**. `--version`, `--help`, `help models`, `help agent` a `models`
byly provedené bez model inference. Help potvrzuje `-p` / `--print` / `--prompt`,
`--model`, `--effort low|medium|high|max`, `--mode plan`, `--sandbox`,
`--disable-slash-commands`, `--output-format text|json|stream-json`, `--json-schema`,
`--log-file` a `--print-timeout`. `models` vrací mimo jiné `gemini-3.1-pro-high`
a `gemini-3.1-pro-low`; implicitní model ID reálné review obálky neuvádějí.
`AGY_PRO_MODEL` během přímých testů nebylo nastavené, model zůstává null/unknown.

Původní adapter byl přímo zavolaný na disposable diffu `a + b` → `a - b`, bez
Chief, queue, workeru či verifieru. Za **54 ms** selhal stejnou obecnou chybou.
Shodný příkaz pod stejným runtime/sandboxem pak bezpečně zachytil exit 1,
stdout 0 znaků a public stderr:

```
Error: invalid --json-schema: schema root must specify "type": "object"
```

Zod export původního discriminated union má root `$schema` / `oneOf`, bez type.
To je prokazatelný první blocker rekonstruované původní příkazové cesty. Historický
71ms review row stderr neuložil, proto nelze zpětně rekonstruovat jiné detaily
konkrétní historické instance nebo tvrdit, že již provedla cloud generation.

Samostatné izolované `models` odhalilo další blocker: `listen tcp 127.0.0.1:0:
bind: operation not permitted`. Po povolení loopback inbound došlo k `Please
sign in`; normální uživatelské `models` vrátilo seznam. CLI auth používá přesnou
Keychain identitu **service gemini / account antigravity** a file fallback
**`.gemini/antigravity-cli/antigravity-oauth-token`**. Starý kopírovaný
`jetski-standalone-oauth-token` nebyl dostačující. Toto bylo ověřené bez inference:
kopie minimálního consumer OAuth do správného CLI adresáře umožnila izolované
`models` se stejným sandboxem, exit 0.

## Runtime a hranice

Host adapter přečte jen uvedenou Keychain položku, max. 5 s, bez logování jejího
obsahu. Pokud neexistuje, použije přesný CLI auth file. Přenáší pouze auth_method,
id_token a whitelist token fields access_token / refresh_token / token_type /
expiry; podporovaná metoda je consumer. Žádný HOME/config dump, globální config,
trusted workspaces, hooks, skills, MCP nebo jiné credentials se nepřebírají.
Soukromý auth soubor je 0600 a v reviewer sandboxu read-only včetně unlink.

HOME/TMP/config/cache/log jsou disposable. Snapshot reviewer nemá repo/worktree
attachment; čtení, zápis, nové soubory, symlink escape a jiná executable (včetně
sh/security/git) jsou zakázané. CLI plan/sandbox/slash-disable flags zůstávají.
Runtime i auth kopie se v finally odstraní, včetně timeoutu. Produkční limit
Antigravity je 120 s, Codex 90 s; žádný nový retry/fallback po invocation.

Antigravity má navíc inbound filtr `localhost:*` pro vlastní CLI backend.
OS test prokázal, že macOS tento filtr připouští i wildcard **bind**; není to
obecná záruka zákazu wildcard socketu. Native CLI startup byl pozorovaný na
127.0.0.1:0. Filesystem ani process-exec allowlist se kvůli tomu nerozšiřují.
OS regrese ověřují loopback startup a nezávisle skutečný zákaz repo read/write,
symlink escape, shell/security execution a změn auth kopie.

## Wire schema, veřejná obálka a parser

Pouhé doplnění root type do oneOf odstranilo preflight reject, ale neposkytlo
použitelné structured_output. Dvě malé GOOD invocations dokončily status SUCCESS;
první parser neznal response field, druhá veřejná response nebyla validní JSON.
Tyto výstupy se nevydávají za úspěšné review a E2E gate zůstala zavřená.

CLI nyní dostává objekt s explicitními properties / required / additionalProperties
false pro decision, summary, severity, findings a optional humanQuestion.
Decision-specific omezení vždy kontroluje původní strict Zod reviewSchema,
například findings pro request_changes a otázku pro needs_human.

Obě úspěšné reálné fixtures vrátily veřejný envelope s keys:

```
conversation_id, status, response, duration_seconds, num_turns,
structured_output, json_schema, usage
```

Status byl SUCCESS, structured_output byl object. Parser preferuje tento objekt,
jinak parsuje response string; ponechává legacy result/direct object a Codex
JSONL. Non-success status, nonzero exit, timeout, oversized/empty output,
malformed JSON, Markdown a Zod-invalid fields nikdy nevytvoří approval.
Envelope/response/raw stdout ani hidden reasoning se nepersistují. Reference
rozhraní: [oficiální headless dokumentace](https://antigravity.google/docs/cli/headless/).

## Diagnostika a orchestrace

Typed ReviewFailure a onDiagnostics vrací bounded metadata: executable, exitCode,
timedOut, signal, model/tier, durationMs, stdoutFormat, whitelist envelopeFields,
resultField/resultType, stderrPublic ≤1000 znaků, jsonParseError category,
schemaValidation ≤500 znaků, modelOutputReceived a terminalStatus.
Model-output boolean znamená rozpoznanou veřejnou response/result, nikoli počet
cloud requests. Schema summary obsahuje jen whitelist field paths a issue codes.
Stderr ponechává jen public CLI error lines, rediguje bearer/token/password/API
key/JWT/OAuth/URL credentials a odstraňuje reasoning blocks. Auth/env/raw logs
se neukládají. Neznámé implicitní model ID se nevymýšlí.

Metadata se persistují v orchestration_events review_failed / review_finished;
DB schéma se nemění. reviews.error má krátký stabilní popis s infrastructure /
result classification. CLI missing/auth/start/runtime/timeout → infrastructure /
waiting_human a zachovaný ověřený worktree. Invalid JSON/schema → review /
waiting_human. Failed infrastructure review blokuje repair Chief i nový coding
worker i po redelivery/human answer. Platné request_changes a needs_human zachovávají
původní lifecycle. Approval dál vyžaduje verifier i provider independence.

## Skutečné přímé fixtures

| Fixture | Normalizovaný výsledek | CLI | Duration | Read-only proof |
| --- | --- | --- | --- | --- |
| GOOD: return (a + b) | approve / none, findings [] | exit 0, SUCCESS, structured_output object | 81944 ms | SHA/HEAD/status shodné |
| BAD: return a - b | request_changes / high, correctness add.js:2 | exit 0, SUCCESS, structured_output object | 17809 ms | SHA/HEAD/status shodné |

GOOD summary: změna přidává závorky a zachovává sčítání. BAD finding identifikuje
odčítání, výsledky -1 místo 5 a -5 místo 1 a navrhuje obnovit a + b.
GOOD SHA před/po: `b4614aa51402c085ea7668c41c3ca96e85a981690cd03b2f1e42b612d8e56260`.
BAD SHA před/po: `75cfacb7faac086c50b23ac4b29a709eb8680999e6756f620ca76d42aba07cab`.
Žádný queue/Chief/worker/verifier nebyl zavolaný. Fixture byla odstraněná.
E2E gate po těchto výsledcích **PASS**. Opt-in příkaz `npm run reviewer:direct`
není součástí regression suite.

## Regrese

- typecheck PASS.
- npm test PASS, 69 assertion tests + router příklady; bez reálné DB/inference.
- reviewer:test PASS, 11 tests, včetně native fake CLI, OS boundary a skutečného
  fake process timeoutu/cleanup; auth v OS fixtures je fake, bez Keychain access.
- orchestration:test PASS, 23 tests se skutečnou lokální DB/Git/verifier,
  fake worker/Chief/reviewer. Nové infrastructure/result persistence a stop po
  human answer/redelivery assertions prošly, stejně jako stávající repair lifecycle.
- db:test, queue:test a worktree:test PASS; vlastní fixture data uklizená.

Neprovedeny samostatné codex:test, agy:test, executor:test, chief:test,
opencode:test, web build/browser E2E. Žádné nové DB migrace, změny local modelu,
verifieru, routeru, repair logic ani Control Plane designu. Expired consumer
credential refresh a enterprise/GCP auth nejsou tímto reálným fixture ověřené.

## Inference před repository E2E

Local Chief **0**, OpenCode/Qwen **0**, Codex **0**. Antigravity přímé fixtures:
**4** real model-review CLI invocations (2 format-discovery GOOD + valid GOOD/BAD).
Navíc **2** reprodukční print attempts skončily na schema preflight reject před
model output; nejsou započítané jako cloud inference. Version/help/models probes
nevolají generation. Přesný počet interních cloud generation requests CLI
nezpřístupňuje; počet invocations není vydávaný za počet interních requests.
Evidence veřejných normalized results: `/tmp/jo-review-direct-flat.jsonl`;
format discovery diagnostics: `/tmp/jo-review-direct-results.jsonl` a
`/tmp/jo-review-direct-final.jsonl`. Credential kopie v těchto souborech nejsou.
