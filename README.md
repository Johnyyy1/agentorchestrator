# Jonas OS

Lokální orchestrátor úkolů v TypeScriptu. Úkol uloží do PostgreSQL, zařadí do
trvalé fronty `pg-boss` a předá ho Codexu, Antigravity CLI nebo lokálnímu OpenCode. Volitelný
**Chief** přes lokální Ollama navrhuje strukturované úkoly z přirozeného jazyka.
Úkoly pro změny kódu běží v odděleném Git worktree: deterministické ověření,
omezené opravy přes Chief, nezávislé review a durable lidské eskalace.

Projekt je určený pro vývojáře a lokální použití. Ovládá se přes TypeScript API
a [lokální Control Plane](docs/control-plane.md) nebo [spustitelné příklady](examples/). Repository
coding má bounded repair/review smyčku; další úkol po úspěchu se neplánuje. Mastra je zatím pouze prázdný inicializační modul.

## Co potřebuješ

- Node.js **>=22.13**, doporučená řada **24** (`.nvmrc`), npm a Git.
- PostgreSQL **16** s pgvector, nejjednodušeji přes Docker Compose v tomto repozitáři.
- Pro coding úkoly přihlášený **Codex CLI** v `PATH`.
- Pro ostatní úkoly přihlášený **Antigravity CLI** (`agy`) v `PATH`.
- Pro Chief **Ollama** s lokálním `qwen3.5:9b-q4_K_M`.
- Pro volitelné lokální coding úkoly **OpenCode + Ollama** na macOS.

Kompletní coding workflow s OS sandboxem je ověřovaný na macOS. Ostatní
platformy nejsou tímto repozitářem ověřené; podrobnosti a verze CLI najdeš
v [setupu](docs/setup.md).

## Rychlý start

