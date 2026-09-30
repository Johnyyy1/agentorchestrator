# Pokyny pro LLM agenty

## Dokumentace je součást změny

Při každé změně posuď, zda ovlivňuje instalaci, konfiguraci, veřejné API,
používání, směrování, databázi, testy, omezení nebo provoz projektu. Pokud ano,
**aktualizuj odpovídající dokumentaci ve stejné změně a před jejím dokončením**.
Úkol není hotový, pokud dokumentace neodpovídá výslednému chování kódu.
U čistě interní změny bez dopadu na uživatele dokumentaci neměň jen formálně.

- `README.md`: přehled, rychlý start a odkazy.
- `docs/setup.md`: požadavky, instalace, konfigurace a aktualizace.
- `docs/usage.md`: zadávání úkolů, Chief, výsledky a worktrees.
- `docs/architecture.md`: datový tok, routování, schéma a bezpečnostní hranice.
- `docs/development.md`: struktura, příkazy a ověřování změn.
- `docs/troubleshooting.md`: diagnostika známých problémů.
- `.env.example`: každá přidaná, odebraná nebo změněná proměnná prostředí.
- `examples/`: udržuj spustitelné příklady a JSON vstupy v souladu se schématy.

Dokumentaci piš česky, technické identifikátory ponech v původním jazyce.
Příkazy musí fungovat z kořene čerstvého checkoutu; nepoužívej osobní cesty.
Nevydávej návrh, placeholder nebo výsledek přeskočeného testu za funkční řešení.
Změníš-li skripty, modely, limity či předpoklady, oprav i jejich tabulky a příklady.

## Práce v projektu

TypeScript ESM, Node.js >=22.13, npm a PostgreSQL 16. Importy v TypeScriptu
používají příponu `.js`; skripty spouští `tsx`. Zachovej `package-lock.json`.
Neměň router, sandbox, retry chování ani oprávnění jen proto, aby prošel test.
Nevkládej `.env`, tokeny, přihlašovací data, `.mastra/` ani `node_modules/` do Gitu.

Po změně kódu spusť `npm run typecheck` a `npm test`. Podle dopadu přidej
`npm run db:test`, `npm run queue:test` a `npm run worktree:test` na lokální
vývojové databázi. Integrační testy vytvářejí a uklízejí vlastní data.
`codex:test`, `agy:test` a `executor:test` volají skutečné AI providery;
`chief:test` spouští skutečnou lokální inferenci. Nespouštěj je automaticky
kvůli změně dokumentace. Uveď, co bylo ověřeno a co zůstalo neověřené.

`opencode:test` rovněž volá skutečný lokální model. `opencode:unit` používá
fake CLI a na macOS ověřuje OS sandbox; `capability-router:test` je pure test.
`opencode:check` kontroluje readiness bez inference. U změn capabilities,
recommendation persistence nebo lokálního workeru aktualizuj i routing tabulky,
OpenCode setup a proměnné LOCAL_CODING_*/OPENCODE_BIN v dokumentaci.

Respektuj rozpracované změny uživatele. Úkoly pracující s repozitářem používají
izolované worktrees. Neuklízej cizí či rozpracovanou práci; vynucené odstranění
worktree vyžaduje výslovný požadavek na zahození jeho změn.
