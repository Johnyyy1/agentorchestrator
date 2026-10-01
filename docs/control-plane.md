# Control Plane V1

Lokální operátorské rozhraní pro Jonas OS. Aplikace `apps/control-plane` používá
Next.js App Router, React, TypeScript a Tailwind CSS. Existující orchestrátor,
router, sandboxy, retry pravidla a Drizzle schéma zůstávají samostatným enginem.
Nevznikla nová databázová tabulka ani migrace.

## Spuštění

Z kořene checkoutu po [běžném setupu](setup.md):

```sh
npm ci
npm run control-plane:dev
```

Otevři [http://127.0.0.1:3000](http://127.0.0.1:3000). Wrapper načítá `.env`
z kořene a předává konfiguraci serverové aplikaci. Webový proces **nespouští
consumer fronty**. Pro skutečné vykonávání zařazených úkolů nech v druhém
terminálu běžet:

```sh
npm run worker
```

Worker může volat skutečné providery podle stávající routing policy. Bez něj
lze data prohlížet a úkoly zařazovat, ale zůstanou `queued`. Web nespouští
Docker, Ollama ani autonomní plánování dalších úkolů.

Lokální produkční režim:

```sh
npm run control-plane:build
npm run control-plane:start
```

Oba servery bindují na `127.0.0.1`, nikoli LAN. Jiný port:

```sh
PORT=3001 npm run control-plane:dev
# po buildu
PORT=3001 npm run control-plane:start
```

Build nepotřebuje běžící DB, Ollama ani credentials. Pro reálná data server
potřebuje `DATABASE_URL` a aplikované existující migrace. Delegování potřebuje
Chief setup z [Ollama dokumentace](setup.md#volitelný-lokální-chief).

Next běží přes `--webpack`: resolver mapuje ESM importy `.js` na sdílené TS
soubory mimo aplikaci. Engine se nepřesunul do Next. Všechny dependencies
spravuje kořenový npm workspace a jediný `package-lock.json`. Fonty jsou
systémové; build nestahuje fonty a UI nevyžaduje externí CDN.

## Stránky

| Route | Účel |
| --- | --- |
| `/` | Delegování cíle, running/queued/waiting/failed/pending, aktivní a čekající úkoly, otevřené eskalace, recent activity |
| `/projects` | Seznam skupin podle normalizovaných repository paths |
| `/projects/[key]` | Aktivní/queued/completed/failed úkoly, rozhodnutí a recent activity daného repozitáře |
| `/tasks` | Vyhledávání title/objective/UUID, status/category/worker/repository filtry, řazení a stránkování |
| `/tasks/[id]` | Objective, acceptance criteria, lifecycle, attempts, routing, verifier, workspace metadata, review findings a eskalace |
| `/decisions` | Eskalační inbox: otevřené první, potom resolved/cancelled, stránkování |
| `/decisions/[id]` | Otázka, kontext, odpověď + resume, potvrzované abandon |
| `/agents` | Čtyři execution lanes, modely, readiness a zaznamenané použití |
| `/activity` | Audit události a doplněné persisted task/run/review records, stránkování |

Task status zůstává doménový. Filtr `active` sdružuje running/repairing/reviewing,
`attention` sdružuje failed/pending; nejde o nové uložené stavy. Worker filtr
hledá **jakýkoli zaznamenaný pokus**, takže opravený OpenCode → Codex task najdeš
pod oběma workery. Sloupec Worker ukazuje poslední run. Failed count zahrnuje
uchovanou historii, ne údaj o právě probíhajících incidentech.

## Delegování a rozhodnutí

Command bar zavolá stávající `planGoal()`, znovu validuje Chief decision i
repository grounding a potom zavolá `submitDecision()`.

- `create_task`: zobrazí skutečné ID, title, capability a queued state; odkaz
  otevře detail. `createTask()` nadále odpovídá za persistence a enqueue.
- `ask_human`: zobrazí otázku přímo, bez falešného tasku. Doplníš cíl a odešleš
  jej znovu; nejedná se o uloženou orchestration escalation.
- `no_action`: zobrazí reason, bez zápisu nebo vykonávání.

Repository selector předává jen neprůhledný hash key. Server dohledá poslední
persisted repository context. Browser nemůže dodat vlastní filesystem path
ani baseBranch. První úkol v novém repozitáři musí dostat repository context
přes existující API/příklady; UI zatím nemá registraci projektů. Samotný text
„Pokračuj na Investi“ nevytváří projektovou paměť. Vyber odpovídající repository.

Odpověď volá `answerEscalation()`: transaction atomicky ukládá answer,
resolved, queued a nový job existujícího tasku. Při enqueue failure se rollback
odráží v UI jako chyba a otevřená eskalace. Controls jsou při odesílání disabled;
success se zobrazí až po úspěchu služby. Polling následně čte skutečný stav.
Abandon má malé inline potvrzení a volá `abandonTask()`. Task skončí failed,
open escalations cancelled, worktree i historie se zachovají. Odpověď
neobnovuje attempt budget. Před resume přerušeného providera ověř jeho ukončení.

Každá mutace má UUID request ID. Proces slučuje souběžné i opakované stejné
požadavky a drží výsledek včetně chyby 15 minut (max. 500 požadavků).
Delegování dovolí jeden souběžný planning request. Ochrana není durable přes
restart ani sdílená mezi více servery; V1 provozuj jako jeden lokální proces.
Při nejasném výsledku spojení/restartu nejprve inspectuj Tasks/Decisions.
Submission failure může podle stávajícího `createTask()` ponechat pending row.

## Data a bezpečnost

Serverové read modely jsou v `src/control-plane/queries.ts`. React komponenty
neprovádějí SQL. DTO v `contracts.ts` validuje Zod, datum přechází jako ISO UTC
string a browser je zobrazuje ve své lokální časové zóně. HTML `time` má exact
`datetime` a ISO timestamp v title. Výstupy jsou plain text, bez HTML/Markdown
execution. Logy a task text procházejí redakcí běžných credential patterns a známých
credential hodnot z environment serveru;
server neposílá raw environment, raw result JSON ani escalation context.

API:

| Endpoint | Vstup/účinek |
| --- | --- |
| `GET /api/providers` | Cheap readiness + aggregate DB use, bez inference |
| `POST /api/commands/delegate` | `goal`, volitelně `projectKey`; Local Chief + submission |
| `POST /api/commands/answer` | `id`, `answer`; existující escalation service |
| `POST /api/commands/abandon` | `taskId`, `confirmed: true`; existující abandonment service |

POST vyžaduje JSON, `X-Request-ID` UUID, přesný lokální Host a stejný Origin.
Body má hard limit 32 KB, goal 4000 znaků a answer 6000 znaků. Extra doménová
pole strict schemas odmítnou. Proxy chrání lokální Host, včetně DNS rebinding,
a blokuje cross-site mutace. Používá se CSP, zakázané framing, no-referrer a
nosniff. Produkční CSP nepovoluje eval. UI nečte auth files, neotevírá soubory
z browserem dodaných cest a neposkytuje shell ani filesystem browser.

Read model má tyto limity:

| Data | Limit |
| --- | --- |
| Task list / escalation inbox | 30 položek na stránku |
| Activity | 50 položek na stránku |
| Overview | 20 active, 10 queued, 10 failed/pending, 8 decisions, 15 activity |
| Task detail | Nejnovějších 100 runs/reviews/escalations, 500 audit events |
| Run message / check output / Git status / diff stat | 8000 znaků každé zobrazené položky |
| Changed files | 100 cest, 500 znaků/cesta |
| Objective / acceptance / context | 16000 znaků; 50 kritérií po 2000; 20 context položek po 2000 |
| Repository inventory | Max. 2000 různých persisted cest pro výběr kontextu |

List nevybírá result/logy. Last-run lookup je jeden bulk dotaz, nikoli N+1.
Detail omezuje zprávu, check output a task text už v PostgreSQL; zkrácený
objective/context/criteria mají viditelné upozornění. Overview nemá full diff.
UI používá jen persisted Git metadata; engine nyní neukládá full diff content,
takže jej UI nezískává z filesystemu. Skips mají vlastní stav a žádný text je
nevydává za otestování. Verifier timestamp v timeline je finish daného runu,
nikoli odhad začátku checks. Run startedAt je uložený čas založení runu, který
může předcházet skutečnému worker startu. Audit worker_started zaznamenává start
workeru zvlášť. Legacy flows doplňuje activity feed labels „Recorded …“.

Projects nejsou novou doménovou entitou. Key je hash normalizovaného
repository.path; skupiny nevycházejí ze symlink realpath a přesun repozitáře
vytvoří jinou skupinu. Neexistuje roadmap, procenta dokončení ani semantic memory.

## Health a obnovování

| Lane | Readiness |
| --- | --- |
| Local Chief / Ollama | Existující `checkOllama()`: tags/show, lokální model, bez chat/generation |
| Local coding / OpenCode | Existující `checkOpenCode()`: binary/help/config/model discovery a OS sandbox startup, bez promptu |
| Strong coding / Codex | Executable CLI v PATH; bez auth/model invocation |
| General/research / Antigravity | Executable `agy` v PATH; bez auth/model invocation |

Lokální úspěšná readiness znamená `available`; známé selhání `unavailable`.
Cloud binary presence znamená **unknown**, protože auth ani endpoint nejsou
ověřené. Missing binary znamená unavailable. Globální status rozlišuje DB
offline, unavailable providers a unverified providers; nehlásí fake uptime.

Readiness má procesní cache 20 sekund a slučuje souběžné kontroly. Run statistiky
čtou skutečné attempts: count/success/failure za 7 dní, poslední success/failure
za celou historii. Chief ukazuje jen uložené úspěšné repair decisions; initial
planning a jeho chyby nemají durable záznam a nejsou vydávány za známé údaje.
Review metadata patří do detailu tasku, nezvyšují execution run statistiky.
Při offline DB se statistics zobrazí jako nedostupné, nikoli jako nula.

Aktivní views refreshují server components po 4 sekundách, ostatní po 15.
Hidden tab nepolluje; návrat obnoví data. Při focus v input/textarea/select
refresh čeká, aby nerušil vyplňování. Globální provider status fetchuje po 20
sekundách; readiness neběží pro každý task ani každé čtyřsekundové pollování.
Systémový dark/light mode, viditelné keyboard focus, semantic tables, labels,
textové statusy a reduced-motion fallback jsou součástí UI.

## Development fixtures a testy

```sh
npm run control-plane:fixtures
```

Explicitní development command zapne `CONTROL_PLANE_FIXTURES=1`. Data jsou
**jen v paměti procesu**, banner označuje simulaci, mutace používají fake Chief
a fake služby. Nic se neseeduje do DB, nespouští fronta ani skutečná inference.
Restart resetuje data. V production je fixture flag odmítnutý; nemůže tiše
spadnout zpět na mutace skutečných dat. Do běžné `.env` ho nepřidávej.

```sh
npm run typecheck
npm test
npm run control-plane:typecheck
npm run control-plane:lint
npm run control-plane:build
npm run control-plane:test
npm run control-plane:db:test
npx playwright install chromium
npm run control-plane:e2e
```

`npm test` nyní zahrnuje i pure Control Plane tests. `control-plane:db:test`
používá existující lokální **vývojovou DB**, vloží jen vlastní označené rows,
nikdy neposílá job workeru a uklidí cascade historii. Browser smoke spouští
vlastní fixture dev server na 127.0.0.1:3107, testuje rendering, filtry, task
history, odpověď, rollback-like error UX, Chief create/ask/no_action, projekty,
health, cross-origin/Host guards a overflow. Nevstupuje do skutečné DB.

Screenshoty skutečného UI ukládá do [control-plane/](control-plane/), včetně
1440×900, 1280×800, 390×844 a dark mode. Nejsou generované ilustrace. Kompletní
výsledky tohoto milestone jsou v [reportu](control-plane-report.md).

## Limity V1

- Web nezjišťuje, zda běží queue consumer; queued state sám jeho dostupnost
  nedokládá. Worker se spouští samostatně.
- Cloud readiness neověřuje přihlášení ani dostupnost modelu.
- První repository context se zavádí existujícím API. Neexistuje project registry.
- Detail a output jsou bounded, plný diff není persisted. Historické záznamy
  s chybějícími metadata nevytvářejí domyšlené lifecycle stages.
- Po restartu neexistuje durable HTTP idempotency; uncertain submission řeš
  inspekcí záznamů, ne slepým opakováním.
- Remote access, více uživatelů, notifikace, schedules, semantic memory,
  embeddings, autonomous next-task generation a GitHub nejsou součást V1.
