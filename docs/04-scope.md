# 04 — Scope

What we are fixing, what we are deliberately leaving alone, and why.

This document exists because the analysis found more than the assignment asks for.
`INSTRUCTIONS.md` is narrow on purpose:

> Focus on identifying and fixing the root causes of the reported issues.
> Do not add new features or redesign the system.

So "is this defect real?" is the wrong question for deciding what to change. The
right one is below.

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

## In scope — 20 defects, 10 commits

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
today, so C2 ships `pnpm add @keyv/redis`, drops `cache-manager-ioredis-yet`, and
carries a `pnpm-lock.yaml` diff. It is the only commit in the plan that touches the
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
  less. Duplicate `productId` entries are merged before the stock check
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

### C10. Search scans the whole products table

| # | Defect | Severity |
|---|---|---|
| [D12](01-defect-analysis.md#d12) | `searchProducts` SELECTs every product and filters in JavaScript | 🟠 High |

Last commit, and initially cut from scope entirely. The reversal is deliberate, so the
reasoning on both sides is recorded here.

**The case for leaving it out** was that results are correct today and the seeded
dataset is nowhere near large enough to feel the scan.

**The case for putting it back is the in-scope test itself.** "Some requests are
extremely slow or never complete" is a reported symptom, and this is the only defect
that produces it on an ordinary request. [D11](01-defect-analysis.md#d11) carries that
symptom only while the payment provider is *persistently* down; under normal conditions
[05](05-reproduction.md#e-slow--never-completes) measures its cost at one ~200ms retry
in twelve calls. Shipping C6 as the whole answer would respond to a stakeholder report
with a fix nobody can observe.

The cache is what made the scan look cheap. Every miss pays full table cost, and until
C2 lands the cache is a per-process Map that `nest start --watch` wipes on every file
save — so in the deployment that generated these reports, close to every search was a
cold miss.

**Scoped tightly**, because the neighbouring performance work stays out: push the
existing predicate into SQL with `ILike` on `name`/`description` and bound the result
with `take`. Same route, same response shape, no pagination envelope, no contract
change. [D16](01-defect-analysis.md#d16) and [D26](01-defect-analysis.md#d26) stay out
of scope precisely because they *do* change the contract or need a call-site audit.

Severity is 🟠 High per the [rubric](#severity-rubric) — unbounded latency on a normal
request. The ⚪ Low it carried while out of scope was scored against "this dataset,"
which is the argument this section rejects.

## Out of scope — 7 defects

Real, verified, and deliberately not fixed.

Two of them — D19 and D27 — are nonetheless *touched* by in-scope commits, because
the in-scope fix cannot land safely without them. They stay listed here because
neither is a goal and neither would justify a commit alone. The counts hold: 20 in
scope, 7 out, 27 total.

D12 sat in this table in an earlier draft and has since moved into scope as
[C10](#c10-search-scans-the-whole-products-table) — the entry below is gone, not
mislaid.

| # | Defect | Why it stays | Severity |
|---|---|---|---|
| [D16](01-defect-analysis.md#d16) | No pagination on collection endpoints | Latent at scale; correct on this dataset. Adding a pagination envelope changes the API contract, which the instructions rule out — the internal `take` cap in [C10](#c10-search-scans-the-whole-products-table) does not ([Q8](03-open-questions.md#q8)) | ⚪ Low |
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

### Whether the search scan belongs in scope — **decided: reversed, it does**

Originally cut as "latent at scale," now shipped as
[C10](#c10-search-scans-the-whole-products-table). The argument in full is in that
section; in one line: "extremely slow or never complete" is a reported symptom, and
[D11](01-defect-analysis.md#d11) alone answers it only when the payment provider is
persistently down — which is not the normal-request condition the in-scope test asks
about. D16 and D26 are unaffected and stay out.

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

One gap to name: [C10](#c10-search-scans-the-whole-products-table) has no captured
*Observed* block, because D12 entered scope after the runbook was recorded and needs a
seeded 50k-row table. [05](05-reproduction.md) carries the procedure and marks it
explicitly as not yet executed.

The honest limit of this approach: it is manual, so it catches a regression only when
someone re-runs the affected section. The two race-condition fixes (D8, D9) are the
weakest case — a single green run proves little, since the broken code also passes
most of the time. Those need the relevant loop run repeatedly, and the structural
check that the write is genuinely a single conditional `UPDATE`, before being called
verified.

## Status

Nothing has been fixed yet. This is the plan, not a record of work.
