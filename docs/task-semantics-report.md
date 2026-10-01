# Oprava sémantiky TaskSpec a falešného dokončení

Stav k 1. 10. 2026: oprava a deterministické regrese ověřené. Níže je zachycen
první blokovaný preflight; po explicitním povolení dočasného stash následoval
[jeden skutečný E2E task](jonas-os-real-e2e-report.md), který skončil bezpečně
waiting_human po worker/verifier failure. Úspěšný completed lifecycle s review
není potvrzený.

## Příčina

Chief prompt původně rozlišoval kategorie a doporučoval capability, ale
nepopisoval jejich povinnou vazbu pro repository změny. Zod/JSON schéma
validovalo oba enumy samostatně a repository bylo nepovinné. Proto byl
`utility + local-coding + repository` platným strukturovaným výstupem.
Přesný vnitřní důvod volby modelu nelze určit z jeho výstupu; prokazatelná
chyba systému byla přijetí a vykonání tohoto konfliktu.

`submitDecision()` i `createTask()` prováděly pouze strukturální validaci.
Capability router pak použil „Non-coding category overrides coding capability“
a vybral Antigravity flash. Fronta rozhodovala o coding orchestraci pouze
podle uložené category. Utility tedy šlo do general executoru, který po
úspěšném worker response zapisoval task completed bez verifieru a review.
Durable coding cesta už měla verification/review fáze, ale completion
persistence sama jejich invariant nekontrolovala.

Read-only audit lokální vývojové DB našel dva completed tasky, z toho jeden
sémanticky repository coding. Právě task
`ab228795-4609-4cc2-82dc-63d267d47094` měl utility/local-coding a Antigravity
bez coding/worktree/verifier evidence. Historická data se nepřepisovala.

## Policy a routování

Centrální `normalizeTaskSemantics()` používá category, capability,
repository, objective a acceptanceCriteria. Explicitní local-coding nebo
strong-coding vynutí coding; coding bez repository se odmítne před uložením
či execution. Úzká doplňková kontrola přímých anglických mutation instrukcí
v objective/kritériích zachytí například Add docs/foo.md, Modify README.md,
Fix a TypeScript test a Refactor component i s non-coding capability.
Není to obecný jazykový klasifikátor; hlavní signály jsou strukturované.
Repository samo nepřeklasifikuje research, planning, review nebo utility.

Kontrola běží při Chief parsing/revalidation, submission, createTask,
načítání DB rows, category/capability routing a vstupu do executoru.
Queue/recovery normalizují historické aktivní konfliktní rows před volbou
pipeline; coding bez repository bezpečně selže.

| Vstup | Výsledek |
| --- | --- |
| utility + local-coding + repository | coding → OpenCode, pokud splní stávající eligibility/readiness |
| planning + strong-coding + repository | coding → Codex |
| research + research + repository bez mutation | Antigravity |
| planning bez repository a bez mutation | Původní general route |
| coding bez repository | Odmítnutí; žádná worker inference |
| repository + explicitní mutation + non-coding capability | Coding pipeline; general execution zakázané |

Chief prompt a schema guidance mají povinné coding pravidlo a konkrétní
coding/research/planning příklady. TypeScript je autoritativní. Risk/difficulty,
readiness fallback, sandbox, verifier, nezávislost review a retry limity se
neuvolňovaly. LOCAL_CODING_* a OPENCODE_BIN mají stejné hodnoty a limity.

## Dokončení

Oba task completion writery volají `assertTaskCompletion()` pod task row
lockem v transakci zapisující completed. Repository coding musí mít poslední
úspěšný coding run se startem workeru a neprázdným reportem, uložený worktree
se shodnými metadaty ve výsledku, Git changedFiles metadata a úspěšný neprázdný
verifier result. Guard ověří i dostupnost worktree a canonical repository.
Completed review se stejným taskId/runId musí obsahovat validní APPROVE od
nezávislé provider family. Starší úspěch nebo review jiného pokusu nestačí.
Skipped checks zůstávají explicitní podle existujícího verifieru.

Neúplná údajně úspěšná execution eskaluje waiting_human s chybou
„Execution incomplete: repository mutation was not verified.“ General
completion shortcut skončí failed. Control Plane důvod zobrazí bez nové UI
struktury; stejným varováním označí chybějící evidence historického completed
repository coding, aniž by přepsal DB stav nebo vytvořil chybějící Final Result.

## Změněné soubory

- `src/tasks/semantics.ts`, `semantics.test.ts`, `task-spec.ts`, `create-task.ts`:
  společná policy, DB boundary a přesný Chief/submission regression.
- `src/chief/schema.ts`, `prompt.ts`: authoritative normalization a guidance.
- `src/router/router.ts`, `capability-router.ts`, `capability-router.test.ts`:
  normalizace před route, odstranění nebezpečného category override.
- `src/workers/execute.ts`, `src/queue/task-worker.ts`: správná pipeline i
  pro historické konflikty, guard general completion.
- `src/orchestration/completion.ts`, `completion.test.ts`, `persistence.ts`,
  `service.ts`, `integration.test.ts`: evidence invariant, transakční guard,
  recovery a DB regrese.
