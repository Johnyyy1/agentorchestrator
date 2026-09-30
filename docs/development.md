# Vývoj a ověřování

## Struktura

| Cesta | Účel |
| --- | --- |
| src/tasks/ | Zod TaskSpec, DB rows, createTask |
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
přes tsx. Typecheck nic neemituje. Není build, lint, dev server ani deploy.

## Všechny npm příkazy

| Příkaz (`npm run …`) | Závislosti a účinky |
| --- | --- |
| typecheck | Kontrola TS včetně examples; bez DB/modelů |
| test (`npm test`) | chief:unit + router:test + capability-router:test + opencode:unit + repair:unit + reviewer:test; bez reálné DB/modelů |
| router:test | Routovací příklady; bez AI/DB |
| chief:unit | node:test schémat/bridge a local HTTP fixtures; bez inference |
| db:generate | Generuje migrace; config vyžaduje DATABASE_URL |
| db:migrate | Aplikuje migrace do nakonfigurované DB |
| db:test | Dočasný task insert/read/delete ve skutečné DB |
| queue:test | DB, unikátní queue, fake executor; i restart/přerušení |
| worktree:test | DB, Git, Codex OS sandbox; fake AI executor a CLI parser test |
| worker | Consumer hlavní queue; může spouštět skutečné providery |
| codex:test | Skutečný Codex, může čerpat kvótu |
| agy:test | Skutečný Antigravity, může čerpat kvótu |
| executor:test | Skutečný coding executor, volá Codex read-only |
| chief:check | Ollama readiness bez inference/downloadu |
| chief:test | Dvě lokální inference + izolovaná queue integration; žádný execution provider |
| capability-router:test | Pure policy assertions, včetně fallbacků; bez DB/modelů |
| opencode:check | Binárka, capabilities/config, sandbox startup, lokální model discovery; bez inference/downloadu |
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
potřebuje kompatibilní CLI, lokální model, DB a codex sandbox; automaticky nic neinstaluje.

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
funkční lokální codex sandbox a test parseru/oprávnění používá fake executable.
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
