# Investigation Docs

Working notes for the product-engineer challenge: a NestJS + PostgreSQL + Redis
e-commerce API shipped with deliberately planted defects.

Per `INSTRUCTIONS.md` the goal is to **find and fix root causes** — not to add
features or redesign the system. These docs are the analysis that precedes the
fixes, so that every code change lands with a stated cause and a way to verify it.

## Contents

| Doc | What's in it |
|---|---|
| **[04 — Scope](04-scope.md)** | **Start here.** What we're fixing, what we're deliberately not, and the test used to decide |
| [01 — Defect Analysis](01-defect-analysis.md) | All 27 confirmed defects: root cause, failure scenario, evidence, proposed fix |
| [02 — Remediation Plan](02-remediation-plan.md) | The order to fix them in, and why that order is forced |
| [03 — Open Questions](03-open-questions.md) | Decisions needed from a product/infra owner before some fixes can land |
| **[05 — Reproduction Runbook](05-reproduction.md)** | Copy-paste commands to watch each defect fail, with real captured output |

> **The analysis found more than the assignment asks for.** 27 defects are real; 19
> of them cause a reported symptom, and land as 6 commits. [04 — Scope](04-scope.md) draws that line and
> justifies both sides of it. Read it before reading the defect list, or the list
> reads as a code review rather than an answer to `INSTRUCTIONS.md`.

## Scoreboard

| Severity | Count |
|---|---|
| 🔴 Critical | 7 |
| 🟠 High | 8 |
| 🟡 Medium | 10 |
| ⚪ Low | 2 |
| **Total** | **27** |

Grouped into 6 themes:

- **Cache correctness & wiring** (4) — The Redis cache is never actually connected — @nestjs/cache-manager 3.x reads `options.stores` (plural) and app.module.ts:33 passes `store` (singular), so cache-manager 7 falls back to a per-process in-memory Keyv while an orphaned ioredis socket stays open. On top of that broken foundation sit a constant cache key that collides across all search terms, zero invalidation on any product write, and a hardcoded `db: 0` that ignores REDIS_DB=1. This theme is the origin of the 'cache behavior does not match expectations' symptom and is the ordering constraint for the whole fix plan.
- **Transactional integrity & concurrency** (5) — Every multi-write flow in the orders module runs as a sequence of independently auto-committed statements with no transaction, no row lock and no conditional UPDATE. Order creation writes the parent row before validating any line item; the stock decrement is a floating promise that writes an absolute value derived from a stale read; cancel() and processPayment both check state and then act on it across an unprotected window. Together these produce orphaned orders, oversold inventory, phantom stock and double charges — the whole 'data is sometimes inconsistent or missing' symptom.
- **Input validation & mass assignment** (7) — The global ValidationPipe is constructed with `transform: true` but neither `whitelist` nor `forbidNonWhitelisted`, so class-transformer copies every body property onto the DTO and TypeORM's `repository.create()` maps any of them that happen to be columns — including the primary key, which turns POST into a silent UPDATE. Around that hole sit endpoints that bypass validation entirely (an inline structural body type, a bare `@Body('status')`) and DTOs too loose for their columns (empty items arrays, fractional integers, unchecked foreign keys).
- **Error handling & diagnosability** (6) — Non-HttpException failures are allowed to escape to Nest's default filter as bare 500s (circular JSON, TypeError on an unloaded relation, FK violations, unique-constraint violations, driver type errors), while the two places that DO catch errors destroy them: the batch loop logs a constant id-less string and still returns `success: true`, and the outer catch rewrites any cause into `BadRequestException('Batch processing failed')`. Both halves produce the 'vague or misleading error messages' symptom from opposite directions.
- **Unbounded & wasted work** (6) — Several endpoints do work proportional to the whole table or to an arbitrary retry budget rather than to the request: a 1000-iteration payment retry loop with a flat 100ms sleep, a search that SELECTs every product and filters in JavaScript, collection endpoints with no pagination hydrating a five-table eager graph, an uncapped batch of serial round-trips, and a category-tree path that joins in every product only to discard them. This is the entire 'extremely slow or never complete' symptom.
- **Schema & type fidelity** (1) — The entity declarations do not match what the driver actually returns or accepts. All three money columns are `decimal` typed as `number` with no transformer, so pg hands back strings and the same field has one JSON type on create (in-memory entity) and another on read (from DB) — the `Number(order.total)` cast at orders.service.ts:110 is the codebase's own admission of the mismatch.

