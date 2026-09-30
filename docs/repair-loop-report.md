# Repair loop milestone: implementace a ověření

Změna přidává bounded repair → verifier → independent review → human escalation
pro repository coding tasky. Původní non-repository execution zůstává zachovaná.
Práce je v izolovaném worktree a není commitnutá, pushnutá, mergovaná ani nasazená;
nevzniklo PR. Souběžná změna AGENTS.md v původním checkoutu zůstala nedotčená.

## 1. Vytvořené soubory

- `docs/repair-loop-report.md`
- `docs/repair-loop.md`
- `drizzle/0003_curious_shen.sql`
- `drizzle/meta/0003_snapshot.json`
- `src/chief/repair-prompt.ts`
- `src/chief/repair-schema.ts`
- `src/chief/repair.test.ts`
- `src/chief/repair.ts`
- `src/escalations/cli.ts`
- `src/escalations/service.ts`
- `src/orchestration/context.ts`
- `src/orchestration/integration.test.ts`
- `src/orchestration/persistence.ts`
- `src/orchestration/service.ts`
- `src/orchestration/state.ts`
- `src/review/adapter.ts`
- `src/review/policy.ts`
- `src/review/prompt.ts`
- `src/review/review.test.ts`
- `src/review/schema.ts`
- `src/test-repair.ts`

## 2. Změněné soubory

- `.env.example`
- `README.md`
- `docs/architecture.md`
- `docs/development.md`
- `docs/opencode.md`
- `docs/setup.md`
- `docs/troubleshooting.md`
- `docs/usage.md`
- `drizzle/meta/_journal.json`
- `examples/inspect-task.ts`
- `package.json`
- `src/chief/chief.test.ts`
- `src/db/schema.ts`
- `src/git/worktree.ts`
- `src/local/ollama.ts`
- `src/queue/task-worker.ts`
- `src/tasks/create-task.ts`
- `src/test-opencode.ts`
- `src/test-worktree.ts`
- `src/workers/execute.ts`

`package-lock.json` se nezměnil. .env/node_modules ani auth nejsou Git změny.
Dokumentace je česky a odpovídá novému lifecycle, CLI i omezením.

## 3. Databázová migrace

`0003_curious_shen.sql` + Drizzle snapshot/journal přidává reviews, escalations,
orchestration_events, tasks.queueName/orchestration a runs.parentRunId/failureKind.
Reviews mají unique runId; historie se nepřepisuje. Stavy jsou text, nikoli PG enum.
`npm run db:generate` i `npm run db:migrate` proběhly na lokální vývojové DB.
Původní task/run data se nemažou; testy uklidily jen vlastní fixture data.

## 4. Task state machine

Pending → queued → running; running → repairing nebo reviewing;
repairing → running; reviewing → repairing nebo completed.
Running/repairing/reviewing → waiting_human; waiting_human → queued po odpovědi
nebo failed při explicitním abandon. Failed také pro neplatný/corrupt task state.
Legální přechody jsou centralizované. U původní execution bez repository zůstává
running → completed/failed bez nového coding review.

## 5. MaxAttempts

Pokus 1 je implementace, pokusy 2+ opravy. Limit je min(TaskSpec.maxAttempts,
JONAS_OS_MAX_ATTEMPTS); default globálního capu 3, povolené hodnoty 1–3.
Počítají se už rezervované runy, konzervativně i selhání přípravy. Chief ani
lidská odpověď počet neobnovují. Vyčerpání znamená max_attempts/waiting_human.

## 6. Repair schema

Strict discriminated union action: repair/ask_human/give_up. Všechny mají
summary/reason. Repair vyžaduje local-coding/strong-coding a repairBrief,
ask_human humanQuestion, give_up nezahájí další worker. Unknown/policy fields
se odmítnou. Samostatný prompt/bridge ponechává planGoal beze změny.
Chief dostává bounded/redigovaný kontext, nikoli tools nebo reasoning traces.

