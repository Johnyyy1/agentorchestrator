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
| Check potřebuje síť, DB, secret | Verifier má izolované env; pouze omezené TCP localhost fixtures, žádný externí outbound |
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
- Review failed: čti `reviews.error` a `orchestration_events` s kind `review_failed`.
  `data.diagnostics` obsahuje executable/exit/timeout/signal/model/tier, format,
  bounded redacted public stderr, JSON/schema category, modelOutputReceived,
  terminalStatus a durationMs. Raw stdout, tokeny ani reasoning se neukládají.
- `invalid --json-schema: schema root must specify "type": "object"`: starý
  union-only export byl nekompatibilní s AGY 1.2.14. Reviewer používá explicitní
  objektové fields a po výstupu původní strict Zod union.
- `bind: operation not permitted`: CLI backend potřebuje listener na loopbacku;
  reviewer profil jej povoluje při zachování zákazu repo čtení/zápisů a jiných procesů.
- `Please sign in` / `authentication required`: ověř `agy models` v běžném
  prostředí. Izolovaný adapter kopíruje pouze Keychain `gemini` / `antigravity`
  do CLI auth souboru v privátním HOME. Starý jetski token není dostačující.
  Consumer auth je jediná podporovaná metoda této integrace. Neměň HOME na
  globální ani nerozšiřuj přístup do repozitáře.
- Reviewer infrastructure failure: waiting_human/infrastructure, žádný coding
  repair pro ověřený nezměněný diff. Human answer nereplayuje review stejného
  pokusu. Invalid structured result má waiting_human/review. Pouze validní
  request_changes může vstoupit do normálního bounded repair lifecycle.
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

### Registry a Final Result

- **Prázdný repository selector:** aplikuj `npm run db:migrate`, potom přidej
  absolutní Git cestu přes **+ Add repository**. Historický task už není nutný.
- **Registration required:** položka pochází pouze z historie; zaregistruj ji
  před delegací. **Unavailable:** cesta zmizela, Git metadata nejsou validní
  nebo nyní odkazuje jinam. Registry se nemaže; obnov původní adresář a refresh.
- **Duplicate:** server převádí symlinky a podadresáře na canonical Git root.
  Vyber již registrovanou položku.
- **Bootstrap error:** `JONAS_OS_REPOSITORIES` má být absolutní cesta nebo validní
  JSON pole max. 100 cest. Neplatné Git cesty se nezaregistrují; zkontroluj
  serverovou diagnostiku a restartuj web po změně `.env`.
- **No final worker summary was captured:** worker nezanechal veřejnou zprávu
  pro vybraný successful run; UI ukazuje dostupná metadata bez nové inference.
  Truncated report/list má viditelné upozornění. Chybějící checks/review nejsou
  automaticky úspěšné a nikdy se nenahrazují verdict z jiného pokusu.

## Execution incomplete: repository mutation was not verified

Jde o selhání orchestration invariantu, nikoli úspěšné dokončení. Task zůstává
`waiting_human` (durable coding) nebo `failed` (general shortcut); Control Plane
ukazuje důvod v rozhodnutí či chybě runu. Zkontroluj poslední `runs` záznam,
workerStarted/execution success, worktree metadata a Git inspekci, verifier checks a completed
independent APPROVE review se stejným runId. Starší schválený pokus nestačí.
Důkazy ručně nedoplňuj jako náhradu za execution. Historické completed rows bez
metadata nejsou touto aktualizací zpětně certifikované. Před resume prohlédni
uchovanou práci a ověř ukončení provider procesů; automatický replay se neprovádí.
Coding bez repository oprav novým explicitním zadáním s repository kontextem.

## Verifier: tsx `listen EINVAL`

`tsx` 4.23.15 sestavuje IPC cestu z `os.tmpdir()` jako
`tsx-<euid>/<pid>.pipe`. Na macOS má `sockaddr_un.sun_path` 104 bajtů; dlouhý
worktree/TMPDIR může selhat ještě před assertions. Verifier proto používá
vlastní krátký temp adresář, nikoli cestu pod worktree. AF_UNIX bind/connect
povoluje macOS profil pouze pod tímto runtime. Ověření bez inference:
`npm run verifier:unit`. Tests se nepřeskakují.

## Verifier: HTTP fixture `listen EPERM 127.0.0.1`

Příčina byla síťová deny politika původního Codex verifier sandboxu, nikoli
assertion nebo coding chyba. Nový samostatný verifier profil povoluje TCP
`localhost:*`; Node guard vyžaduje explicitní 127.0.0.1/::1 (`localhost` přepíše
na IPv4 loopback). 0.0.0.0, ::, chybějící host a LAN bind odmítá guard.
**Guard není OS hranice**: Seatbelt localhost zahrnuje i wildcard/host LAN
adresy. Jiný runtime nebo kód obcházející guard může takto listenovat; používej
jen důvěryhodné fixtures. Externí TCP outbound je dál odmítaný profilem.
[Report a přesné omezení](verifier-loopback-report.md).

Verifier před testy ověří vlastní temp/HTTP runtime. Známé setup/probe/spawn
nebo cleanup chyby vrátí `Verifier infrastructure failure` se zprávou max. 500
znaků, například relevantním `listen EPERM 127.0.0.1`. Orchestrace otevře
`infrastructure` eskalaci a zachová worktree i historické číslo pokusu; žádný
coding retry ani repair Chief se nespustí. Odpověď na eskalaci sama verifier
nepřespouští a neautorizuje nový coding pokus nad nezměněným diffem.
Chyba uvnitř již spuštěného testu včetně EPERM zůstává `verification`; systém
ji nesmí odhadovat podle textu logu. Nenulové assertions/typecheck/lint/build
zůstávají standardní cestou opravy. Root lint/build bez scriptu jsou SKIPPED.

## Verifier: vnořený `sandbox_apply: Operation not permitted`

macOS odmítá druhé sandbox_init i pod vnějším `allow default`. Proto
`npm test` obsahuje pure/parser/HTTP/Git regrese a skutečné worker/reviewer
OS regrese mají samostatné `npm run sandbox:test` mimo verifier. Žádný test
nebyl přeskočen ani boundary uvolněná; úplná deterministická kontrola je
`npm test` + `npm run sandbox:test` (a podle dopadu DB integrační sady).
Samostatné `opencode:unit` i `reviewer:test` stále zahrnují své původní OS testy.

### OpenCode tool chyby nebo incomplete při exit 0

Neodvozuj success z exit 0 či vzniklého souboru. Prohlédni bounded `toolDiagnostics`
a `terminalReasons`; `length` znamená neúplný krok, ne automaticky chybu sandboxu.
`context_mismatch` v readiness znamená chybějící/odlišný model-level `num_ctx`.
OpenCode 1.18.33 `/v1/chat/completions` ignoruje config `num_ctx`; samotný limit 16384
může současně s Ollama runtime 4096 vést k truncation. Použij
[lokální modelový alias](opencode.md#skutečný-kontext-ollama-přes-v1). Neuvolňuj externí
filesystem či shell permissions. Cwd/root/branch nebo sandbox probe failure a explicitní
ripgrep runtime chyba eskalují infrastructure a zachovají worktree bez coding repair.
Unknown detail se z bezpečnostních důvodů neukládá; staré tool errors bez detailu
nelze zpětně přesně vysvětlit. `opencode:tools:test` oddělí adaptér od orchestrace.