## Symptom → cause map

The challenge reports five user-visible symptoms. Every one maps to at least one
confirmed defect:

### "Some requests are extremely slow or never complete"

- [D11](01-defect-analysis.md#d11) Payment retry loop: maxRetries = 1000 with flat delay and a non-HttpException rethrow
- [D12](01-defect-analysis.md#d12) searchProducts loads the whole products table and filters in Node
- [D16](01-defect-analysis.md#d16) Collection endpoints have no pagination and pull the full eager graph
- [D19](01-defect-analysis.md#d19) POST /products/batch binds an inline structural type, so validation is skipped and the real error is masked
- [D27](01-defect-analysis.md#d27) getCategoryTree loads every product of the category and never uses them
- [D26](01-defect-analysis.md#d26) Product.category is eager: true, forcing a categories join on every product read

### "Intermittent errors occur in certain flows"

- [D7](01-defect-analysis.md#d7) buildCategoryTree dereferences category.parent, which is never loaded for children
- [D6](01-defect-analysis.md#d6) GET /orders/:id/full builds a self-referential graph and JSON.stringify's it
- [D15](01-defect-analysis.md#d15) DELETE on referenced products/users leaks a raw Postgres FK violation as a 500
- [D21](01-defect-analysis.md#d21) Duplicate-email user creation surfaces as a bare 500 instead of 409
- [D22](01-defect-analysis.md#d22) Dangling categoryId/parentId is caught by Postgres, not the API, producing a raw 500
- [D14](01-defect-analysis.md#d14) PATCH /orders/:id/status accepts any body value: no DTO, no enum validation
- [D20](01-defect-analysis.md#d20) GET /orders?userId=<non-numeric> yields NaN in the WHERE clause and a 500
- [D4](01-defect-analysis.md#d4) Stock decrement is a floating promise: updateStock is never awaited in create()
- [D24](01-defect-analysis.md#d24) CreateProductDto validates price/stock as loose numbers
- [D23](01-defect-analysis.md#d23) CreateOrderDto accepts an empty items array and non-integer productId/quantity

### "Data is sometimes inconsistent or missing"

- [D3](01-defect-analysis.md#d3) Order creation is non-transactional: mid-loop failure leaves orphaned order and partial items
- [D4](01-defect-analysis.md#d4) Stock decrement is a floating promise: updateStock is never awaited in create()
- [D8](01-defect-analysis.md#d8) updateStock is a non-atomic absolute-value read-modify-write: lost updates and oversell
- [D9](01-defect-analysis.md#d9) cancel() restores stock non-atomically and non-idempotently
- [D10](01-defect-analysis.md#d10) processPayment has no order-status guard: cancelled orders are resurrected and double-charged
- [D2](01-defect-analysis.md#d2) Global ValidationPipe has no whitelist: POST bodies mass-assign entity columns and turn create into UPDATE
- [D23](01-defect-analysis.md#d23) CreateOrderDto accepts an empty items array and non-integer productId/quantity
- [D17](01-defect-analysis.md#d17) No product write path invalidates the product-search cache
- [D5](01-defect-analysis.md#d5) searchProducts uses one constant cache key for every query
- [D1](01-defect-analysis.md#d1) Redis cache store never wired: `store` vs `stores` silently falls back to an in-process Map
- [D25](01-defect-analysis.md#d25) Decimal columns come back from Postgres as strings
- [D13](01-defect-analysis.md#d13) processProductBatch swallows per-item errors and always reports success: true
- [D14](01-defect-analysis.md#d14) PATCH /orders/:id/status accepts any body value: no DTO, no enum validation

### "Cache behavior does not match expectations"

- [D1](01-defect-analysis.md#d1) Redis cache store never wired: `store` vs `stores` silently falls back to an in-process Map
- [D5](01-defect-analysis.md#d5) searchProducts uses one constant cache key for every query
- [D17](01-defect-analysis.md#d17) No product write path invalidates the product-search cache
- [D18](01-defect-analysis.md#d18) Redis db index hardcoded to 0, ignoring REDIS_DB=1

### "Some failures produce vague or misleading error messages"

- [D6](01-defect-analysis.md#d6) GET /orders/:id/full builds a self-referential graph and JSON.stringify's it
- [D7](01-defect-analysis.md#d7) buildCategoryTree dereferences category.parent, which is never loaded for children
- [D13](01-defect-analysis.md#d13) processProductBatch swallows per-item errors and always reports success: true
- [D19](01-defect-analysis.md#d19) POST /products/batch binds an inline structural type, so validation is skipped and the real error is masked
- [D11](01-defect-analysis.md#d11) Payment retry loop: maxRetries = 1000 with flat delay and a non-HttpException rethrow
- [D15](01-defect-analysis.md#d15) DELETE on referenced products/users leaks a raw Postgres FK violation as a 500
- [D21](01-defect-analysis.md#d21) Duplicate-email user creation surfaces as a bare 500 instead of 409
- [D22](01-defect-analysis.md#d22) Dangling categoryId/parentId is caught by Postgres, not the API, producing a raw 500
- [D20](01-defect-analysis.md#d20) GET /orders?userId=<non-numeric> yields NaN in the WHERE clause and a 500
- [D14](01-defect-analysis.md#d14) PATCH /orders/:id/status accepts any body value: no DTO, no enum validation
- [D24](01-defect-analysis.md#d24) CreateProductDto validates price/stock as loose numbers

Severity here means **user impact only**, per the rubric in
[04 — Scope](04-scope.md#severity-rubric). It is not fix order — see
[02 — Remediation Plan](02-remediation-plan.md).

## Method

Findings were produced by five independent scans (orders, products, users+cache,
infra/config, cross-cutting API contracts), then put through an **adversarial
verification pass** whose job was to *refute* each one by re-reading the real code,
defaulting to "refuted" under uncertainty. 48 findings were confirmed and deduped
to 27; **11 were rejected**.

Line numbers cited by scans that read several small files at once were concatenated
across those files; every citation in these docs has been re-checked against the
actual source and corrected.

### Limits of this method

Stated plainly, because they change how much each finding should be trusted:

- ~~**2 of 27 were actually executed.**~~ **Superseded.** Every in-scope defect has
  since been run against the live stack — see
  [05 — Reproduction Runbook](05-reproduction.md), which records real captured output.
  Of the 19 in-scope defects: **14 reproduced directly, 2 partially (D8 is an
  intermittent race, D11 needs a forced-failure mock), and 3 stand on code inspection
  alone (D4, D9, D18)**. The 8 out-of-scope defects were not re-tested. The
  `confidence` field on each defect still means "the mechanism was traced end to end
  in the source," not "we ran it" — the runbook is the authority on what was observed.
- **Severity was originally ungraded.** The first pass asked for
  `critical|high|medium|low` with no definitions attached, so the initial ratings were
  model intuition. They have since been re-scored against an explicit
  [rubric](04-scope.md#severity-rubric).
- **The scans were partly led.** Each finder was given area-specific hints ("look hard
  at the retry loop, the cache key, the recursion") drawn from a first read of the
  code. That speeds things up and biases toward confirming existing hypotheses. The
  infra scan is the useful counter-example: it contradicted the initial guess about
  *why* Redis was broken, finding a singular/plural config key rather than the assumed
  library version incompatibility.
- **One early claim was wrong and is corrected here.** A first skim called D7 infinite
  recursion. It is not — `findCategory` loads relations one level deep, so `.parent` is
  `undefined` on children and the recursion dies on a `TypeError`. That changes the fix
  from a cycle guard to a proper subtree query.

## Confirmed by running it

Two headline claims were checked against the running stack rather than argued from
the source, because they are the ones the rest of the plan hinges on.

**The Redis store is never wired ([D1](01-defect-analysis.md#d1)).** The installed
`@nestjs/cache-manager` is 3.1.3, whose `dist/cache.providers.js` references
`options.stores` three times and `options.store` zero times — while
`app.module.ts:33` passes the singular `store`:

```
$ grep -c "options.stores" node_modules/@nestjs/cache-manager/dist/cache.providers.js   # 3
$ grep -c "options.store" node_modules/@nestjs/cache-manager/dist/cache.providers.js  # 0
```

After exercising every cached endpoint, Redis held **zero keys in every database**,
while the app reported cache hits — the fallback is a per-process `Keyv` Map.

**The constant search key collides ([D5](01-defect-analysis.md#d5)).** With a Laptop
and a Shoes product in the table:

```
$ curl -s "localhost:3000/products/search?q=laptop"   # -> [Laptop]
$ curl -s "localhost:3000/products/search?q=shoes"    # -> [Laptop]   <-- wrong
```

That second response is also where the string-typed decimal
([D25](01-defect-analysis.md#d25)) shows up in the wild: `"price":"999.99"`, quoted.

> **Note on masking.** An earlier reading of this codebase assumed the broken Redis
> wiring meant the cache-key defects could not reproduce at all. That is wrong, and
> the distinction matters for testing: the fallback is an in-process cache, not a
> no-op, so D5 reproduces today within a single process. What the wiring defect
> actually hides is the `db: 0` bug entirely, persistence across restarts (under
> `--watch` every file save wipes the cache, which is why the bug reads as
> *intermittent*), all cross-instance staleness, and any `redis-cli` verification of
> a fix. See [Q2](03-open-questions.md#q2).

### Rejected findings

Recorded so we don't re-litigate them later:

- **Monetary totals accumulated in binary floating point over decimal columns typed as number**
  - The failure scenario cannot occur: Postgres rounds numeric(10,2) on store, so the ~1e-14 float error never reaches a persisted cent value, and the only arithmetic use of the string-typed total (line 110) already coerces with Number(). String-typed decimals are uniform TypeORM/pg behaviour across the whole codebase, so this is a typing nit rather than a planted defect or a cause of any reported symptom.
- **cascade + eager on Order.items causes every status write to re-save all order items**
  - The claimed mechanism is wrong: TypeORM's SubjectChangedColumnsComputer omits cascaded entities with no modified columns from the generated UPDATEs, so saving a hydrated order whose items are untouched does not emit N order_items updates. The eager+cascade flags are also load-bearing for the creation path and for cancel()'s use of order.items. Style/perf observation, not a defect.
- **Order creation validates the user through the cached read path, so it accepts users that no longer exist**
  - The only in-app way to remove a user is UsersService.remove, which evicts both `users:all` and `user:${id}` in the same process (users.service.ts:56-57) immediately after the DELETE — so a cached ghost user cannot survive an API-driven deletion. The scenario the finding describes therefore requires either an out-of-band DELETE straight against Postgres or a second app instance; compose.yaml and the README describe a single `pnpm start:dev` process with no app replicas. And the multi-instance variant is not an independent defect at all — it is a restatement of finding 1 (the cache is a per-process Map because `store`/`stores` is misconfigured); once that is fixed, the eviction at line 57 reaches every instance. Additionally, a user who has orders cannot be deleted in the first place: the `user_id` FK from src/orders/order.entity.ts:28 blocks it with no cascade, so the population most exposed to this is exactly the population that cannot hit it.
- **User deletion invalidates only after the DB write, leaving a window where a concurrent read resurrects the deleted user**
  - Write-then-invalidate is the standard, correct ordering for cache-aside; the code already does the right thing. The residual read-repopulates-after-delete window is an inherent property of every cache-aside implementation, not something planted here, and — decisively — the proposed fix does not close it: evicting both before *and* after `usersRepository.remove(user)` still leaves the exact same window, because the racing reader loaded its row before the DELETE and can still `set` at line 42 after the trailing eviction completes. Closing it genuinely needs a different mechanism (delete-marker/tombstone, or versioned keys), which is a redesign, not a root-cause fix. The secondary 'plain object from JSON' concern is contingent on finding 1 being fixed first: under the code as it actually runs today the cached value is the very same `User` entity instance (verified — the fallback Keyv has serialisation disabled), so `remove()` works. The 'deletes zero rows and still returns 204' variant requires the same unreachable stale-cache precondition refuted in the orders finding.
- **Every cached read uses get-then-set with no single-flight, so hot keys stampede the database on each expiry**
  - Cache-aside get/miss/query/set is the normal, correct pattern; the absence of request coalescing is a hardening opportunity, not a defect the code gets wrong, and the finding proposes no incorrect behaviour — only a better library call. It also mis-attributes the 'extremely slow or never complete' symptom, which is explained by concrete unbounded work elsewhere: orders.service.ts:26 sets `maxRetries = 1000` against a retry loop (108-121) with a 100ms sleep per failure, and products.service.ts:94-110 `buildCategoryTree` recurses unbounded through both `parent` and `children`. Neither of those is a cache stampede. The `findAll` unpaginated-SELECT remark is likewise a generic scalability observation with no defective behaviour attached.
- **`keyv` peer dependency of @nestjs/cache-manager is undeclared in package.json**
  - A packaging hygiene observation, not a defect that produces any reported symptom. pnpm nests keyv@5.6.0 inside @nestjs/cache-manager where it is actually required, no src/ file imports keyv, and the app boots. The failure scenario ('application code fails at import time') presupposes code that does not exist. Merge this into the store-wiring fix as an implementation prerequisite.
- **TypeORM `synchronize: true` performs unguarded auto-DDL on every boot**
  - Best-practice nit, not a planted defect, and the proposed fix is actively harmful here. With no migrations and no seed step anywhere in the repo, `synchronize: true` is the only thing that creates the schema; `synchronize: false` would leave the app with no tables. Neither half of the failure scenario (a hypothetical future column rename; speculative concurrent-DDL lock contention under a single watch process) is reachable in the repo as given, and neither maps to a reported request-time symptom.
- **compose.yaml splits postgres and redis onto two isolated bridge networks**
  - An odd but inert topology, not a defect with any current failure mode. Neither compose file contains an app service; the API runs on the host and reaches both dependencies through published localhost ports (.env DB_PORT=5434 / REDIS_PORT=6380 matching compose.local.yaml). Postgres and Redis never need to talk to each other. The failure scenario is explicitly conditional on adding a service that does not exist.
- **No global exception filter and an uncaught bootstrap() rejection**
  - Untouched `nest new` scaffolding presented as a planted defect, with the root cause misattributed. Nest's default ExceptionsHandler already logs the underlying stack, and the real 'vague error message' defects are the swallowed `console.log('Error processing product')` at src/products/products.service.ts:123 (which still returns `success: true`) and the cause-discarding rethrow at :127 — plus the orders retry path — none of which a global filter in main.ts would fix.
- **postgres service declares no volume, so data is destroyed on `docker compose down`**
  - Expected design for a disposable interview/dev stack, not a planted defect. There is no seed data or migration state to lose, and the 'failure' is the direct result of an explicit `docker compose down`, not an intermittent runtime behavior. It does not explain the reported 'data is sometimes inconsistent or missing' symptom, which traces to the mass-assignment hole (src/main.ts:7) and the non-shared in-process cache (src/app.module.ts:33).
- **processPayment rethrows a raw Error (or `undefined`), producing a bare 500 for a payment failure**
  - Both failure modes depend on the retry loop being exhausted, which is unreachable. The mock provider (lines 12-22) fails independently with p=0.1 and never returns `{ success: false }`, so the expected number of attempts is ~1.11 (~120ms) and exiting the 1000-iteration loop without returning requires 1000 consecutive failures (p = 10^-1000). `throw lastError!` at line 123 — whether `undefined` or a raw Error — is therefore dead code in this codebase, and the stated '~200 seconds then HTTP 500' outcome cannot be produced. The one real defect in this range is the absurd `maxRetries = 1000` at line 26, but it is a latency/resilience defect with a different mechanism and symptom than the finding describes, so this finding as written does not stand.

## Reproducing

The stack runs on non-default ports locally because 5432/6379 are occupied by other
projects on this machine (see `compose.local.yaml`, which is gitignored):

```bash
docker compose -f compose.local.yaml up -d
pnpm install
pnpm run start:dev
```
