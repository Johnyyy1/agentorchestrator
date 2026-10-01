# OpenCode nástroje: skutečný runtime kontext a bezpečná diagnostika

Ověřování 1. 10. 2026 navazuje na čistý `codex/verifier-loopback` commit
`6580816e`. Verifier kód/profile ani router eligibility/attempt cap se nemění.
Implementace je v izolované větvi `codex/opencode-tool-reliability`.

## Co lze a nelze přesně prokázat

Historický task `fd74d994-f43f-42d8-9fb8-8bfab600c77b` obsahoval read error,
dvě glob error a glob completed, ale žádné veřejné tool error zprávy/argumenty.
Tyto jednotlivé chyby nelze zpětně přesně vysvětlit. Report nevydává odhad
permission/path/schema chyby za zjištěný fakt. V nových přímých testech původního
modelu read/glob/write/read fungovaly; chyba oprávnění se nereprodukovala.

**Prokázaná chyba konfigurace/runtime:** OpenCode resolved config tvrdil context
16384 a provider/model `num_ctx=16384`, ale skutečný `/v1/chat/completions`
požadavek obsahoval `max_tokens=4096`, `think=false`, žádný `num_ctx/options`.
Ollama běžela s `n_ctx_slot=4096`. Také log historického tasku dokládá poslední
prompt 4017 tokenů a release `n_tokens=4095, truncated=1`. Toto je přímý důkaz
truncation původního neúplného execution, nikoli důkaz příčin předchozích tools.

Přímá reprodukce se snapshotem původního repository commitu `2d0694e3` a přesným
historickým TaskSpec/worker briefem skončila `write completed → read completed →
glob completed → length`, exit 0, success false. Poslední prompt měl 3947 tokenů,
release 4095/truncated=1. Soubor vznikl; incomplete přesto zůstal failure.
Druhá diagnostická reprodukce s pasivním loopback HTTP pozorováním prošla
write → stop, ale neprokázala inspect-first. Ukládaly se pouze numeric/model/request
options a veřejné finish reasons, nikdy text messages ani raw stream.

