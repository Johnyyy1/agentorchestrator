# Jonas OS

Lokální orchestrátor úkolů v TypeScriptu. Úkol uloží do PostgreSQL, zařadí do
trvalé fronty `pg-boss` a předá ho Codexu, Antigravity CLI nebo lokálnímu OpenCode. Volitelný
**Chief** přes lokální Ollama navrhuje strukturované úkoly z přirozeného jazyka.
Úkoly pro změny kódu běží v odděleném Git worktree a mají následné ověření.

Projekt je určený pro vývojáře a lokální použití. Ovládá se přes TypeScript API
a [spustitelné příklady](examples/). Nemá webové UI, HTTP API ani automatickou
smyčku Chief → worker. Mastra je zatím pouze prázdný inicializační modul.

## Co potřebuješ

- Node.js **>=22.13**, doporučená řada **24** (`.nvmrc`), npm a Git.
- PostgreSQL **16**, nejjednodušeji přes Docker Compose v tomto repozitáři.
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

První příklad volá skutečný Codex v režimu `read-only` a může čerpat kvótu jeho
účtu. Stav `queued` znamená čekání na worker; kontrolu zopakuj až do
`completed` nebo `failed`. Výsledek je v `runs[].result.workerResult`.
`acceptanceCriteria` jsou instrukce pro model, text odpovědi se automaticky
neporovnává s očekávanou hodnotou.

## Dokumentace

| Dokument | Obsah |
| --- | --- |
| [Setup](docs/setup.md) | Instalace, CLI účty, `.env`, databáze, Chief, aktualizace |
| [Používání](docs/usage.md) | Zadávání úkolů, routování, výsledky, worktrees a úklid |
| [Architektura](docs/architecture.md) | Datový tok, schéma, sandboxy a hranice Chief |
| [Vývoj a testy](docs/development.md) | Struktura kódu, všechny npm příkazy, migrace |
| [Řešení problémů](docs/troubleshooting.md) | Diagnostika fronty, databáze, CLI a verifikace |
| [Lokální OpenCode](docs/opencode.md) | Capability policy, lokální setup, fallback a security boundary |
| [AGENTS.md](AGENTS.md) | Pokyny pro LLM včetně povinné aktualizace dokumentace |

## Současná omezení

- Chief pouze plánuje; až explicitní odeslání vytvoří úkol. Capability a
  `workerBrief` se ukládají jako doporučení, execution router vynucuje vlastní pravidla.
- Coding bez `repository` používá `read-only`; coding s `repository` používá
  izolovaný worktree přes Codex nebo způsobilý lokální OpenCode. Jonas OS sám necommitne, nemerguje,
  nepushuje a nenasazuje změny.
- Závislosti cílového projektu se do nového worktree automaticky neinstalují.
  Ověřují se existující npm/pnpm/yarn skripty; jiné technologie zatím nemají
  vlastní verifier.
- `maxAttempts` se ukládá, ale aktuálně neřídí queue retries. Repository coding
  má automatické opakování vypnuté; ostatní úkoly používají výchozí nastavení
  `pg-boss`. Detaily jsou v [architektuře](docs/architecture.md).
- Docker Compose spouští pouze databázi. Worker, CLI a Ollama běží na hostu.

## Capability policy

| Capability | Worker |
| --- | --- |
| local-coding | OpenCode + Qwen, coding s repository, risk low/medium a difficulty ≤2 |
| strong-coding | Codex |
| strong-general | Antigravity pro |
| research | Antigravity |
| local-utility / independent-review | Původní category fallback; nové execution paths jsou odložené |
| Bez doporučení | Původní router |

Limit mění `LOCAL_CODING_MAX_DIFFICULTY` (1–3). High risk nebo vyšší difficulty
použije Codex; non-coding nesmí použít OpenCode. Local readiness failure má
zaznamenaný fallback na Codex **před execution**. Po zahájení local execution
není automatický retry ani handoff; worktree zůstane k inspekci. Oba coding workery sdílejí
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

Real OpenCode **1.18.33 + qwen3.5:9b-q4_K_M** smoke prošel na tomto hostu
30. 9. 2026: změna pouze v izolovaném worktree, nezměněný source checkout,
všechny čtyři verifier checks, DB routing/workspace/result persistence a cleanup.
Readiness vrací `available: true`, `outputFormat: json`. Compatibility se ověřuje
podle capabilities a resolved security config; omezený text fallback je dostupný
pro CLI bez JSON. Jonas OS žádný CLI ani model automaticky neinstaluje.
