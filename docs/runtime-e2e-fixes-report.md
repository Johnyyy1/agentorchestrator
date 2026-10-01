# Verifier runtime, OpenCode a completion: výsledek opravy

Ověřeno 1. 10. 2026. Deterministické regrese prošly. Přesně jeden nový reálný
repository E2E vytvořil zamýšlený soubor a ověřil opravený OpenCode execution
success, ale **nedokončil se**: existující HTTP fixture testy nemohou v síťově
uzavřeném verifier sandboxu bindovat TCP localhost. Task zůstal `waiting_human`;
Antigravity se správně nespustilo. Tento report netvrdí verifier PASS ani APPROVE.

## 1. Verifier socket: příčina a oprava

Instalovaný `tsx` 4.23.15 používá `os.tmpdir()` pro
`tsx-<euid>/<pid>.pipe`. Ověřeno čtením skutečných modulů
`temporary-directory-*.mjs` a `cli.mjs` a regresí s živým IPC socketem.
Původní cesta měla 112 bajtů, nad macOS `sun_path` (104 bajtů).

Verifier nyní atomicky vytváří vlastní `/tmp/jo-v-<mkdtemp suffix>` s právy
0700; na macOS je canonical cesta `/private/tmp/…`. Limit runtime je 40 bajtů.
HOME, TMPDIR/TMP/TEMP a npm cache míří do něj. Cwd zůstává worktree.
`codex sandbox` má explicitní writable root a `--allow-unix-socket` jen pro
vlastní runtime. Obecné `/tmp`, TCP síť i source zápisy zůstávají zakázané;
coding worker tuto výjimku neobdrží. Cleanup ověřuje canonical cestu, inode,
device a vlastníka a odmítá nahrazený adresář či symlink. Testy se nepřeskakují.

## 2. Skutečné OpenCode 1.18.33 JSONL

Povolený samostatný parser smoke byl neškodný read-only požadavek na název
package. Jedna CLI invocation skončila po 180 s bez JSONL, nebyla opakována.
Nelze z ní dovodit veřejný textový formát.

Bezpečná observační CLI obálka u jediného následného E2E předávala skutečnému
OpenCode stejný argv, env a stdout. Zachytila jen názvy/pole eventů a relevantní
step envelopes; žádné thinking ani tool inputs/outputs. Skutečný stream měl
`step_start` ×3, `tool_use` ×3, `step_finish` ×3 a **žádný `text` event**.
Dva step finish měly `reason: tool-calls`, poslední `reason: stop`.

Přesná relevantní pozorovaná struktura:

```json
{"type":"step_finish","timestamp":1790850000695,"sessionID":"ses_f0906717affeOZNWUI1MZFNE4N","part":{"id":"prt_0f6fa672f001Klmz6vJX0G58yG","reason":"stop","messageID":"msg_0f6fa4f88001OysG2X3yo0QLer","sessionID":"ses_f0906717affeOZNWUI1MZFNE4N","type":"step-finish","tokens":{"total":3314,"input":3239,"output":75,"reasoning":0,"cache":{"write":0,"read":0}},"cost":0}}
```

Přesná relevantní JSONL fixture je
`src/local/fixtures/opencode-1.18.33-no-summary.jsonl`. Veřejný textový event
v těchto reálných voláních nebyl pozorován. Dosavadní podporovaný kontrakt
`type: text`, `part.type: text`, `part.text: <public text>` je pokryt syntetickým
testem, nikoli vydáván za nově pozorovanou envelope. Příčinou skutečného
`message: null` byl chybějící veřejný event; změna envelope se neprokázala.

## 3–5. Parser, execution success a completion

Parser zachovává session ID a sčítá whitelisted token counts. Ignoruje
reasoning a tool payload, toleruje unrelated typy, odmítá malformed JSONL,
explicitní error/incomplete, nedokončený step, timeout a neúspěšný proces.
Limity: 2 MiB stream, 4096 řádků, 256 kB/event, 64 kB zpráva, 256 znaků session.
Při chybějící zprávě persistuje pouze `eventTypes`: nejvýše 16 typů do 64 znaků.
Text-mode kompatibilita zůstává; úspěšný prázdný výstup má `message: null`.

