# Projekty a sémantická paměť V1

Projekt je dlouhodobá doménová entita s vlastní identitou, cíli, omezeními,
instrukcemi a milníkem. Repository Registry nadále vlastní validovanou Git
cestu; projekt ji nekopíruje ani neregistruje. Jeden projekt má až 20 vazeb,
repozitář může patřit do více projektů. Unique partial index dovoluje nejvýše
jeden primary. Projects a Repositories jsou dvě samostatné stránky.

## Používání

1. Přidej Git working tree v **Repositories / + Add repository**.
2. V **Projects / Create project** zadej název, popis a strukturovaná pole,
   zaškrtni registrované repozitáře a volitelně vyber primární.
3. Detail umožňuje upravit projekt, vazby, status a milník. `paused` a
   `archived` zachovávají historii a vyžadují aktivaci před novou delegací.
4. **Add manual memory** přijímá explicitní znalost. Druhy: `fact`, `decision`,
   `milestone`, `issue`, `architecture`, `outcome`; importance je integer 0–5.
5. **Semantic search** ukazuje vybrané paměti, cosine similarity, výsledné
   relevance score a původ. Browser nikdy nedostane embedding vektory.
6. V Overview vyber **Project**, případně jeden z jeho vázaných repozitářů a
   napiš cíl. Primary nebo jediná vazba poskytne jednoznačný default. Bez
   vazby nebo s více vazbami bez primary/výběru aplikace vrátí `ask_human`.
7. Bez vybraného projektu dál funguje původní repository-only delegace.

Slug vzniká z názvu, je unikátní a stabilní; API umožňuje při vytvoření dodat
ASCII slug. Kolize vrací 409. Name má max. 200 znaků, description 2000,
currentMilestone 1000, goals/constraints/instructions jednotlivě 3000.
Projekt není úložiště velkých dokumentů. UI má inventář max. 100 projektů;
překročení zobrazí chybu místo tichého vynechání.

## Paměti a původ

Každá paměť má jeden `projectId`, content (1–8000 znaků), volitelný title (200),
importance, SHA-256 content hash a provenance. Interní validovaný writer
přijímá `manual`, `task`, `run`, `review`, `task_outcome_sync`, `import`;
všechny ne-manual zdroje musí mít `sourceId`. Browser může vytvořit pouze
`manual`; server přidá metadata `input=explicit_human`.

Identita duplicity je project + sourceType + SHA-256(kind, title, content,
sourceId). Importance a metadata nejsou součástí hashe. Dva různé původní
záznamy zůstávají samostatné. Task outcome navíc má unikátní project + task ID,
takže změna historických metadat nevyrobí druhý outcome. V1 již vytvořený
outcome nepřepisuje. Archivovaná přesná manual duplicita se znovu neaktivuje;
pro nový záznam vlož aktualizovaný obsah.

**Archive manual memory** je bezpečný soft archive: vyřadí z budoucího hledání
i seznamu, zachová ID a historické task snapshots. Odvozené outcome paměti
nelze tímto API archivovat. Hard delete projektu není veřejné API; DB odmítá
smazání projektu s úkoly (`RESTRICT`). Bez historických úkolů by interní DELETE
kaskádově odstranil vazby a paměti. Smazání vázaného repository je `RESTRICT`.

## Lokální embedding a připravenost

