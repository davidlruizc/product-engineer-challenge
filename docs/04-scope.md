# 04 — Scope

What we are fixing, what we are deliberately leaving alone, and why.

This document exists because the analysis found more than the assignment asks for.
`INSTRUCTIONS.md` is narrow on purpose:

> Focus on identifying and fixing the root causes of the reported issues.
> Do not add new features or redesign the system.

So "is this defect real?" is the wrong question for deciding what to change. The
right one is below.

## Traceability to `INSTRUCTIONS.md`

The stakeholders reported five symptoms. They did not report defects, and the D- and
C-numbers used throughout these docs are this investigation's labels, not theirs. So
the check that matters is the one below: **every commit answers a sentence the
stakeholders actually wrote**, and every sentence has at least one commit.

| Reported symptom | Commits | Observed on the seeded dataset |
|---|---|---|
| "Some requests are extremely slow or never complete" | `c6` | 1000 retries × 100ms flat ≈ 200s while the provider is down; now 3 attempts with backoff, measured max 650ms over 20 calls |
| "Intermittent errors occur in certain flows" | `c7`, `c9` | `/orders/:id/full` and `/categories/:id/tree` returned 500 on **every** call; all read endpoints now 200 |
| "Data is sometimes inconsistent or missing" | `c1`, `c3`, `c4`, `c5` | A POST carrying `id` overwrote an existing user; a failed order left an orphan row and consumed stock; 6 concurrent orders against stock 3 now yield exactly 3 sales |
| "Cache behavior does not match expectations" | `c2`, `c3` | Redis was empty while the app reported hits, and the cache died on restart; keys now live in db 1 and survive a restart |
| "Some failures produce vague or misleading error messages" | `c7`, `c8`, `c9` | Bare 500s carrying raw constraint names, and a batch returning `success: true` while items failed; now 409/404/400 naming the cause, and per-item failures reported |

Read in the other direction, so no commit is unaccounted for:

| Commit | Symptom it serves |
|---|---|
| `c1` validation whitelist | data missing — a create silently performed an update |
| `c2` redis cache store | cache behaviour |
| `c3` search cache key | cache behaviour, and wrong data returned |
| `c4` order transaction + atomic stock | data inconsistent |
| `c5` cancel/pay state machine | data inconsistent |
| `c6` payment retry bound | never completes |
| `c7` read endpoint crashes | intermittent errors, vague messages |
| `c8` batch error reporting | misleading messages |
| `c9` error mapping | vague messages |

One commit is weaker than the rest and is flagged rather than smoothed over: **`c6`**.
Under normal conditions the old 1000-retry loop was fast, because the mock provider
fails independently at 10% and usually succeeded on the first attempt. The 200-second
hang needs the provider to be *persistently* down, which could not be reproduced
without a forced-failure mock. Its claim on "never complete" is real but conditional,
and that is stated here rather than argued around.

## The in-scope test

> A defect is in scope only if it **causes one of the five reported symptoms on a
> normal request**.

Three things that explicitly do **not** qualify:

- **"It's true."** Plenty of the findings are true and still out of scope.
- **"It would matter at scale."** Latent scale problems are not reported symptoms.
  No user has hit them on this dataset.
- **"It's better practice."** The instructions rule out redesign. A defensible
  refactor that fixes no reported symptom is scope creep with extra steps.

## Severity rubric

The original severity ratings were assigned per-finding with no defined scale — a
real weakness in the first pass. They have been re-scored against this rubric, which
measures **user impact only**:

| Severity | Means |
|---|---|
| 🔴 **Critical** | Corrupts or loses data, or crashes a normal request |
| 🟠 **High** | Returns wrong results, or unbounded latency, on a normal request |
| 🟡 **Medium** | Wrong status code or misleading message; the data itself is correct |
| ⚪ **Low** | Latent at scale only; not user-visible on this dataset |

