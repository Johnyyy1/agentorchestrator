# Vývoj a ověřování

## Struktura

| Cesta | Účel |
| --- | --- |
| apps/control-plane/ | Next App Router, UI primitives, server bridge, HTTP routes a Playwright smoke |
| src/control-plane/ | DTO, read modely, redakce, health cache, validované mutace a fixtures |
| src/tasks/ | Zod TaskSpec, centrální sémantika, DB rows, createTask |
| src/router/ | Legacy + capability route, recommendation a readiness |
| src/workers/ | CLI wrappers a jeden implementation/verifier pokus |
| src/orchestration/ | Durable lifecycle, checkpointy, audit, cap a integration tests |
| src/review/ | Nezávislost, read-only snapshot adapter, prompt/schema |
| src/escalations/ | Open/answer/abandon service a minimální CLI |
| src/worker.ts | Start a graceful shutdown consumeru |
| src/queue/ | pg-boss, processing a persistence runů |
| src/db/ | Drizzle schéma a PostgreSQL pool |
| src/git/ | Worktrees, validace, inspekce, úklid |
| src/verification/ | Sandbox execution npm checks |
| src/chief/ | Prompt, schémata, capabilities, plánování/submission |
| src/local/ | Ollama, OpenCode config/readiness, bounded process a sandbox |
| src/mastra/ | Prázdná Mastra instance |
| src/tests/, src/test-*.ts | Fixture a integrační/smoke testy |
| drizzle/ | SQL migrace + metadata |
| examples/ | Spustitelné příklady a vstupní JSON |

TypeScript ESM (type module, module nodenext), source importy s `.js`, běh
přes tsx. Typecheck nic neemituje. Engine nemá build ani deploy; webový workspace má vlastní
typecheck, lint, dev/start a production build. Root TS kontrola vynechává apps,
frontend typecheck kontroluje UI i jeho sdílené TS importy.

## Všechny npm příkazy

| Příkaz (`npm run …`) | Závislosti a účinky |
| --- | --- |
| control-plane:dev | Lokální web na 127.0.0.1:3000; načte root .env, nespouští worker |
| control-plane:fixtures | Explicitní in-memory development UI, fake služby, bez DB/inference |
| control-plane:build | Produkční Next build; bez DB/inference |
| control-plane:start | Built web na 127.0.0.1:3000; bez automatického consumeru |
| control-plane:typecheck | Frontend a sdílené serverové importy |
| control-plane:lint | ESLint UI + src/control-plane |
| control-plane:test | Pure DTO/activity/query/security/mutation/cache testy, fake Chief |
| control-plane:db:test | Vlastní DB rows + cleanup, SQL/read-model integrace, žádný consumer |
| control-plane:e2e | Playwright Chromium + izolovaný fixture dev server :3107, skutečné screenshoty |
| typecheck | Kontrola TS včetně examples; bez DB/modelů |
| test (`npm test`) | semantics:test + chief:unit + router:test + capability-router:test + opencode:unit + repair:unit + reviewer:test + control-plane:test; bez reálné DB/modelů |
| router:test | Routovací příklady; bez AI/DB |
| semantics:test | Pure regrese konfliktního Chief/TaskSpec, routování a completion evidence; bez DB/inference |
| chief:unit | node:test schémat/bridge a local HTTP fixtures; bez inference |
| db:generate | Generuje migrace; config vyžaduje DATABASE_URL |
| db:migrate | Aplikuje migrace do nakonfigurované DB |
| db:test | Dočasný task insert/read/delete ve skutečné DB |
| queue:test | DB, unikátní queue, fake executor; i restart/přerušení |
| verifier:unit | Dlouhé worktree + skutečný tsx/HTTP IPv4/IPv6, OS outbound deny, Node guard, assertion/startup/spawn klasifikace a cleanup; bez DB/AI |
| worktree:test | DB, Git, macOS Seatbelt verifier; fake AI executor a CLI parser test |
| worker | Consumer hlavní queue; může spouštět skutečné providery |
| codex:test | Skutečný Codex, může čerpat kvótu |
| agy:test | Skutečný Antigravity, může čerpat kvótu |
| executor:test | Skutečný general executor, volá Antigravity flash bez úprav souborů |
| chief:check | Ollama readiness bez inference/downloadu |
| chief:test | Dvě lokální inference + izolovaná queue integration; žádný execution provider |
| capability-router:test | Pure policy assertions, včetně fallbacků; bez DB/modelů |
| opencode:check | Binárka, capabilities/config, sandbox startup, lokální model discovery; bez inference/downloadu |
| opencode:pure / reviewer:pure | Parsery, policy a schema bez nového OS sandboxu; součást npm test |
| opencode:os / reviewer:os | Původní skutečné worker/reviewer OS regrese s fake CLI, bez inference |
| sandbox:test | opencode:os + reviewer:os + verifier:unit; spouštěj mimo verifier |
| opencode:unit | Fake OpenCode + HTTP fixtures, parser/permissions a reálná macOS OS hranice |
| opencode:test | Reálný lokální coding smoke v disposable repo + DB/queue persistence, žádný cloud fallback |
| repair:unit | Strict repair schema/bridge, state/cap/redakce, fake Ollama; bez skutečné inference |
| repair:smoke | Jedna bounded skutečná Ollama repair inference, bez DB/cloud workerů |
| reviewer:test | Policy/schema/parser, macOS OS fixture a native fake CLI (vyžaduje cc); bez cloud inference |
| orchestration:test | DB/Git/verifier, fake worker/reviewer/Chief; scénáře A–K a safety |
| escalation:test | Alias orchestration:test; navíc transactional answer/resume/abandon assertions |
| escalations:list | Read-only DB výpis otevřených eskalací |
| escalation:answer | Resolve/odpověď + atomický enqueue existujícího tasku |
| task:abandon | Explicitní failed/cancelled pro waiting_human, worktree zůstane |
| executor:integration | Alias worktree:test; fake Codex/OpenCode, reálná DB/Git/verifier |

