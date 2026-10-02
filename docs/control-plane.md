# Control Plane V1

Lokální operátorské rozhraní pro Jonas OS. Aplikace `apps/control-plane` používá
Next.js App Router, React, TypeScript a Tailwind CSS. Existující orchestrátor,
router, sandboxy a retry pravidla zůstávají samostatným enginem.
Minimální registry používá tabulku `repositories` a migraci
`0004_loving_pretty_boy.sql`. Project Model + Semantic Memory V1 přidává
samostatné doménové tabulky migrací `0005_overconfident_gladiator.sql`.

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
| `/projects` | Skutečné projekty, status, milestone, primary repository, recent tasks a Create Project |
| `/projects/[UUID]` | Projektová pole/vazby, editor, memory inspector/search/sync, recent tasks |
| `/repositories` | Původní registry a historické repository skupiny |
| `/repositories/[key]` | Úkoly/rozhodnutí/activity repozitáře; původní `/projects/[hash]` přesměruje sem |
| `/tasks` | Vyhledávání title/objective/UUID, status/category/worker/repository filtry, řazení a stránkování |
| `/tasks/[id]` | Final Result / Waiting for you / Failed, objective, acceptance criteria, lifecycle, attempts, verifier, review a workspace metadata |
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

Repository selector předává jen neprůhledný hash key. Server dohledá
**registrovanou** cestu, znovu ověří Git working tree před Chief i před submission
a zachová poslední historický `baseBranch`, pokud existuje. Bez něj platí
stávající default enginu. Browser nemůže delegaci dodat vlastní cestu ani větev.
Historické cesty jsou viditelné, ale musíš je zaregistrovat před delegováním.

### První repozitář

1. Po `npm run db:migrate` otevři Overview nebo Repositories.
2. Klikni **+ Add repository**, vlož absolutní cestu a potvrď **Add repository**.
3. Server normalizuje cestu přes `realpath`, vyžaduje existující adresář a Git
   working tree; podadresář mapuje na Git root. `.git` i alias do `.git`, soubor,
   bare repo a neexistující cesta se odmítnou. Git běží s oddělenými argumenty,
   bez shell interpolace a zděděných `GIT_DIR`/`GIT_WORK_TREE` overrides.
4. Unique index odmítne duplicitu včetně trailing slash, `..` a symlink aliasu.
5. Overview novou položku vybere automaticky. Repositories ji zobrazí i s 0 úkoly.

Registry uchovává UUID, name, canonical path a created/updated timestamps.
Nedostupná nebo přesměrovaná registrovaná cesta zůstává pro diagnostiku,
zobrazuje **Unavailable** a nelze ji z UI delegovat. Validace registry
nedokládá čistý checkout, existující base commit ani připravené dependencies;
tyto stávající požadavky kontroluje worktree engine.

Volitelně nastav v root `.env` `JONAS_OS_REPOSITORIES` na jednu absolutní cestu
nebo JSON pole cest. Při čtení inventory/contextu server idempotentně zajistí
validní entries. Neplatnou cestu nezaregistruje, vypíše stručnou diagnostiku a
ostatní položky zachová. Neplatný formát konfigurace je chyba. Žádné skenování
home, directory browser ani čtení libovolných souborů nevzniká.
Pro „Pokračuj na Investi“ vytvoř Project Model a vyber projekt v Overview.
Bez projektu zůstává původní repository-only delegace. [Project workflow](project-memory.md).

### Výsledek úkolu

Dokončený task má hned pod headerem **FINAL RESULT**: skutečný veřejný final
message posledního úspěšného coding workeru, změny popsané workerem,
počet/seznam souborů a diff stat, deterministické checks a nezávislé review
**stejného runu**. Plain text nepotřebuje přesné Markdown headings. Coding
prompty pro OpenCode i Codex, včetně oprav, žádají `Summary`, `What changed`,
`Files changed`, `Notes / limitations`. Samotné tvrzení workeru nenahrazuje
persistované checks/review; `skipped`, failed a timeout jsou odlišené.

Chybějící report má text **No final worker summary was captured** a zobrazí
jen dostupná metadata. Display limits jsou viditelné: přesný počet uložených
cest se nezmenšuje s list limitem 100; při neúplných persisted Git metadata
je počet dolní mez. Bez Git metadat se neuvádí vymyšlená nula. Zpráva je
redigovaná a obyčejný text; skryté reasoning traces se nezobrazují.

`waiting_human` má **WAITING FOR YOU**, důvod zastavení, aktuální otázku a
poslední worker report. `failed` má **FAILED**, zaznamenanou příčinu a poslední
report s kontextem checks/review. Objective a technická lifecycle jsou až pod
tímto panelem. Žádné nové modelové volání, summary persistence ani podmínka
pro dokončení tasku nevzniká; read model nemění orchestration policy.

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
| `POST /api/commands/repository` | `path`; serverová validace a zápis registry |
| `POST /api/commands/delegate` | `goal`, projectId + optional bound repositoryId nebo legacy projectKey; Chief + submission |
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
| Repository inventory | Max. 2000 registry entries a 2000 historických cest pro kontext; max. 100 bootstrap cest |

