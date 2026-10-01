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
orchestration:test, navíc DB/queue/worktree assertion skripty. Neprovedeny:
web browser E2E/build ani samostatné real-provider test skripty. Toto není
zpráva o reálném repository-coding E2E; jeho následný výsledek se zaznamená
samostatně po skutečném běhu.
