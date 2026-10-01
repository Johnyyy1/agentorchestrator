# Lokální coding worker a capability routing

Chief přes Ollama navrhuje **capability** a `workerBrief`; nemá nástroje a nevybírá
providera. OpenCode je samostatný execution worker: v izolovaném worktree čte
a upravuje soubory pomocí stejného lokálního Qwen. Chiefův brief je task data,
pevná pravidla a oprávnění vlastní TypeScript. Repository coding nyní používá bounded repair/review smyčku podle
[repair lifecycle](repair-loop.md); další úkol po úspěchu se neplánuje.

## Směrování

| Doporučení | Policy |
| --- | --- |
| `local-coding` | Normalizuje category na coding, vyžaduje repository; OpenCode, pokud má risk low/medium a difficulty ≤ `LOCAL_CODING_MAX_DIFFICULTY`; prokázaná runtime/config infrastructure vede na waiting_human |
| `strong-coding` | Normalizuje category na coding, vyžaduje repository; Codex |
| `strong-general` | Antigravity pro |
| `research` | Antigravity; původní volba flash/pro podle risk/difficulty |
| `local-utility` | Původní category route; lokální utility execution adapter zatím neexistuje |
| `independent-review` | Zachované abstraktní doporučení; samostatná capability route zůstává původní; repository coding dostává nezávislé review po verifieru |
| Bez doporučení | Category route po sémantické validaci |