Dříve OpenCode success vyžadoval také message. Nyní vyžaduje úspěšný exit 0,
validní terminální CLI stav a absenci explicitní chyby/incomplete; zpráva může
chybět. Dříve completion guard i historické UI warning vyžadovaly report.
Nyní report neovlivňuje validitu: poslední coding execution success,
workerStarted, shodné dostupné worktree, Git evidence, verifier success,
nezávislé completed APPROVE a stávající state/risk invariants zůstávají povinné.
Exit 0 sám task nedokončí. UI zachová „No final worker summary was captured.“
Žádný summary se nevymýšlí a nevolá se další model.

## 6–7. Regrese a výsledky

- Exit 0 + terminální stop + public text → success/message.
- Stejný terminální stav bez public text → success/null, včetně reálné fixture.
- Error, malformed/incomplete, timeout, failed exit a parsing limity → failure.
- Reasoning/tool data nikdy nejsou summary ani diagnostika.
- Coding bez summary s workspace/Git + verifier PASS + independent APPROVE
  se dokončí; ověřeno pure guardem i skutečnou DB orchestration s fake AI.
- Chybějící verifier či review a neshodné persisted worktree dokončení blokují.
- Dlouhé worktree spustí skutečný tsx, existující socket má <104 bajtů,
  runtime se odstraní; externí zápisy, TCP a externí Unix socket jsou zakázané.
- Cleanup odmítne podstrčený symlink a zachová jeho target.

| Kontrola | Výsledek mimo reálný E2E |
| --- | --- |
| `npm run typecheck` | PASS |
| `npm test` | PASS: 64 testů + routing example skript, fake modely |
| `npm run verifier:unit` | PASS: 2 OS/Git/tsx testy, bez inference |
| `npm run db:test` | PASS, vlastní data uklizena |
| `npm run queue:test` | PASS, fake executor |
| `npm run worktree:test` | PASS, fake AI; reálná DB/Git/sandbox/verifier |
| `npm run orchestration:test` | PASS: 18 testů včetně parent testu, fake AI |
| `npm run control-plane:typecheck` | PASS |
| `npm run control-plane:lint` | PASS |
| `git diff --check` | PASS |

Po E2E byla doplněna pozorovaná fixture a znovu prošel typecheck a npm test.
Root lint/build skripty neexistují; skip policy se nezměnila. Production web
build, browser E2E a samostatné real-provider test skripty se nespouštěly.

## 8–14. Jediný nový reálný E2E

Čas: 1. 10. 2026, 12:18:13–12:20:06 Europe/Prague.
Task: `5a7de7a6-7c81-4a10-af43-8b892d047eb1`; předchozí task nebyl použit.
Repository: `/Users/jonas/jonas-os`; baseBranch `codex/runtime-e2e-fixes`,
baseCommit `9da36fda32182f7751920baf3941d5030d02ab3e` obsahuje opravy.
Původní main nebylo potřeba měnit ani mergovat.

Chief/Qwen vrátil `create_task`, category `coding`, capability `local-coding`,
difficulty 1, low risk a **sám zvolil maxAttempts 1**. Výstup nebyl přepisován;
`JONAS_OS_MAX_ATTEMPTS` zůstal na standardním cap 3. Chief brief nepřenesl
instrukci inspect-first věrně; code-owned worker pravidlo „Inspect existing code
before editing“ zůstalo autoritativní. Detailní tool inputs se neuchovaly,
konkrétní inspekci proto tento report necertifikuje.

Routing: OpenCode, `ollama/qwen3.5:9b-q4_K_M`, fallback null.
Izolovaný worktree:
`/Users/jonas/.jonas-os/worktrees/5a7de7a6-7c81-4a10-af43-8b892d047eb1`.
Jediná Git změna: `docs/jonas-os-e2e-smoke-2.md` (untracked).
Dependencies byly explicitně zkopírovány do ignored node_modules; source zůstal
čistý během execution. Smoke soubor existuje pouze ve worktree, která zůstává.

Worker: exit 0, success true, message null, session ID zachované; usage
input 9013, output 518, reasoning 0. Verifier:

| Check | Skutečný výsledek |
| --- | --- |
| test | FAIL, exit 1, 1784 ms; tsx a assertions už běží, 4 HTTP fixture testy selžou na `listen EPERM 127.0.0.1` |
| typecheck | PASS, exit 0, 2567 ms |
| lint | Explicitní existing-script skip |
| build | Explicitní existing-script skip |