- `src/control-plane/mapping.ts`, `outcome.ts`, `outcome.test.ts`: skutečné
  invariant chyby a historická evidence warning.
- `src/test-router.ts`, `test-queue.ts`, `test-worktree.ts`, `test-execute.ts`,
  `examples/tasks/read-only.json`, `package.json`: aktualizované legacy fixtures,
  general smoke a nový pure `semantics:test` v npm test.
- `README.md`, `docs/architecture.md`, `development.md`, `opencode.md`,
  `repair-loop.md`, `setup.md`, `troubleshooting.md`, `usage.md` a tento report:
  nové chování, routing, omezení, příkazy a diagnostika v češtině.

DB schéma, environment proměnné, dependencies a package-lock.json se nemění.

## Ověření a regrese

| Kontrola | Skutečný výsledek |
| --- | --- |
| npm run typecheck | PASS |
| npm test | PASS: 59 assertion testů, bez inference/DB; navíc routing example skript |
| npm run db:test | PASS, vlastní data uklizena |
| npm run queue:test | PASS, fake executor, durable/abort/restart/cleanup |
| npm run worktree:test | PASS, DB/Git/OS sandbox/verifier, fake AI a CLI |
| npm run orchestration:test | PASS: 18 testů včetně parent testu; reálné DB/Git/verifier, fake worker/Chief/reviewer |
| npm run control-plane:typecheck | PASS |
| npm run control-plane:lint | PASS |
| npm run control-plane:db:test | PASS, bounded SQL read model a cleanup 3000 vlastních historických fixture tasků |
| npm run chief:check | READY: lokální Qwen, bez inference/downloadu |
| npm run opencode:check | READY: OpenCode 1.18.33, JSON, qwen3.5:9b-q4_K_M, bez inference |
| git diff --check | PASS |

Přesný utility/local-coding regression byl ověřen přes Chief validation,
submitDecision, createTask a legacy DB row processing. V DB/Git regresi fake
OpenCode vytvořil pouze docs/smoke.md v izolovaném worktree, všechny čtyři
fixture verifier checks prošly a fake Antigravity schválil stejný run.
Coding task bez verifieru, výsledkového či uloženého workspace nebo review
se nedokončil. U uloženého workspace test měl verifier PASS i review APPROVE,
přesto final transakční guard zabránil completed. General executor s dodatečně
zjištěným konfliktem rovněž nemohl dokončit repository coding.

## První preflight a původní checkout

Preflight použil skutečný nezměněný `createTaskWorktree()` pro původní
repozitář. Odmítl vytvoření worktree s chybou „Source repository is dirty.
Commit or stash its changes explicitly before creating a task worktree.“
Zdroj obsahuje rozpracovanou uživatelskou změnu AGENTS.md. Ta se nestashovala,
necommitovala ani neupravovala; pro její dočasné uložení a přesné obnovení byl
vyžádán výslovný souhlas. Bez něj nelze splnit požadovaný reálný lifecycle.

- Local Chief inference: **neproběhla**; test se blokoval před inferencí.
- Skutečný coding worker vybraný/invokovaný tímto smoke: **žádný**.
- Skutečný verifier tohoto smoke: **neproběhl**.
- Skutečný independent review tohoto smoke: **neproběhl**.
- Reálný task completed / populated Final Result: **neověřeno**.
- docs/jonas-os-e2e-smoke.md: **nevznikl** ani v původním checkoutu ani ve
  smoke worktree; smoke worktree se kvůli preflight guardu nevytvořil.
- Původní main checkout: HEAD beze změny (`998b9e52`), stále pouze původní
  AGENTS.md diff; ostatní změny jsou v izolovaném opravném worktree.
- Model/provider calls spotřebované těmito testy: Chief/Qwen **0**, reálný
  OpenCode/Qwen **0**, Antigravity inference **0**, Codex inference **0**.
  Lokální Codex OS sandbox a fake CLI nejsou AI inference.

Úspěšný reálný E2E s Qwen authoring a jedním Antigravity review zůstává
neověřený. Neproběhly skutečné codex:test, agy:test, chief:test, opencode:test
ani executor:test; production web build a browser E2E nejsou součástí tohoto
ověření. Zdrojový checkout ani bezpečnostní pravidla se kvůli smoke neuvolňují.

## Navazující skutečný E2E

Po výslovném souhlasu uživatele byla pouze změna AGENTS.md dočasně stashnuta,
main se fast-forwardnul na 3898426b a proběhl jeden reálný task. OpenCode/Qwen
vytvořil pouze cílový soubor v izolovaném worktree. Worker neměl zachycený
finální public report a verifier test selhal na dlouhé tsx IPC socket cestě;
typecheck prošel, lint/build byly explicitně skipped. Review proto neproběhl
a task zůstal waiting_human. AGENTS.md byl přesně obnoven a ověřen byte-for-byte
i shodou diff patchů; vlastní stash byl odstraněn až po ověření.
[Kompletní výsledky, skutečná inference volání a Control Plane](jonas-os-real-e2e-report.md).