Coding capability má přednost před chybnou non-coding kategorií; coding category
má přednost před non-coding capability. High risk nebo
difficulty nad limitem vždy použije Codex. Non-coding nikdy nepoužije OpenCode.
Coding bez repository se odmítá před persistence/execution. Repository-aware
research či planning bez změn souborů zůstává na Antigravity.
[Autoritativní sémantika a completion invariant](architecture.md#invariant-dokončení-repository-coding).

## Konfigurace a readiness

OpenCode CLI musíš mít již nainstalované. Jonas OS nic neinstaluje, nestahuje
modely ani nespouští trvalou OpenCode službu. Binárku přidej do `PATH` nebo
nastav `OPENCODE_BIN` na její absolutní cestu. Desktop aplikace sama o sobě
nezaručuje dostupnost CLI. Ollama musí běžet s lokálním completion modelem.

| Proměnná | Default | Omezení |
| --- | --- | --- |
| `LOCAL_CODING_MODEL` | `LOCAL_CHIEF_MODEL`, jinak `qwen3.5:9b-q4_K_M` | Lokální model s explicitním model-level `num_ctx`; `.env.example` doporučuje alias `qwen3.5:9b-q4_K_M-jonas-16k`; cloud odmítnut |
| `OPENCODE_BIN` | `opencode` | Název v PATH nebo absolutní cesta |
| `LOCAL_CODING_CONTEXT` | `16384` | 4096–16384 |
| `LOCAL_CODING_TIMEOUT_MS` | `180000` | 1000–300000 ms |
| `LOCAL_CODING_MAX_DIFFICULTY` | `2` | 1–3, včetně hranice |
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | Sdílená validovaná loopback konfigurace Chief |

```sh
opencode --version
opencode run --help
opencode models
npm run opencode:check
```

`checkOpenCode()` vrací binary, version, model, outputFormat a strukturovaný error.
Ověří executable, verzi pro diagnostiku, option tokens z obou streamů `run --help`,
explicitní model, resolved `debug config`, Ollama readiness/native inventory a
start CLI uvnitř macOS sandboxu. Subprocess checks mají limity 5/10 sekund,
Ollama request maximálně 5 sekund. Readiness neprovádí inferenci ani download.

Kompatibilita závisí na schopnostech a zachování bezpečnostní konfigurace,
ne na major verzi. `debug config` musí zachovat provider allowlist, celý
požadovaný config a dedicated agent s deny-by-default permissions. `--agent`
není povinný: stejný agent je nastavený přes `default_agent`. JSON je preferovaný;
bez deklarovaného JSON formátu se použije omezený non-TTY textový výstup.
Model se musí objevit přes native Ollama discovery v izolované konfiguraci.
Není přidaný custom provider SDK. Chybějící model vrací `model_missing`,
nekompatibilní config `unsupported_cli`; bezpečnostní nastavení se neuvolňuje.

### Skutečný kontext Ollama přes `/v1`

OpenCode 1.18.33 používá OpenAI-compatible `/v1/chat/completions`. `limit.context`
slouží k účtování kontextu v CLI; provider/model option `num_ctx` nezmění skutečný
Ollama kontext. [Ollama doporučuje modelový alias](https://docs.ollama.com/api/openai-compatibility#setting-the-local-context-size)
s explicitním `PARAMETER num_ctx`. Na ověřovaném hostu původní model běžel s
4096 tokeny, přestože config uváděl 16384; reálný běh končil truncation.

Z kořene projektu, po ruční instalaci základního modelu:

```sh
ollama create qwen3.5:9b-q4_K_M-jonas-16k -f examples/opencode.Modelfile
LOCAL_CODING_MODEL=qwen3.5:9b-q4_K_M-jonas-16k npm run opencode:check
LOCAL_CODING_MODEL=qwen3.5:9b-q4_K_M-jonas-16k npm run opencode:tools:test
LOCAL_CODING_MODEL=qwen3.5:9b-q4_K_M-jonas-16k npm run opencode:tools:test -- --primitives
```

Do `.env` nastav `LOCAL_CODING_MODEL=qwen3.5:9b-q4_K_M-jonas-16k` a
`LOCAL_CODING_CONTEXT=16384`. Alias používá existující lokální váhy, nepřepisuje
základní model; Jonas OS jej sám nevytváří ani nestahuje. Pro jiný model či
kontext uprav vlastní Modelfile a alias. Readiness i přímý adaptér kontrolují
`/api/show.parameters`: explicitní `num_ctx` se musí rovnat `LOCAL_CODING_CONTEXT`.
Chybějící/odlišný údaj je `context_mismatch`, nikoli úspěšná readiness; samotný
`/api/ps` po jiném klientovi nestačí jako trvalý důkaz konfigurace.

## Execution a bezpečnost

Strategie je nový subprocess `opencode run --model ollama/<model> --agent
jonas-local-coding --format json` pro každý task; bez attach, resume, auto nebo
sdílené služby. Volitelné flags se přidávají podle zjištěných capabilities. Jejich [CLI dokumentace](https://opencode.ai/docs/cli/)
nenahrazuje ověření konkrétní instalace.

Manager vytvoří jediný worktree a callback uloží `runs.workspace` před workerem.
Pak proběhne capability policy a uložení skutečného selected workeru. Codex i
OpenCode pokračují stejným `executeTask()` pipeline: worker →
`verifyWorktree()` → `inspectTaskWorktree()` → durable orchestrace a queue persistence.
Completion tasku vyžaduje worker success, verifier success **i nezávislé approve**. Všechny dostupné
test/typecheck/lint/build skripty mají stejný standard pro oba workery.

OpenCode ověřuje cwd přes `assertTaskWorktree()`, včetně kontrolovaného rootu,
UUID, větve, symlinků a Git registrace. Dedicated agent povolí jen repository
read/edit/glob/grep/list. Shell, network tools, external_directory, subagents,
skills, questions a LSP jsou zakázané; také auto formatters, snapshots a sharing.
Agent nemůže změnit `.git` ani OpenCode configuration přes edit nástroje.

Navíc macOS `sandbox-exec` povoluje data cílového worktree, read-only Git metadata,
potřebné systémové runtime soubory (včetně read-only `/private/var/db/timezone`
pro Bun/ICU) a vlastní disposable runtime. Zápisy jsou
omezené na worktree/runtime; `.git` pointer nelze přepsat. Symlink na source
checkout nezpřístupní jeho obsah. Síť směřuje jen na loopback port Ollama.
Unsupported OS execution je odmítnuta. Nástroje nikdy neobdrží uživatelův HOME,
auth ani credentials environment; projektové/global plugins a config jsou
izolované. Runtime se uklidí, úspěšný i neúspěšný task worktree zůstane.

Před inferencí se navíc ověří supplied/canonical cwd, expected task worktree,
Git root/větev a writable status. Ve stejném OS profilu proběhne čtení `.git`
a exkluzivní temp write/read/delete uvnitř vlastního dočasného adresáře worktree.
Do logu/resultu jdou pouze cesty a booleany, žádný obsah. Chybné cwd/root/branch
se odmítne ještě před CLI/model invocation.

## Fallback a metadata

Pokud před execution chybí OpenCode binary/Ollama/model, dosavadní policy může
zvolit Codex a uloží důvod. Prokázaná chyba konfigurace/hranice (`configuration`,
`unsupported_cli`, `sandbox_unavailable`, `context_mismatch`) však v executor
pipeline zastaví způsobilý local-coding task jako infrastructure, zachová worktree
a vede na waiting_human bez cloud fallbacku. Pure router policy se nemění. Codex/Antigravity mají původní
execution-time health behavior; readiness pro ně nevolá model.

Jakmile OpenCode invocation začne, failure/timeout/malformed output ukončí tento pokus.
Známý runtime/config preflight failure a explicitní selhání inicializace/execution
ripgrep se klasifikují jako infrastructure: žádný repair Chief, coding repair ani
review, také po redelivery/human answer nad nezměněným výsledkem. ENOENT souboru,
invalid arguments, externí cesta, permission policy a samotný terminal `length`
nejsou automaticky infrastructure; bez dalšího důkazu zůstávají execution failure.
Nový pokus smí autorizovat jen Chief a TypeScript v rámci min(maxAttempts,
JONAS_OS_MAX_ATTEMPTS); může jít na Codex ve stejném worktree. Není inline
provider fallback ani slepý queue retry. Repository jobs mají retryLimit 0.
Výjimka adaptéru zachová worktree a Git metadata; každý pokus má vlastní run.

Migrace `0002_absurd_madame_masque.sql` přidává nullable JSON `tasks.chief`
(`capability`, `workerBrief`) a `runs.routing` (`requestedCapability`,
`selectedWorker`, `fallbackReason`, `model`, `reason`). Staré tasky mají null.
`runs.result` uchovává worker result, routing, workspace, verification a Git diff
metadata. OpenCode result obsahuje success, exitCode, public message, sessionId,
explicit model, whitelisted token counts, durationMs, bounded stderr a error.
Typ message je volitelný/nullable; adaptéry při absenci reportu vracejí null.
Při chybějící veřejné zprávě navíc `eventTypes` (nejvýše 16 typů, délka typu
64 znaků), bez raw streamu nebo thinking. Parser má limity 2 MiB stream,
4096 řádků, 256 kB/event a 64 kB zpráva. Veřejný text bere pouze z
`type=text` a `part.text` s `part.type=text` (nebo legacy bez part.type).
`step_start` zahájí novou závěrečnou zprávu; reasoning ani tool payload se
nepoužijí jako náhrada. Explicitní error/incomplete a neúplný step selžou.
JSON parser vyžaduje exit 0, netimeoutovaný úspěšný proces a konečný
`step_finish.part.reason = stop`; veřejná `message` může být null.
malformed, error nebo neúplný stream selže. Reasoning a libovolné tool input/output payloady se nepersistují. Bounded
`toolDiagnostics` (nejvýše 32) obsahují event type, tool/status, rozpoznanou
public category/code a code-owned zprávu do 500 znaků; pouze bezpečnou relativní
repo cestu nebo pathScope bez externí cesty. Neznámý detail je vynechán. `eventTypes`
a `terminalReasons` jsou bounded metadata i u běhů s veřejnou zprávou.
Incomplete/error zůstane failure i při exit 0 či změněných souborech; failure report
uvádí veřejný step reason a poslední rozpoznanou tool chybu, ne domnělou příčinu. Text fallback vyžaduje exit 0, netimeoutovaný úspěšný proces a
výstup do 64 kB; prázdná zpráva je null; sessionId a usage jsou null. Thinking se nevyžaduje. Fallback
se volí před invocation, nikoli po chybě JSON parseru. Verifier je pro oba formáty
stejně povinný. Cloud model ID je null,
pokud ho původní CLI path nehlásí a používá default; žádný ID se nevymýšlí.

## Testy a aktuální stav ověření

```sh
npm run typecheck
npm test
npm run executor:integration
npm run opencode:test
```

První tři používají fake coding adapters/CLI; verifier launcher je lokální
macOS `sandbox-exec`, nikoli AI inference. Jeho TCP/Node fixture výjimka
nemění OpenCode worker sandbox; přesnou inbound hranici a omezení popisuje
[architektura](architecture.md#verifikace). Integration ověřuje oba workery, ukládání
route před editací, čtyři checks, failure po editaci s durable eskalací a unavailable
fallback před execution. Nové orchestration:test navíc ověřuje autorizovaný repair handoff. `opencode:unit` také skutečně ověřuje OS odmítnutí external read/write,
symlink escape a `.git` write, JSON/text parser, stderr help, odmítnutí
nekompatibilního configu a timeout.

`opencode:test` je skutečný bounded OpenCode/Qwen queue smoke: vytvoří disposable
TypeScript Git repo a unikátní pg-boss queue. Před skutečným workerem kontroluje
persistované `runs.routing` a `runs.workspace`, po něm uložený result. Reviewer je v tomto local smoke záměrně nedostupný,
takže úspěšný pokus vede na waiting_human bez cloud inference. Upraví
pouze worktree, spustí stejný verifier a ověří nezměněný source checkout. Fixture explicitně použije již nainstalovaný TypeScript
compiler; neinstaluje dependencies. Vyžaduje DB a uklidí vlastní queue, task/run řádky, worktree, branch a runtime.
Při readiness failure test skončí s chybou; nikdy nespadne na cloud AI.

Na tomto hostu dne **30. 9. 2026** prošla readiness i skutečný smoke s OpenCode
**1.18.33** (`/opt/homebrew/Cellar/opencode/1.18.33/bin/opencode`) a
`ollama/qwen3.5:9b-q4_K_M`. `run --help` jde do stderr; `--model`, `--agent`,
`--format json` a `--title` skutečně fungují v izolovaném runtime/sandboxu.
JSON i default non-TTY probe vrátily `LOCAL_OPENCODE_OK` bez nástrojů.

Real coding smoke prošel za přibližně 77 sekund včetně verifieru: Qwen opravil
`a - b` na `a + b`, změnil pouze `add.ts`, source HEAD/obsah/status zůstal stejný.
Uložený worker result měl sessionId, veřejnou zprávu a token totals, žádný error;
všechny test/typecheck/lint/build checks prošly. Route/workspace metadata byla
uložená před inferencí a result po dokončení. Vlastní queue, task/run rows,
worktree/branch a runtime byly odstraněné. Žádná Codex/Antigravity inference.
To je historické ověření před přidáním nezávislého review. [Report oprav a ověření](opencode-milestone-report.md).

Historický resolved config zachoval context/output/options hodnoty, ale účinnost
provider `num_ctx` nebyla tehdy měřena. Nová reprodukce odhalila, že přes `/v1`
nefungoval; nepoužívané `num_ctx` options jsou odstraněné. Model-level kontrola
a alias výše tento runtime předpoklad opravují. Ověření
se vztahuje na tuto CLI/model/macOS kombinaci; jiná instalace musí projít readiness
a vlastním smoke testem.

## Současný repair/review milestone

LOCAL_CODING_*/OPENCODE_BIN, eligibility a OpenCode sandbox se nemění.
Pro dokončení tasku je nyní nutný nezávislý reviewer: Antigravity, fallback
Codex pouze před inference. Qwen svůj kód neschvaluje. Verifier failure a
review request_changes řeší samostatný Chief repair schema/prompt. Přechod
OpenCode → Codex je záměrný až v novém bounded pokusu a nikdy v originálním
checkoutu. Nejasný crash, vyčerpaný cap a humanQuestion vedou na waiting_human.
[CLI, history, restart, quota a limity](repair-loop.md).

Coding prompt žádá na konci operátorský report `Summary`, `What changed`,
`Files changed`, `Notes / limitations`, včetně repair attempts. Persistuje se
skutečná veřejná zpráva; exact Markdown se neparsuje pro completion. Control
Plane ji zobrazí vedle nezávislých checks/review bez další inference. Routing,
OpenCode setup a `LOCAL_CODING_*`/`OPENCODE_BIN` defaults se tím nemění.

Worker execution success vyjadřuje dokončený proces a validní terminální
CLI stav. Task completion navíc vyžaduje Git/workspace evidence, verifier
a nezávislé approve. Chybějící veřejný report tuto evidence nenahrazuje
ani neznehodnocuje; Control Plane zachová „No final worker summary was captured.“
Bez nové inference a bez vymyšlené zprávy. LOCAL_CODING_* a OPENCODE_BIN,
routing tabulka i attempt/skip policy zůstávají stejné.

OpenCode 1.18.33 v reálném repository E2E emitovalo pouze step_start,
tool_use a step_finish, bez text eventu. Není potvrzena jiná veřejná textová
envelope; no-summary terminal fixture je skutečně pozorovaná.
[Výsledky a omezení tohoto smoke](runtime-e2e-fixes-report.md).

`opencode:tools:test` přímo volá stejný adaptér bez DB, queue, verifieru/review.
Default ověří inspect → write → jediný `docs/smoke.md` → success true; `--primitives`
spustí čtyři samostatné read/glob/write/read inference. Fixture i bezpečný report
zůstávají k inspekci; test nevykonává cloud fallback a nemaže dirty worktree.
[Diagnostika, ověření a jediný E2E](opencode-tool-reliability-report.md).