Používá se lokální Ollama a `qwen3-embedding:0.6b`, bez cloud fallbacku,
automatického downloadu a bez generování textu. Nativní dimension je **1024**
([Ollama model](https://ollama.com/library/qwen3-embedding:0.6b)); centrální
`EMBEDDING_DIMENSION` musí odpovídat `/api/show` a každému `/api/embed` výstupu.
Žádné padding/truncation vektorů. Zero a non-finite vectors se odmítají.

```sh
# Jednorázový explicitní download, pokud model chybí:
ollama pull qwen3-embedding:0.6b
npm run memory:check
# Explicitní inference, ne skrytá část readiness:
npm run memory:smoke
```

Konfigurace v `.env`: `MEMORY_EMBEDDING_MODEL` (default výše),
`MEMORY_EMBEDDING_TIMEOUT_MS` (default 30000, 50–120000 ms), sdílený
`OLLAMA_BASE_URL` (default `http://127.0.0.1:11434`). URL musí být loopback HTTP,
bez credentials/path/query a bez redirectů. Model musí být nainstalovaný,
embedding-capable, bez remote metadata, se správnou dimenzí. Výstup max. 512 KB,
embedding vstup max. 8201 znaků (title + newline + content); `truncate:false`.
Query dostane krátký instruction prefix podle účelu embedding modelu.

`memory:check` kontroluje DB, extension, tabulku a typ sloupce `vector(1024)`, Ollama
tags/show a dimenzi z metadat bez inference. `memory:smoke` je jedna malá smoke sada: query „market
data architecture“ a tři paměti; obě doménové musí rankovat nad dark mode.
Persistovaný embedding model obsahuje jméno **a digest** modelu. Retrieval
nikdy nemíchá embedding spaces. Změna modelu/digestu vyžaduje reindexaci;
V1 retry indexuje jen neindexované paměti, hromadná změna modelu není UI funkcí.

Paměť se nejprve uloží bez embeddingu. Chyba indexace uchová obsah a bezpečný
error code; **Retry pending indexing** zpracuje nejvýše 30 neindexovaných
záznamů. Task completion transakce nikdy nevolá embedding adapter.

## PostgreSQL / upgrade

Compose používá `pgvector/pgvector:0.8.6-pg16-trixie`, stále PostgreSQL 16 a
stejné `jonas_pg` volume. Trixie zachovává collation prostředí předchozího
`postgres:16` používaného při ověření; u vlastní instalace porovnej původní
OS/locale. Použij stejný Compose project name jako před změnou, zejména ve
worktree, aby vznikající prefix volume nepřesměroval databázi.

Před výměnou zastav consumer/aplikace, ověř PostgreSQL major, mount volume a
udělej zálohu. Příkazy z kořene checkoutu; dosaď skutečný původní Compose
project name, pokud se liší od `jonas-os`:

```sh
docker compose -p jonas-os ps
docker compose -p jonas-os exec -T postgres psql -U jonas -d jonas_os -c 'SELECT version();'
docker compose -p jonas-os exec -T postgres pg_dump -U jonas -d jonas_os -Fc > ../jonas-os-before-memory.dump
docker compose -p jonas-os pull postgres
docker compose -p jonas-os up -d postgres
docker compose -p jonas-os exec -T postgres pg_isready -U jonas -d jonas_os
npm run db:migrate
npm run memory:check
```

Migrace `0005_overconfident_gladiator.sql` používá `CREATE EXTENSION IF NOT
EXISTS vector`, přidává projects, project_repositories, project_memories a
nullable `tasks.project_id/project_context`. Historické úkoly nepotřebují
backfill. Task snapshot je JSONB, max. 12000 znaků v DB; immutable trigger
odmítá změnu association i snapshotu po insertu. Staré sloupce a lifecycle
zůstávají stejné. Nepoužívej `down -v`, reset databáze ani nové prázdné volume.
Na vlastním PostgreSQL nainstaluj pgvector pro major 16 a zajisti oprávnění
pro extension creation před migrací.

## Retrieval a limity kontextu

SQL nejdřív omezuje na `project_id`, nearchivované a indexované záznamy se
stejným model digestem. Přesný cosine dotaz vybere nejvýše **30** nejbližších
kandidátů; V1 nepoužívá approximate index ani externí search service.
TypeScript znovu filtruje project identity a similarity ≥0.2, poté řadí:

```text
score = 0.90 × cosine_similarity
      + 0.07 × importance/5
      + 0.03 / (1 + age_days/30)
```

Age je nezáporný věk od createdAt. Shody řadí similarity, createdAt DESC a ID
ASC. Max. **8** výsledků; importance/recency přidají dohromady nejvýše 0.10,
takže nové irelevantní datum nepotlačí výrazně relevantnější staré rozhodnutí.

`buildProjectContext()` načte strukturovaný projekt, vazby, retrieval a
nejvýše **5** posledních task statuses/titles. Chief dostane existující
`project.summary/roadmapExcerpt` rozhraní; jeho schema a systémové politiky
zůstávají nezměněné. Rendered budget je **6400** znaků: static/repositories
max. 3000, memories max. 2500 (content max. 800 na vybraný záznam), recent
activity max. 5 položek. Statická pole se pro prompt zkracují na 450 znaků
(name 200); databáze uchovává celý validovaný obsah. Celé Chief input JSON
zůstává omezené na 16000 znaků včetně goal (max. 4000). Výjimečně vysoké JSON
escaping náklady způsobí validovanou chybu místo překročení limitu.

Při nedostupném embedding provideru se plánování může opřít o statická pole
a recent activity, s explicitním `retrievalStatus=unavailable` a prázdným
memory výběrem. DB chyby se nezamlčí. Žádné vektory, kompletní logy nebo hidden
reasoning nevstupují do Chief kontextu.

## Association a „Proč to Chief věděl?“

Caller dodá `projectId`; model jej nemá v TaskSpec. `planProjectGoal()` vrací
Chief decision a separátní submission context. `submitDecision(decision,
{ projectContext })` předá metadata čtvrtým argumentem do `createTask()`.
Samostatný počáteční task insert transakčně kontroluje aktivní projekt,
updatedAt, vazbu/repository identity a příslušnost vybraných memory/task IDs.
Pokud se projekt mezitím změnil, vložení odmítne. Existing queue transakce a
pending-row diagnostika fungují stejně.

Snapshot obsahuje project ID/updatedAt, vybraná memory IDs, recent task IDs,
použitou repository vazbu, query, retrieval status a createdAt. Je immutable;
nejde o full prompt dump. Task detail zobrazí snapshot i odkazy na projekt a
recent tasks. Při archive paměti si snapshot ID uchová. Zkrácený prompt ani
historické znění všech statických polí V1 neukládá; updatedAt je reference na
verzi projektu, úplný replay promptu není garantovaný.

## Explicitní outcome sync

Detail projektu má **Sync completed task outcomes**. CLI:

```sh
npm run memory:sync -- <project-UUID>
# Pokud odpověď obsahuje nextCursor:
npm run memory:sync -- <project-UUID> <nextCursor>
npm run memory:index -- <project-UUID>
```

Dávka má max. **50 completed tasks** v deterministickém ID pořadí; další dávka
použije cursor. Výsledek: scanned, created, alreadyExisted, embeddingFailures,
skipped, nextCursor. Ne-completed tasks se neprojektují. Staré completed tasks
bez run/review metadat používají `(not recorded)` a nevytvářejí domyšlený důkaz.

Projection obsahuje pouze title, objective, bounded changed files, verifier
statuses, reviewer verdict a public worker summary, plus task/run/review IDs.
Žádná LLM sumarizace, druhý Chief call, task mutation nebo dokončovací hook.
Embedding failures nevytvářejí duplicitní paměť; opakovaná dávka zkusí chybějící
indexaci. Nic se automaticky nesynchronizuje při načtení stránky.

## API a bezpečnost

Všechny routes využívají původní Host/Origin ochrany, strict Zod, UUID a délkové
limity. Mutace vyžadují `X-Request-ID` UUID a stejný lokální Origin. Process
idempotency cache chrání opakované HTTP requests; durable unique constraints
chrání memory duplicity a primární vazby.

| Endpoint | Účel |
| --- | --- |
| GET /api/projects | Nejvýše 100 projektů se zkrácenou recent activity |
| POST /api/projects | Vytvoření; registrovaná repository IDs, nikdy cesty |
| GET /api/projects/[id]?page=1 | Projekt a 50 pamětí + hasMore |
| PATCH /api/projects/[id] | Pole/status/atomická výměna vazeb |
| POST /api/projects/[id]/memories | Manual memory + pokus o local indexaci |
| POST /api/projects/[id]/archive-memory | Pouze manual memoryId, soft archive |
| POST /api/projects/[id]/search | Project-scoped query/limit, bez vektorů |
| POST /api/projects/[id]/sync | Bounded deterministic outcomes, optional afterTaskId |
| POST /api/projects/[id]/index | Max. 30 neindexovaných pamětí |
| POST /api/commands/delegate | goal + projectId/optional bound repositoryId, nebo legacy projectKey |

Memory je data, ne autorita. Nemění capability policy, routing, sandbox,
verifier, reviewer, repair, escalation ani completion invariant. Chief nemá
DB tools. Model a DB zůstávají lokální, UI rediguje rozpoznané secrets. V1
neimplementuje cross-project/personal memory, LLM memories, autonomní next-step
planning, schedules, remote triggers ani cloud embeddings.

## Ověřování

`npm test` zahrnuje fake embeddings a pure project/memory testy.
`npm run memory:db:test` vytváří vlastní fixtures, ověřuje SQL vector/query,
constraints, sync a skutečné task association/queue bez consumeru a uklízí jen
vlastní rows/queue. `npm run memory:browser:test` používá skutečnou vývojovou DB,
registrovaný dočasný Git repo, UI project CRUD a local embeddings. Vyžaduje
nainstalovaný embedding model. Server :3118 má explicitní
`CONTROL_PLANE_PROJECT_QA=1`: načte a validuje real project context, ale fake
Chief vrátí pouze `ask_human`, nikdy nezařadí coding task. Flag je odmítnut v
production. Test po sobě uklidí projekt/repository a pořídí screenshoty do
`docs/project-memory-v1/`. Běžný fixture server zůstává pouze in-memory simulací
repository-only enginu; nehraje si na skutečný Project Model.
