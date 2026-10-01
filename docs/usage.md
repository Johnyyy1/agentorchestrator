# Používání

## Životní cyklus

1. Připrav `TaskSpec` nebo získej návrh přes Chief.
2. `createTask()` uloží task do PostgreSQL a do fronty pošle jen UUID.
3. Worker načte task, určí providera a založí záznam `runs`.
4. Provider vykoná úkol; repository coding vytvoří worktree a ověří ho.
5. Task/run skončí `completed` nebo `failed`, výsledek zůstane v DB.

Spusť `npm run worker`. Úkol lze zařadit i bez consumeru, zůstane `queued`.
Lokální UI spustíš `npm run control-plane:dev` na 127.0.0.1:3000.
Overview deleguje cíl přes Chief, Tasks ukazuje lifecycle a Decisions umožňuje
answer/resume nebo potvrzované abandon waiting_human tasku. Obecný rerun či
rušení běžícího workeru nejsou podporované. [Control Plane](control-plane.md).

## Přímé zadání

```sh
npx tsx examples/create-task.ts examples/tasks/read-only.json
```

Příklad čte JSON, validuje ho aplikačním Zod schématem, odešle task a uzavře
DB/frontové spojení. Vlastní JSON může ležet mimo repo. API snippet lze uložit
do `.ts` souboru v kořeni a spustit `npx tsx <soubor.ts>`:

```ts
import { createTask } from "./src/tasks/create-task.js";
import { boss } from "./src/queue/boss.js";
import { pool } from "./src/db/index.js";

try {
  const task = await createTask({
    title: "Plán testování",
    objective: "Navrhni pět kroků testování malé TypeScript knihovny.",
    category: "planning",
    difficulty: 2,
    risk: "low",
    context: ["Používáme npm a node:test. Pouze navrhni plán."],
    acceptanceCriteria: ["Každý krok má konkrétní ověřitelný výsledek."],
    maxAttempts: 1,
  });
  console.log(task.id);
} finally {
  try { await boss.stop({ graceful: true }); }
  finally { await pool.end(); }
}
```

Planning používá skutečné `agy`. Příklady v `examples/` už mají správné
relativní importy a jsou zahrnuté v TypeScript kontrole.

### TaskSpec

| Pole | Povinné | Hodnota |
| --- | --- | --- |
| `title`, `objective` | Ano | Neprázdný string |
| `category` | Ano | coding, research, planning, review, utility |
| `difficulty` | Ano | Celé číslo 1–5 |
| `risk` | Ano | low, medium, high |
| `context` | Ano | Pole stringů, může být prázdné |
| `acceptanceCriteria` | Ano | Pole stringů, přímé API dovoluje prázdné |
| `maxAttempts` | Ano | Integer >=1; repository pokusy omezuje také globální cap 1–3 |
| `repository` | Ne | Objekt `path` + volitelné `baseBranch` |

Acceptance criteria se přidávají do promptu, nejsou automaticky vyhodnoceným
testem. Prázdná kritéria nahradí obecná instrukce dokončit cíl správně.

### Category fallback router

| Podmínka (v pořadí) | Worker |
| --- | --- |
| `category === "coding"` | Codex bez ohledu na risk/difficulty |
| Ostatní, difficulty >=4 nebo risk high | Antigravity pro |
| Ostatní | Antigravity flash |

Modely tierů určuje `AGY_PRO_MODEL`/`AGY_FLASH_MODEL`, jinak CLI default.
Tato tabulka je výchozí route bez doporučení Chief. Pro změny souborů použij coding
s `repository`.

Chief recommendation nebo třetí argument `createTask(spec, queueName,
{ capability, workerBrief })` rozšiřuje route podle pravidel:

| Capability | Výsledná politika |
| --- | --- |
| local-coding | OpenCode jen pro coding s repository, risk !=high, difficulty <= LOCAL_CODING_MAX_DIFFICULTY a úspěšnou readiness; jinak Codex |
| strong-coding | Coding zůstává na Codexu |
| strong-general | Non-coding na Antigravity pro |
| research | Non-coding na Antigravity s tierem podle původní náročnosti |
| local-utility, independent-review | Samostatná capability route zachovává category fallback; coding má následné nezávislé review |
| Capability neslučitelná s kategorií | Kategorie má přednost |