`npm test` je základní kontrola bez cloud kvóty a DB. Ollama fixture testy
krátce spouští HTTP servery na loopbacku. Router skript vypisuje routovací
příklady; nejsou v něm assertion testy. Tyto kontroly nejsou ověření
přihlášení providerů nebo skutečného modelu.

OpenCode OS fixture vyžaduje macOS; její success
nelze deklarovat jako ověření jiné platformy. Na ostatních OS test nedokládá funkční OS hranici. Skutečný OpenCode smoke test
potřebuje kompatibilní CLI, lokální model, DB a macOS Seatbelt; automaticky nic neinstaluje.

Pro DB/frontu/worktrees na vývojové instalaci:

```sh
npm run db:migrate
npm run db:test
npm run queue:test
npm run worktree:test
npm run orchestration:test
```

Queue/worktree testy používají vlastní unikátní queue a uklízejí své tasky,
runy i fixture repozitáře. Nevolají AI model. Worktree test potřebuje
funkční macOS Seatbelt verifier a test parseru/oprávnění používá fake executable.
Ověřuje success/failure verifikace, timeout, sandbox/cleanup guardy a ochranu
originálního checkoutu. Nespouštěj je proti cizí nebo produkční DB. Při tvrdém
přerušení inspectuj zbývající testová data; globální mazání není cleanup.

Chief smoke test volá reálné Qwen coding/clarification plánování, odešle task
do vlastní queue bez consumeru, ověří uložený task a ID-only payload a data
odstraní. Nikdy nevolá execution providery. Potřebuje Ollama, model i DB.

## Změny a migrace

1. Uprav kód i dokumentaci podle [AGENTS.md](../AGENTS.md).
2. Při změně DB spusť db:generate, zkontroluj SQL a commitni migraci i metadata.
   Historické aplikované migrace nepřepisuj.
3. Na vývojové DB spusť db:migrate.
4. Spusť typecheck, npm test a integrační kontroly podle dopadu.
5. Před commitem zkontroluj `git diff --check` a `git status --short`.

Závislosti měň přes npm, commitni manifest i lockfile. Novou env proměnnou
přidej do `.env.example` i [setupu](setup.md). Limity dokumentuj podle kódu.
Žádný test/migrace nyní automaticky neběží v GitHub Actions.

## Ověřování repair loop

Fake workers používají skutečné worktrees a sandboxovaný verifier; žádný
Codex/Antigravity model. Fake review/Chief output se revaliduje stejně jako
produkční. Orchestration integration používá vlastní queue/tasky a cascade
cleanup historie, ověřuje A–K, partial edit → strong repair, high severity,
malformed outputs, caps, stejné workspace, advisory lock a orphan recovery.