[Oficiální Ollama dokumentace](https://docs.ollama.com/api/openai-compatibility#setting-the-local-context-size)
potvrzuje, že OpenAI-compatible API neumí nastavit runtime context size; doporučuje
modelový alias s `PARAMETER num_ctx`. Původní root/source cesta v briefu byla
prověřovaná hypotéza, nikoli prokázaná root cause, a nebyl kvůli ní uvolněn sandbox.

## Nejmenší oprava prokázaného runtime předpokladu

`examples/opencode.Modelfile` vytvoří lokální alias
`qwen3.5:9b-q4_K_M-jonas-16k` ze stejných existujících Qwen vah a explicitním
`num_ctx=16384`. Základní model se nepřepisuje, žádné váhy se nestahují.
`.env.example` doporučuje alias; actual fallback `LOCAL_CHIEF_MODEL`/base model
v `getOpenCodeConfig()` zůstává, ale musí splnit model-level readiness.

Readiness i adaptér před inferencí ověřují `/api/show.parameters.num_ctx ==
LOCAL_CODING_CONTEXT`. Chybějící/odlišný údaj je infrastructure/context_mismatch.
Nepoužívané provider/model `num_ctx` options jsou odstraněné; CLI context/output
limits zůstávají 16384/4096 a agent má pořád max. 12 kroků. `/api/ps` po opravené
fixture skutečně ukázalo model alias s context_length 16384; server slot také 16384.

Preflight kontroluje supplied/canonical cwd, expected worktree, Git root/branch,
writable status. Ve stejném Seatbelt profilu čte `.git` a provede vlastní exclusive
temp write/read/delete uvnitř worktree. Nevalidní cwd se odmítne před CLI/inferencí.
Public log/result obsahuje pouze cesty a booleany. Worker OS profil se nemění.

## Skutečná effective config a hranice

Byly spuštěny skutečné OpenCode 1.18.33 `debug config` a `debug agent
jonas-local-coding` s přesným izolovaným HOME/XDG/env. Bez inference.
[Relevantní effective config](opencode-effective-config.json) obsahuje pouze
Jonas-owned generované hodnoty; [celý effective permission list a tools](opencode-effective-agent.json)
zachovává pořadí včetně vestavěných defaults a overrides, jen náhodný vlastní
runtime prefix je nahrazen `<runtime>`. Není zde uživatelův auth/global config.

| Oblast | Skutečné účinné nastavení |
| --- | --- |
| Agent | `jonas-local-coding`, primary; explicitní --agent i default_agent; není build |
| Providers/model | pouze ollama, alias stejných Qwen vah, loopback `/v1`, think false |
| read | allow `*`, deny `*.env`, `*.env.*`; OS čte jen worktree/runtime/systém/Git metadata |
| glob/grep/list | allow; system PATH rg je dostupný; reálný glob funguje |
| edit/write | edit allow `*`; deny `*.git*`, `*.opencode*`, `*opencode.json*`; write tool používá edit permission |
| bash/process tool | bash false/deny; OS dovoluje potřebné procesy CLI/search, agent nemá shell |
| external_directory | deny `*`; CLI přidává poslední allow pouze pro vlastní `<runtime>/data/opencode/tool-output/*` |
| network tools | webfetch/websearch/codesearch deny; OS outbound pouze loopback port Ollama |
| Další | task/skill/question/LSP deny; formatter false, mcp {}, plugin [], sharing disabled, snapshots false |
| HOME/config | disposable HOME/XDG/tmp; project/global plugins/config/Claude/external skills disabled; bez credentials env |

OS regrese reálně odmítá external read/write, symlink escape a `.git` write.
Original checkout se nepoužívá jako pracovní cwd a jeho obsah nelze takto přepsat.
Není přidané právo push/merge/deploy ani unrestricted filesystem/network fallback.

## Diagnostika, incomplete a retry

Nejvýše 32 toolDiagnostics: eventType, tool, status, rozpoznaná veřejná category,
errno code, code-owned bounded message, bezpečná relativní repo cesta nebo pathScope
bez externí cesty. Event counts jsou bounded 16 typy, terminalReasons 32 záznamy.
Neznámý error detail se vynechá. Žádný tool content/input/output payload, reasoning,
auth, secrets či raw JSONL se nově nepersistuje. Chybová zpráva je nejvýše 500 znaků
s actual step reason a poslední rozpoznanou tool chybou, bez tvrzení o kauzalitě.

Exit 0/changed files nikdy nepřebijí explicitní incomplete/error/length.
Known workspace/runtime/config/model-context preflight a explicitní ripgrep
initialization/execution failure → infrastructure → waiting_human, zachovaný
worktree, žádný repair Chief/coding worker/review ani při redelivery/human answer.
Readiness configuration/unsupported_cli/sandbox_unavailable/context_mismatch se
zastaví v executor pipeline před cloud fallbackem; pure router policy je zachovaná.
ENOENT souboru, invalid arguments, external path/policy denial či samotný length
zůstávají execution, bez neprokázané infrastructure klasifikace; stávající repair
flow a skutečné attempt capy zůstávají.

## Přímé fixture výsledky

Přímý adaptér nemá DB/queue/orchestration/verifier/reviewer.

| Volání | Výsledek |
| --- | --- |
| Původní model, malý inspect/create fixture | Adapter success true, read/read/write/stop, pouze docs/smoke.md; první harness assertion chybně vyžadovala newline a byla opravena, soubor obsahoval přesné `smoke` |
| Původní A read package.json | PASS, read completed |
| Původní B glob src TypeScript | PASS, glob completed |
| Původní C create smoke | PASS, write completed |
| Původní D read smoke | PASS, read completed |
| Přesný historický prompt/snapshot | FAIL incomplete length s výše doloženou runtime truncation |
| Druhý historický prompt/snapshot + metadata proxy | execution success, write/stop, inspect-first neprokázáno |
| Opravený alias, povinná inspect/create fixture | PASS, read/read/write/stop, success true, pouze docs/smoke.md, source čistý, context 16384 |

Bezpečné fixture reports jsou zachované pod vlastními `jo-opencode-tools-*` a
`jo-brief-repro-*` temp adresáři; žádný historický task/worktree se nepřepisoval.
Opravená povinná fixture: `jo-opencode-tools-vluir1/report.json`, task-worktree
`1b41bc24-7426-4827-bc9f-2d33e1bc7919`, nikoli orchestration task.

## Regrese bez skutečné AI

Typecheck a npm test PASS (65 node:test testů plus router example skript).
`opencode:unit` PASS, 11 testů včetně skutečného OS boundary a context mismatch
před inferencí. `orchestration:test` PASS, 21 testů včetně parent; local readiness
context mismatch nevolá žádný local/cloud worker, infrastructure po workeru
nevolá repair/review a neopakuje se po redelivery/human answer.
`db:test`, `queue:test`, `worktree:test` PASS na lokální vývojové DB, vlastní data
uklizena. Fake AI/CLI v těchto kontrolách nevolaly cloud ani Ollama generaci.
Package lock je zachovaný, žádná DB/schema migrace. Verifier nemá změny.

Také všechny čtyři samostatné primitives s opraveným aliasem PASS: read package.json,
glob (čtyři completed glob + completed read src), write docs/smoke.md a následný
read. Všechny invocations success true a stop, source čistý, jediný zamýšlený soubor.
Evidence: `jo-opencode-tools-VFc5zz/report.json`. Vícekrokový glob zůstává modelovou
volbou, timeout/krokový cap se nezvětšuje. Regrese navíc kontroluje, že zotavená
search executable chyba nepřeklasifikuje pozdější model truncation na infrastructure,
i když success event nastane až za limitem persistovaných diagnostics.
