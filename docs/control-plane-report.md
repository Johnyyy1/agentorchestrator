# Control Plane V1 — implementace a ověření

Ověřeno 1. 10. 2026 na macOS, Node.js 24.15.0 a lokálním PostgreSQL 16.
Práce je v izolovaném worktree, branch `codex/control-plane-v1`, bez commitu,
pushe, merge, PR nebo deploymentu. Původní checkout nebyl změněn; jeho
rozpracovaná změna `AGENTS.md` zůstala zachovaná.

## 1. Zvolená architektura

Samostatný npm workspace `apps/control-plane`: Next.js 16.3.8 App Router,
React 19.3.0, TypeScript a Tailwind 4.3.3. Stránky a čtení jsou serverové,
client components zajišťují formuláře, navigaci, čas a polling. Shared read
modely/DTO jsou v `src/control-plane`. Engine, DB schema, queue consumer,
routing, sandboxy a bounded repair/review loop se nepřesunuly ani nezměnily.
Webpack resolver podporuje sdílené `.js` ESM importy směřující do TS.

## 2. Vytvořené soubory/aplikace

- `apps/control-plane/app/`: shell, globální CSS, Overview, Projects/detail,
  Tasks/detail, Decisions/detail, Agents, Activity, loading/error/not-found.
- `apps/control-plane/app/api/commands/[operation]/route.ts`: validated
  delegate/answer/abandon; `app/api/providers/route.ts`: health.
- `apps/control-plane/components/`: navigation, primitives, live, commands,
  task-detail.
- `apps/control-plane/lib/server.ts`: server-only read bridge a fixture dispatch.
- `apps/control-plane/proxy.ts`: local Host/Origin guard.
- `apps/control-plane/package.json`, `tsconfig.json`, `next.config.ts`,
  `postcss.config.mjs`, `next-env.d.ts`, `playwright.config.ts`, `e2e/smoke.spec.ts`.
- `apps/control-plane/AGENTS.md` a `CLAUDE.md`: managed instrukce automaticky
  vytvořené aktuálním Next dev; instrukce commitu v managed textu nebyla provedena.
- `src/control-plane/contracts.ts`, `queries.ts`, `mapping.ts`, `format.ts`,
  `providers.ts`, `mutations.ts`, `security.ts`, `fixtures.ts`, `launcher.ts`,
  `control-plane.test.ts`, `db-integration.ts`.
- `eslint.config.mjs`, `docs/control-plane.md`, tento report a screenshoty.

## 3. Upravené soubory

`package.json` a jediný `package-lock.json` (workspace + příkazy), root
`tsconfig.json` (apps mají vlastní kontrolu), `.gitignore` (Next/test artifacts),
`.env.example`, `README.md`, `docs/setup.md`, `docs/usage.md`,
`docs/architecture.md`, `docs/development.md`, `docs/troubleshooting.md`.
Žádný existující source modul enginu ani Drizzle schema/migrace se nezměnil.
Žádná předchozí locked package version se nezměnila.

## 4. Nové dependencies

Web: `next`, `react`, `react-dom`, `tailwindcss`, `@tailwindcss/postcss`,
`lucide-react`; development: `@types/react`, `@types/react-dom`, `eslint`,
`eslint-config-next`. Root přidal `@playwright/test` 1.63.0. Spouštěcí launcher
používá už existující `dotenv` a `tsx`; nebyla přidána další env CLI dependency.
Není velká komponentová knihovna, externí font, AI grafika ani nový DB driver.

## 5. Routes

