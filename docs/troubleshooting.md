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
má queue retries vypnuté, worktree zůstává. Opravy řídí aplikace podle
min(maxAttempts, JONAS_OS_MAX_ATTEMPTS). Restart bezpečný checkpoint obnoví,
nejasnou executing/reviewing/deciding invocation převede na waiting_human.
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
u plánovacího planGoal doplň odpověď do nového vstupu. U repair loop použij
escalation:answer pro existující durable task. LOCAL_CHIEF_MODEL nemění cloud modely; local coding ho používá jako default,
pokud není zadaný LOCAL_CODING_MODEL.
Detaily formátu/validace jsou v [architektuře](architecture.md#lokální-chief).

## OpenCode

Začni `npm run opencode:check`. Readiness vrací available, version, model,
binary a strukturované error. `binary_missing` znamená chybějící CLI nebo
chybnou OPENCODE_BIN; version_failed/unsupported_cli znamená nekompatibilní
run/model interface nebo nezachovaný resolved security config. model_missing/models_failed
vyžaduje lokální model a Ollama discovery. sandbox_unavailable znamená
chybějící macOS OS hranici nebo selhání startu CLI uvnitř sandboxu. configuration prověřuje env limity.

Při nedostupném OpenCode se způsobilý task před execution přesměruje na Codex.
Skutečný výběr a důvod jsou v runs.routing, ne jen v počáteční worker logu.
Task bez recommendation nebo bez repository nikdy nejde na OpenCode.
Chyba po startu lokálního workeru nepoužívá inline fallback; Chief může
navrhnout nový bounded repair pokus v témže worktree, i přes Codex. Inspectuj
workerResult.error/timedOut, repair events a worktree. Lokální worker má shell zakázaný,
testy spouští až samostatný verifier.

OpenCode 1.18.33 píše `run --help` do stderr; detekce čte oba streamy.
Bun/ICU při startu potřebuje read-only `/private/var/db/timezone`, jinak může
CLI skončit SIGTRAP ještě před inferencí. Tato výjimka nepovoluje další zápisy
ani externí síť.
Fake parser/adapter a OS fixture testy nenahrazují `npm run opencode:test`.
[Podrobný stav ověření a lokální setup](opencode.md#testy-a-aktuální-stav-ověření).

## Waiting_human a review

```sh
npm run escalations:list
npx tsx examples/inspect-task.ts <task-UUID>
npm run escalation:answer -- <escalation-UUID> "Upřesnění rozhodnutí."
```

- max_attempts: cap se odpovědí nemění. Inspectuj práci, pak task:abandon nebo nový task.
- Reviewer unavailable: coding po Codexu vyžaduje Antigravity, nikoli další Codex.
- Review failed: čti reviews.error, CLI přihlášení, podporované flags a macOS sandbox.
  Snapshot-only reviewer má izolované auth/config; nestandardní auth storage může selhat.
- Neúplný snapshot: rozsáhlé diffy, secrets/symlinky či velké nové soubory vyžadují lidskou kontrolu.
- High/critical: odpověď musí upřesnit autorizované hranice; Chief znovu rozhodne.
- Interrupted: ověř, že starý provider už neběží. Automatické replay je úmyslně zakázané.
- Queue completed, task waiting_human: job zpracoval durable stop; task dokončený není.

Answer musí cílit na open eskalaci; resolved/cancelled či prázdná odpověď se odmítá.
Při enqueue failure zůstává open/waiting_human, transakce nepersistuje půl výsledku.
Worktree nikdy automaticky nemaž; [podrobné limity a recovery](repair-loop.md).

## Control Plane

- **Database unavailable:** ověř root `.env`, PostgreSQL a existující migrace.
  `docker compose exec postgres pg_isready -U jonas -d jonas_os`. Build může
  uspět i bez DB; není to důkaz její readiness.
- **Task zůstává queued:** web neprovozuje consumer. Spusť zvlášť `npm run worker`;
  tím povolíš skutečné worker invocation podle routing policy.
- **Cloud lane unknown:** CLI existuje, ale health nespouští auth/model test.
  Přihlášení nastav podle provider setupu.
- **Chybí repository v selectoru:** V1 ho odvozuje z persisted task.repository;
  první context zadej existujícím API/příkladem.
- **Submission selhala:** prohlédni pending Tasks před opakováním. Stávající
  createTask může pending row uchovat. Answer enqueue failure rollbackuje
  answer i state; reload Decisions ukáže source of truth.
- **403:** otevři přímo http://127.0.0.1:3000 nebo localhost, bez proxy/custom Host.
  Cross-site mutace nejsou podporované.
- **Fixture banner:** běží explicitní simulace, nikoli tvoje DB. Ukonči proces
  a použij `npm run control-plane:dev` bez CONTROL_PLANE_FIXTURES=1.
- **Port je obsazený:** `PORT=3001 npm run control-plane:dev`.

[Podrobnosti a známé limity](control-plane.md), [ověření milestone](control-plane-report.md).