Přímý JSON příklad doporučení nepředává a dál používá původní route.
Readiness fallback OpenCode → Codex probíhá pouze před vykonáváním. Po chybě
lokálního workeru či verifikace může Chief navrhnout nový repair pokus ve
stejném worktree, včetně strong-coding přes Codex. Doporučení neuděluje sandbox výjimky.

## Změny repozitáře

Task JSON obsahující všechna povinná pole rozšiř o:

```json
{
  "repository": {
    "path": "/absolute/path/to/target-repository",
    "baseBranch": "main"
  }
}
```

Toto je fragment, ne samostatný task. Vynechaná větev znamená lokální `main`.
Zdrojový checkout musí být čistý včetně neignorovaných untracked souborů,
cesta musí být absolutní Git root, lokální větev musí existovat s commitem.
`origin/main` není lokální base branch. Repozitáře s externími Git
clean/smudge/process filtry (např. konfigurací LFS) manager odmítá.

Úkol dostane branch `jonas-os/task-<UUID>` a worktree
`~/.jonas-os/worktrees/<UUID>`; root mění `JONAS_OS_WORKTREE_DIR`. Existující
větev/cesta se nepřepisuje. Worktree se vytvoří před readiness/routováním
a používá ho vybraný coding worker. Bez `repository` běží Codex read-only v cwd
consumeru, obvykle kořeni Jonas OS.

Nový worktree nemá ignorované soubory z originálního checkoutu, zejména
`node_modules` a `.env`. Dependencies se automaticky neinstalují a worker
po vytvoření worktree nečeká na ruční setup. Pro první pokus zvol projekt
se samostatnými testy bez instalace (např. čisté `node --test`). Složitější
projekty potřebují vlastní explicitní provisioning/integraci.

Verifier spouští existující `test`, `typecheck`, `lint`, `build` v tomto
pořadí přes npm/pnpm/yarn v lokálním Codex OS sandboxu; každý má limit
60 sekund a zakázanou síť. Placeholder `test` s exit 1 způsobí failure.
Chybějící skripty jsou `skipped`; pokud chybí všechny nebo `package.json`,
může být aggregate success i se všemi skips. To není důkaz otestování.

## Chief

