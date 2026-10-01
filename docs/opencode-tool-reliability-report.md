# OpenCode nástroje: skutečný runtime kontext a bezpečná diagnostika

Ověřování 1. 10. 2026 navazuje na čistý `codex/verifier-loopback` commit
`6580816e`. Verifier kód/profile ani router eligibility/attempt cap se nemění.
Implementace je v izolované větvi `codex/opencode-tool-reliability`.

## Co lze a nelze přesně prokázat

Historický task `fd74d994-f43f-42d8-9fb8-8bfab600c77b` obsahoval read error,
dvě glob error a glob completed, ale žádné veřejné tool error zprávy/argumenty.
Tyto jednotlivé chyby nelze zpětně přesně vysvětlit. Report nevydává odhad
permission/path/schema chyby za zjištěný fakt. V nových přímých testech původního
modelu read/glob/write/read fungovaly; chyba oprávnění se nereprodukovala.

**Prokázaná chyba konfigurace/runtime:** OpenCode resolved config tvrdil context
16384 a provider/model `num_ctx=16384`, ale skutečný `/v1/chat/completions`
požadavek obsahoval `max_tokens=4096`, `think=false`, žádný `num_ctx/options`.
Ollama běžela s `n_ctx_slot=4096`. Také log historického tasku dokládá poslední
prompt 4017 tokenů a release `n_tokens=4095, truncated=1`. Toto je přímý důkaz
truncation původního neúplného execution, nikoli důkaz příčin předchozích tools.

Přímá reprodukce se snapshotem původního repository commitu `2d0694e3` a přesným
historickým TaskSpec/worker briefem skončila `write completed → read completed →
glob completed → length`, exit 0, success false. Poslední prompt měl 3947 tokenů,
release 4095/truncated=1. Soubor vznikl; incomplete přesto zůstal failure.
Druhá diagnostická reprodukce s pasivním loopback HTTP pozorováním prošla
write → stop, ale neprokázala inspect-first. Ukládaly se pouze numeric/model/request
options a veřejné finish reasons, nikdy text messages ani raw stream.

