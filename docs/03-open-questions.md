# 03 — Open Questions

Items that needed a decision, or that qualify a claim made elsewhere in these docs.

Every blocking question below is now **decided**. Each carries the step it gates, the
decision taken, and the reasoning — so the choice can be reviewed independently of the
code. Q-numbers are unchanged from the first draft; cross-references still resolve.

- [Part A — Decisions taken](#part-a) (blocked work; ordered by the step they gate)
- [Part B — Resolved or non-blocking](#part-b) (recorded, no decision required)

---

<a id="part-a"></a>
## Part A — Decisions taken

| | Question | Gates | Decision |
|---|---|---|---|
| [Q11](#q11) | `whitelist` vs `forbidNonWhitelisted` | Step 1 | `whitelist: true` alone |
| [Q3](#q3) | Which Redis remediation path | Step 2 | Upgrade — keyv + `@keyv/redis` |
| [Q7](#q7) | Duplicate `productId` in one order | Step 4 | Leave the lines as sent |
| [Q6](#q6) | Payment idempotency | Steps 5–6 | Conditional status flip only — no new column |
| [Q10](#q10) | Is `parent` needed in the tree payload | Step 7 | No — drop it; flat `path` if needed |
| [Q5](#q5) | Delete semantics for referenced rows | Step 9 | 409 Conflict, not soft-delete |
| [Q8](#q8) | Search bound, pagination and index | — | Moot again; search stays out of scope |

---

## Q11
<a id="q11"></a>

**Gates** step 1 — the first commit. **Decision: ship `whitelist: true` alone; do not enable `forbidNonWhitelisted` yet.**

*The question was:* are there existing API consumers sending extra body fields today? That determines whether step 1 can ship `forbidNonWhitelisted: true` immediately or must ship `whitelist: true` alone and tighten later.

*Why this answer:* `whitelist: true` fully closes [D2](01-defect-analysis.md#d2) — `id` is stripped from the DTO, `repository.create()` stops mapping it onto the entity, and `save()` stops turning into an `UPDATE`. The root cause is dead either way. What `forbidNonWhitelisted` adds is converting previously-tolerated extra fields into `400`s, which is a response-contract change for callers that cannot be surveyed. `INSTRUCTIONS.md` asks for root-cause fixes, not redesign, so take the half that is complete and reversible.

`forbidNonWhitelisted: true` remains the correct end state and should follow a client audit. Recorded as a deliberate deferral, not an omission.

---

## Q3
<a id="q3"></a>

**Gates** step 2, and step 3 behind it. **Decision: upgrade — add `@keyv/redis`, drop `cache-manager-ioredis-yet`.**

*The question was:* swap to keyv + `@keyv/redis`, or downgrade to `@nestjs/cache-manager` ^2 + `cache-manager` ^5 (the API `cache-manager-ioredis-yet` actually targets)?

*Why this answer:* the installed tree settles it.

```
@nestjs/cache-manager: 3.1.3       cache-manager: 7.2.9
cache-manager-ioredis-yet: 2.1.2   <-- targets the cache-manager v5 store API
keyv: 5.6.0                        <-- already present, transitively via cache-manager 7
@keyv/redis: not installed
```

`cache-manager-ioredis-yet` is the wrong generation of adapter for the installed cache-manager: it exposes `del`/`reset` where Keyv-based v7 calls `delete`/`clear`. That mismatch is the second trap named in step 2.

The upgrade adds **one** package and removes one; `keyv` is already in the tree, so this completes a runtime that is already half-present. The downgrade moves `@nestjs/cache-manager` back a major and `cache-manager` back two on a **Nest 11** application — `@nestjs/cache-manager` 3.x is the Nest 11 line, so ^2 invites a peer conflict with `@nestjs/common` 11. Pinning three packages backwards to accommodate one miswired adapter is the wrong direction.

---

## Q7
<a id="q7"></a>

**Gates** step 4. **Decision: leave the request's line items exactly as sent. Do not merge, do not reject.**

*The question was:* should `POST /orders` listing the same `productId` twice be merged into one line item or rejected as a 400? The atomic-decrement fix makes stock correct either way, but the resulting order shape differs and no requirement covers it.

*Why this answer:* the last clause of the question is the answer. **No requirement covers it, and no reported symptom involves it.** An earlier draft chose to merge, on grounds that were about invoice aesthetics ("`Widget x1` three times reads as broken") and a marginal saving in round trips. Neither is a defect anybody reported, and merging changes what comes back from a create — a request that used to produce two rows produced one.

Correctness does not need it. Each line is decremented with its own conditional `UPDATE` inside the transaction, so two lines of 6 against stock 5 fail on the second and roll the whole thing back. Verified: `[{id:1,qty:6},{id:1,qty:6}]` against stock 5 returns `400 Not enough stock for Laptop` and leaves stock at 5, while `[{id:1,qty:2},{id:1,qty:3}]` writes two rows and decrements by 5.

What step 4 *does* keep is processing lines in `productId` order. That is not cosmetic: without a consistent lock order, two concurrent orders touching the same two products in opposite order can deadlock in Postgres, which would surface as a 500 on a normal request.

**Consequence for verification:** the step-4 acceptance test for [D4](01-defect-analysis.md#d4) submits `productId` twice in one order. That stays valid — the request is still accepted, and now asserts two line items and a combined decrement rather than one merged line.

---

## Q6
<a id="q6"></a>

**Gates** steps 5–6. **Decision: make the pay endpoint idempotent with the conditional status flip alone. Do not persist a `transactionId`. No provider contract is available.**

*The question was:* the mock `processPayment(orderId, amount)` has no idempotency-key parameter, so the double-charge risk in the pay path cannot be fully closed inside this codebase. Is the real provider contract available, or should we key off orderId plus a stored transactionId?

*Why this answer:* the provider contract is not available, so nothing keyed on a provider-side idempotency token is implementable here. What *is* implementable is making the state transition conditional (`PENDING` → `CONFIRMED` only): a replayed pay call then finds a non-pending status and returns `400` without re-charging. That is the same conditional-UPDATE mechanism step 5 introduces for [D10](01-defect-analysis.md#d10), and it closes the defect by itself.

**An earlier draft of this decision also persisted the provider's `transactionId` on the order. That half is now dropped**, because it means a new column on the `Order` entity, and `INSTRUCTIONS.md` says *do not add new features or redesign the system*. The stored id would buy an audit trail and a way to recognise a replay after the status has moved on — neither of which any reported symptom asks for. The conditional flip is the root-cause fix; the column is the feature. Keeping the schema untouched also keeps C5 reviewable as a pure behaviour change.

Recorded as a deliberate narrowing, in the same spirit as [Q11](#q11): take the half that fixes the reported defect, leave the half that widens the system.

**State the limit honestly:** this makes the pay *endpoint* idempotent at the API boundary. It cannot make the provider call itself idempotent. If the provider succeeds but its response is lost in flight, the exposure remains. Closing that requires an idempotency key in the provider contract, which is outside this codebase.

---

## Q10
<a id="q10"></a>

**Gates** step 7, and materially changes its size. **Decision: `parent` is not part of the tree payload. Drop the upward branch.**

*The question was:* is `parent` supposed to appear in the category tree payload at all? If consumers only need the downward subtree, the fix is much smaller than a recursive CTE.

*Why this answer:* `buildCategoryTree` currently recurses in **both** directions — `tree.parent = buildCategoryTree(category.parent)` at products.service.ts:101-103 walks up, `children.map(...)` walks down. Two consequences:

1. **The crash.** `findCategory` loads `relations: ['parent','children','products']` exactly one level deep. The root has `parent` populated, but a *child* has `child.parentId` set and `child.parent` undefined. The `if (category.parentId)` guard passes, `buildCategoryTree(undefined)` runs, and it dies dereferencing `category.id`. That is [D7](01-defect-analysis.md#d7).
2. **A latent cycle.** Loading relations deeper makes it worse, not better: `parent.children` contains the node you started from, so up-and-down traversal recurses forever. The one-level-deep load is the only reason it currently terminates.

`parent` is therefore structurally incompatible with a tree walk in the same function. A "category tree" should be its descendants.

**The fix, in order:**
1. Delete the `parent` branch at products.service.ts:101-103.
2. If a breadcrumb is genuinely required later, return it as a **flat** `path: [{id,name},...]` built by walking ancestors iteratively. Flat cannot cycle.
3. Load the subtree properly — TreeRepository or a recursive CTE, with a visited-set. This addresses the incompleteness the crash was hiding. No depth bound, since no endpoint can produce a cycle in `parent_id`.
4. Drop the unused `products` relation in the same pass ([D27](01-defect-analysis.md#d27), free).

**Verification trap:** with the seeded `Electronics → Laptops → Gaming` chain, a tree on Electronics must show **Gaming nested under Laptops**. The one-line `if (category.parent)` guard stops the crash but returns Gaming missing — which looks like a pass. Assert on depth, not on absence of a 500.

---

## Q5
<a id="q5"></a>

**Gates** step 9. **Decision: 409 Conflict. Keep hard delete; do not adopt soft-delete.**

*The question was:* delete semantics for referenced rows — 409 Conflict, or soft-delete via the existing `Product.isAvailable` / `User.isActive` columns? Both columns already exist and are unused by any endpoint, which hints soft-delete was the intent — but that changes what every list/search endpoint must filter on.

*Why this answer:* the reported symptom is *"some failures produce vague or misleading error messages."* Catching `QueryFailedError`, switching on SQLSTATE `23503`, and returning `409 Cannot delete product referenced by existing orders` fixes exactly that symptom, in the same commit as the other FK/unique mappings.

Soft-delete solves a different problem — one nobody reported — and its cost is not local: every list, search, and findOne path must begin filtering on the flag, or "deleted" rows keep appearing everywhere. That is the redesign `INSTRUCTIONS.md` rules out.

The unused `isAvailable` / `isActive` columns are recorded as an observation about probable original intent, not as an action. Adopting soft-delete is a product decision for a later cycle.

---

## Q8
<a id="q8"></a>

**Gates** nothing any more. **Decision: moot — search is out of scope, so there is no bound, no pagination and no index.**

*The question was:* should product search be paginated, and does the DB owner accept a trigram/GIN index on `products(name, description)`?

*Why this answer:* an earlier draft marked this moot because search was out of scope, then reopened it when [D12](01-defect-analysis.md#d12) was promoted to a tenth commit. That promotion has been withdrawn — the predicate measures the same in SQL and in JavaScript at this table size — so the question closes the way it opened.

The intermediate answer was "a hard internal `take` cap, on the grounds that it is not a contract change." That reasoning does not survive contact with the endpoint: a search matching 150 products returned 100, with no total and no next-page marker. For any caller with more matches than the cap, the response silently changed — and silently dropping rows is the same "data is sometimes missing" the report complains about. The cap went out with the commit.

If search ever does need bounding, pagination and the index should be revisited together, behind the same client audit that [Q11](#q11) defers `forbidNonWhitelisted` behind.

---

<a id="part-b"></a>
## Part B — Resolved or non-blocking

Recorded because they document the investigation. None of them gates a fix.

## Q1
<a id="q1"></a>

**Coverage claim — no decision required.** All five reported symptoms map to at least one confirmed defect; no symptom is left unexplained. The thinnest mapping is "cache behavior does not match expectations", carried entirely by the four defects in the cache theme. If operators report cache anomalies that survive step 3, that is a signal something beyond these four is in play.

## Q2
<a id="q2"></a>

**Already answered — this is a correction to the framing we were given, not an open question.** Broken Redis wiring does NOT fully mask the cache-key collision. Because `@nestjs/cache-manager` falls back to an in-process Keyv (not a no-op), `GET /products/search?q=laptop` followed by `?q=shoes` reproduces the wrong-results bug TODAY within a single process. What the wiring defect actually masks is (a) the `db: 0` defect, entirely; (b) persistence across restarts — under `nest start --watch` every file save wipes the cache, which is why the bug reads as intermittent; (c) all cross-instance staleness; and (d) any redis-cli-based verification of a fix. The step ordering stands; the design doc should state the masking precisely rather than claiming the key bug cannot reproduce.

## Q4
<a id="q4"></a>

**A test to run during step 2, not a decision to obtain.** Does switching to a real serializing Redis store break `UsersService.remove()`? users.service.ts:53-55 loads the user via the cached `findOne` and passes it to `usersRepository.remove(user)`. Today that is a live entity instance; after step 2 it is a deserialized plain object with `createdAt` as a string. Must be exercised explicitly as part of step 2 — cache a user, delete them, confirm no throw — rather than assumed.

## Q9
<a id="q9"></a>

**Affects urgency, never content.** Is more than one app instance ever run in production? compose.yaml defines no app service and the README describes a single `pnpm start:dev` process. If single-instance is permanent, the cross-instance half of the cache defect is theoretical and step 2 can be scheduled on cost grounds rather than urgency — but it still gates verification of step 3, so the step ordering is unchanged either way.