## 7. Worker selection pro opravy

TypeScript použije existující capability eligibility/readiness. Stejný
validovaný task worktree se použije pro všechny runy. OpenCode → Codex je
záměrný nový repair pokus, nikoli inline fallback. High risk, high-severity
repair po lidské odpovědi a práce po Codexu vynucují strong-coding.
Worker transition, reason a parent run zůstávají v historii.

## 8. Independent reviewer policy

OpenCode/Qwen → Antigravity, fallback Codex před inferencí.
Codex → pouze Antigravity, jinak člověk. Policy vynucuje odlišnou provider family.
Reviewer má bounded snapshot včetně untracked obsahu, izolované HOME/config/MCP,
jen privátní auth kopii a macOS OS read-only boundary mimo disposable runtime.
Repo/original čtení/zápisy i další executable jsou zakázané. --help readiness
nevolá model. Neúplný snapshot eskaluje bez review invocation.

## 9. Review schema

Strict union approve/request_changes/needs_human; summary/severity/findings.
Finding má category, description, reason a volitelně file/line/suggestedFix.
Approve dovoluje none/low; request_changes vyžaduje nález a severity low+;
needs_human vyžaduje otázku. High/critical repair nejdřív vyžaduje člověka.
Reviewer nemůže obejít deterministický neúspěch.

## 10. Human escalation persistence

Dedicated escalations table obsahuje task/run, open/resolved/cancelled,
reasonType, question, summary, JSON context, answer a timestamps. Otevření
s waiting_human je transakční. Worktree zůstává. Give_up také eskaluje.
List/answer/abandon API a CLI jsou implementované; inspect-task vrací i review,
eskalace, audit a checkpoint.

## 11. Human resume

Answer ověří open eskalaci a neprázdnou odpověď do 6000 znaků. V jedné
transakci persistuje answer/resolved, queued, původní queue job a audit event.
Enqueue failure rollbackuje i odpověď. Chief interpretuje nové human context
před workerem; resume marker se jednorázově spotřebuje. Starší odpověď nemůže
povolit nové automatické Chief volání po pozdějším vyčerpání limitu.
Odpověď se nikdy přímo nespouští jako shell/code.

```sh
npm run escalations:list
npm run escalation:answer -- <escalation-UUID> "Zachovej API; oprav výpočet."
npm run task:abandon -- <task-UUID>
```

## 12. Crash/restart

Major transitions předcházejí drahému volání. Session advisory lock zabrání
souběžné execution. Startup obnovuje aktivní repository tasky pouze své queue;
bezpečné checkpointy pokračují, in-flight executing/deciding/reviewing se
eskalují bez replay. Ambiguous runs/reviews dostanou interrupted/failed.
Provider může přežít tvrdý crash: člověk musí před resume ověřit jeho ukončení.
Žádné automatické zjištění vzdáleného výsledku ani globální cleanup.

## 13. Pg-boss interaction

Repository coding má retryLimit 0 a expiration 3600 s. Normální worker/verifier/
review selhání vlastní aplikační lifecycle. Durable waiting_human/completed
vypořádá queue job jako completed; job status není task verdict. Duplicate
completed/waiting_human/failed delivery nic dalšího nevykoná. Non-repository
queue/executor behavior je zachovaný a nový recovery ho nezasahuje.

## 14. Quota safety

Nejvýše 3 rezervované worker pokusy, jedno review na úspěšný pokus, žádné review
před worker + verifier success. Žádné nested agent loops, transition cap 30,
žádné model volání po waiting_human. Chief/OpenCode mají původní konfigurované
bounded timeouty; Codex 90 s, Antigravity review 120 s, verifier 60 s/check.
Wrappers nemají aplikační provider retries ani fallback po zahájeném review.
CLI interní transport je omezený host timeoutem. Loguje se pokus/worker/reviewer
či reason, nikoli auth nebo skryté reasoning traces.