Krátký runtime `/private/tmp/jo-v-4ZFpHE` odstraněn. Síťový sandbox nebyl
uvolněn a testy nebyly přeskočené. Tento další infrastrukturní blocker je mimo
požadovanou opravu; neproběhl slepý retry, repair ani další E2E task.

Antigravity reviewer/provider: **nevykonán**, verdict není; verifier selhal.
Finální task state: **waiting_human**, escalation `max_attempts`, důvod
„Worker budget exhausted.“ Run je failed kvůli verifieru, nikoli chybějící summary.
Úspěšný completed Final Result **nevznikl**. Persistovaný Control Plane read model
obsahuje Git/workspace, čtyři checks, summary null, review null a waiting reason.
UI fallback ukazuje „No final worker summary was captured.“

Soubor obsahuje nadpis „Generated by Jonas OS End-to-End Smoke Test“ a krátké
vysvětlení, že vznikl testem pro ověření write access/document creation.

## 15–16. Source checkout a AGENTS.md

Source main HEAD zůstal `3898426b9ae85c32c1704cf901ce0ce9859d3594`.
Před i po smoke je jediná změna ` M AGENTS.md`. Před stashem byly uloženy
`git status`, binární kopie, `git diff --binary` a SHA-256; stash obsahoval pouze
AGENTS.md. Po apply byla ověřena byte-for-byte shoda, totožný binary patch,
totožný Git status i HEAD. Teprve poté byl vlastní stash odstraněn.

- AGENTS.md SHA-256 před/po:
  `cb7f056226669cf21c040d7c2d8f14f70c51dbb3ae191b4458dac4de0b49ca60`.
- Binary patch SHA-256 před/po:
  `eab08f5ba2b1f45179a2a0e82b1fc88d606ba75dcaf71665c04c8d5a9ba0b17d`.
- Bezpečnostní kopie a JSON report zůstávají v `/tmp/jo-e2e-2-oI2QgP`.

## 17. Přesné počty volání

| Provider | Samostatný parser smoke | Nový repository E2E | Celkem adapter/CLI inference invocations |
| --- | --- | --- | --- |
| Chief/Qwen | 0 | 1 | 1 |
| OpenCode/Qwen | 1 (timeout) | 1 | 2 |
| Repair Chief/Qwen | 0 | 0 | 0 |
| Antigravity | 0 | 0 | 0 |
| Codex worker/reviewer | 0 | 0 | 0 |

Lokální Ollama HTTP log navíc rozlišuje requests uvnitř invocation: parser
smoke měl 2 `/v1/chat/completions` requests (200/500 při ukončení, bez výsledného
JSONL), E2E měl 3 úspěšné `/v1/chat/completions` steps a 1 `/api/chat` Chief.
Celkem tedy 6 generation HTTP requests, z toho 2 z timeoutovaného parser smoke.
Readiness `/api/show`, `/api/tags`, CLI help/version a `codex sandbox` nejsou
inference. Nebyl proveden cloud generation request.

## Změněné soubory opravy

- `src/verification/runtime.ts`, `verifier.ts`, `verifier.test.ts`: krátký owned
  runtime, scoped IPC, cleanup a skutečná dlouhá tsx regrese.
- `src/workers/opencode.ts`, `src/local/opencode.test.ts`,
  `src/local/fixtures/opencode-1.18.33-no-summary.jsonl`: success semantics,
  bounded diagnostika/parsing a pozorovaná fixture.
- `src/orchestration/completion.ts`, `completion.test.ts`, `integration.test.ts`:
  report není invariant, evidence/review zůstávají povinné.
- `src/control-plane/outcome.ts`, `outcome.test.ts`: missing summary není
  chybějící correctness evidence, fallback zůstává.
- `package.json`: samostatný `verifier:unit` (OS integrace, bez DB/AI).
- `docs/architecture.md`, `control-plane.md`, `development.md`, `opencode.md`,
  `setup.md`, `troubleshooting.md`, `usage.md` a tento report: skutečné chování,
  příkazy, diagnostika a ověření. Package-lock a env proměnné se nemění.

Opravy jsou commitnuté na izolované `codex/runtime-e2e-fixes`; push této větve
vyžaduje uživatelské AGENTS.md pravidlo. Žádné unrelated feature work se nemerguje.
