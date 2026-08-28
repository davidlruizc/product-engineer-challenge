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

## In scope — 19 defects, 6 commits

Grouped as they would be committed, not as they were found.

### 1. Cache never reaches Redis

| # | Defect | Severity |
|---|---|---|
| [D1](01-defect-analysis.md#d1) | `app.module.ts` passes `store`; `@nestjs/cache-manager` 3.1.3 reads `stores` | 🟠 High |
| [D18](01-defect-analysis.md#d18) | `db: 0` hardcoded, ignoring `REDIS_DB=1` | 🟡 Medium |

Ships as one change. D18 is inert until D1 lands, and would silently write to the
wrong logical database the moment it does.

### 2. Cache returns the wrong thing

| # | Defect | Severity |
|---|---|---|
| [D5](01-defect-analysis.md#d5) | One constant key `'product-search'` for every query | 🟠 High |
| [D17](01-defect-analysis.md#d17) | No product write invalidates the search cache | 🟠 High |

Sequenced together because the invalidation strategy depends on the key scheme.

### 3. Orders lose and corrupt data

| # | Defect | Severity |
|---|---|---|
| [D3](01-defect-analysis.md#d3) | `create()` is non-transactional — orphaned orders, partial items | 🔴 Critical |
| [D4](01-defect-analysis.md#d4) | `updateStock` is never awaited — a floating promise | 🔴 Critical |
| [D8](01-defect-analysis.md#d8) | Absolute-value read-modify-write — lost updates, oversell | 🟠 High |
| [D9](01-defect-analysis.md#d9) | `cancel()` restores stock non-atomically and non-idempotently | 🟠 High |
| [D10](01-defect-analysis.md#d10) | `processPayment` has no status guard — cancelled orders get confirmed and charged | 🟠 High |

**The only genuinely non-trivial change in the set**, and the one place a scope
decision is still open — see [Open question below](#open-how-far-on-stock).

D9 and D10 are separated into their own commit but belong to this group: both replace
a check-then-act with a conditional `UPDATE` on `status`, and both reuse the atomic
stock helper introduced for D8. Fixing D10 without D9 leaves the double-restore path;
fixing D9 without D10 leaves a cancelled order payable.

### 4. Two endpoints 500 on every valid call

| # | Defect | Severity |
|---|---|---|
| [D6](01-defect-analysis.md#d6) | `/orders/:id/full` builds a self-reference, then `JSON.stringify`s it | 🔴 Critical |
| [D7](01-defect-analysis.md#d7) | Category tree dereferences `parent`, which is never loaded | 🔴 Critical |

Both are pure-read crash fixes, independent of everything else.

### 5. Silent and unbounded failure

| # | Defect | Severity |
|---|---|---|
| [D2](01-defect-analysis.md#d2) | No `whitelist` on `ValidationPipe` — POST silently UPDATEs existing rows | 🔴 Critical |
| [D11](01-defect-analysis.md#d11) | `maxRetries = 1000` with a flat 100ms delay | 🟠 High |
| [D13](01-defect-analysis.md#d13) | Batch swallows every per-item error, still returns `success: true` | 🟠 High |

D2 is a one-line fix for the single most destructive defect in the codebase.

### 6. Raw driver errors reach the client

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

| # | Defect | Why it stays | Severity |
|---|---|---|---|
| [D12](01-defect-analysis.md#d12) | `searchProducts` loads the whole table and filters in Node | Correct results today; only slow at a table size this dataset never reaches | ⚪ Low |
| [D16](01-defect-analysis.md#d16) | No pagination on collection endpoints | Same — latent at scale. Adding a pagination envelope changes the API contract, which the instructions rule out | ⚪ Low |
| [D25](01-defect-analysis.md#d25) | `decimal` columns come back as strings | **Not a planted bug.** This is standard TypeORM/pg behaviour. A transformer would change the JSON type of every money field on every read — a breaking change for clients, fixing no reported symptom | ⚪ Low |
| [D26](01-defect-analysis.md#d26) | `Product.category` is `eager: true` | A join on a 1-row category table. Removing it means auditing every call site for a benefit no user can perceive | ⚪ Low |
| [D27](01-defect-analysis.md#d27) | Category tree loads products it never uses | Wasteful, invisible. Worth dropping *only* as a side effect of the D7 fix, never on its own | ⚪ Low |
| [D19](01-defect-analysis.md#d19) | `/products/batch` binds an inline structural type | Edge-case hardening. The user-facing half of this is D13, which is in scope | ⚪ Low |
| [D23](01-defect-analysis.md#d23) | `CreateOrderDto` allows empty `items`, fractional `quantity` | Requires a malformed request to trigger; no reported symptom | ⚪ Low |
| [D24](01-defect-analysis.md#d24) | `price`/`stock` validated as loose numbers | Same | ⚪ Low |

### Why write this list down at all

Because omission is indistinguishable from oversight. A reviewer who spots the
unpaginated `findAll` has no way to know whether it was considered and rejected or
simply missed. Stating the call converts a gap into a decision — and demonstrating
scope discipline is worth more here than eight more diffs.

## Open questions on scope

<a id="open-how-far-on-stock"></a>

### How far to go on stock correctness

The one place "lean" and "correct" genuinely pull apart.

| Option | Fixes | Leaves |
|---|---|---|
| **Minimal** — wrap `create()` in a transaction, `await` the stock update | Orphaned orders, phantom stock | Concurrent oversell: two simultaneous orders both read `stock: 5` and both write `stock: 3` |
| **Correct** — the above, plus `UPDATE products SET stock = stock - :q WHERE id = :id AND stock >= :q`, treating `affected !== 1` as insufficient stock | Both | Nothing in this area |

The second is perhaps ten more lines and is the actual root-cause fix — a lost
update is exactly "data is sometimes inconsistent," and *sometimes* is the word the
report uses. **Recommendation: take the correct option.** It is not a redesign; it is
one SQL statement replacing two.

### Whether the error-mapping group is required

Argued above as in scope, since it maps directly to a stated symptom. The counter is
that five defects mapping to "vague messages" is the group most easily read as
polish. If it needs trimming, D15 and D21 carry the symptom on their own; D20, D22
and D14 could be dropped without leaving the requirement unaddressed.

## Status

Nothing has been fixed yet. This is the plan, not a record of work.