List nevybírá result/logy. Last-run lookup je jeden bulk dotaz, nikoli N+1.
Detail omezuje zprávu, check output a task text už v PostgreSQL; zkrácený
objective/context/criteria mají viditelné upozornění. Overview nemá full diff.
UI používá jen persisted Git metadata; engine nyní neukládá full diff content,
takže jej UI nezískává z filesystemu. Skips mají vlastní stav a žádný text je
nevydává za otestování. Verifier timestamp v timeline je finish daného runu,
nikoli odhad začátku checks. Run startedAt je uložený čas založení runu, který
může předcházet skutečnému worker startu. Audit worker_started zaznamenává start
workeru zvlášť. Legacy flows doplňuje activity feed labels „Recorded …“.

Projects jsou samostatná UUID/slug entita. Registry používá canonical Git
root; key zůstává hash normalizované cesty. Historické cesty se deduplikují
normalizací řetězce bez procházení filesystemu; historický symlink alias může
mít samostatnou skupinu. Projekty mají milestone a explicitní semantic memory;
procenta ani autonomní plánování se neodvozují. [Kontrakty a limity](project-memory.md).

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
a fake služby. Nové registrace validují skutečný testovací Git adresář, ale
ukládají se pouze do paměti fixture procesu. Nic se neseeduje do DB, nespouští fronta ani skutečná inference.
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
nikdy neposílá job workeru a uklidí cascade historii i vlastní registry entry
a dočasný Git adresář. Ověřuje také bootstrap bez historických úkolů, duplicity
a nedostupný repozitář. Browser smoke spouští
vlastní fixture dev server na 127.0.0.1:3107, testuje rendering, filtry, task
history, odpověď, rollback-like error UX, Chief create/ask/no_action, projekty,
health, Final Result, registraci dočasného Git repozitáře, nulové task counts,
fake-Chief repository grounding, cross-origin/Host guards a overflow. Nevstupuje do skutečné DB.

Screenshoty skutečného UI ukládá do [control-plane/](control-plane/), včetně
1440×900, 1280×800, 390×844 a dark mode. Nejsou generované ilustrace. Kompletní
výsledky původního milestone jsou v [reportu](control-plane-report.md).
[Registry a Final Result report](control-plane-results-report.md) popisuje tuto změnu a její QA.

## Limity V1

- Web nezjišťuje, zda běží queue consumer; queued state sám jeho dostupnost
  nedokládá. Worker se spouští samostatně.
- Cloud readiness neověřuje přihlášení ani dostupnost modelu.
- Repository Registry vlastní filesystem identity; Project Model je samostatný. Žádný filesystem browser.
- Detail a output jsou bounded, plný diff není persisted. Historické záznamy
  s chybějícími metadata nevytvářejí domyšlené lifecycle stages.
- Po restartu neexistuje durable HTTP idempotency; uncertain submission řeš
  inspekcí záznamů, ne slepým opakováním.
- Remote access, více uživatelů, notifikace, schedules, cloud embeddings,
  autonomous next-task generation a GitHub nejsou součást V1.

Chybějící worker summary samo není completion invariant ani historická
evidence warning. Pokud poslední coding execution, workspace/Git, verifier
a nezávislé APPROVE odpovídají, Final Result zobrazí metadata a text
„No final worker summary was captured.“ bez dalšího model callu.

Verifier infrastruktura se zobrazuje v existujícím Final Result/waiting reason
a run error jako `Verifier infrastructure failure: …`, s bounded relevantním
důvodem a eskalací `infrastructure`. Check `verifier` zaznamenává infrastrukturní
selhání odděleně od běžných neúspěšných test/typecheck checks. Nedochází k UI
redesignu ani k předstírání review/completion. Číslo provedeného coding pokusu
zůstává historicky zachované; infrastruktura nespouští další coding pokus.

## Projekty a paměť V1

Overview má Project selector a Repository dropdown omezený na bound registry
entries. Detail projektu umožňuje vytvořit a archivovat manual memory,
prohlédnout mandatory provenance, hledat s relevance score a explicitně syncnout
completed task outcomes. Task detail ukazuje immutable snapshot „why Chief knew
this“. New APIs používají stejný Host/Origin/Zod/request-ID boundary;
[endpointy, provenance, scoring a limity](project-memory.md#api-a-bezpečnost).
Readiness paměti je `npm run memory:check`; retrieval/indexace nevstupuje do
completion transakce. Browser QA: `npm run memory:browser:test`.