[Oficiální Ollama dokumentace](https://docs.ollama.com/api/openai-compatibility#setting-the-local-context-size)
potvrzuje, že OpenAI-compatible API neumí nastavit runtime context size; doporučuje
modelový alias s `PARAMETER num_ctx`. Původní root/source cesta v briefu byla
prověřovaná hypotéza, nikoli prokázaná root cause, a nebyl kvůli ní uvolněn sandbox.

## Nejmenší oprava prokázaného runtime předpokladu

`examples/opencode.Modelfile` vytvoří lokální alias
`qwen3.5:9b-q4_K_M-jonas-16k` ze stejných existujících Qwen vah a explicitním
`num_ctx=16384`. Základní model se nepřepisuje, žádné váhy se nestahují.
`.env.example` doporučuje alias; actual fallback `LOCAL_CHIEF_MODEL`/base model
v `getOpenCodeConfig()` zůstává, ale musí splnit model-level readiness.

Readiness i adaptér před inferencí ověřují `/api/show.parameters.num_ctx ==
LOCAL_CODING_CONTEXT`. Chybějící/odlišný údaj je infrastructure/context_mismatch.
Nepoužívané provider/model `num_ctx` options jsou odstraněné; CLI context/output
limits zůstávají 16384/4096 a agent má pořád max. 12 kroků. `/api/ps` po opravené
fixture skutečně ukázalo model alias s context_length 16384; server slot také 16384.

Preflight kontroluje supplied/canonical cwd, expected worktree, Git root/branch,
writable status. Ve stejném Seatbelt profilu čte `.git` a provede vlastní exclusive
temp write/read/delete uvnitř worktree. Nevalidní cwd se odmítne před CLI/inferencí.
Public log/result obsahuje pouze cesty a booleany. Worker OS profil se nemění.

## Skutečná effective config a hranice

Byly spuštěny skutečné OpenCode 1.18.33 `debug config` a `debug agent
jonas-local-coding` s přesným izolovaným HOME/XDG/env. Bez inference.
[Relevantní effective config](opencode-effective-config.json) obsahuje pouze
Jonas-owned generované hodnoty; [celý effective permission list a tools](opencode-effective-agent.json)
zachovává pořadí včetně vestavěných defaults a overrides, jen náhodný vlastní
runtime prefix je nahrazen `<runtime>`. Není zde uživatelův auth/global config.

| Oblast | Skutečné účinné nastavení |
| --- | --- |
| Agent | `jonas-local-coding`, primary; explicitní --agent i default_agent; není build |
| Providers/model | pouze ollama, alias stejných Qwen vah, loopback `/v1`, think false |
| read | allow `*`, deny `*.env`, `*.env.*`; OS čte jen worktree/runtime/systém/Git metadata |
| glob/grep/list | allow; system PATH rg je dostupný; reálný glob funguje |
| edit/write | edit allow `*`; deny `*.git*`, `*.opencode*`, `*opencode.json*`; write tool používá edit permission |
| bash/process tool | bash false/deny; OS dovoluje potřebné procesy CLI/search, agent nemá shell |
| external_directory | deny `*`; CLI přidává poslední allow pouze pro vlastní `<runtime>/data/opencode/tool-output/*` |
| network tools | webfetch/websearch/codesearch deny; OS outbound pouze loopback port Ollama |
| Další | task/skill/question/LSP deny; formatter false, mcp {}, plugin [], sharing disabled, snapshots false |
| HOME/config | disposable HOME/XDG/tmp; project/global plugins/config/Claude/external skills disabled; bez credentials env |

OS regrese reálně odmítá external read/write, symlink escape a `.git` write.
Original checkout se nepoužívá jako pracovní cwd a jeho obsah nelze takto přepsat.
Není přidané právo push/merge/deploy ani unrestricted filesystem/network fallback.

## Diagnostika, incomplete a retry

Nejvýše 32 toolDiagnostics: eventType, tool, status, rozpoznaná veřejná category,
errno code, code-owned bounded message, bezpečná relativní repo cesta nebo pathScope
bez externí cesty. Event counts jsou bounded 16 typy, terminalReasons 32 záznamy.
Neznámý error detail se vynechá. Žádný tool content/input/output payload, reasoning,
auth, secrets či raw JSONL se nově nepersistuje. Chybová zpráva je nejvýše 500 znaků
s actual step reason a poslední rozpoznanou tool chybou, bez tvrzení o kauzalitě.

Exit 0/changed files nikdy nepřebijí explicitní incomplete/error/length.
Known workspace/runtime/config/model-context preflight a explicitní ripgrep
initialization/execution failure → infrastructure → waiting_human, zachovaný
worktree, žádný repair Chief/coding worker/review ani při redelivery/human answer.
Readiness configuration/unsupported_cli/sandbox_unavailable/context_mismatch se
zastaví v executor pipeline před cloud fallbackem; pure router policy je zachovaná.
ENOENT souboru, invalid arguments, external path/policy denial či samotný length
zůstávají execution, bez neprokázané infrastructure klasifikace; stávající repair
flow a skutečné attempt capy zůstávají.

## Přímé fixture výsledky

Přímý adaptér nemá DB/queue/orchestration/verifier/reviewer.

| Volání | Výsledek |
| --- | --- |
| Původní model, malý inspect/create fixture | Adapter success true, read/read/write/stop, pouze docs/smoke.md; první harness assertion chybně vyžadovala newline a byla opravena, soubor obsahoval přesné `smoke` |
| Původní A read package.json | PASS, read completed |
| Původní B glob src TypeScript | PASS, glob completed |
| Původní C create smoke | PASS, write completed |
| Původní D read smoke | PASS, read completed |
| Přesný historický prompt/snapshot | FAIL incomplete length s výše doloženou runtime truncation |
| Druhý historický prompt/snapshot + metadata proxy | execution success, write/stop, inspect-first neprokázáno |
| Opravený alias, povinná inspect/create fixture | PASS, read/read/write/stop, success true, pouze docs/smoke.md, source čistý, context 16384 |

Bezpečné fixture reports jsou zachované pod vlastními `jo-opencode-tools-*` a
`jo-brief-repro-*` temp adresáři; žádný historický task/worktree se nepřepisoval.
Opravená povinná fixture: `jo-opencode-tools-vluir1/report.json`, task-worktree
`1b41bc24-7426-4827-bc9f-2d33e1bc7919`, nikoli orchestration task.

## Regrese bez skutečné AI

Typecheck a npm test PASS (65 node:test testů plus router example skript).
`opencode:unit` PASS, 11 testů včetně skutečného OS boundary a context mismatch
před inferencí. `orchestration:test` PASS, 21 testů včetně parent; local readiness
context mismatch nevolá žádný local/cloud worker, infrastructure po workeru
nevolá repair/review a neopakuje se po redelivery/human answer.
`db:test`, `queue:test`, `worktree:test` PASS na lokální vývojové DB, vlastní data
uklizena. Fake AI/CLI v těchto kontrolách nevolaly cloud ani Ollama generaci.
Package lock je zachovaný, žádná DB/schema migrace. Verifier nemá změny.

Také všechny čtyři samostatné primitives s opraveným aliasem PASS: read package.json,
glob (čtyři completed glob + completed read src), write docs/smoke.md a následný
read. Všechny invocations success true a stop, source čistý, jediný zamýšlený soubor.
Evidence: `jo-opencode-tools-VFc5zz/report.json`. Vícekrokový glob zůstává modelovou
volbou, timeout/krokový cap se nezvětšuje. Regrese navíc kontroluje, že zotavená
search executable chyba nepřeklasifikuje pozdější model truncation na infrastructure,
i když success event nastane až za limitem persistovaných diagnostics.

## Právě jeden nový repository E2E

OpenCode milestone dosáhl reálného dodání požadovaného souboru a verifier PASS.
**Celý E2E nedosáhl APPROVE/COMPLETED:** jediná Antigravity review invocation
selhala bez platného verdictu. Nebyl spuštěn druhý task, druhý worker/repair,
druhé review ani další milestone. Nejde o request_changes ani vynucenou approval.

| Údaj | Skutečný uložený výsledek |
| --- | --- |
| Task ID | `0cf3e792-6329-49cd-b40d-5681a8e99d97` |
| Repository | `/Users/jonas/jonas-os` |
| Base branch/commit | `codex/opencode-tool-reliability`, `d91189bf1ebb4cc861f9ccf6dd1d029a2d29eea5` |
| Chief | `qwen3.5:9b-q4_K_M`, create_task, coding/local-coding, difficulty 1, low risk, maxAttempts 1; skutečný výstup se nepřepisoval |
| Route/model | OpenCode 1.18.33, `ollama/qwen3.5:9b-q4_K_M-jonas-16k`, fallback null |
| Preflight | supplied/canonical cwd == expected task worktree == Git root; správná UUID větev, writable/read/temp write-delete true |
| Tool sequence | read target error/not_found → glob completed v repository → write target completed → read target completed |
| Přesná nová read chyba | První read mířil na dosud neexistující `docs/jonas-os-e2e-smoke-4.md`. Public error signature byla not_found, žádná permission/sandbox denial. Následný read po vytvoření prošel. Toto není důkaz stejné příčiny historických tool chyb. |
| Event counts | 4 step_start, 4 step_finish, 4 tool_use, 2 text; reasons tool-calls/tool-calls/tool-calls/stop |
| Worker result | success true, exit 0, timeout false, error null; public report zachovaný; session `ses_f06b6afc7ffehgvnTS7x9uVJu8` |
| Usage/duration | input 16167, output 998, reasoning 0; adaptér 116102 ms |
| Run | `9f2337d0-80a9-415c-a1d7-ace1540d61df`, attempt 1, completed, failureKind null |
| Changed files | pouze `docs/jonas-os-e2e-smoke-4.md`; žádný jiný tracked/untracked diff |
| test | PASS, npm test, exit 0, 4351 ms |
| typecheck | PASS, npm typecheck, exit 0, 2925 ms |
| lint/build | oba SKIPPED, root script absent, exitCode null; nejsou PASS |
| Verifier aggregate | success true, failureKind null; žádná změna verifieru |
| Antigravity review | provider family Google, model ID unknown/null, jediná invocation; status failed, verdict/result null |
| Review row/error | `9eec6b48-234d-4646-b695-76b6eeba4cc0`; `Review invocation failed or returned invalid structured output.` |
| Task state | waiting_human, orchestration phase human |
| Escalation | review, `264ad66d-74b2-4c8c-9007-f0d1210aeaa2`; žádná další review/worker invocation |
| Final Result | Persistovaný Control Plane read model obsahuje veřejný worker report, completed run, jeden changed file, checks, failed review a open human decision. Task je waiting_human; schválený completed Final Result nevznikl. Read model nemá samostatný lifecycle status. |
| Retained worktree | `/Users/jonas/.jonas-os/worktrees/0cf3e792-6329-49cd-b40d-5681a8e99d97` |

Glob inspekce předchází prvnímu write; původní new-file read není vydávaný za
úspěšnou inspekci. Následný read ověřil vytvořený soubor. Obsah uvádí, že soubor
vytvořil Jonas OS end-to-end smoke test za účelem ověření repository writes.
Ollama server v těchto čtyřech worker krocích vykazuje skutečný context 16384;
poslední dva prompty měly 4474/4695 tokenů, release truncated=0. Původní runtime
4096 by pro tyto kroky nestačil.

Normal flow zůstal planGoal → submitDecision → PostgreSQL/unikátní pg-boss queue →
registerTaskWorker/processTaskJob → executeTask/OpenCode → nezměněný verifier →
nezávislé runReview/Antigravity. Dependencies byly explicitně provisionované pouze
do ignored node_modules task worktree. Worker necommitnul/pushnul/mergoval.

Reviewer adapter tehdy uloží jen obecnou bezpečnou chybu a odstraní vlastní runtime;
konkrétní CLI/public error a cloud request count nejsou dostupné. Invocation trvala
přibližně 71 ms podle review row timestamps, což samo neprokazuje příčinu ani počet
cloud generací. Report nevymýšlí auth/sandbox/schema vysvětlení a nepřevádí failure
na APPROVE. Read-only readiness (--help) před invocation skutečně prošla.

## Original checkout a přesná obnova AGENTS.md

Original main HEAD před/po je `3898426b9ae85c32c1704cf901ce0ce9859d3594`.
Před/po jediná změna ` M AGENTS.md`; smoke-4 nevznikl v original checkoutu.
Original `.env` se neměnil; ověřování použilo explicitní process environment
`LOCAL_CODING_MODEL=qwen3.5:9b-q4_K_M-jonas-16k`. Po nasazení nové větve nastav
modelový alias podle setupu. Větev není automaticky sloučená do main.

Před stashem pouze AGENTS.md vznikly byte copy, binary patch, status snapshot,
HEAD a SHA-256. Restore použil vlastní stash SHA; skutečné cmp bytes/diff/status,
hash a HEAD porovnání prošly. Vlastní stash se odstranil až po přesném důkazu obnovy.
Žádný reset --hard, git clean ani force operace. Task worktree se zachoval.

| Důkaz | Před i po / výsledek |
| --- | --- |
| AGENTS.md SHA-256 | `cb7f056226669cf21c040d7c2d8f14f70c51dbb3ae191b4458dac4de0b49ca60` |
| Binary diff SHA-256 | `eab08f5ba2b1f45179a2a0e82b1fc88d606ba75dcaf71665c04c8d5a9ba0b17d` |
| byteCmp / diffCmp / statusCmp | true / true / true |
| headUnchanged / stashDroppedAfterProof | true / true |
| E2E report/backups | `/tmp/jo-e2e-4-bohe63/report.json` a vlastní byte/patch/status soubory |

## Skutečné inference počty celého tohoto úkolu

| Provider/fáze | Adapter/CLI invocations | Doložené generation HTTP requests |
| --- | --- | --- |
| OpenCode, před E2E | 12 | 34 `/v1/chat/completions` |
| Chief v jediném E2E | 1 | 1 `/api/chat` |
| OpenCode v jediném E2E | 1 | 4 `/v1/chat/completions` |
| Repair Chief | 0 | 0 |
| Antigravity review | 1, failed | cloud generation count neověřitelný; nesmí být vydávaný za 0 ani 1 |
| Codex worker/reviewer | 0 / 0 | 0 |

Celkem **14 skutečných lokálních adapter invocations a 39 doložených Ollama
generation requests**, z toho 38 OpenCode a 1 Chief. Právě 1 neúspěšný cloud-review
CLI pokus; počet skutečných cloud generací není uložený. HTTP součty vycházejí
ze server log delta po posledním historickém tasku a souhlasí s public step counts;
bezpečné generation lines jsou `/tmp/jo-tools-generation-lines.txt`, E2E delta
navíc v jeho evidence directory. Model alias create, debug config/agent,
version/help, model tags/show/ps a sandbox preflight nejsou inference. Fake unit,
DB/queue/worktree testy nevykonaly skutečné provider generace.

## Změny a omezení

Implementační commit `d91189bf` byl pushnut do origin na
`codex/opencode-tool-reliability`; následující dokumentační commit zaznamenává
skutečný jediný E2E. Package-lock.json a verifier source jsou byte/diff beze změny.

Změněny: local Ollama metadata/OPENCODE context checks/config, safe diagnostics a
workspace preflight; OpenCode result parsing, executor/availability infrastructure
metadata, orchestration/completion guard a regrese; nový direct tools test/script,
Modelfile příklad, .env.example, české README/setup/usage/architecture/development/
troubleshooting/opencode/repair-loop a tento report s effective config snapshoty.

Neověřeno: přesná příčina jednotlivých historických read/glob chyb, úspěšný cloud
review verdict a dokončený celý E2E. OpenCode dodání a verifier jsou nyní skutečně
ověřené, reviewer failure není zastřená. Žádný Project Memory ani další milestone.