**Severity is not fix order.** [D1](01-defect-analysis.md#d1) is High by impact but
is fixed second, because nothing else in the cache theme can be verified until it
lands. Ordering lives in [02 — Remediation Plan](02-remediation-plan.md).

## In scope — 19 defects, 9 commits

Listed in **commit order**, matching the steps in
[02 — Remediation Plan](02-remediation-plan.md). The thematic grouping used in an
earlier draft put D2 fifth and merged the two order commits; both conflicted with the
dependency rules in 02, so the order below supersedes it.

### C1. Mass assignment destroys rows

| # | Defect | Severity |
|---|---|---|
| [D2](01-defect-analysis.md#d2) | No `whitelist` on `ValidationPipe` — POST silently UPDATEs existing rows | 🔴 Critical |

First, not fifth. One line in `src/main.ts`, no dependency on anything else, and the
only defect actively destroying pre-existing rows on every POST. It also has to land
before any DTO tightening: without `whitelist`, tightening decorators only constrains
the fields a DTO happens to declare, and undeclared columns still sail through.
Ships as `whitelist: true` alone — see [Q11](03-open-questions.md#q11).

### C2. Cache never reaches Redis

| # | Defect | Severity |
|---|---|---|
| [D1](01-defect-analysis.md#d1) | `app.module.ts` passes `store`; `@nestjs/cache-manager` 3.1.3 reads `stores` | 🟠 High |
| [D18](01-defect-analysis.md#d18) | `db: 0` hardcoded, ignoring `REDIS_DB=1` | 🟡 Medium |

Ships as one change. D18 is inert until D1 lands, and would silently write to the
wrong logical database the moment it does.

**This commit changes dependencies, not just source.** `@keyv/redis` is not installed
today, so C2 ships `pnpm add @keyv/redis`, drops `cache-manager-ioredis-yet` and the
now-unused `ioredis` that only ever backed it, and carries a `pnpm-lock.yaml` diff. It is the only commit in the plan that touches the
dependency tree, and it is declared here rather than left for a reviewer to find in
the lockfile. Why a swap and not a downgrade: [Q3](03-open-questions.md#q3).

### C3. Cache returns the wrong thing

| # | Defect | Severity |
|---|---|---|
| [D5](01-defect-analysis.md#d5) | One constant key `'product-search'` for every query | 🟠 High |
| [D17](01-defect-analysis.md#d17) | No product write invalidates the search cache | 🟠 High |

Sequenced together because the invalidation strategy depends on the key scheme.

### C4. Order writes lose and corrupt data

| # | Defect | Severity |
|---|---|---|
| [D3](01-defect-analysis.md#d3) | `create()` is non-transactional — orphaned orders, partial items | 🔴 Critical |
| [D4](01-defect-analysis.md#d4) | `updateStock` is never awaited — a floating promise | 🔴 Critical |
| [D8](01-defect-analysis.md#d8) | Absolute-value read-modify-write — lost updates, oversell | 🟠 High |
| [D9](01-defect-analysis.md#d9) | `cancel()` restores stock non-atomically and non-idempotently | 🟠 High |
| [D10](01-defect-analysis.md#d10) | `processPayment` has no status guard — cancelled orders get confirmed and charged | 🟠 High |

**The only genuinely non-trivial change in the set.** Split across two commits,
because 02 establishes that C5 depends on the atomic stock helper C4 introduces:

- **C4** — D3 + D4 + D8, one indivisible change to `OrdersService.create()` and
  `ProductsService.updateStock`. Indivisible because awaiting the stock update
  *without* the surrounding transaction makes partial commits more deterministic, not
  less. Line items are processed in `productId` order so concurrent orders cannot
  deadlock, but the request's lines are otherwise preserved one for one
  ([Q7](03-open-questions.md#q7)).
- **C5** — D9 + D10, the order state machine. Both replace a check-then-act with a
  conditional `UPDATE` on `status`, and both reuse the helper from C4. Fixing D10
  without D9 leaves the double-restore path; fixing D9 without D10 leaves a cancelled
  order payable. Payment idempotency comes from the conditional status flip alone —
  no new column ([Q6](03-open-questions.md#q6)).

Depth of the stock fix is settled below — see
[Scope decisions taken](#open-how-far-on-stock).

### C6. Payment retry never gives up

| # | Defect | Severity |
|---|---|---|
| [D11](01-defect-analysis.md#d11) | `maxRetries = 1000` with a flat 100ms delay | 🟠 High |

Ships the retry bound and the `ServiceUnavailableException` mapping as **one** commit.
Lowering `maxRetries` is precisely what makes the previously-unreachable `throw
lastError!` live; shipping the bound alone would convert a latency defect into a fresh
production 500.

### C7. Two endpoints 500 on every valid call

| # | Defect | Severity |
|---|---|---|
| [D6](01-defect-analysis.md#d6) | `/orders/:id/full` builds a self-reference, then `JSON.stringify`s it | 🔴 Critical |
| [D7](01-defect-analysis.md#d7) | Category tree dereferences `parent`, which is never loaded | 🔴 Critical |

Both are pure-read crash fixes, independent of everything else. The D7 fix drops the
upward `parent` traversal entirely and loads the subtree properly
([Q10](03-open-questions.md#q10)) — which incidentally removes the unused `products`
relation, i.e. D27.

### C8. Batch reports success while items fail

| # | Defect | Severity |
|---|---|---|
| [D13](01-defect-analysis.md#d13) | Batch swallows every per-item error, still returns `success: true` | 🟠 High |

Strictly ordered internally: `ProcessBatchDto` lands first, *then* the masking catch is
removed, *then* the return shape reports per-item failures. Reversed, a malformed body
degrades from a vague 400 to a 500 — worse, not better. The DTO half is D19, out of
scope as a goal but a prerequisite here.

D2 previously sat in this group. It is now [C1](#c1-mass-assignment-destroys-rows).

### C9. Raw driver errors reach the client

| # | Defect | Severity |
|---|---|---|
| [D15](01-defect-analysis.md#d15) | FK violation on delete → bare 500 | 🟡 Medium |
| [D21](01-defect-analysis.md#d21) | Duplicate email → bare 500 instead of 409 | 🟡 Medium |
| [D22](01-defect-analysis.md#d22) | Dangling `categoryId`/`parentId` → raw 500 | 🟡 Medium |
| [D20](01-defect-analysis.md#d20) | `?userId=abc` → `NaN` in the WHERE clause → 500 | 🟡 Medium |
| [D14](01-defect-analysis.md#d14) | `PATCH /orders/:id/status` accepts any value — no DTO, no enum check | 🟡 Medium |

Counted as one group. **"Some failures produce vague or misleading error messages"
is one of the five reported symptoms**, so this is a stated requirement, not polish.
The implementation is a `catch` plus a `switch` on SQLSTATE (23503 / 23505) — not an
architecture.

## Out of scope — 8 defects

Real, verified, and deliberately not fixed.

Two of them — D19 and D27 — are nonetheless *touched* by in-scope commits, because
the in-scope fix cannot land safely without them. They stay listed here because
neither is a goal and neither would justify a commit alone. The counts hold: 19 in
scope, 8 out, 27 total.

D12 moved into scope in an earlier draft and has since moved back out — see
[Scope decisions taken](#decided-search-scan) for why the reversal was itself
reversed.

| # | Defect | Why it stays | Severity |
|---|---|---|---|
| [D12](01-defect-analysis.md#d12) | `searchProducts` SELECTs every product and filters in JavaScript | Correct results today, and invisible at this table size — measured at 6–20ms either way on the seeded dataset. Making the gap appear needed 50,000 synthetic rows. No user reported a slow search | ⚪ Low |
| [D16](01-defect-analysis.md#d16) | No pagination on collection endpoints | Latent at scale; correct on this dataset. Adding a pagination envelope changes the API contract, which the instructions rule out ([Q8](03-open-questions.md#q8)) | ⚪ Low |
| [D25](01-defect-analysis.md#d25) | `decimal` columns come back as strings | **Not a planted bug.** This is standard TypeORM/pg behaviour. A transformer would change the JSON type of every money field on every read — a breaking change for clients, fixing no reported symptom | ⚪ Low |
| [D26](01-defect-analysis.md#d26) | `Product.category` is `eager: true` | A join on a 1-row category table. Removing it means auditing every call site for a benefit no user can perceive | ⚪ Low |
| [D27](01-defect-analysis.md#d27) | Category tree loads products it never uses | Wasteful, invisible. **Not a goal, but changed incidentally by C7** — the D7 subtree rewrite drops the unused `products` relation on its way past. Never worth its own commit | ⚪ Low |
| [D19](01-defect-analysis.md#d19) | `/products/batch` binds an inline structural type | Edge-case hardening; the user-facing half is D13. **Not a goal, but a prerequisite inside C8** — the inline type's `catch` is the only thing currently converting a malformed body into a 400, so the DTO must exist before that catch can be removed | ⚪ Low |
| [D23](01-defect-analysis.md#d23) | `CreateOrderDto` allows empty `items`, fractional `quantity` | Requires a malformed request to trigger; no reported symptom | ⚪ Low |
| [D24](01-defect-analysis.md#d24) | `price`/`stock` validated as loose numbers | Same | ⚪ Low |

### Why write this list down at all

Because omission is indistinguishable from oversight. A reviewer who spots the
unpaginated `findAll` has no way to know whether it was considered and rejected or
simply missed. Stating the call converts a gap into a decision — and demonstrating
scope discipline is worth more here than seven more diffs.

## Scope decisions taken

<a id="open-how-far-on-stock"></a>

### How far to go on stock correctness — **decided: take the correct option**

The one place "lean" and "correct" genuinely pull apart.

| Option | Fixes | Leaves |
|---|---|---|
| **Minimal** — wrap `create()` in a transaction, `await` the stock update | Orphaned orders, phantom stock | Concurrent oversell: two simultaneous orders both read `stock: 5` and both write `stock: 3` |
| **Correct** — the above, plus `UPDATE products SET stock = stock - :q WHERE id = :id AND stock >= :q`, treating `affected !== 1` as insufficient stock | Both | Nothing in this area |

The second is perhaps ten more lines and is the actual root-cause fix — a lost
update is exactly "data is sometimes inconsistent," and *sometimes* is the word the
report uses. It is not a redesign; it is one SQL statement replacing two.

**Decision: take the correct option.** C4 ships the atomic
`UPDATE products SET stock = stock - :q WHERE id = :id AND stock >= :q`, treating
`affected !== 1` as insufficient stock. Stopping at "minimal" would leave D8 open
while claiming the orders group was fixed.

<a id="decided-search-scan"></a>

### Whether the search scan belongs in scope — **decided: no, it stays out**

This one was reversed twice, so both turns are recorded.

**First draft:** out, as "latent at scale."
**Second draft:** in, shipped as a tenth commit, on the argument that "extremely slow
or never complete" is a reported symptom and the payment retry bound answers it only
during a provider outage.
**Final:** out again, and the tenth commit was removed from the stack.

What settled it was measuring instead of arguing. On the seeded dataset the search
costs **6–20ms whether the predicate runs in SQL or in JavaScript** — the two are
indistinguishable. The 520ms-versus-49ms gap that justified the second draft only
appeared after inserting 50,000 synthetic rows, which is a table this system does not
have and no user has reported waiting on.

That failed the in-scope test as written at the top of this document: *latent scale
problems are not reported symptoms*. Keeping it would have meant applying that test to
D16 and D26 and exempting D12 from it, which is not a scope rule, it is a preference.

[C6](#c6-payment-retry-never-gives-up) therefore carries "extremely slow or never
complete" alone. Its claim is narrower than the second draft implied — a 1000-iteration
loop only hangs while the provider is persistently down — and that limit is stated in
[C6](#c6-payment-retry-never-gives-up) rather than patched over by widening scope.

### Whether the error-mapping group is required — **decided: keep it in full**

Argued above as in scope, since it maps directly to a stated symptom. The counter was
that five defects mapping to "vague messages" is the group most easily read as
polish. If it needed trimming, D15 and D21 carry the symptom on their own; D20, D22
and D14 could be dropped without leaving the requirement unaddressed.

**Decision: keep all five.** "Some failures produce vague or misleading error
messages" is one of the five reported symptoms, and [Q1](03-open-questions.md#q1)
claims every symptom is fully covered. Trimming the group to look disciplined would
undercut that claim to save one `switch` statement. C9 ships all five.

## How the fixes will be validated

**No automated test suite is being added.** The repository ships one trivial unit test
and one trivial e2e test; building a regression suite would be a larger body of work
than the fixes themselves, and the instructions ask for root-cause fixes, not test
infrastructure.

Validation runs off [05 — Reproduction Runbook](05-reproduction.md) instead. Every
section there is a before/after pair: the *Observed* block is the pre-fix state, and
the *Expected* block is the pass condition. The per-defect table in
[02 — Remediation Plan](02-remediation-plan.md#verification-per-defect) carries the
same assertions in command form.

The honest limit of this approach: it is manual, so it catches a regression only when
someone re-runs the affected section. The two race-condition fixes (D8, D9) are the
weakest case — a single green run proves little, since the broken code also passes
most of the time. Those need the relevant loop run repeatedly, and the structural
check that the write is genuinely a single conditional `UPDATE`, before being called
verified.

## What was removed for going beyond the report

Six changes were written, then taken back out, because each one bounded or reshaped
behaviour that no reported symptom covers. They are listed here rather than quietly
dropped, so the reversal is as reviewable as the work.

| Removed | Was in | Why it went |
|---|---|---|
| The whole search-in-SQL commit | its own tenth commit | Measured at 6–20ms either way on the real dataset — see [above](#decided-search-scan) |
| `take: 100` on search results | that same commit | Silently truncated results. A search matching 150 products returned 100 with no total and no next-page marker, which is itself "data is sometimes missing" |
| `ArrayMaxSize(500)` on `/products/batch` | [C8](#c8-batch-reports-success-while-items-fail) | Rejected 501-id batches that work today. No reported symptom involves a large batch |
| `ArrayNotEmpty()` on `/products/batch` | [C8](#c8-batch-reports-success-while-items-fail) | Turned `{"productIds": []}` from `success: true, processed: 0` into a 400. A well-formed request that worked before. The rest of the DTO stays, because `IsArray` and `IsInt({each})` are what turn a malformed body into a message naming the field — that is the reported symptom; rejecting an empty list is not |
| Depth cap of 50 on the category tree | [C7](#c7-two-endpoints-500-on-every-valid-call) | Removed, and the removal was right, but **the reason given for it was wrong** — see [below](#corrected-the-cycle-premise). A cycle is reachable. C7 ships a cycle-safe recursion instead of a depth cap: still no arbitrary bound, but no reliance on the false premise either |
| Merging duplicate `productId` lines | [C4](#c4-order-writes-lose-and-corrupt-data) | Changed the shape of an order to answer [Q7](03-open-questions.md#q7), a question these docs record as having no requirement behind it. Stock stays correct without it: each line is decremented conditionally, and a combined quantity over stock still rolls the transaction back |

The dependency tidy-up in [C2](#c2-cache-never-reaches-redis) went the other way —
`ioredis` was left installed by an earlier draft on the grounds that removing it was
"tidying rather than a root-cause fix." It is now removed, because the commit that
orphaned it is the commit that should account for it.

<a id="corrected-the-cycle-premise"></a>

### Corrected: a cycle in the category tree IS reachable

An earlier version of this document justified dropping C7's depth cap by asserting that a
cycle "cannot be produced through this API: `POST /categories` only ever points a new row
at an existing one, and nothing reparents a category."

The second clause is true — the global `whitelist: true` from [C1](#c1-mass-assignment-destroys-rows)
strips `id`, so an existing category cannot be reparented. The first clause is false, and
one request falsifies it:

```console
$ curl -s localhost:3000/categories                      # -> ids [2, 1, 3]
$ curl -X POST localhost:3000/categories -H 'content-type: application/json'     -d '{"name":"SelfLoop","parentId":4}'
{"id":4,"name":"SelfLoop","parentId":4}                  # HTTP 201
```

`createCategory` does not validate `parentId`, ids are sequential and readable, and Postgres
checks the foreign key at statement end — so a row may name itself as its own parent. With
`UNION ALL` and no guard, the subtree query then never returns:

```console
$ curl -m 15 localhost:3000/categories/4/tree
HTTP 000 after 15.013259s
# pg_stat_activity: WITH RECURSIVE subtree ... active 00:00:15.257571 (ended by pg_cancel_backend)
```

That is worse than the defect C7 fixes: on `main` the same row fails instantly with a
TypeError, so an unguarded CTE converts a fast 500 into an unbounded hang on the endpoint
whose whole purpose is to stop 500ing.

[C9](#c9-raw-driver-errors-reach-the-client) does not close it either — that commit maps
*dangling* foreign keys, and a self-loop is a valid one.

**The decision stands, the reasoning does not.** There is still no arbitrary depth cap;
C7's recursion instead carries the path it has walked and refuses to re-enter a node
already on it, which is bounded by the graph rather than by a magic number. Recorded here
because a scope decision resting on a false premise is worth more as a correction than as
a quietly amended table.

## Status

**Nine commits, `c1` through `c9`, one branch each.** Every one traces to a sentence in
`INSTRUCTIONS.md` via the table at the top of this document, and every one was verified
against a running stack — Postgres and Redis in Docker, the seeded fixture from
[05](05-reproduction.md), and the assertions recorded in each commit message.

Two things are deliberately not done, and are decisions rather than omissions:

- **No automated regression suite**, for the reason given above.
- **`PATCH /orders/:id/status` still permits any transition**, including
  `cancelled → pending`, which makes a cancelled order payable again. It is noted at
  [D14](01-defect-analysis.md#d14) and left alone: reaching it needs a client to drive
  an order backwards through its lifecycle on purpose, so it fails the in-scope test in
  exactly the way [D23](01-defect-analysis.md#d23) and [D24](01-defect-analysis.md#d24)
  do. Closing it would also mean inventing transition rules the README never states.
