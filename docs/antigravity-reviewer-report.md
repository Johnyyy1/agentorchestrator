# Spolehlivost nezávislého Antigravity reviewera

Stav k 2. 10. 2026: implementace, přímé reálné GOOD/BAD reviews, deterministické
regrese i právě jeden repository E2E prošly. E2E skončil APPROVE / COMPLETED.
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


## Právě jeden finální repository E2E

E2E začal 1. 10. 2026 ve 23:59:24 CEST a skončil 2. 10. v 00:01:54 CEST.
Běžel až po validním GOOD/BAD a regresích, z commitu `f3a658d9` na větvi
`codex/opencode-tool-reliability`. Žádný další repository task, repair inference
nebo druhý review pokus nebyl spuštěný.

| Evidence | Skutečný výsledek |
| --- | --- |
| Task ID | `485e34b5-c3f3-4b29-9d1f-353478d33f55` |
| Run ID | `3d20d133-f27f-4c57-8f25-f9a8c66dccae`, attempt 1 / maxAttempts 1 |
| Chief | qwen3.5:9b-q4_K_M, create_task, coding, local-coding, difficulty 1, risk low; 38839 ms |
| Worker | OpenCode 1.18.33; qwen3.5:9b-q4_K_M-jonas-16k, 58173 ms, success true, terminal stop |
| Routing | requested local-coding, selected opencode, fallbackReason null |
| Changed files | přesně `docs/jonas-os-e2e-smoke-5.md`, nový untracked soubor |
| test | PASS, exit 0, 4293 ms |
| typecheck | PASS, exit 0, 2556 ms |
| lint / build | SKIPPED: Script is not defined; žádné tvrzení o jejich provedení |
| Reviewer | Antigravity / providerFamily google, model unknown/null, tier pro |
| Review ID | `dd3c8be9-11da-4f4d-a654-501c61005518` |
| Public CLI output | exit 0, SUCCESS, structured_output object, response + metadata |
| Safe review diagnostics | 30075 ms, timedOut false, signal null, modelOutputReceived true, parse/schema error null |
| Verdict | approve, severity none, findings [] |
| Final task state | completed; žádná eskalace |
| Final Result | Persistovaný Control Plane read model: completed run, veřejný worker summary, workspace/Git, 1 changed file, 4 checks, matching independent APPROVE; reason/decision null |

Reviewer summary potvrzuje požadovanou vysvětlující větu, splněná acceptance
criteria, žádné unrelated files a verifier PASS. Worker nejdřív zkusil read
zamýšleného nového souboru (not_found), potom write. Tento benigní not_found
není porucha sandboxu; execution skončilo úspěšně. Worker veřejně uvedl, že sám
netestoval dokumentační změnu; následný deterministický verifier skutečně provedl
test a typecheck a jejich výsledky jsou uložené samostatně.

Výsledný soubor má obsah:

```md
# Jonas OS End-to-End Smoke Test

This file was created by the Jonas OS end-to-end smoke test.
```

Worktree zůstává pro inspekci:
`/Users/jonas/.jonas-os/worktrees/485e34b5-c3f3-4b29-9d1f-353478d33f55`,
branch `jonas-os/task-485e34b5-c3f3-4b29-9d1f-353478d33f55`.
Task výsledek se automaticky nemergoval do původního checkoutu.
E2E report `/tmp/jo-e2e-5-L4hztz/report.json` obsahuje snapshot persisted
Task/Run/Review/events i Final Result; runtime auth/hidden reasoning v něm nejsou.

## Původní checkout a obnova AGENTS.md

Před i po E2E je původní checkout na main, HEAD
`3898426b9ae85c32c1704cf901ce0ce9859d3594`, s jediným statusem ` M AGENTS.md`.
Smokefile v původním checkoutu nevznikl. Implementace používá izolovaný worktree
na codex/opencode-tool-reliability; foreign worktrees nebyly odstraněné.

Před stashem pouze AGENTS.md vznikly byte backup, git diff --binary, status
snapshot, HEAD a SHA-256. Apply použil vlastní stash SHA. Skutečné cmp byte
kopie, binárních patch souborů a status souborů prošly; HEAD i SHA byly shodné.
Vlastní stash se odstranil až po těchto důkazech. Žádný reset --hard, git clean
ani force operace.

| Restoration proof | Výsledek |
| --- | --- |
| byteCmp / diffCmp / statusCmp | true / true / true |
| headUnchanged | true |
| stashDroppedAfterProof | true |
| AGENTS.md SHA-256 před/po | cb7f056226669cf21c040d7c2d8f14f70c51dbb3ae191b4458dac4de0b49ca60 |
| Binary patch SHA-256 před/po | eab08f5ba2b1f45179a2a0e82b1fc88d606ba75dcaf71665c04c8d5a9ba0b17d |
| Backups | /tmp/jo-e2e-5-L4hztz/AGENTS.md.original, AGENTS.md.patch, status.txt a restored protějšky |

## Konečné počty inference za tento milník

| Provider / účel | Skutečné model CLI/API invocations | Pozorované generation requests |
| --- | --- | --- |
| Local Chief, E2E | 1 | 1 /api/chat |
| OpenCode/Qwen, E2E | 1 | 3 /v1/chat/completions |
| Local repair Chief | 0 | 0 |
| Antigravity přímé fixtures | 4: dvě format-discovery GOOD + valid GOOD/BAD | Interní cloud request count CLI nezpřístupňuje |
| Antigravity E2E | 1 | Interní cloud request count CLI nezpřístupňuje |
| Codex worker / reviewer | 0 / 0 | 0 |

Navíc dva původní print attempts odmítl schema preflight před model output.
Nezapočítávají se jako model inference. Celkem Antigravity **5** model-review CLI
invocations a **2** preflight rejects; cloud generation count není vydávaný za
5. Lokální log delta obsahuje přesně **4** generation requests (Chief 1 + Qwen 3),
uložené v `/tmp/jo-e2e-5-L4hztz/ollama-generation-lines.txt`. Fake regressions,
version/help/models/readiness a oprava dokumentace další reálnou inferenci nepřidaly.

Žádný další milestone nebyl zahájený. E2E prošel s původním workerem, 16k modelem,
verifierem, semantic routingem a běžným completion invariantem; nezávislé
review nebylo nahrazené fake výstupem ani vynucenou approval.