## 15. Integrační scénáře

A initial success; B verifier repair se stejným worktree; C review repair;
D Chief ask_human bez dalšího workeru; E reviewer needs_human;
F max attempts bez dalšího automatického modelu; G transactional human answer,
rollback/resume a Chief context; H OpenCode/Codex reviewer independence;
I unavailable reviewer/fallback před execution; J checkpoint restoration a
orphaned worker/review; K concurrent claim + retryCount redelivery bez duplicity.

Navíc partial edits → Codex repair, high severity, give_up, malformed Chief/
review output, incomplete snapshot, worker failure přes aggregate success,
immutable cap po resume a exclusion původních non-repository tasků z recovery.
Finální suite: 15 testů včetně souhrnného testu, bez skips.

## 16. Regresní výsledky

| Kontrola | Výsledek |
| --- | --- |
| npm run typecheck | PASS |
| npm test | PASS: 32 unit/policy/OS testů + router examples |
| router:test / capability-router:test | PASS, zahrnuté v npm test |
| chief:unit + repair:unit | PASS, fake Ollama/server, strict outputs a cap |
| reviewer:test | PASS, 5 testů včetně reálného OS guardu a native fake provider CLI |
| db:test | PASS, skutečná lokální DB a cleanup |
| queue:test | PASS, separate worker process, durability/abort/settlement a cleanup |
| worktree:test | PASS, 7 fake pipeline scénářů + verifier timeout/guards/cleanup |
| orchestration:test (také escalation:test alias) | PASS, A–K a doplňkové safety scenarios |
| opencode:unit | PASS, fake CLI/parser a skutečný OS boundary |
| opencode:check | PASS, available=true, OpenCode 1.18.33, JSON, lokální Qwen |
| Reviewer availability | PASS, oba CLI --help ve skutečném read-only runtime, bez inference |
| repair:smoke | PASS, skutečná lokální inference vrátila validní ask_human |
| git diff --check | PASS |

Původní chief:test (dvě skutečné plánovací inference) a opencode:test (skutečná
coding inference) nebyly spuštěné; Chief/OpenCode regrese použily fake testy.
Nový repair smoke byl po odstranění příliš přísné assertion konkrétní action
zopakovaný; celkem dvě bounded lokální repair inference, obě validní ask_human.
Nešlo o retry v aplikaci. Smoke neprokazuje skutečnou autonomní opravu souborů;
repair lifecycle a provider selection ověřily fake integration scénáře.

## 17. Codex/Antigravity kvóta

Žádná Codex ani Antigravity inference v testech. Pouze fake coding/review CLI,
--help readiness a lokální codex sandbox launcher pro deterministické checks.
Lokální Ollama smoke používal qwen3.5:9b-q4_K_M a nenavázal worker execution.

## 18. Omezení a další milník

Native review OS boundary je nyní macOS-only. Readiness neověřuje login ani
reálný cloud review envelope; jiné CLI/auth storage může vyžadovat integraci.
Skutečné cloud review nebylo spuštěné, toto ověření se opírá o native fake CLI.
Snapshot má pevné limity; neúplný/secret/symlink context vede na člověka.
Redakce není univerzální detektor všech secrets. Dependencies se do cílových
worktrees neinstalují. Skipped checks jsou nadále skips, ne důkaz testování.

Nejasné provider volání se automaticky neobnovuje; člověk musí inspectovat
process/worktree. Vyčerpaný cap se neobnovuje lidskou odpovědí; další práce
vyžaduje explicitně nový omezený task po kontrole retained práce. Není zde
HTTP/dashboard/schedules ani auto commit/push/merge/deploy. Neimplementovaná
memory/embedding a autonomní next-task planning zůstávají mimo tento milník.

Doporučený další milník: **project memory + semantic retrieval using qwen3-embedding**.

[Podrobný lifecycle a provozní postupy](repair-loop.md).