`/`, `/projects`, `/projects/[key]`, `/tasks`, `/tasks/[id]`, `/decisions`,
`/decisions/[id]`, `/agents`, `/activity`; dvě HTTP route families popsané
v [API tabulce](control-plane.md#data-a-bezpečnost). Všechny dynamické views
se serverově renderují z aktuálních dat.

## 6. Overview

Primární command bar, derived repository context, skutečné running/repairing/
reviewing, queued, waiting_human, failed a pending counts. Kompaktní aktivní a
queued řádky, viditelné otázky, failures/pending k inspekci, recent activity.
Failed count je explicitně uchovaná historie. Mobil ukazuje decisions před
aktivními úkoly. Bez vanity metrics nebo domyšlených procent.

## 7. Task detail

Objective/acceptance/context, repository, UUID a data; chronological timeline
z DB task/run/review/escalation/events. Attempts ukazují worker, requested
capability, route/model/fallback, parent, failure kind, duration a workspace.
Checks rozlišují pass/fail/skipped/timeout, mají duration, snippet a bounded
expandable output. Skips nejsou vydávány za test success. Persisted changed
files, Git status, diff stat, branch/worktree/base; žádné čtení souborů podle
browser input. Review verdict/severity/provider/model/summary/findings včetně
file:line, reason a suggested fix. Chybějící metadata jsou označená.

## 8. Decisions/escalations

Inbox prioritizuje open, detail volá `answerEscalation()` a ukazuje success až
po transaction. Pending controls a request IDs zabraňují duplicitnímu submitu.
Queue failure ponechává open rozhodnutí; error UX byl ověřen browser mockem a
transaction rollback stávající orchestration integrací. Abandon vyžaduje
inline confirmation a volá `abandonTask()`; historie a worktree zůstanou.

## 9. Delegate/Chief

Stávající `planGoal()` → revalidace + grounding → `submitDecision()`. Všechny
create_task/ask_human/no_action výsledky mají vlastní UI. Zvolený repository key
server mapuje na persisted context. Žádná nová Chief logika, fake task pro
clarification ani automatic next-task generation. UI tests použily fake Chief
s reálným submission bridge; skutečná webová planning inference nebyla spuštěna.

## 10. Agents/provider health

Local Chief, OpenCode, Codex a Antigravity lanes. `checkOllama()` a
`checkOpenCode()` bez inference; cloud pouze executable discovery, proto
installed cloud CLI zůstává unknown. Run statistiky vycházejí z DB, Chief jen
z uložených repair decisions. Neexistuje quality score ani credential dump.
Na ověřovaném hostu Chief/OpenCode available, Codex/Antigravity unknown.

## 11. Live updates

Server-component refresh: active 4 s, inactive 15 s, hidden tab pauza;
input focus refresh odkládá. Globální health fetch 20 s, coalesced provider
readiness cache 20 s po dokončení. Bez WebSockets a per-task readiness.

## 12. Security boundary

Dev/start launcher fixuje 127.0.0.1. Proxy a endpoints kontrolují lokální Host,
POST stejný Origin, JSON/body size a strict Zod input. Repository browser
předává hash key, žádnou vlastní path. Žádný shell/file browser/status mutation
z klienta. Secret-pattern a server-env credential redakce, bounded plain text,
žádné auth files/raw env/raw result/context JSON, CSP a zakázané framing.
Request-ID gate je procesní, nikoli durable přes restart.

## 13. Přidané testy

12 pure tests: overview counts/read DTO, timeline bez falešných stages,
activity formatter, query filters/pagination/project identity, fake Chief pro
všechny actions + grounding, answer success/failure/duplicate, potvrzené abandon,
provider mapping/cache, Host/Origin/bounded body, idempotency a redakce/formaty,
production fixture guard. `npm test` je zahrnuje.
SQL integrace: skutečná DB, vlastní rows/cleanup, filters/projects/history,
clipping před přenosem, redakce, skipped state a 3000 historical task/run/event
records. Bounded overview/activity/list při posledním měření 27 ms (předchozí
běh 471 ms za souběžného browser/build zatížení); nejde o obecný SLA benchmark.

## 14. Browser QA

Playwright Chromium: Overview, search/filter task table, repaired task detail,
review findings, decision detail, answer/resume, simulované enqueue failure UX,
inline abandon confirmation/cancel, Agents, Projects/detail, Activity a Chief
create/clarification/no_action. Cross-origin POST a hostile Host odmítnuty 403.
Viewporty 1440×900, 1280×800, 1024×768 a 390×844; overflow assertions pro mobilní
Overview/task table/detail, dark mode, žádné browser page exceptions.
Screenshoty byly skutečně otevřené a vizuálně zkontrolované.

Zvlášť proběhl **production** browser render všech šesti hlavních views se
skutečnou DB, health bez inference a startup přes root příkazy. Oddělený server
s úmyslně nedostupným DB endpointem ověřil jeden prominentní database error.
Real task data nebyla browser testy měněna a production queue consumer nebyl
spuštěn. Fixture dev server spouští a ukončuje Playwright sám.

## 15. Screenshoty

V `docs/control-plane/`:

- `overview-desktop.png`, `overview-laptop.png`, `overview-mobile.png`;
- `overview-dark.png`;
- `task-detail-desktop.png`, `task-detail-mobile.png`;
- `decisions-desktop.png`, `agents-desktop.png`.

Jde o full-page captures skutečné implementace v explicitním development
fixture režimu (viditelný banner), nikoli o screenshot soukromých real tasků.

## 16. Production build

`npm run control-plane:build` úspěšně dokončil compile, TypeScript, route
collection a traces. `control-plane:start` skutečně naběhl na loopbacku,
production browser render neměl page exceptions. Root dev launcher byl také
spuštěn a skutečný DB Overview render prošel. Frontend typecheck a ESLint prošly
bez chyby/warning. `npm ci --dry-run` ověřil soulad manifestů a lockfile;
není zde tvrzení, že proběhla druhá čistá instalace.

## 17. Backend regrese

| Příkaz | Výsledek |
| --- | --- |
| `npm run typecheck` | pass |
| `npm test` | pass: 11 Chief, 8 capability-router, 4 OpenCode, 4 repair, 5 reviewer, 12 Control Plane tests; router:test výpisy |
| `npm run db:test` | pass; vlastní dočasný task + cleanup |
| `npm run queue:test` | pass; izolovaná queue, fake executor, persistence/restart/abort/shutdown/rollback |
| `npm run worktree:test` | pass; fake AI, skutečný Git/verifier/OS sandbox, workspace/fallback/cleanup guardy |
| `npm run orchestration:test` | pass, 15 tests; durable lifecycle A–K a answer/resume/abandon transaction |
| `npm run opencode:check` | pass; OpenCode 1.18.33, Qwen local model, available true, JSON |
| `npm run control-plane:db:test` | pass; owned rows + cascade cleanup, 3000 historical records |
| `npm run control-plane:typecheck` | pass |
| `npm run control-plane:lint` | pass |
| `npm run control-plane:build` | pass |
| `npm run control-plane:e2e` | pass, jeden souvislý bounded workflow |

## 18. Inference spotřebovaná testy

**Žádná skutečná Codex, Antigravity, Ollama ani OpenCode/Qwen inference.**
Core testy používají fake adapters/CLI a isolated queues. Codex executable
sloužil pouze OS sandboxu/verifieru, nikoli model invocation. Readiness
používala inventory/help/config/model discovery, žádný prompt nebo download.
Neběžely codex:test, agy:test, executor:test, chief:test ani opencode:test.

## 19. Známá omezení / neověřené

Single local process, bez durable HTTP idempotency přes restart, bez cloud auth
readiness. Consumer se spouští zvlášť a jeho heartbeat UI nezná. Projects jsou
odvozené z cest; nový repository context přidáš existujícím API. Full diff není
v engine persisted, UI používá metadata. Historie/logy mají dokumentované limity.
Skutečné AI vykonání přes web nebylo během QA testováno. Neproběhl deploy,
GitHub integration, project memory, embeddings, schedules ani multi-user auth.

Aktuální `npm audit` hlásí čtyři moderate advisories ve **stávajícím**
Drizzle-kit/esbuild development řetězci. Předchozí locked versions byly zachovány;
force upgrade nebo změna backendových dependencies nebyla součástí milestone.

## 20. Příkazy k použití

Z kořene tohoto worktree/checkoutu, po běžném DB/provider setupu:

```sh
npm ci
npm run control-plane:dev
```

Otevři http://127.0.0.1:3000. Pro skutečné vykonávání v druhém terminálu:

```sh
npm run worker
```

Lokální produkční provoz místo dev:

```sh
npm run control-plane:build
npm run control-plane:start
```

Nebo explicitní prohlídka bez DB/inference:

```sh
npm run control-plane:fixtures
```

[Kompletní provozní dokumentace](control-plane.md) obsahuje všechny routes,
kontrakty, limity, diagnostiku a testovací příkazy.
