# OpenCode milestone: dokončeno, 30. 9. 2026

Skutečný OpenCode **1.18.33 + ollama/qwen3.5:9b-q4_K_M** úspěšně opravil
TypeScript fixture přes izolovaný worktree a skutečnou durable queue. Čtyři
verifier checks prošly, routing/workspace/result byly uložené v DB, originální
checkout se nezměnil a cleanup prošel. Milestone je dokončený.

1. **Příčina falešného unsupported_cli:** `opencode run --help` píše výstup
   do **stderr**, ale původní kontrola hledala model/agent/JSON pouze v stdout.
   Všechny tři flags byly ve skutečnosti dostupné. Major-version gate navíc
   nahrazoval ověření skutečných schopností domněnkou o schématu.
2. **Skutečné rozhraní:** Homebrew binary
   `/opt/homebrew/Cellar/opencode/1.18.33/bin/opencode`, verze `1.18.33`.
   `run --model ollama/qwen3.5:9b-q4_K_M --agent jonas-local-coding
   --format json --title ... -- <prompt>` funguje non-interactively s ignore stdin.
   `models ollama` model objeví; `debug config` zachová požadované isolated
   provider/agent/permissions/options. JSON a default non-TTY probe s lokálním
   modelem oba vrátily `LOCAL_OPENCODE_OK` bez nástrojů.
3. **Změněné soubory v opravě:** `src/local/opencode.ts`,
   `src/local/opencode-config.ts`, `src/local/opencode-sandbox.ts`,
   `src/local/opencode.test.ts`, `src/workers/opencode.ts`,
   `src/test-opencode.ts`, `README.md`, `docs/opencode.md`, `docs/setup.md`,
   `docs/usage.md`, `docs/architecture.md`, `docs/development.md`,
   `docs/troubleshooting.md` a tento report. Již rozpracované `.env.example`
   zůstalo zachované. Router, Codex/Antigravity adapters, verifier, worktree
   manager, queue failure/retry policy a DB schéma se v této opravě neměnily.
4. **Parsing:** JSONL parser uchovává veřejný `text`, sessionID a whitelisted
   token totals. Úspěch potřebuje exit 0, žádnou process/session chybu a konečný
   `step_finish.reason = stop`; malformed/neúplný stream a timeout selžou.
   Tool payloady a reasoning eventy se nevracejí. Text fallback je omezený na
   neprázdný veřejný non-TTY stdout do 64 kB, exit 0 a žádný timeout; sessionId
   a usage jsou null. Formát se zvolí před invocation; JSON chyba nezpůsobí
   nový běh ani přechod na text. Verifier zůstává povinný pro oba formáty.
5. **JSON:** Ano, skutečná CLI používá `--format json`. Readiness čte option
   tokens z obou help streamů a kontroluje skutečný resolved config. `--agent`
   není povinný, protože `default_agent` musí prokazatelně vybrat stejný
   restrictive agent. `--title` je také volitelný. Major verze sama neblokuje
   kompatibilní interface; nezachovaný security config zůstává unsupported.
6. **opencode:check:** PASS, `available: true`, `version: 1.18.33`,
   `model: qwen3.5:9b-q4_K_M`, `outputFormat: json`, `error: null`.
   Readiness nemá inferenci/download. Nově zkouší i start CLI v OS sandboxu.
   Bun/ICU jinak skončil SIGTRAP již při `--version`; úzká read-only výjimka
   pro systémové `/private/var/db/timezone` řeší startup. Zápisy zůstávají
   pouze ve worktree/runtime, source/symlink/.git writes a externí síť zakázané.
7. **Real fixture:** PASS. Qwen změnil jen `add.ts` z `a - b` na `a + b`,
   worker vrátil success/exit 0/public message/session ID/token totals.
   První úspěšný queue běh trval přibližně 77 sekund včetně verifieru,
   session `ses_f0be39114ffeXIQfdBYNaAegWe`. Druhý běh také prošel (přibližně
   87 sekund, session `ses_f0bdefb74ffeVkt4pkL6nAoGxO`), včetně explicitní
   kontroly odstranění queue a task/run rows. test/typecheck/lint/build prošly.
   `runs.routing` a `runs.workspace` se zkontrolovaly v DB ještě před inferencí;
   po completion se zkontroloval uložený result i queue state. Source bytes,
   HEAD a clean status se nezměnily. Vlastní queue, task/run rows, worktree,
   fixture repository s větví a isolated runtime byly uklizené. Cleanup se
   pokusí odstranit všechny vlastní prostředky i při dílčí chybě a chyby hlásí.
8. **Regrese:** PASS: `typecheck`, `npm test` (11 Chief/Ollama + 8 capability
   router + 4 OpenCode unit testy a router examples), `db:test`, `queue:test`,
   `worktree:test`, `chief:test`, `opencode:check` a `opencode:test`.
   Chief skutečně vrátil create_task a ask_human; unikátní queue s persistovaným
   recommendation neměla execution consumer. Sedm fake integration scénářů
   zůstalo funkčních: Codex success/verification failure; OpenCode success,
   verification failure, returned failure a thrown failure after edit;
   unavailable-local fallback na fake Codex. OS test znovu prokázal odmítnutí
   source read/write, symlink escape a `.git` write. Nové testy pokrývají
   stderr help, text fallback, compatible newer version a odmítnutý config/MCP.
9. **Cloud kvóta:** Žádná Codex ani Antigravity inference. Jen lokální
   OpenCode/Qwen a Chief/Qwen. `codex sandbox` sloužil jako lokální OS launcher
   deterministických checks. `codex:test`, `agy:test` a `executor:test` nebyly
   spuštěné. Jonas OS nebyl commitnutý, pushnutý, mergovaný ani nasazený;
   nevzniklo PR. Baseline commits existovaly pouze v disposable fixture repos.
10. **Blocker:** Žádný pro tuto CLI/model/macOS kombinaci. Další platformy
    nebo odlišné CLI musí projít readiness a vlastním smoke. Resolved config
    zachoval resource settings; účinnost každého provider option nebyla
    samostatně měřená. To neblokuje ověřenou izolovanou lokální execution.