Zprovozni a přihlas Codex podle [setupu](docs/setup.md#codex-pro-coding-úkoly),
pak v terminálu:

```sh
git clone https://github.com/Johnyyy1/agentorchestrator.git
cd agentorchestrator
# S nvm: nvm install && nvm use
npm ci
cp .env.example .env
docker compose up -d postgres
docker compose exec postgres pg_isready -U jonas -d jonas_os
npm run db:migrate
npm run typecheck
npm test
npm run worker
```

Pokud `pg_isready` ještě hlásí start databáze, počkej a zopakuj kontrolu před
migrací. Worker vypíše `Jonas OS worker ready; listening on jonas-os.tasks.execute`.
Nech ho běžet a ve druhém terminálu ze stejného adresáře odešli první úkol:

```sh
npx tsx examples/create-task.ts examples/tasks/read-only.json
npx tsx examples/inspect-task.ts <ID-vypsané-při-vytvoření>
```

První příklad je `utility` bez úprav souborů a volá skutečný Antigravity flash;
může čerpat kvótu jeho účtu. Stav `queued` znamená čekání na worker; kontrolu zopakuj až do
`completed` nebo `failed`. Výsledek je v `runs[].result.workerResult`.
`acceptanceCriteria` jsou instrukce pro model, text odpovědi se automaticky
neporovnává s očekávanou hodnotou.


## Lokální Control Plane

Po základním setupu spusť `npm run control-plane:dev` a otevři
[127.0.0.1:3000](http://127.0.0.1:3000). Overview, Projects, Repositories, Tasks, Decisions,
Agents a Activity čtou skutečná data a umožňují delegování přes Chief,
answer/resume i potvrzované abandon. Pro vykonávání úkolů nech zvlášť běžet
`npm run worker`; samotné UI consumer nespouští.

```sh
npm run control-plane:build
npm run control-plane:start
```

Bez DB/inference lze UI prohlédnout přes `npm run control-plane:fixtures`
(explicitní simulace v paměti). [Setup, bezpečnost, limity a testy](docs/control-plane.md),
[report ověření](docs/control-plane-report.md).

Projekty nyní uchovávají cíle, omezení, milník a explicitní paměti. Před Chief
plánováním TypeScript sestaví omezený kontext z lokálních embeddings a recent
activity. Execution Core zůstává samostatný. [Project Model + Semantic Memory V1](docs/project-memory.md).

## Dokumentace

| Dokument | Obsah |
| --- | --- |
| [Setup](docs/setup.md) | Instalace, CLI účty, `.env`, databáze, Chief, aktualizace |
| [Používání](docs/usage.md) | Zadávání úkolů, routování, výsledky, worktrees a úklid |
| [Architektura](docs/architecture.md) | Datový tok, schéma, sandboxy a hranice Chief |
| [Vývoj a testy](docs/development.md) | Struktura kódu, všechny npm příkazy, migrace |
| [Řešení problémů](docs/troubleshooting.md) | Diagnostika fronty, databáze, CLI a verifikace |
| [Opravy a eskalace](docs/repair-loop.md) | Lifecycle, nezávislé review, maxAttempts, lidské CLI a restart |
| [Lokální OpenCode](docs/opencode.md) | Capability policy, lokální setup, fallback a security boundary |
| [Control Plane](docs/control-plane.md) | Lokální UI, routes, delegování, rozhodnutí, health a fixtures |
| [Projekty a paměť](docs/project-memory.md) | Project Model, lokální embeddings, pgvector, retrieval, sync a snapshot |
| [AGENTS.md](AGENTS.md) | Pokyny pro LLM včetně povinné aktualizace dokumentace |

## Současná omezení

- Chief plánuje a rozhoduje o opravách; až explicitní odeslání vytvoří nový úkol. Capability a
  `workerBrief` se ukládají jako doporučení, execution router vynucuje vlastní pravidla.
- Coding vyžaduje `repository`; chybějící kontext se odmítá před execution.
  Coding capability normalizuje neslučitelnou kategorii na `coding`, která používá
  izolovaný worktree přes Codex nebo způsobilý lokální OpenCode. Jonas OS sám necommitne, nemerguje,
  nepushuje a nenasazuje změny.
- Závislosti cílového projektu se do nového worktree automaticky neinstalují.
  Ověřují se existující npm/pnpm/yarn skripty; jiné technologie zatím nemají
  vlastní verifier.
- Repository coding má `min(maxAttempts, JONAS_OS_MAX_ATTEMPTS)` pokusů (globální
  default 3), jedno nezávislé review na úspěšný pokus a pg-boss retryLimit 0.
  Waiting_human uchová práci bez dalších volání; ostatní úkoly zachovávají původní chování.
- Docker Compose spouští pouze databázi. Worker, CLI a Ollama běží na hostu.

## Capability policy

| Capability | Worker |
| --- | --- |
| local-coding | OpenCode + Qwen, coding s repository, risk low/medium a difficulty ≤2; prokázaná runtime/config infrastructure vede na waiting_human |
| strong-coding | Codex |
| strong-general | Antigravity pro |
| research | Antigravity |
| local-utility / independent-review | Původní category fallback; nové execution paths jsou odložené |
| Bez doporučení | Původní router |

Limit mění `LOCAL_CODING_MAX_DIFFICULTY` (1–3). High risk nebo vyšší difficulty
použije Codex; non-coding nesmí použít OpenCode. Běžná local readiness unavailable failure má
zaznamenaný fallback na Codex **před execution**. Po failure rozhoduje Chief o novém bounded pokusu; oprava může přejít na Codex
ve stejném worktree. Nejde o fallback uvnitř jedné invocation. Oba coding workery sdílejí
stejný worktree/verifier/Git/persistence pipeline.

OpenCode běží per task s explicitním modelem a JSON výstupem. Dedicated agent
zakazuje shell, externí files, web a subagents; macOS OS sandbox vynucuje
worktree write boundary. Používá stejné Qwen jako Chief a budget 16k.
Podrobnosti, konfigurace a omezení jsou v [OpenCode dokumentaci projektu](docs/opencode.md).

```sh
npm run opencode:check
npm run capability-router:test
npm run executor:integration
npm run opencode:test
```

Předchozí OpenCode milestone ověřil **1.18.33 + qwen3.5:9b-q4_K_M** smoke prošel na tomto hostu
30. 9. 2026: změna pouze v izolovaném worktree, nezměněný source checkout,
všechny čtyři verifier checks, DB routing/workspace/result persistence a cleanup.
Readiness vrací `available: true`, `outputFormat: json`. Compatibility se ověřuje
podle capabilities a resolved security config; omezený text fallback je dostupný
pro CLI bez JSON. Jonas OS žádný CLI ani model automaticky neinstaluje.

## Repair loop a lidská rozhodnutí

Repository task dokončí až úspěšný verifier **a** nezávislé approve.
OpenCode/Qwen hodnotí Antigravity (fallback Codex), Codex pouze Antigravity.
Review je read-only snapshot v izolovaném macOS runtime. Nejasná/high-severity
rozhodnutí, nedostupný reviewer, vyčerpané pokusy nebo orphaned execution
vedou na `waiting_human`. Žádný automatický commit, push, merge či deploy.

```sh
npm run escalations:list
npm run escalation:answer -- <escalation-UUID> "Zachovej současné API a oprav výpočet."
npm run task:abandon -- <task-UUID>
```

Příklad: pokus 1 → test failure → Chief repair → pokus 2 ve stejném worktree
→ checks pass → Antigravity approve → completed. Odpověď se atomicky uloží a
vrátí existující task do fronty; Chief ji interpretuje před dalším workerem.
Cap se odpovědí neobnovuje. [Podrobnosti a omezení](docs/repair-loop.md),
[report implementace a ověření](docs/repair-loop-report.md).

Control Plane obsahuje [Repository Registry V1](docs/control-plane.md#první-repozitář)
pro první Git checkout bez historických úkolů a
[Final Result](docs/control-plane.md#výsledek-úkolu) s veřejným worker reportem,
verification a nezávislým review. Po aktualizaci spusť `npm run db:migrate`.

Deterministický verifier nyní podporuje lokální Node HTTP fixtures a explicitně
rozlišuje chybu vlastní infrastruktury od aplikační verification failure.
macOS inbound omezení, Node guard a ověření popisuje
[verifier loopback report](docs/verifier-loopback-report.md). Pro úplné
deterministické regrese spusť `npm test` i `npm run sandbox:test`; macOS
neumožňuje vnořené sandbox_apply.

OpenCode `/v1` vyžaduje modelový alias s explicitním `num_ctx`; samotný CLI
context limit nestačí. [Lokální setup](docs/opencode.md#skutečný-kontext-ollama-přes-v1)
a `npm run opencode:tools:test` ověřují přímý adaptér bez cloud inference.
Prokázaná local-worker configuration/sandbox/context chyba vede na waiting_human
se zachovaným worktree a bez automatického coding repair/cloud fallbacku.

[Reálné ověření OpenCode tool reliability](docs/opencode-tool-reliability-report.md):
read/glob/write a skutečný repository worker/verifier prošly; jediný nový E2E
zůstal waiting_human kvůli neúspěšné Antigravity review invocation, bez verdictu.

Přímé ověření nezávislého Antigravity reviewera a safe diagnostics:
[report spolehlivosti reviewera](docs/antigravity-reviewer-report.md).