Reviewer unit test skutečně odmítá original/worktree/symlink writes a shell
execution. Readiness --help v izolovaném runtime nevolá model. Reálná cloud
review inference se v regresích nespouští; auth a provider JSON envelope jiné
CLI verze musí být ověřené zvlášť. [Aktuální report](repair-loop-report.md).

## Control Plane QA

[Setup a přesné příkazy](control-plane.md#development-fixtures-a-testy),
[aktuální report](control-plane-report.md). Screenshoty browser smoke jsou
v `docs/control-plane/`; fixture banner rozlišuje simulaci od reálné DB.
Testy nepoužívají cloud ani lokální modelovou inferenci. Production build
se ověřuje zvlášť od lint/typecheck a fixture browser smoke.

Registry/outcome unit testy jsou součástí `control-plane:test` a `npm test`.
Používají dočasné Git adresáře a fake Chief; nevolají AI. DB QA ověřuje bootstrap
s nulovou historií daného repozitáře, canonical duplicates, počty a
nedostupnost; uklízí jen vlastní records. E2E registruje skutečný dočasný Git
adresář do fixture paměti a ověřuje cestu až v TaskSpec přes submitDecision.
Při změně registry spusť i `db:test`, `control-plane:db:test`, web typecheck,
lint, production build a browser smoke. Migration metadata musí zůstat spolu
s SQL. Outcome tests pokrývají opravy, legacy/missing report, matching review,
failed checks a současnou human question.

Sémantické regrese zahrnují přesný `utility + local-coding + repository` Chief
výstup, strong-coding/planning konflikt, research/planning bez mutation a coding
bez repository. Completion pure testy odmítají chybějící verifier/workspace/worker success,
neshodné attempt/review a neindependentního reviewera. `orchestration:test` navíc
ověřuje normalizaci historické DB row do OpenCode pipeline, chybějící verifier,
workspace či review → waiting_human, a zablokování general completion shortcutu.

Control Plane outcome regrese pokrývá i historický utility/local-coding task
s repository, který omylem dokončil general worker; ukáže explicitní varování
bez fabricace worker reportu či přepisování historie.

Socket regresi spusť samostatně `npm run verifier:unit`. Vytváří skutečný
Git worktree s dlouhou cestou a přes produkční verifier spouští instalovaný
`tsx`. Ověří existující AF_UNIX socket pod krátkým TMPDIR, nezměněný cwd,
HTTP request/response na 127.0.0.1 i ::1, Node odmítnutí wildcard/LAN bind,
OS odmítnutí externího TCP, zákaz zápisu do source i mimo vlastní runtime
a odstranění runtime po běhu. Failing assertion s EPERM není infrastructure;
chybějící manager a sandbox startup failure jsou infrastructure. DB
`npm run orchestration:test` ověřuje jediný zachovaný pokus, žádný repair/review
a stejné bezpečné zastavení i po redelivery nebo human answer. Vše bez inference.
Jde o integraci OS launcheru, nespouští se v sandboxovaném `npm test` uvnitř
verifieru (tam by vznikl další vnořený OS sandbox/runtime).

Root `npm test` neprovádí OS-in-OS regrese: macOS odmítá vnořené
`sandbox_apply` i s vnějším allow default. Původní testy se přesunuly celé
do `opencode-sandbox.test.ts` a `review-sandbox.test.ts`, žádné assertions
nebyly vynechané. Úplnou sadu spouštěj z kořene checkoutu:

```sh
npm run typecheck
npm test
npm run sandbox:test
npm run orchestration:test
```

`opencode:unit` a `reviewer:test` nadále zahrnují pure i OS testy.
Root lint/build se nepřidávají: jejich nepřítomnost zůstává verifier SKIPPED.

### Přímá OpenCode tool diagnostika

`npm run opencode:tools:test` volá skutečný lokální model bez DB/orchestrace/verifieru.
`npm run opencode:tools:test -- --primitives` ověří samostatně read/glob/write/read.
Vyžaduje macOS/OpenCode/Ollama a modelový `num_ctx` shodný s `LOCAL_CODING_CONTEXT`;
[alias setup](opencode.md#skutečný-kontext-ollama-přes-v1). Obě varianty zachovávají
vlastní fixture/worktree/report a nikdy nevolají cloud. Nejsou součástí `npm test`.
Fake `opencode:unit` kontroluje mismatch před inferencí a OS hranice; DB
`orchestration:test` kontroluje infrastructure stop i po redelivery/human answer.
