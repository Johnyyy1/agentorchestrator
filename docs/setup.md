# Instalace a konfigurace

## Požadavky a kompatibilita

| Součást | Požadavek | Kdy je potřeba |
| --- | --- | --- |
| Node.js + npm | Node >=22.13, doporučená řada 24 | Vždy |
| Git | CLI v `PATH` | Klonování a repository coding |
| PostgreSQL | 16; Docker Compose plugin nebo vlastní server | Ukládání a vykonávání úkolů |
| Codex CLI | `exec --json`, `--ignore-user-config`, `--ignore-rules`, `sandbox` | Coding; sandbox i ve worktree testech |
| Antigravity CLI | `agy -p`, `--output-format json`, `--print-timeout` | Research, planning, review, utility |
| Ollama + lokální model | `/api/tags`, `/api/show`, `/api/chat` se structured outputs | Chief a lokální OpenCode worker |
| OpenCode V1 + Ollama | `run --model --agent --format json`, macOS sandbox-exec | Volitelný lokální coding worker |

Node minimum vychází z požadavků závislostí. Coding sandbox byl ověřen
na macOS s `codex-cli 0.159.2`; nejde o garanci každé starší či budoucí verze.
Chief byl ověřen s Ollama **0.32.14**. Na Linuxu nejprve ověř podporu
použitého `codex sandbox` launcheru. Windows není ověřený pro celý workflow:
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

Adaptér používá **OpenCode V1**, nativní provider `ollama` a macOS
`/usr/bin/sandbox-exec`. OpenCode V2 odmítá kvůli odlišnému permission/config
schématu. Instaluj explicitně řadu V1, ne automaticky latest; například
existující npm verzi `npm install -g opencode-ai@1.2.27`, nebo nastav
`OPENCODE_BIN` na absolutní cestu své V1 binárky. Samotnou instalaci popisuje
[OpenCode dokumentace](https://opencode.ai/docs/). Tato konkrétní verze zde
není deklarovaná jako ověřená reálným modelem; fixture testy používají fake CLI.

Připrav lokální Ollama model jako pro Chief, potom:

```sh
opencode --version
opencode run --help
npm run opencode:check
npm run opencode:unit
```

Readiness neprovádí inferenci/download: ověří binárku, major V1, potřebné
flagy, Ollama model a discovery přes `opencode models ollama`. Při chybě se
způsobilý task **před execution** směruje na Codex, takže musí být přihlášený,
pokud tento fallback chceš používat. Na jiné platformě je lokální cesta
nedostupná. Verifikace OpenCode změn stále potřebuje `codex sandbox`, který
nevolá AI ani cloud. Pro dobrovolný test se skutečným lokálním modelem slouží
`npm run opencode:test` (disposable repo, bez DB, žádný fallback na Codex).

## Proměnné prostředí

| Proměnná | Default | Význam / omezení |
| --- | --- | --- |
| `DATABASE_URL` | Žádný v kódu; ukázka v `.env.example` | Povinná pro DB, migrace, frontu a worker |
| `AGY_FLASH_MODEL` | CLI default | Model běžných non-coding úkolů |
| `AGY_PRO_MODEL` | CLI default | Model non-coding s difficulty >=4 nebo risk high |
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
`PATH` musí obsahovat potřebné binárky pro worker i verifier.

## Spuštění, zastavení a aktualizace

```sh
npm run typecheck
npm test
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
provider packages. Adapter podporuje V1 permissions a macOS OS boundary;
V2/unsupported discovery bezpečně odmítne a policy zaznamená Codex fallback.
Migraci nullable `tasks.chief` a `runs.routing` aplikuje `npm run db:migrate`.
