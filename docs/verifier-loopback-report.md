# Verifier loopback a klasifikace infrastruktury

Ověřeno 1. 10. 2026. Implementace navazuje na `a098ba59` větve
`codex/runtime-e2e-fixes`, včetně `9da36fda` a semantic fixu `3898426b`.
Deterministické regrese níže nevolají skutečné AI providery.

## Příčina a skutečná hranice macOS

Původní verifier používal `codex sandbox` s
`sandbox_workspace_write.network_access=false` a povoleným AF_UNIX jen pod
vlastním krátkým runtime. Nejmenší Node HTTP server s `listen(0, '127.0.0.1')`
a následným close mimo sandbox prošel; ve stejném původním sandboxu skončil
`listen EPERM: operation not permitted 127.0.0.1`. Selhal legitimní HTTP
fixture, ne aplikační assertion ani coding worker.

Byl přečten skutečný verifier a instalované Apple profily, například
`/usr/share/sandbox/com.apple.smbd.sb` s `local tcp` filtry. Parser odmítl
číselné host filtry s hláškou `host must be * or localhost in network address`.
Podporovaný `localhost:*` byl ověřen reálnými bind/request/close experimenty.
Také [Codex Seatbelt generator](https://github.com/openai/codex/blob/main/codex-rs/sandboxing/src/seatbelt.rs)
používá tento matcher pro lokální síťovou politiku.

**Zjištěné omezení:** `local tcp localhost:*` povolil nejen 127.0.0.1/::1,
ale i 0.0.0.0, :: a skutečnou LAN adresu stroje. Externí host proces se přes
LAN adresu dostal k odpovědi wildcard listeneru. Není to kernelová izolace
inbound na loopback. Remote filtr pro inbound nepovolil použitelný lokální
server; není řešením. Toto omezení popisuje také
[primární Bazel změna](https://bazel.googlesource.com/bazel/+/696734cfd3d338d04a885fa65b996ece43fe365c).
Operátor po předložení důkazů explicitně zvolil minimální TCP profil plus
Node guard s výslovně popsanou ne-kernelovou hranicí.

## Implementovaná politika

Verifier nyní používá vlastní `/usr/bin/sandbox-exec` profil, oddělený od
workerů. Default deny, read-only host filesystem jako dosavadní verifier,
zápisy pouze do worktree a vlastního krátkého runtime; `.git`, `.codex`,
`.agents` a guard file jsou read-only. AF_UNIX bind/connect zůstává pouze pod
runtime. Process exec/fork, process info a signal mají potřebnou lokální
hranici; původní OpenCode, Codex a reviewer sandbox implementace se nemění.

- TCP bind/inbound/outbound: podporovaný matcher `localhost:*`, všechny porty
  včetně ephemeral. OS sám nedokáže slíbit přesný loopback-only inbound.
- Node/npm/tsx: `NODE_OPTIONS` načte vlastní read-only guard. Veřejný
  `net.Server.listen` dovolí explicitní 127.0.0.1/::1; hostname localhost
  přepíše na 127.0.0.1. Odmítá wildcard, LAN, implicitní host a socket handles.
- OS odmítá testované externí/LAN-style TCP outbound na 1.1.1.1, 192.0.2.1
  a 192.168.1.1 okamžitým EPERM; UDP a DNS nejsou povolené. Matcher neizoluje
  služby běžící na tomto stroji obecně. Unix socket mimo runtime je EPERM.
- Node guard lze obejít změnou Node API/env nebo jiným runtime. Takový kód
  může listenovat na wildcard/LAN. Používej důvěryhodné fixtures; pro hostile
  testy s přesnou inbound hranicí je potřeba jiná OS izolace. Žádná obecná
  network allow ani unrestricted fallback se nepřidává.

## Infrastruktura, attempt a Control Plane

Pevný verifier-owned preflight ověří temp write a HTTP bind/request/close na
IPv4 i IPv6 před prvním application checkem. Trusted launcher zapisuje
strukturovaný checkpoint při spawn package manageru. Známé setup, sandbox,
launcher nebo cleanup operace vrací `verification.failureKind: infrastructure`
a stage/zprávu nejvýše 500 znaků. Infrastrukturní chyba zastaví další checks.
Nenulový exit či timeout již spuštěného checku a neplatný manifest/manager
zůstává verification failure. EPERM uvnitř aplikačních logů se neodhadne jako
infrastruktura; není zde obecné string matching řešení.

Run persistuje `failureKind: infrastructure`, zachová pracovní diff/worktree
se skutečným historickým attempt číslem. Orchestrace otevře `waiting_human`
se reasonType infrastructure před repair Chiefem, dalším workerem či reviewerem.
Cap/maxAttempts se nemění ani nedoplňuje. Redelivery nic neopakuje; human
answer nad stejným infrastrukturním výsledkem znovu eskaluje a nevyvolá coding
ani samostatné reverify. Nový resume/reverify mechanismus se nepřidává.

Existující Control Plane read model a Final Result/waiting reason ukáže
`Verifier infrastructure failure: Local test server could not start … listen EPERM 127.0.0.1`
místo obecné test failure; skutečná DB regrese potvrzuje bounded relevantní
text bez velkého logu. Completion guard explicitně odmítá infrastructure,
i kdyby nekonzistentní výsledek současně tvrdil success.

## Regrese a ověření

A/B: skutečný tsx HTTP fixture v dlouhém worktree, IPv4/IPv6 response a clean
close, krátký IPC socket, scoped zápisy, guard wildcard/LAN odmítnutí a reálný
OS outbound deny. C: skutečný failing node:test assertion obsahující EPERM
zůstává verification. D: chybějící package-manager spawn a skutečný sandbox
startup failure jsou infrastructure. E: DB orchestrace drží jeden pokus,
žádný repair/review, i po redelivery a human answer. F: dosavadní missing/
failed verifier, missing review a PASS + APPROVE completion regrese zůstávají.

Další zjištěná infrastruktura: macOS odmítá vnořené `sandbox_apply` i pod
vnějším `(allow default)`. Původní worker/reviewer OS regrese byly přesunuty
celé do samostatných test souborů; žádné assertions se nemažou/nepřeskakují.
Root npm test používá pure/parser/HTTP/Git sady. `opencode:unit` a
`reviewer:test` dál zahrnují své původní OS regrese. `sandbox:test` je spouští
samostatně mimo verifier spolu s verifier OS regresí. Root lint/build se
nepřidávají a chybějící skripty zůstávají explicitně SKIPPED, ne PASS.

| Kontrola | Skutečný výsledek |
| --- | --- |
| npm run typecheck | PASS |
| npm test | PASS, 61 testů + router example skript |
| npm test pod novým reálným verifier profilem a Node guardem | PASS, exit 0 |
| npm run sandbox:test | PASS, 9 testů: OpenCode OS 1, reviewer OS 2, verifier 6 |
| npm run orchestration:test | PASS, 19 testů včetně parent; fake AI |
| npm run db:test | PASS, vlastní data uklizena |
| npm run queue:test | PASS, fake executor a vlastní queue |
| npm run worktree:test | PASS, fake AI, reálná DB/Git/verifier |
| npm run opencode:check | PASS, OpenCode 1.18.33, qwen3.5:9b-q4_K_M; bez inference |

Celkem 89 počítaných node:test regresí v npm test + sandbox:test +
orchestration:test, navíc DB/queue/worktree assertion skripty. Neprovedeny: web browser E2E/build ani samostatné real-provider test skripty.
Následující část zaznamenává právě jeden skutečný repository-coding E2E.


## Jediný nový reálný E2E: verifier PASS, worker nedodal změnu

**Celkové success kritérium milestone nebylo dosaženo:** verifier již funguje,
ale tento jediný task skončil na neúplném OpenCode execution před review.
Nebyl spuštěn další task, druhý worker pokus, repair inference ani cloud review.
Neobnovoval se předchozí waiting_human smoke. Nejde o APPROVE ani COMPLETED.

| Údaj | Skutečný persistovaný výsledek |
| --- | --- |
| Task ID | `fd74d994-f43f-42d8-9fb8-8bfab600c77b` |
| Repository | `/Users/jonas/jonas-os` |
| Task baseBranch | `codex/verifier-loopback` |
| Přesný baseCommit | `2d0694e3769938ac94ffa226acb746a2be734c3f` |
| Chief | Local Qwen `qwen3.5:9b-q4_K_M`; `create_task`, category coding, capability local-coding, difficulty 1, low risk |
| Chief maxAttempts | 1, skutečný výstup bez přepisování; globální cap nezměněný |
| Worker | OpenCode 1.18.33; `ollama/qwen3.5:9b-q4_K_M`, fallback null |
| Worker execution | exit 0, timeout false, **success false**, error `OpenCode reported an incomplete step.` |
| Run | `c236e676-e69d-44bf-8f13-0ada3ab81ddf`, attempt 1, failed, failureKind execution |
| Požadovaný soubor | `docs/jonas-os-e2e-smoke-3.md` **nevznikl** |
| Changed files | `[]`; žádný tracked/untracked diff, potvrzeno samostatným Git status/diff |
| test | PASS, exit 0, 4491 ms; skutečný npm test uvnitř verifieru |
| typecheck | PASS, exit 0, 2917 ms |
| lint | SKIPPED, script absent, exitCode null; není PASS |
| build | SKIPPED, script absent, exitCode null; není PASS |
| Verifier aggregate | success true, failureKind null; žádná verifier infrastructure chyba |
| Reviewer/provider | Antigravity/Google je normální nezávislý kandidát a readiness prošla; **invocation neproběhla** |
| Actual review verdict | Žádný; reviews `[]` |
| Final task state | waiting_human, orchestration phase human |
| Escalation | max_attempts, summary `Worker budget exhausted.` |
| Final Result | Existující persisted Control Plane read model obsahuje run/routing/worktree/Git a čtyři checks; waiting reason, summary null, review null. Úspěšný completed Final Result nevznikl. |
| Worktree | `/Users/jonas/.jonas-os/worktrees/fd74d994-f43f-42d8-9fb8-8bfab600c77b`, zachovaný |

Normální flow: skutečný planGoal → submitDecision → createTask/PostgreSQL →
unikátní pg-boss queue → normální registerTaskWorker/processTaskJob →
executeTask/OpenCode → skutečný verifier → normální attempt cap eskalace.
Dependencies byly explicitně zkopírovány pouze do ignored node_modules task
worktree přes provisioning callback; source zůstal čistý během execution.
Task se založil na commitu obsahujícím semantic, parser, krátký runtime i nový
loopback fix. Stale main se nepoužil jako task base a žádná unrelated práce
se nemergovala.

Pasivní obálka předala skutečnému OpenCode stejné argv/env a nezměněné
stdout/stderr. Uložila pouze bounded event counts a veřejné tool názvy/statusy,
nikoli reasoning, tool input/output payload ani velké logy. Byly pozorovány
4 step_start, 4 step_finish, 4 tool_use a 1 text event; tool statusy byly
read error, glob error, glob error, glob completed. Žádný edit/write event
nebyl zaznamenán. Detailní důvod tool chyb/terminálního step reason nebyl
uchován; tento report jej nevymýšlí. Nelze certifikovat úspěšnou inspect-first
sekvenci. Message je null a session ID je zachované
`ses_f06d6ba6bffeqLh8murd0L1ERo`. Usage: input 13813, output 472, reasoning 0.
Parser správně neposkytl success jen z exit 0; není zde ručně vytvořený soubor,
fabricovaný summary ani vynucená approval.

Verifier PASS tak prokazuje opravený runtime i na skutečném repository tasku,
**neprokazuje dodání požadované změny**. Completion invariant odmítl selhaný
worker. Proto není žádný reviewer verdict a kritická cesta až k revieweru
v tomto konkrétním smoke není ověřena. Druhý smoke by porušil explicitní
požadavek přesně jednoho tasku; nebyl spuštěn.

## Source checkout a přesná obnova AGENTS.md

Source main HEAD před i po zůstal
`3898426b9ae85c32c1704cf901ce0ce9859d3594`. Jediná source změna před i po:
` M AGENTS.md`. Task worktree zůstal čistý, požadovaný smoke file neexistuje.
Implementace je v samostatném managed worktree
`/Users/jonas/.codex/worktrees/verifier-loopback/jonas-os` na větvi
`codex/verifier-loopback`; source main se neměnil.

Před stashem pouze AGENTS.md byl uložen status, byte copy, git diff --binary,
HEAD a SHA-256. Po apply vlastního stash SHA proběhly skutečné `cmp` kopie,
binárního diffu i statusu a porovnání HEAD; všechny prošly. Teprve pak byl
odstraněn vlastní stash. Žádný reset --hard, git clean ani force operace.

- AGENTS.md SHA-256 před/po:
  `cb7f056226669cf21c040d7c2d8f14f70c51dbb3ae191b4458dac4de0b49ca60`.
- Binary diff SHA-256 před/po:
  `eab08f5ba2b1f45179a2a0e82b1fc88d606ba75dcaf71665c04c8d5a9ba0b17d`.
- Byte cmp / diff cmp / status cmp / HEAD unchanged: **PASS**.
- Důkazy, JSON persisted snapshot a zálohy:
  `/tmp/jo-e2e-3-OLjLbu`. Report neobsahuje secrets ani reasoning.

## Skutečné inference počty

| Provider | Adapter/CLI inference invocations | Generation HTTP requests |
| --- | --- | --- |
| Chief Qwen | 1 | 1 `/api/chat` |
| OpenCode/Qwen | 1 | 4 `/v1/chat/completions` kroky |
| Repair Chief Qwen | 0 | 0 |
| Antigravity | 0 | 0 |
| Codex worker/reviewer | 0 | 0 |

HTTP počty vycházejí z Ollama server log delta během jediného běhu, nikoli
z odhadu podle tokenů. Readiness model/show/tags, CLI help/version a sandbox
kontroly nejsou inference. Regresní testy používaly fake providery/CLIs.
Celkem 2 skutečné lokální adapter invocations, 5 generation HTTP requests,
žádná cloud inference. Nebyl další parser/provider smoke ani restart tasku.

## Změněné soubory a Git

Implementační commit `2d0694e3` je na `codex/verifier-loopback` a byl pushnut
na origin. Tato následná dokumentační změna pouze zaznamenává skutečný výsledek.

- Verifier: `src/verification/verifier.ts`, `launcher.ts`, `loopback-guard.ts`,
  `infrastructure.ts`, `verifier.test.ts`.
- Persistence/orchestrace: `src/workers/execute.ts`, `src/orchestration/service.ts`,
  `completion.ts`, `completion.test.ts`, `integration.test.ts`.
- Celé přesunuté OS testy: `src/local/opencode-sandbox.test.ts`,
  `src/review/review-sandbox.test.ts`; původní pure soubory opencode/review.test.ts.
- Příkazy: `package.json`; package-lock.json zůstal zachovaný beze změny.
- Česká dokumentace: README a architecture, setup, usage, development,
  troubleshooting, opencode, repair-loop, control-plane a tento report.
- Žádná nová env proměnná, schema migrace, model/routing změna či navýšení capu.

Žádný další milestone se nezačal. Verifier oprava je ověřená; reálné dodání
souboru a dosažení nezávislého revieweru zůstávají v jediném povoleném smoke
**neúspěšné/neověřené** z výše uvedeného execution důvodu.
