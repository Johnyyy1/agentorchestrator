# Instalace a konfigurace

## Požadavky a kompatibilita

| Součást | Požadavek | Kdy je potřeba |
| --- | --- | --- |
| Node.js + npm | Node >=22.13, doporučená řada 24 | Vždy |
| Git | CLI v `PATH` | Klonování a repository coding |
| PostgreSQL | 16 + pgvector; Docker Compose plugin nebo vlastní server | Ukládání a vykonávání úkolů |
| Codex CLI | `exec --json`, `--ignore-user-config`, `--ignore-rules`, `sandbox` | Codex coding worker |
| macOS Seatbelt | `/usr/bin/sandbox-exec` | Deterministický verifier; žádný unrestricted fallback |
| Antigravity CLI | `agy -p`, `--output-format json`, `--print-timeout` | Research, planning, review, utility |
| Ollama + lokální model | `/api/tags`, `/api/show`, `/api/chat` se structured outputs | Chief a lokální OpenCode worker |
| OpenCode + Ollama | `run --model`, ověřený config/agent, JSON preferovaný, macOS sandbox-exec | Volitelný lokální coding worker |

Node minimum vychází z požadavků závislostí. Coding sandbox byl ověřen
na macOS s `codex-cli 0.159.2`; nejde o garanci každé starší či budoucí verze.
Chief byl ověřen s Ollama **0.32.14**. Verifier, lokální worker a nezávislá
review hranice aktuálně vyžadují macOS. Na Linuxu/Windows verifier bezpečně
vrátí infrastructure failure; celý workflow zde není ověřený:
worktree manager používá unixové předpoklady jako `/dev/null`, verifier na
Unixu ukončuje procesní skupiny.

## Checkout a závislosti

```sh
git clone https://github.com/Johnyyy1/agentorchestrator.git
cd agentorchestrator
node --version
npm --version
git --version
```

S nvm spusť `nvm install` a `nvm use` (řada z `.nvmrc`), poté:

```sh
npm ci
cp .env.example .env
```

Při existující instalaci nepřepisuj vlastní `.env`. Je ignorovaný Gitem.
Všechny příkazy spouštěj z kořene projektu, aby `dotenv` našel `.env`.
Proměnné už nastavené v procesu mají před souborem přednost.

## Databáze

Spusť Docker Desktop nebo jiný Docker engine s Compose pluginem:

```sh
docker compose up -d postgres
docker compose ps
docker compose exec postgres pg_isready -U jonas -d jonas_os
```

Pokud databáze ještě startuje, readiness kontrolu zopakuj. Po úspěchu:

```sh
npm run db:migrate
npm run db:test
```

Compose používá PostgreSQL 16, databázi `jonas_os`, lokální uživatelské jméno
i heslo `jonas`, host port **127.0.0.1:5434** (uvnitř kontejneru 5432).
Výchozí `.env.example` tomu odpovídá. Tyto údaje jsou pro lokální vývoj.
Data přetrvávají ve volume `jonas_pg` (obvykle s prefixem Compose projektu).

Místo Dockeru můžeš vytvořit DB na vlastním PostgreSQL a nastavit
`DATABASE_URL`. Účet musí mít oprávnění vytvářet aplikační tabulky i
schéma/tabulky `pg-boss`; `boss.start()` vytváří queue infrastrukturu
samostatně od Drizzle migrací. Pro testy použij samostatnou vývojovou DB.

Port změň v Compose i `DATABASE_URL`. Změna `POSTGRES_USER`,
`POSTGRES_PASSWORD` nebo `POSTGRES_DB` nezmění již inicializovaný volume;
uprav existující DB nebo založ novou.

## Codex pro coding úkoly

