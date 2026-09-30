# Řešení problémů

## Databáze a instalace

| Projev | Kontrola |
| --- | --- |
| DATABASE_URL is not configured | .env v kořeni, správný cwd, env procesu |
| ECONNREFUSED / DB offline | Docker engine, compose ps, URL a host port 5434 |
| Relation tasks/runs does not exist | db:migrate na stejné DB jako worker |
| Port 5434 obsazený | Změň Compose host port i DATABASE_URL |
| Password failure po změně Compose | Volume má původní credentials, změna env nemění DB účet |
| Node engine / ESM chyby | Node >=22.13, nvm use, npm ci |

```sh
docker compose ps
docker compose logs --tail=100 postgres
docker compose exec postgres pg_isready -U jonas -d jonas_os
```

Nesdílej `.env` ani citlivé prompty/výsledky. Smazání volume není běžná
diagnostika; `docker compose down -v` maže všechna data.

## Fronta

**Stále queued:** spusť worker, ověř readiness a shodný DATABASE_URL.
Consumer čte `jonas-os.tasks.execute`; vlastní queue potřebuje consumer
registrovaný s odpovídajícím queueName.

**Pending po chybě:** insert prošel, queueing selhal a row je zachovaný.
Neopakuj slepě createTask, mohly by vzniknout duplikáty. Inspectuj DB,
log a existenci jobu. Recovery CLI zatím není; po diagnóze lze queueing
obnovit programově nebo vědomě založit nový task.

**Failed / running po tvrdém ukončení:**

```sh
npx tsx examples/inspect-task.ts <task-UUID>
```

Čti runs[].error, workerResult, verification a workspace. Repository coding
má retries vypnuté, worktree zůstává. maxAttempts není limit queue retries.
Nové zadání vytvoří nový task/worktree; nejdřív inspectuj starou práci.
Hromadné přepisování statusů neskrývá nedokončenou execution.

**Pomalý shutdown:** worker může na dokončení čekat až 10 minut. Vynucené
ukončení může zanechat running run a rozpracovaný worktree.

## CLI providery

**Binárka not found:** ověř `command -v codex`, `command -v agy` a PATH
uživatele workeru. GUI/daemon nemusí zdědit shell setup. Dokonči přihlášení
interaktivně před headless execution; stdin je ignorovaný.

**Unsupported flag / sandbox failure:** porovnej exec/sandbox help
s [požadavky](setup.md). Verifier odmítne sandbox failure, bez unrestricted
fallbacku. Použij kompatibilní CLI a ověřenou platformu, neměň guardy.

**AGY Pro/Flash má stejný model:** nastav obě AGY_*_MODEL z `agy models`
a restartuj worker. Bez env použijí CLI default. AGY permissions řeší
samotné CLI; wrapper nenastavuje sandbox ani auto-approve flagy.

**Timeout providera:** Codex má pevně 90 s, AGY 120 s. Zmenši úkol a inspectuj
worktree; retry může čerpat další kvótu. Chief timeout je zvláštní nastavení.

## Worktree a verifikace

| Projev | Řešení |
| --- | --- |
| Source repository dirty | git status, explicitně commit/stash vlastní změny |
| Base branch does not exist | Existující lokální větev, default main |
| Repository path must point to root | Absolutní git rev-parse --show-toplevel |
| External Git filters unsupported | Repo s clean/smudge/process filtry není podporované |
| Path/branch already exists | Inspectuj retained práci; manager nepřepisuje |
| Invalid/nested root | Absolutní JONAS_OS_WORKTREE_DIR mimo všechny source checkouty |
| Cleanup odmítá workspace | Skutečná run.workspace, původní root, platná registrace; zachovej dirty práci |
| tsx/tsc/deps not found | Worktree nemá automaticky node_modules; explicitní provisioning |
| Check potřebuje síť, DB, secret | Verifier má izolované env a zakázanou síť |
| Package manager chce download | Zajisti binárku/cache; Corepack síť je vypnutá |
| Success, ale všechny skipped | Chybí podporované checks; skips nejsou testování |

Git diff neukazuje untracked obsah, i když je v changedFiles. Při truncated
inspectuj celý worktree přímo. Force cleanup zahazuje necommitnuté změny.

## Chief / Ollama

Začni bez inference: `ollama list` a `npm run chief:check`.

| Error code | Další krok |
| --- | --- |
| configuration | Loopback HTTP, lokální generation model, limity ze setupu |
| offline | Spusť Ollama aplikaci/službu nebo ollama serve |
| model_missing | Explicitní ollama pull; aplikace model nestáhne |
| remote_model | Vyber skutečně lokální model bez remote metadat |
| timeout | Zátěž/paměť, menší kontext nebo zvýšení timeoutu v povoleném rozsahu |
| http, bad_response | Server, model capabilities, Ollama log; output může být truncated/tool request |
| invalid_input | Zmenši kontext, oprav vstupní schéma |
| invalid_json, invalid_decision | Neplatný návrh, nic se neodeslalo, není automatická oprava |
| ungrounded_repository | Předej repo cestu/větev explicitně ve vstupu |
| submission_failed | DB/queue health, retained pending row před retry |

Chief nedohledává chybějící soubory či informace. ask_human není chyba;
doplň odpověď do nového vstupu. LOCAL_CHIEF_MODEL nemění cloud modely; local coding ho používá jako default,
pokud není zadaný LOCAL_CODING_MODEL.
Detaily formátu/validace jsou v [architektuře](architecture.md#lokální-chief).

## OpenCode

Začni `npm run opencode:check`. Readiness vrací available, version, model,
binary a strukturované error. `binary_missing` znamená chybějící CLI nebo
chybnou OPENCODE_BIN; version_failed/unsupported_cli znamená nekompatibilní
V1 interface (V2 je explicitně odmítnutá). model_missing/models_failed
vyžaduje lokální model a Ollama discovery. sandbox_unavailable znamená
chybějící podporovanou macOS OS hranici. configuration prověřuje env limity.

Při nedostupném OpenCode se způsobilý task před execution přesměruje na Codex.
Skutečný výběr a důvod jsou v runs.routing, ne jen v počáteční worker logu.
Task bez recommendation nebo bez repository nikdy nejde na OpenCode.
Chyba po startu lokálního workeru nepředává partial edits Codexu; inspectuj
workerResult.error/timedOut a worktree. Lokální worker má shell zakázaný,
testy spouští až samostatný verifier.

OpenCode zatím nebylo na tomto hostu možné reálně spustit: binárka chybí.
Fake parser/adapter a OS fixture testy nenahrazují `npm run opencode:test`.
[Podrobný stav ověření a lokální setup](opencode.md#testy-a-aktuální-stav-ověření).
