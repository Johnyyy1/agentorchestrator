# Repository Registry V1 a Final Result — ověření změny

## Výsledné chování

Migrace `0004_loving_pretty_boy.sql` přidává `repositories` s UUID, name,
canonical path (unique), createdAt a updatedAt. `db:migrate` byla aplikována na
lokální vývojové DB. Žádný Project Model, roadmap ani semantic memory nevzniká.

Server vyžaduje absolutní existující Git working tree, odmítá soubory,
neexistující/non-Git/bare cesty i `.git` a jeho symlink alias. Podadresář
převádí na Git root; unique index odmítá canonical duplicity. Git volání
používají oddělené argumenty, izolované Git environment/config a žádný shell.
Při delegaci se registry/context ověřuje před Chief i před submission.
Historická neregistrovaná cesta není execution kontext. Zmizelý nebo změněný
working tree zůstává v registry pro diagnostiku a je unavailable.

Overview i Projects mají **+ Add repository**. Overview po registraci vybere
novou cestu; selector uvádí name a zkrácenou cestu. Projects ukazuje i
0 úkolů. `JONAS_OS_REPOSITORIES` přijímá jednu absolutní cestu nebo JSON pole
max. 100 cest a zajišťuje validní entries při čtení. Žádný filesystem browser
ani procházení home adresáře nevzniká.

Dokončený detail má **FINAL RESULT** před objective/lifecycle: skutečný veřejný
worker report, file count/list/diff stat a checks/review stejného runu.
OpenCode i Codex coding prompty, včetně repair attempts, žádají `Summary`,
`What changed`, `Files changed`, `Notes / limitations`. Chybějící report,
truncation, absent evidence a skipped checks jsou výslovně označené.
Waiting/failed task ukazuje důvod, otázku a poslední captured worker report;
pokud patří staršímu pokusu než systémová metadata, panel to rozlišuje.
Žádné další modelové volání ani změna completion/retry/router/sandbox policy.

## Ověřeno

- `npm run typecheck`, `npm test` (Control Plane: 19 testů).
- `npm run control-plane:typecheck`, `npm run control-plane:lint`.
- `npm run db:test`, `npm run control-plane:db:test` — vlastní data uklizena;
  bootstrap bez historie daného repozitáře, canonical duplicates, 150 cest
  při list limitu 100, unavailable a historický baseBranch.
- `npm run queue:test`, `npm run worktree:test` — fake workers/reviewer/Chief,
  skutečný lokální verifier sandbox; prompt kontrakt pro oba coding workery.
- `npm run control-plane:build` — production compilation úspěšná.
- `npm run control-plane:e2e` — dva browser testy: operátorský workflow a
  registrace skutečného dočasného Git adresáře do fixture paměti, 0 tasks,
  automatic selection, fake-Chief → submitDecision → TaskSpec, duplicate,
  non-Git, arbitrary delegation path a cross-origin odmítnutí.
- Samostatná lokální QA na nově vytvořené prázdné DB: všechny Drizzle migrace,
  explicitní bootstrap, 0 task rows a selectable repository context. Dočasná
  DB a adresář byly odstraněny.
- Git validace zdrojového checkoutu Jonas OS úspěšná; reálný coding task nebyl
  odeslán ani spuštěn.

První browser run odhalil oddělené error-class instance mezi Next server
bundles po navigaci: duplicate skončil generic 503. Oprava typed error boundary
zachovává správný 409 i přes shared fixture closures; unit/browser regression
ji ověřuje. Screenshoty jsou skutečné fixture UI, nikoli AI ilustrace.

Skutečná Codex/Antigravity/Ollama inference ani nezávislé modelové review této
změny nebyly spuštěny. Kontroly používají fake adaptéry; `codex sandbox` ve
verifieru model nevolá. Registrace sama nezaručuje čistý checkout, base commit
ani připravené dependencies. Historické symlink aliasy mohou mít oddělenou
read-only skupinu, protože registry neprochází historické filesystem cesty.

## Registrace vlastního checkoutu

1. V kořeni checkoutu spusť `npm run db:migrate` a `pwd -P`.
2. Spusť `npm run control-plane:dev` a otevři lokální Overview.
3. Klikni **+ Add repository**, vlož cestu z `pwd -P`, potvrď **Add repository**.
4. Nová položka se automaticky vybere; Projects ji ukáže i bez tasku.

Alternativa: ulož tuto absolutní cestu jako `JONAS_OS_REPOSITORIES` do root
`.env`, restartuj web a otevři Overview/Projects. Bootstrap neskenuje disk.

Změna zůstává v izolovaném worktree bez commit/push/merge/deploy podle zadání.