Po [setupu Ollama](setup.md#volitelný-lokální-chief):

```sh
npx tsx examples/plan-goal.ts examples/goals/planning.json
```

Bez flagu proběhne jen lokální inference a výpis návrhu; nic se nezařadí.
Uprav goal JSON pro vlastní cíl. Pro přímé odeslání nového návrhu:

```sh
npx tsx examples/plan-goal.ts examples/goals/planning.json --submit
```

`--submit` odešle rozhodnutí této **nové inference**, ne dříve vypsaný návrh.
Chceš-li nejprve zkontrolovat konkrétní návrh a pak odeslat přesně ten, použij
API a ponech si stejný objekt `decision`:

```ts
import { planGoal } from "./src/chief/chief.js";
import { submitDecision } from "./src/chief/submit-decision.js";

const decision = await planGoal({
  userGoal: "Přidej čistou clamp funkci a node:test testy.",
  project: {
    name: "Můj projekt",
    repositoryPath: "/absolute/path/to/target-repository",
    baseBranch: "main",
    summary: "TypeScript ESM. Malá změna bez nových závislostí.",
  },
});
console.log(decision);
// Caller zde rozhodne, zda tento konkrétní návrh přijmout.
try {
  const result = await submitDecision(decision);
  console.log(result);
} finally {
  if (decision.action === "create_task") {
    const { boss } = await import("./src/queue/boss.js");
    const { pool } = await import("./src/db/index.js");
    try { await boss.stop({ graceful: true }); }
    finally { await pool.end(); }
  }
}
```

### Vstup a výstup

Povinný `userGoal`: 1–4000 znaků. Volitelný `project`: name, absolutní
repositoryPath, baseBranch, summary, roadmapExcerpt. Volitelný `recentState`:
completedTasks, failedTasks, openTasks, decisions (každé max. 10 stringů po
max. 1000 znacích). Serializovaný vstup má limit 16000 znaků. Chief sám
nečte soubory, roadmapu, DB ani historii; kontext dodáváš explicitně.

| action | Návrh | Účinek submitDecision |
| --- | --- | --- |
| create_task | summary, reason, capability, task, workerBrief | Validuje a zavolá createTask; vrátí task + capability + brief |
| ask_human | summary, reason, humanQuestion | Vrátí otázku; nic nezapisuje ani neposílá lidem |
| no_action | summary, reason | Nic nezapisuje |

Chief navíc vyžaduje neprázdná kritéria a maxAttempts <=3. Repo cesta a
explicitní větev musí pocházet ze vstupu. Capabilities jsou local-utility,
local-coding, strong-coding, strong-general, research, independent-review.
Jsou **doporučením pro capability router**: ukládají se do `tasks.chief`
odděleně od TaskSpec a brief se předává workeru jako task data. Pevná execution
pravidla mají přednost. Chief nemůže určit konkrétní provider nebo model.

## Výsledky

```sh
npx tsx examples/inspect-task.ts <task-UUID>
```

Výpis obsahuje task a runs od nejnovějšího. Stavy: pending (uložen, nezařazen),
queued, running, repairing, reviewing, waiting_human, completed, failed. Pending po queue failure je zachovaný
pro diagnostiku. Task nemá vlastní `error`; čti runs[].error a worker log.

Repository run má workspace metadata uložená před startem coding workeru. `runs.routing` zaznamenává capability, selected worker, fallback reason a model. Result
obsahuje workerResult, verification.checks (exit code, stdout/stderr,
trvání, timeout/skips), git.statusShort, changedFiles, diffStat, dirty,
truncated a případné error. `runs.routing` a `result.routing` obsahují
requestedCapability, selectedWorker, fallbackReason, model a reason.
Completion repository tasku vyžaduje úspěch coding workeru, všech
objevených checks a nezávislé review approve. Run completed značí pouze úspěšný pokus. Výpisy jsou omezené; diff stat neobsahuje untracked obsah.

Worktree zůstává po úspěchu i failure. Inspectuj ho:

```sh
git -C /absolute/path/from/run/workspace status --short
git -C /absolute/path/from/run/workspace diff
```

Po vlastní kontrole můžeš změny ručně commitnout/začlenit. Jonas OS sám
necommitne, nemerguje, nepushuje ani nenasazuje.

## Úklid

Načti skutečné `run.workspace` z DB a předej ho `removeTaskWorktree()`:

```ts
import { removeTaskWorktree } from "./src/git/worktree.js";
await removeTaskWorktree(workspace); // skutečné metadata z run.workspace
```

Default odstraňuje čistý worktree. `{ force: true }` explicitně zahodí
necommitnuté změny. Funkce validuje UUID, root, cestu, větev a Git registraci,
odmítá symlink i originální checkout. Větev ponechá. Úklid není automatický.

## Explicitní doporučení bez Chief inference

API dovoluje `createTask(spec, undefined, { capability: "local-coding",
workerBrief: "Malá izolovaná změna; zachovej testy." })`. TaskSpec zůstává
beze změny; nepřidávej concrete provider do Chief decision. Caller odpovídá
za správný `repository` context. [Failure policy a výsledky OpenCode](opencode.md#fallback-a-metadata).

Diagnostika `npm run opencode:check` vrací také `outputFormat`. OpenCode 1.18.33
používá JSONL: result má veřejnou zprávu, sessionId a token totals. Pokud
kompatibilní CLI JSON nenabízí, omezený text fallback ponechá sessionId/usage
null; repository completion navíc vyžaduje nezávislé review.

## Opravy a čekání na člověka

`maxAttempts=2` znamená implementaci + jednu opravu. Globální
`JONAS_OS_MAX_ATTEMPTS` (default 3, rozmezí 1–3) je tvrdý cap. Každý pokus
má vlastní run; worktree zůstává stejný, i když oprava přejde OpenCode → Codex.
Review findings se nejprve předají lokálnímu Chief a nezvyšují počet pokusů.

OpenCode hodnotí Antigravity nebo při nedostupné readiness Codex. Codex hodnotí
jen Antigravity. Review je read-only a při chybě nebo neúplném snapshotu se
neopakuje. `waiting_human` je durable stop bez spotřeby další kvóty.

```sh
npm run escalations:list
npm run escalation:answer -- <escalation-UUID> "Upřesnění kritérií a hranic změny."
npm run task:abandon -- <task-UUID>
```

Answer potvrdí resolved a queued; existující task se vrátí do své fronty.
Odpověď je kontext pro Chief, nikoli příkaz. Worktree a run/review historie
zůstanou. Při vyčerpaném capu nevznikne další pokus ani po odpovědi.
Inspect výpis nyní obsahuje i reviews, escalations, audit events a checkpoint.
Před resuming přerušené invocation ověř, že původní provider už neběží.
[Celý lifecycle, schema a limity](repair-loop.md).
