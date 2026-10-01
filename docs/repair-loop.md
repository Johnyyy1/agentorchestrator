# Opravy, nezávislé review a lidské eskalace

Repository coding úkol používá durable orchestraci nad původním executorem:
worker → deterministický verifier → nezávislé review → completed. Selhání
workeru/verifieru nebo `request_changes` předává kontext lokálnímu Chief.
Ten navrhuje `repair`, `ask_human` nebo `give_up`; TypeScript návrh validuje
přísným Zod discriminated union a vynucuje všechny limity a oprávnění.
Non-coding bez mutation požadavku zachovává původní execution chování. Coding
bez repository se bezpečně odmítá; konfliktní coding capability se normalizuje
ještě před volbou pipeline. [Completion invariant](architecture.md#invariant-dokončení-repository-coding).
Samotné `executeTask()` provede jeden pokus, nikoli celý lifecycle.

## Stavy a pokusy

Stavy jsou text: pending, queued, running, repairing, reviewing,
waiting_human, completed, failed. Legální přechody vlastní
`src/orchestration/state.ts`. Typický průchod:

```text
queued → running (pokus 1) → repairing (test selhal)
→ running (pokus 2, stejný worktree) → reviewing (checks prošly)
→ completed (nezávislé approve)
```

První pokus je implementace, další jsou opravy včetně oprav po review.
Efektivní počet je `min(TaskSpec.maxAttempts, JONAS_OS_MAX_ATTEMPTS)`.
Globální default je 3 a konfigurace dovoluje pouze integer 1–3.
`maxAttempts=2` dovolí první implementaci a jednu opravu. Chief ani lidská
odpověď počet nemění. Konzervativně se počítá už rezervovaný run i při chybě
přípravy před samotným modelem; není zde automatický infrastructure retry.

Každý pokus založí nový run s attempt, parentRunId, workspace, routing,
výsledkem a failureKind (infrastructure, execution, verification, interrupted).
Run completed označuje úspěšnou implementaci s checks; dokončení **tasku**
je navíc podmíněné nezávislým approve. Historie runů se nepřepisuje.

## Chief a směrování oprav

Repair output obsahuje action, summary a reason. `repair` vyžaduje capability
(local-coding nebo strong-coding) a repairBrief, zakazuje humanQuestion.
`ask_human` vyžaduje humanQuestion, `give_up` nezahájí nový worker.
Unknown fields, prázdné hodnoty nebo návrh maxAttempts se odmítnou bez retries.
Give_up zachová práci a otevře lidskou eskalaci; failed bez eskalace je určeno
pro neplatný/corrupt task state nebo explicitní abandon.

Chief dostává cíl, kritéria, původní brief a task context, číslo/limit pokusu, worker,
veřejný výsledek, selhávající checks s omezenými logy, soubory, diff stat,
omezený diff, minulá rozhodnutí, findings a lidské odpovědi. Celý serializovaný
kontext má nejvýše 32000 znaků. Logy a běžné credentials se redigují;
credential soubory a symlinky se do snapshotu nečtou. To není obecný detektor
všech tajemství; nevkládej secrets do tasků, zdrojového kódu ani výstupů testů.

Chief má opravit příčinu, zachovat platnou práci, nepřidávat scope a neslabit
testy/verifier. Produktové, architektonické či bezpečnostní rozhodnutí patří
člověku. Brief je task data; sandbox, verifier, cap a provider templates
vlastní kód. Chief nemá nástroje, shell ani právo měnit policy.

Local-coding používá stávající eligibility/readiness policy. Strong-coding
používá Codex. OpenCode může po selhání předat rozpracovaný worktree Codexu,
jen jako nový autorizovaný pokus v této orchestraci. High risk a oprava po
Codexu se nikdy nesníží na local-coding. Přechod workeru a důvod jsou v run
routing a audit events. Původní checkout se nepoužívá pro write execution.

## Verifier a review

Každý pokus znovu provede existující test → typecheck → lint → build podle
objevených skriptů. Chybějící checks zůstávají skipped, nikoli otestované.
Model ani reviewer nemohou neúspěch obejít. Failure po editaci také zachová
worktree, aktuální Git metadata a failed run před rozhodnutím o opravě.

| Autor posledního pokusu | Preferred reviewer | Fallback |
| --- | --- | --- |
| OpenCode / Qwen | Antigravity | Codex před začátkem inference |
| Codex | Antigravity | Žádný; lidská eskalace |

Reviewer není lokální Chief/Qwen a Codex nehodnotí vlastní Codex implementaci.
Policy je centralizovaná v `src/review/policy.ts`. Cloud model ID může být null,
pokud CLI používá implicitní default; nevymýšlí se neznámý identifikátor.

Review je snapshot-only v odděleném dočasném runtime, bez připojeného worktree.
Snapshot zahrnuje i obsah nových untracked souborů. Limit je 30 souborů,
12000 znaků diffu a 4000 bytů nového souboru. Neúplný/utajený snapshot vede
k člověku před review; není automatické approve nad vynechanými změnami.

macOS Seatbelt povolí čtení systémového runtime, samotného executable a
privátního runtime; zápisy jen do runtime. Repo/original, symlink escapes
ani další executable nejsou povolené. Cloud síť je nutná pro inference.
Antigravity má `--mode plan --sandbox --json-schema --disable-slash-commands`;
Codex má read-only, ignoruje user config/rules. HOME/config/MCP jsou izolované.
Kopíruje se pouze přihlášení Codex auth.json nebo Antigravity standalone OAuth
token do soukromého runtime (0600), který se po běhu odstraní. Původní auth se
neupravuje. Odlišné auth storage/CLI či platforma mohou vyžadovat novou integraci;
bez funkční read-only cesty se úkol eskaluje, bez uvolnění sandboxu.

Readiness používá bounded --help uvnitř stejného sandboxu, žádnou inferenci.
Neověřuje platnost přihlášení. Fallback lze použít před inference, nikoli po
nejasném selhání již zahájeného review. Každý úspěšný pokus má nanejvýš jedno
review (unique reviews.runId); timeout/malformed output se neopakuje.

Review output má decision, summary, severity a findings (file/line volitelné,
category, description, reason, suggestedFix volitelné). Approve dovoluje jen
none/low. Request_changes vyžaduje aspoň jeden nález a nenulovou severity.
Needs_human vyžaduje otázku. Persistuje se jen veřejný strukturovaný výsledek,
reviewer/providerFamily/model, runId a časy, bez reasoning traces.

Review se soustředí na cíl, kritéria, correctness, security, scope, architekturu
a oslabení testů. Nemá požadovat redesign či kosmetiku bez materiálního přínosu.
Request_changes jde zpět do Chief a následná oprava spotřebuje běžný pokus.
High/critical repair návrh vždy nejdřív čeká na lidské rozhodnutí. Po odpovědi
Chief rozhoduje znovu, TypeScript vynutí strong-coding a nezměněný cap.

## Člověk a praktické CLI

`escalations` má id, taskId, nullable runId, status (open/resolved/cancelled),
reasonType, question, summary, context JSONB, answer, createdAt a resolvedAt.
ReasonType: clarification, max_attempts, review, security, architecture,
product_decision, infrastructure, other. Úkol má při otevření waiting_human.
Worktree zůstane a automatika už nevolá žádný model.

```sh
npm run escalations:list
npm run escalation:answer -- <escalation-UUID> "Zachovej API; očekávaný výsledek je 4."
npm run task:abandon -- <task-UUID>
npx tsx examples/inspect-task.ts <task-UUID>
```

List vypíše escalation ID, task ID, reason, question a createdAt.
Answer vypíše resolved, taskStatus queued a jobId. API `listOpenEscalations()`,
`answerEscalation(id, answer)` a `abandonTask(taskId)` jsou v
`src/escalations/service.ts`.

Odpověď musí být neprázdná a do 6000 znaků, eskalace existovat a být open.
V jediné transakci se uloží odpověď, resolved, queued, ID-only queue job a
human_answered event. QueueName je uložený u tasku, takže se resume vrátí do
stejné fronty. Při enqueue failure se nic částečně nevyřeší. Chief musí
odpověď interpretovat před novým workerem, nikdy se nespustí jako shell/code.
Existující worktree a historie se zachovají; není vytvořen nový task.

Vyčerpaný cap se lidskou odpovědí neobnoví. Chief může vysvětlit další postup,
ale nevznikne další worker run. Použij explicitní abandon nebo po inspekci
nový omezený task; automatický transfer práce do nového tasku není implementovaný.
Abandon ponechá worktree, přepne task na failed a otevřené eskalace cancelled.

## Restart, fronta a kvóta

`tasks.orchestration` drží checkpoint fáze, latestRunId, rozhodnutí a další
recommendation. Major transitions jsou uložené před drahým voláním.
Audit events propojí rezervaci/začátek/konec pokusu, checks, Chief rozhodnutí,
review, eskalaci a odpověď. Není zde event-sourcing framework.

PostgreSQL session advisory lock brání souběžným orchestracím stejného tasku.
Při startu consumeru se obnovují running/repairing/reviewing repository tasky
jeho queue. Bezpečné checkpoints (after_attempt, review, reviewed, decision,
ready) pokračují bez zapomenutí historie. In-flight executing/deciding/reviewing
je po ztrátě vlastníka nejasný: run/review se označí interrupted/failed a
otevře se infrastructure eskalace, nikoli nové placené volání.

Externí proces může přežít tvrdý crash orchestrátoru. Před odpovědí proto
ověř, že původní provider skončil, a inspectuj worktree. Není zde automatické
zjištění finálního stavu vzdálené konverzace. Abort/ztráta DB locku zastavuje
nová volání; in-flight checkpoint vyřeší restart. Recovery nic globálně nemaže.

Repository queue jobs mají retryLimit 0 a expiration 3600 s pro celou bounded
smyčku. Verifier/review/model failure se řeší aplikací a job se po durable
waiting_human/completed vypořádá jako completed; to není task verdict.
Duplicitní delivery completed/waiting_human/failed tasku nevolá worker.
Původní non-repository queue/executor chování zůstává oddělené.

Limity: nejvýše 3 rezervované worker pokusy, jedno review na úspěšný pokus,
žádné review před checks, žádné nested/recursive agent loops, pevný transition
cap 30, žádný model po waiting_human. Chief timeout je LOCAL_CHIEF_TIMEOUT_MS,
OpenCode LOCAL_CODING_TIMEOUT_MS, Codex 90 s, Antigravity review 120 s,
verifier max. 60 s/check. Každý adaptér má jedinou invocation bez aplikačního
provider retry; transportní chování samotných CLI je omezené host timeoutem.

Nejsou implementované memory/vector retrieval, qwen3-embedding, roadmap
retrieval, další autonomní úkol po úspěchu, schedules, webhooks, dashboard,
OpenRouter, auto commit/push/merge/deploy ani self-modifying prompts.