Nainstaluj [Codex CLI](https://developers.openai.com/codex/cli/) a jednou ho
interaktivně přihlas pod účtem, pod kterým bude běžet worker:

```sh
npm install -g @openai/codex
codex
```

Ověř CLI bez AI inference:

```sh
codex --version
codex exec --help
codex sandbox --help
```

Repository coding potřebuje flagy z tabulky výše. Wrapper nepředává
`--model`; write invocation ignoruje user config a execpolicy rules,
přihlášení CLI však zůstává použité. `LOCAL_CHIEF_MODEL` model Codexu nemění.
Jonas OS neprovádí přihlášení a nemá vlastní provider autentizaci.

`npm run codex:test` je volitelná kontrola skutečného modelu s timeoutem
90 sekund a možnou spotřebou kvóty. Worktree test používá fake AI executor.

## Antigravity pro obecné úkoly

Postupuj podle [oficiální instalace a přihlášení](https://antigravity.google/docs/cli/install).
Na macOS/Linux je zveřejněný instalační příkaz:

```sh
curl -fsSL https://antigravity.google/cli/install.sh | bash
agy
```

Dokonči interaktivní setup/přihlášení a ověř:

```sh
agy --help
agy models
```

CLI musí být v `PATH` workeru (instalátor používá `~/.local/bin/agy`). Pro
odlišné modely tierů vlož dostupné identifikátory z `agy models` do
`AGY_FLASH_MODEL` a `AGY_PRO_MODEL`; bez nich obě větve používají CLI default.
Po změně restartuj worker. `npm run agy:test` volá skutečného providera.

## Volitelný lokální Chief

Stáhni a spusť [Ollama](https://docs.ollama.com/quickstart). Chief odmítá
cloud/remote modely. Pokud server neběží jako aplikace nebo služba, spusť ho
v dalším terminálu přes `ollama serve`. V jiném terminálu:

```sh
ollama pull qwen3.5:9b-q4_K_M
ollama list
npm run chief:check
npm run chief:unit
```

Download provádíš explicitně ty; aplikace nikdy model nestahuje. Paměť musí
stačit na 9B model i zvolený kontext. Při timeoutu můžeš snížit kontext nebo
vybrat menší lokální generation model. Čisté `planGoal()` nepotřebuje DB ani
execution CLI, odeslání návrhu již DB potřebuje.

## Volitelný lokální coding worker

Adaptér používá nativní provider `ollama` a macOS `/usr/bin/sandbox-exec`.
Na tomto hostu je dostupná OpenCode **1.18.33** z Homebrew. Nastav `OPENCODE_BIN`
na existující executable nebo zajisti PATH. Jonas OS nic neinstaluje.
Kompatibilita se kontroluje podle interface a resolved bezpečnostní konfigurace,
ne podle major verze. Samotnou instalaci popisuje
[OpenCode dokumentace](https://opencode.ai/docs/).

Připrav lokální Ollama model jako pro Chief, potom:

```sh
opencode --version
opencode run --help
npm run opencode:check
npm run opencode:unit
```

Readiness neprovádí inferenci/download: ověří binárku, explicitní model selection, resolved
agent/permissions, start v sandboxu, Ollama model a discovery přes `opencode models ollama`. Při chybě se
způsobilý task **před execution** směruje na Codex, takže musí být přihlášený,
pokud tento fallback chceš používat. Na jiné platformě je lokální cesta
nedostupná. Verifikace OpenCode změn potřebuje macOS `sandbox-exec`, který
nevolá AI ani cloud. Pro dobrovolný test se skutečným lokálním modelem slouží
`npm run opencode:test` (disposable repo a DB/queue fixture, žádný fallback na Codex).

## Proměnné prostředí

| Proměnná | Default | Význam / omezení |
| --- | --- | --- |
| `JONAS_OS_REPOSITORIES` | Nenastaveno | Volitelný Control Plane bootstrap: absolutní Git cesta nebo JSON pole (max. 100); validace při čtení, bez skenování |
| `DATABASE_URL` | Žádný v kódu; ukázka v `.env.example` | Povinná pro DB, migrace, frontu a worker |
| `AGY_FLASH_MODEL` | CLI default | Model běžných non-coding úkolů |
| `AGY_PRO_MODEL` | CLI default | Model non-coding s difficulty >=4 nebo risk high |
| `JONAS_OS_MAX_ATTEMPTS` | `3` | Integer 1–3; repository worker pokusy včetně oprav, min s TaskSpec.maxAttempts |
| `JONAS_OS_WORKTREE_DIR` | `~/.jonas-os/worktrees` | Absolutní cesta mimo všechny checkouty source repo |
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | Jen HTTP loopback: 127.0.0.1, localhost, ::1; bez credentials/path/query |
| `LOCAL_CHIEF_MODEL` | `qwen3.5:9b-q4_K_M` | Nainstalovaný lokální generation model |
| `LOCAL_CHIEF_CONTEXT` | `16384` | 2048–32768 tokenů |
| `LOCAL_CHIEF_TIMEOUT_MS` | `120000` | 1000–300000 ms na generation request |
| `OPENCODE_BIN` | `opencode` | Binárka v PATH nebo absolutní cesta; relativní cesty s `/` nejsou podporované |
| `LOCAL_CODING_MODEL` | `LOCAL_CHIEF_MODEL` nebo Chief default | Lokální Ollama model pro OpenCode |
| `LOCAL_CODING_CONTEXT` | `16384` | 4096–16384 tokenů |
| `LOCAL_CODING_TIMEOUT_MS` | `180000` | 1000–300000 ms |
| `LOCAL_CODING_MAX_DIFFICULTY` | `2` | 1–3; eligibility limit lokálního coding |

Přihlašovací údaje CLI spravují samotná CLI mimo `.env` tohoto projektu.
`PATH` musí obsahovat potřebné binárky pro worker i verifier. Verifier používá
macOS `sandbox-exec`, krátký vlastní runtime a Node guard zděděný přes
`NODE_OPTIONS`. Testové TCP servery binduj explicitně na 127.0.0.1 nebo ::1.
Profil odmítá externí outbound, ale Seatbelt neumí přesnou izolaci inbound
loopback proti LAN; Node guard není OS hranice pro jiné runtime ani hostile
kód. Podrobnosti jsou v [architektuře](architecture.md#verifikace).
Nové proměnné prostředí ani konfigurace workerů se nepřidávají.

## Spuštění, zastavení a aktualizace

```sh
npm run typecheck
npm test
npm run sandbox:test
npm run worker
```

Worker běží v popředí. `Ctrl+C`/`SIGTERM` zahájí graceful shutdown; čekání na
rozpracovanou práci může trvat až 10 minut. Správci procesů nastav cwd na
kořen projektu a stejného uživatele, `PATH` a CLI přihlášení. Compose
spouští pouze DB, worker a Ollama běží na hostu.

DB zastaví `docker compose stop postgres`, znovu startuje
`docker compose up -d postgres`. `docker compose down` volume ponechá.
**`docker compose down -v` smaže všechna DB data** a není krok aktualizace.

Před aktualizací zastav worker, ulož vlastní změny a zálohuj důležitá data
(např. `docker compose exec -T postgres pg_dump -U jonas jonas_os > ../jonas-os-backup.sql`).
Záloha může obsahovat prompty/výsledky; ukládej ji mimo repo. Pak:

```sh
git pull --ff-only
npm ci
npm run db:migrate
npm run typecheck
npm test
npm run sandbox:test
npm run worker
```

Porovnej `.env` s novou `.env.example`. Migrace se při startu workeru
automaticky neaplikují. Worktree root neměň, dokud potřebuješ inspekci nebo
úklid worktrees vytvořených pod původním rootem.

## OpenCode local coding

Nastavení `LOCAL_CODING_MODEL`, `OPENCODE_BIN`, context/timeout/difficulty
limitů je v [lokálním coding setupu](opencode.md#konfigurace-a-readiness).
Ověř instalovanou CLI přes `npm run opencode:check`; samotná desktop aplikace
nenahrazuje CLI. Jonas OS nepoužívá uživatelův OpenCode config/auth a nestahuje
provider packages. Adapter ověřuje požadovaný config/permissions a macOS OS boundary;
discovery failure má dosavadní fallback, ale prokázaná configuration/CLI/sandbox/context
chyba zastaví local-coding jako infrastructure bez cloud inference. OpenCode `/v1`
nepřenáší `num_ctx`: vytvoř lokální alias přes `examples/opencode.Modelfile`, nastav
`LOCAL_CODING_MODEL=qwen3.5:9b-q4_K_M-jonas-16k` a ověř shodu modelového
`num_ctx` s `LOCAL_CODING_CONTEXT` podle uvedeného setupu. Automatický download ani
úprava základního modelu neprobíhá.
Migraci nullable `tasks.chief` a `runs.routing` aplikuje `npm run db:migrate`.

Pro native fake reviewer CLI test je navíc potřeba C compiler (`cc`, na macOS
z Command Line Tools). Produkční worker tento compiler nepoužívá.

## Nezávislé review a repair loop

Aplikuj novou Drizzle migraci přes `npm run db:migrate`; žádný db push.
Pro opravy potřebuje worker lokální Chief/Ollama a pro dokončení repository
coding také nezávislého reviewera. OpenCode/Qwen → Antigravity (fallback Codex);
Codex → Antigravity. Bez dostupného reviewera task přejde na waiting_human.

Reviewer boundary nyní vyžaduje macOS sandbox-exec. CLI musí podporovat
read-only/plan flags a startovat uvnitř sandboxu. Readiness zkouší jen --help,
nikoli inferenci. Auth zůstává ze stávajícího přihlášení: privátní kopie Codex
`auth.json` (z CODEX_HOME nebo standardní složky). Antigravity CLI 1.2.14 na macOS
používá consumer OAuth položku Keychain `service=gemini`, `account=antigravity`.
Host adapter přečte pouze tuto položku (max. 5 s) a přenese jen `token`, `auth_method`
a `id_token` do souboru `.gemini/antigravity-cli/antigravity-oauth-token` v privátním
HOME. Pokud položka neexistuje, použije přesně tento soubor v běžném HOME.
Starší `.gemini/jetski-standalone-oauth-token` není přihlášení současného CLI.
Jiný auth method v této izolované integraci není podporovaný; chyba eskaluje.

Kopie má režim 0600 a sandbox jí zakazuje zápis/odstranění. CLI nesmí spouštět
`security` ani jiné executable, číst uživatelův HOME, projekt či Keychain.
Config/MCP jsou prázdné a celý runtime se po běhu smaže. CLI backend vyžaduje
loopback listener; profil pro Antigravity povoluje inbound s filtrem `localhost:*`.
Repo přístup se tím nemění. macOS filtr připouští také wildcard bind; neslouží
jako obecný zákaz vytvoření wildcard socketu. Skutečný CLI backend byl pozorovaný
s bindem na `127.0.0.1:0`; jiné programy reviewer spouštět nesmí.

Nejdřív ověř aktuální rozhraní a přihlášení bez inference:

```sh
command -v agy
agy --version
agy --help
agy help models
agy models
```

Přímý opt-in test `npm run reviewer:direct` provede dva malé cloud reviews
GOOD/BAD, bez Chief, workeru, fronty a verifieru. BAD nesmí schválit odčítání
při požadavku na sčítání. Test porovnává hash zdroje, HEAD a Git status a uklidí
fixture. Není součástí `npm test`. Ověřené výsledky a aktuální envelope jsou
v [reportu spolehlivosti reviewera](antigravity-reviewer-report.md).

Limit `JONAS_OS_MAX_ATTEMPTS=3` znamená nanejvýš tři pokusy včetně prvního;
TaskSpec může stanovit nižší limit. Chief ani resume cap nezvyšují.
LOCAL_CODING_*/OPENCODE_BIN a původní capability eligibility jsou beze změny.
[CLI lidských eskalací a restart](repair-loop.md).

## Control Plane

Root `npm ci` instaluje i webový workspace (Next.js 16.3.8, React 19.3, Tailwind 4).
Po existujících migracích spusť `npm run control-plane:dev`; web binduje pouze
na 127.0.0.1:3000. Konfigurace se načítá z kořenové `.env`. DB a modely se
automaticky nestartují. Pro vykonávání úkolů potřebuješ samostatný `npm run worker`.
Lokální produkční režim: `npm run control-plane:build`, potom
`npm run control-plane:start`. Jiný port zvol `PORT=3001 npm run control-plane:start`.

`CONTROL_PLANE_FIXTURES` je development/test přepínač: výchozí 0, explicitní
`npm run control-plane:fixtures` nastaví 1 a používá jen in-memory data/fake
služby. V production je hodnota 1 odmítnutá. Pro běžné používání ji neaktivuj.
Zbytek provider konfigurace včetně LOCAL_CODING_*/OPENCODE_BIN zůstává beze změn.
[Routes, používání, bezpečnost a limity](control-plane.md).

### Repository Registry V1

Po aktualizaci aplikuj `npm run db:migrate` (nová tabulka `repositories`).
První cestu přidej přes **+ Add repository** v Overview/Repositories nebo nastav
`JONAS_OS_REPOSITORIES` v root `.env`. Například jedna absolutní Git cesta či
`["/absolute/path/to/first","/absolute/path/to/second"]`. Hodnotu můžeš získat
příkazem `pwd -P` spuštěným v kořeni cílového checkoutu. Restartuj web po změně
`.env`. Server registraci zajistí idempotentně při čtení; neplatné cesty
nepřidává. [Validace a použití](control-plane.md#první-repozitář).

### Sémantika repository úkolů

Coding a capability `local-coding`/`strong-coding` vyžadují repository kontext.
Při aktualizaci není potřeba migrace ani nová proměnná prostředí; hodnoty a limity
`LOCAL_CODING_*` a `OPENCODE_BIN` se nemění. Staré aktivní konfliktní rows worker
normalizuje před execution, coding bez repository odmítá. General smoke příklad
`examples/tasks/read-only.json` je nyní utility přes Antigravity. Nový worktree
stále vyžaduje explicitní provisioning dependencies, automatická instalace není
součástí executoru. [Policy a routing tabulka](opencode.md#směrování).

## Project Model a lokální paměť

Po upgradu aplikuj `npm run db:migrate`. Compose používá
`pgvector/pgvector:0.8.6-pg16-trixie`, stejné PostgreSQL major 16 a stejné volume.
Před výměnou image zazálohuj DB a použij původní Compose project name; postup
je v [nedestruktivním upgradu](project-memory.md#postgresql--upgrade).
`MEMORY_EMBEDDING_MODEL=qwen3-embedding:0.6b` a
`MEMORY_EMBEDDING_TIMEOUT_MS=30000` nastavují dedicated loopback adapter.
Chybějící model se automaticky nestahuje: `ollama pull qwen3-embedding:0.6b`.
`npm run memory:check` nedělá inference; `npm run memory:smoke` ji provede
explicitně. [Konfigurace, limity a recovery](project-memory.md).
