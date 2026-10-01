# Skutečný E2E smoke po opravě TaskSpec

Dne 1. 10. 2026 proběhl **jeden skutečně vytvořený task a jeden coding pokus**.
Výsledek je **waiting_human**, nikoli completed. Routing a izolace fungovaly;
worker report a úspěšná deterministická verifikace chyběly, takže dokončení
bylo bezpečně odmítnuto. Neproběhl další task, worker retry ani review inference.

## Git a zachování uživatelské práce

Původní main byl 998b9e524c46af3fe942d2ee231c735d963ada83. Jedinou jeho
rozpracovanou změnou byl AGENTS.md. Git status a diff byly zaznamenány;
bezpečnostní patch je `/tmp/jonas-os-agents-before-smoke.patch` a byte kopie
`/tmp/jonas-os-agents-before-smoke.original`. Pouze AGENTS.md byl stashnut jako
`jonas-os-e2e-temporary-agents` (stash SHA
f73719ce7e798df9c6563a12d4139c3f001e74a3).

Oprava se začlenila přes bezpečný fast-forward. **Final main SHA i base commit
skutečného smoke: 3898426b9ae85c32c1704cf901ce0ce9859d3594.** Před taskem byl
checkout čistý. Po celé execution byl stále čistý a HEAD stejný; žádný smoke
soubor v main nevznikl. Dependencies byly před workerem explicitně zkopírovány
do ignorovaného node_modules v task worktree se zachováním relativních symlinků.

Po ukončení tasku a vlastního consumeru byl stash aplikován. `cmp` původního
a obnoveného AGENTS.md, `cmp` původního a obnoveného binary Git diff patche
a `cmp` původního a konečného porcelain status všechny prošly. AGENTS.md
SHA-256: `cb7f056226669cf21c040d7c2d8f14f70c51dbb3ae191b4458dac4de0b49ca60`;
patch SHA-256: `eab08f5ba2b1f45179a2a0e82b1fc88d606ba75dcaf71665c04c8d5a9ba0b17d`.
Stash byl odstraněn až po přesném ověření. Source checkout má pouze původní
` M AGENTS.md`. Žádný reset, force, clean ani odstranění worktree se nepoužilo.

## Chief a execution

Přesný userGoal:

> Add docs/jonas-os-e2e-smoke.md with a short explanation that it was created by the Jonas OS end-to-end smoke test. Inspect the repository first. Do not modify unrelated files.

První Chief inference vracela ask_human: vlastní absenci nástrojů zaměnila za
překážku delegace repository inspekce. Nevznikl task ani worker pokus. Po
předání již uděleného uživatelského povolení a skutečně ověřeného source stavu
jako caller context druhá Chief inference vytvořila jediný task; userGoal se
nezměnil a žádný Chief výstup nebyl ručně přepsán na create_task.

| Položka | Skutečnost |
| --- | --- |
| Task ID | f369d317-2ae9-48dc-b206-a76b348d179a |
| Chief category/capability | coding / local-coding |
| Difficulty/risk/maxAttempts | 1 / low / 1 |
| Worker/model | opencode / ollama/qwen3.5:9b-q4_K_M |
| Fallback | Žádný |
| Run ID | 6746e6ab-3026-4bbc-91d1-2028990a35dd |
| Branch | jonas-os/task-f369d317-2ae9-48dc-b206-a76b348d179a |
| Isolated worktree | /Users/jonas/.jonas-os/worktrees/f369d317-2ae9-48dc-b206-a76b348d179a |
| Changed files | Pouze docs/jonas-os-e2e-smoke.md |
| OpenCode session | ses_f0919b1d6ffeCJDzQ77ebLnl85 |
| Worker exit / public report | Exit 0, zachycený message null, success false |
| Final task state | waiting_human; vlastní queue job completed není task verdict |
| Eskalace | max_attempts, Worker budget exhausted. |

Cílový soubor existuje pouze v uchovaném task worktree. Obsah:

```md
# Jonas OS End-to-End Smoke Test Marker

This file was automatically created by the Jonas OS end-to-end smoke test to verify repository accessibility.
```

## Verifier a independent review

Verifier skutečně spustil standardní checks v nezměněném OS sandboxu:

| Check | Výsledek | Exit / čas |
| --- | --- | --- |
| npm run test | FAIL | 1 / 646 ms |
| npm run typecheck | PASS | 0 / 2451 ms |
| lint | SKIPPED: root skript není definován | Neběžel |
| build | SKIPPED: root skript není definován | Neběžel |

Test selhal ještě při startu tsx: `listen EINVAL` při vytvoření IPC Unix
socketu pod dlouhou `.jonas-os-verify-…/tsx-501/81224.pipe` cestou. Celá cesta
měla 112 bajtů; lokální macOS SDK `sys/un.h` deklaruje `sun_path[104]`.
Jde o konkrétní překážku verifier runtime, nikoli neúspěšnou test assertion.
Sandbox a testy se kvůli ní neměnily ani nepřeskakovaly. Typecheck proběhl.

OpenCode zároveň nezachytil finální public text: exit 0 a token usage byly
zaznamenány, message zůstal null, adapter proto vrátil
`OpenCode did not complete successfully.` Bez uchovaného raw streamu nelze
určit, zda model skončil bez textu, nebo CLI envelope neposkytl text ve tvaru,
který parser zpracovává. Výsledek se nezměnil na success jen podle vytvořeného
souboru či exit code.

**Reviewer/provider/verdict: žádný — review nebylo spuštěno.** Verifier a
worker neměly úspěch, attempt budget byl 1, completion invariant nepustil
completed. Žádný druhý coding pokus ani Codex fallback nebyl vyvolán.

## Final Result a skutečný Control Plane

[Lokální persisted task](http://127.0.0.1:3000/tasks/f369d317-2ae9-48dc-b206-a76b348d179a)
byl načten přes produkční getTaskDetail/taskOutcome i živý browser bez fixtures.
Oba zobrazují waiting_human, zachovaný workspace, jeden změněný soubor,
test FAIL, typecheck PASS, explicitní lint/build skips a žádné review.
Worker report chybí: UI správně říká „No final worker summary was captured.“
Nejde o naplněný úspěšný Final Result; žádná chybějící data nebyla fabricována.
Screenshot je uchován lokálně v `/tmp/jonas-os-real-e2e-control-plane.png`.

Raw výsledek, DB read model a kontrolní SHA/status jsou v
`/tmp/jonas-os-real-e2e.json`; průběh je v `/tmp/jonas-os-real-e2e.log`.

## Skutečná inference volání

Wrapper počítadla: Chief 2, OpenCode CLI session 1, repair Chief 0,
Antigravity review 0, Codex worker/reviewer 0. Ollama server log v časovém
okně 11:55:56–11:58:56 Europe/Prague potvrzuje **5 skutečných Qwen API
inference požadavků**: dva POST /api/chat (Chief) a tři POST
/v1/chat/completions (jediná OpenCode session). Log výpis je uložen v
`/tmp/jonas-os-smoke-ollama-requests.log`.

**Qwen 5; Antigravity 0; Codex inference 0.** Codex CLI pouze spouštěl lokální
OS sandbox verifieru. Readiness kontroly nebyly inference. Cloud approval a
úspěšný completed lifecycle zůstávají neověřené; tento smoke se neoznačuje za PASS.
