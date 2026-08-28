# 05 — Reproduction Runbook

Step-by-step commands to make each defect fail in front of you, **before any fix**.

`INSTRUCTIONS.md` asks to "reproduce the reported issues where possible." This is
that. Every *Observed* block below is real output captured from a run against the
seeded fixture — not predicted output.

Run everything in **Git Bash** (the `curl` and `docker exec` syntax is POSIX).

---

## Setup

### 1. Start the stack

Ports 5432/6379 are taken by other containers on this machine, so the challenge runs
on 5434/6380 via a local compose file:

```bash
docker compose -f compose.local.yaml up -d
pnpm install
pnpm run start:dev
```

Leave the app running in its own terminal — **you need to watch its log**, because
most defects surface as a bare `500` on the wire while the real error only appears in
the server output.

### 2. Reset to a known state

Run this before a repro session, and any time you want to start clean:

```bash
docker exec challenge-db psql -U postgres -d challengedb \
  -c "TRUNCATE order_items, orders, products, categories, users RESTART IDENTITY CASCADE;"

curl -s -X POST localhost:3000/users      -H "Content-Type: application/json" -d '{"email":"alice@test.com","name":"Alice"}'
curl -s -X POST localhost:3000/categories -H "Content-Type: application/json" -d '{"name":"Electronics"}'
curl -s -X POST localhost:3000/categories -H "Content-Type: application/json" -d '{"name":"Laptops","parentId":1}'
curl -s -X POST localhost:3000/categories -H "Content-Type: application/json" -d '{"name":"Gaming","parentId":2}'
curl -s -X POST localhost:3000/products   -H "Content-Type: application/json" -d '{"name":"Laptop","description":"a fast laptop","price":999.99,"stock":10,"categoryId":2}'
curl -s -X POST localhost:3000/products   -H "Content-Type: application/json" -d '{"name":"Mouse","description":"wireless mouse","price":25.50,"stock":3,"categoryId":1}'
```

That gives you: 1 user, a 3-level category chain (Electronics → Laptops → Gaming),
and 2 products.

> **Restarting the app clears the cache.** The cache is in-process (that *is*
> [D1](01-defect-analysis.md#d1)), so `pnpm start:dev` recompiling on file save wipes
> it. If a cache repro behaves oddly, that's why.

---

## A. Data loss and corruption

### D2 — `POST /users` silently destroys an existing row

The single most destructive defect. A *create* endpoint performing a *delete-by-overwrite*.

```bash
curl -s localhost:3000/users

curl -s -X POST localhost:3000/users -H "Content-Type: application/json" \
  -d '{"id":1,"email":"attacker@evil.com","name":"Overwritten"}'

docker exec challenge-db psql -U postgres -d challengedb -c "SELECT id, email, name FROM users ORDER BY id;"
```

**Expected:** `400` rejecting the unknown `id` property, or a new user at `id: 2`. Alice untouched.

**Observed:**
```
HTTP 201
{"id":1,"email":"attacker@evil.com","name":"Overwritten"}

 id |       email       |    name
----+-------------------+-------------
  1 | attacker@evil.com | Overwritten
(1 row)
```

**Alice is gone.** The response says `201 Created` while the row count stays at 1.
`ValidationPipe` has no `whitelist`, so `id` survives onto the DTO, and
`repository.create()` maps it onto the entity — turning `save()` into an `UPDATE`.

---

### D3 — A failed order still writes an order and consumes stock

The clearest "data is sometimes inconsistent" repro. Order two items where the
**second** is short on stock.

```bash
docker exec challenge-db psql -U postgres -d challengedb -tAc \
  "SELECT (SELECT count(*) FROM orders), (SELECT stock FROM products WHERE id=1);"

curl -s -X POST localhost:3000/orders -H "Content-Type: application/json" \
  -d '{"userId":1,"items":[{"productId":1,"quantity":1},{"productId":2,"quantity":99}]}'

docker exec challenge-db psql -U postgres -d challengedb -tAc \
  "SELECT (SELECT count(*) FROM orders), (SELECT stock FROM products WHERE id=1);"

docker exec challenge-db psql -U postgres -d challengedb -c \
  "SELECT o.id, o.status, o.total, count(oi.id) AS items FROM orders o LEFT JOIN order_items oi ON oi.order_id=o.id GROUP BY o.id, o.status, o.total ORDER BY o.id;"
```

**Expected:** `400`, and **nothing** persisted — no order row, no stock change.

**Observed:**
```
before: 1 order, Laptop stock 8
HTTP 400  {"message":"Not enough stock for Mouse","error":"Bad Request","statusCode":400}
after:  2 orders, Laptop stock 7      <-- both changed despite the 400

 id | status  |  total  | items
----+---------+---------+-------
  1 | pending | 1999.98 |     1
  2 | pending |    0.00 |     1     <-- orphaned: total 0.00, never completed
```

The caller got an error, but order #2 exists with `total 0.00` and one item, and a
Laptop was permanently removed from inventory. No transaction wraps the loop.

---

### D10 — A cancelled order can still be paid

```bash
OID=$(curl -s -X POST localhost:3000/orders -H "Content-Type: application/json" \
  -d '{"userId":1,"items":[{"productId":2,"quantity":1}]}' | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)

curl -s -X POST localhost:3000/orders/$OID/cancel > /dev/null
docker exec challenge-db psql -U postgres -d challengedb -tAc "SELECT status FROM orders WHERE id=$OID;"

curl -s -X POST localhost:3000/orders/$OID/pay
docker exec challenge-db psql -U postgres -d challengedb -tAc "SELECT id, status FROM orders WHERE id=$OID;"
```

**Expected:** the pay call returns `400 Only pending orders can be paid`.

**Observed:**
```
status after cancel: cancelled
HTTP 201  {"success":true,"transactionId":"TXN-1787940674774"}
status after pay:    confirmed        <-- resurrected
```

**A customer is charged for an order they cancelled**, and the stock that `cancel()`
already restored is never re-deducted. `processPayment` reads the order and writes
`CONFIRMED` with no status guard.

---

### D8 — Concurrent orders oversell  ⚠️ intermittent

```bash
docker exec challenge-db psql -U postgres -d challengedb -c \
  "DELETE FROM order_items WHERE product_id=2; UPDATE products SET stock=5 WHERE id=2;"

seq 1 10 | xargs -P 10 -I{} curl -s -o /dev/null -w "%{http_code} " \
  -X POST localhost:3000/orders -H "Content-Type: application/json" \
  -d '{"userId":1,"items":[{"productId":2,"quantity":1}]}'

docker exec challenge-db psql -U postgres -d challengedb -tAc "SELECT stock FROM products WHERE id=2;"
```

**Expected:** exactly 5 × `201`, 5 × `400`, final stock `0`.

**Observed across 3 runs:**
```
run 1: accepted=6  (correct=5)   <-- oversold by 1
run 2: accepted=5  (correct=5)
run 3: accepted=5  (correct=5)
```

**Be honest about this one: it reproduced 1 time in 3.** `updateStock` writes an
absolute value computed from a stale read, so two requests that read `stock: 5` both
write `4`. On a fast local loop the window is narrow. Raise concurrency, or add
latency between the read and the write, to widen it. The defect is structural even
when a given run doesn't catch it.

---

### D4 — Un-awaited stock writes race each other inside one request

An earlier draft of this runbook called D4 "not independently observable." **That was
wrong**, and the correction matters: D4 reproduces on its own, without concurrency,
more reliably than D8 does.

The trick is the number of line items. With two, the two un-awaited `updateStock`
calls usually serialise and stock lands on the correct value. With five, the window
opens wide enough to land every time — the floating promises race *each other* inside
a single request.

```bash
for run in 1 2 3 4 5; do
  docker exec challenge-db psql -U postgres -d challengedb -q     -c "UPDATE products SET stock=10 WHERE id=1;"
  curl -s -o /dev/null -X POST localhost:3000/orders -H "Content-Type: application/json"     -d '{"userId":1,"items":[{"productId":1,"quantity":1},{"productId":1,"quantity":1},{"productId":1,"quantity":1},{"productId":1,"quantity":1},{"productId":1,"quantity":1}]}'
  sleep 0.7
  echo -n "run $run: 5x1 from stock 10 -> "
  docker exec challenge-db psql -U postgres -d challengedb -tAc "SELECT stock FROM products WHERE id=1;"
done
```

**Expected:** stock `5` every run (10 − 5×1).

**Observed:**
```
run 1: 5x1 from stock 10 -> 7      <-- only 3 of 5 decrements applied
run 2: 5x1 from stock 10 -> 7
run 3: 5x1 from stock 10 -> 7
run 4: 5x1 from stock 10 -> 8      <-- only 2 of 5 applied
run 5: 5x1 from stock 10 -> 7
```

**5 of 5 runs lost updates.** `create()` fires `updateStock` without `await`, so every
call reads stock before any of them writes. This is the same lost-update mechanism as
[D8](01-defect-analysis.md#d8), but self-inflicted within one request — which is why
it lands every time where D8 needs a lucky interleaving.

Note this repro depends on duplicate `productId` entries being accepted, which
[Q7](03-open-questions.md#q7) settles as *merge, not reject*. If that had been decided
the other way, this construction would start returning 400 and silently stop testing
anything.

---

### D9 — not independently observed

- **[D9](01-defect-analysis.md#d9)** (`cancel()` non-atomic) — same class of race as
  D8, guarded by a check-then-act on `status`. Requires concurrent cancels to observe,
  and given D8 landed only 1 run in 3 with ten parallel requests, chasing it the same
  way was not judged worth the time for a mechanism already demonstrated.

Confirmed by reading the code, not by a reproduction. Treat it as structural rather
than demonstrated.

---

## B. Endpoints that 500 on valid input

### D7 — Category tree crashes on every category

```bash
curl -s -w "\nHTTP:%{http_code}\n" localhost:3000/categories/1/tree
curl -s -w "\nHTTP:%{http_code}\n" localhost:3000/categories/2/tree
curl -s -w "\nHTTP:%{http_code}\n" localhost:3000/categories/3/tree
```

**Expected:** a nested tree.

**Observed:** all three return
```
HTTP 500  {"statusCode":500,"message":"Internal server error"}
```

Server log gives the real cause:
```
TypeError: Cannot read properties of undefined (reading 'id')
    at ProductsService.buildCategoryTree (products.service.ts:96:20)
    at ProductsService.buildCategoryTree (products.service.ts:102:26)   <-- parent branch
    at ProductsService.buildCategoryTree (products.service.ts:106:41)   <-- children branch
```

`findCategory` loads relations exactly **one level deep**, so a child's `.parent` and
a parent's `.children` are `undefined`. The recursion walks into `undefined` from
both directions. Note this is **not** infinite recursion — it's a null dereference,
which is why the fix is a proper subtree query rather than a cycle guard.

---

### D6 — `/orders/:id/full` crashes on every call

```bash
curl -s -w "\nHTTP:%{http_code}\n" localhost:3000/orders/1/full
```

**Expected:** the order with user, items, products, categories.

**Observed:** `HTTP 500`, server log:
```
TypeError: Converting circular structure to JSON
```

The method sets `enriched.user.latestOrder = enriched` — a self-reference — then
calls `JSON.parse(JSON.stringify(enriched))` on it.

---

## C. Cache

### D1 — The cache never reaches Redis

Three observations, together conclusive.

**1. Redis is empty after exercising every cached endpoint:**
```bash
curl -s localhost:3000/users > /dev/null
curl -s "localhost:3000/products/search?q=laptop" > /dev/null
for d in 0 1; do echo -n "db$d: "; docker exec challenge-redis redis-cli -n $d dbsize; done
```
```
db0: 0
db1: 0
```

**2. Flushing Redis has no effect on the app's cache:**
```bash
docker exec challenge-redis redis-cli flushall
curl -s "localhost:3000/products/search?q=mouse"     # still returns the cached value
```

**3. But restarting the app *does* clear it** — `touch src/main.ts`, wait for the
watch rebuild, and the same query returns fresh results.

Root cause, verifiable without running anything:
```bash
grep -c "options.stores" node_modules/@nestjs/cache-manager/dist/cache.providers.js   # 3
grep -c "options.store\b" node_modules/@nestjs/cache-manager/dist/cache.providers.js  # 0
```
`app.module.ts:33` passes `store` (singular). The installed package reads `stores`
(plural). The Redis store is discarded and `cache-manager` falls back to an
in-process `Keyv` Map. **This is why the symptom reads as *intermittent*: every
deploy or file save silently empties the cache.**

[D18](01-defect-analysis.md#d18) (`db: 0` hardcoded over `REDIS_DB=1`) is inert today
for the same reason — and starts writing to the wrong logical DB the moment D1 is fixed.

---

### D5 — Every search returns the first search's results

```bash
docker exec challenge-redis redis-cli flushall   # no-op, see D1 — restart the app instead
curl -s "localhost:3000/products/search?q=laptop"
curl -s "localhost:3000/products/search?q=mouse"
curl -s "localhost:3000/products/search?q=zzzznomatch"
```

**Expected:** `[Laptop]`, then `[Mouse]`, then `[]`.

**Observed:**
```
q=laptop      -> [ 'Laptop' ]
q=mouse       -> [ 'Laptop' ]     <-- wrong
q=zzzznomatch -> [ 'Laptop' ]     <-- a query matching nothing returns a product
```

`const cacheKey = 'product-search'` — one constant key for every query.

---

### D17 — Creating a product doesn't invalidate the search cache

Restart the app first so the cache is empty.

```bash
curl -s "localhost:3000/products/search?q=mouse"      # populates the cache

curl -s -X POST localhost:3000/products -H "Content-Type: application/json" \
  -d '{"name":"Mouse Mat XL","description":"large mat","price":14.99,"stock":30,"categoryId":1}'

curl -s "localhost:3000/products/search?q=mouse"      # should now include it
docker exec challenge-db psql -U postgres -d challengedb -tAc \
  "SELECT name FROM products WHERE name ILIKE '%mouse%' ORDER BY id;"
```

**Observed:**
```
search before create: [ 'Mouse', 'Mousepad' ]
created:              Mouse Mat XL
search after create:  [ 'Mouse', 'Mousepad' ]     <-- stale

DB truth:  Mouse / Mousepad / Mouse Mat XL
```

No product write path evicts the cache.

---

## D. Misleading and vague errors

### D13 — Batch reports success while items fail

```bash
curl -s -X POST localhost:3000/products/batch -H "Content-Type: application/json" \
  -d '{"productIds":[1,999,998]}'
```

**Expected:** a per-item result, or a non-success status — 2 of 3 ids don't exist.

**Observed:**
```
HTTP 201   {"success":true,"processed":1}
```

`success: true` after two thirds of the work failed. The only trace is a
`console.log('Error processing product')` on the server with no id and no reason.

And with a malformed body:
```bash
curl -s -X POST localhost:3000/products/batch -H "Content-Type: application/json" -d '{"wrongField":[1]}'
```
```
HTTP 400   {"message":"Batch processing failed","error":"Bad Request","statusCode":400}
```
The real cause (`productIds` is undefined, so the loop throws) is rewritten into a
message that tells you nothing.

---

### D14 / D15 / D20 / D21 / D22 — raw driver errors leak as bare 500s

Each returns the identical, useless `{"statusCode":500,"message":"Internal server error"}`:

```bash
# D14 — invalid status enum        expected 400
curl -s -w " -> %{http_code}\n" -X PATCH localhost:3000/orders/1/status \
  -H "Content-Type: application/json" -d '{"status":"banana"}'

# D20 — non-numeric userId         expected 400
curl -s -w " -> %{http_code}\n" "localhost:3000/orders?userId=abc"

# D21 — duplicate email            expected 409
curl -s -w " -> %{http_code}\n" -X POST localhost:3000/users \
  -H "Content-Type: application/json" -d '{"email":"alice@test.com","name":"Dup"}'

# D22 — category that doesn't exist  expected 400/404
curl -s -w " -> %{http_code}\n" -X POST localhost:3000/products \
  -H "Content-Type: application/json" -d '{"name":"Ghost","price":1,"stock":1,"categoryId":999}'

# D15 — delete a product an order references  expected 409
curl -s -w " -> %{http_code}\n" -X DELETE localhost:3000/products/1
```

**Observed:** all five → `500`. The server log holds what the client should have been told:

| Test | Actual underlying error | Should be |
|---|---|---|
| D14 | `QueryFailedError: invalid input value for enum orders_status_enum: "banana"` | `400` |
| D20 | `QueryFailedError: invalid input syntax for type integer: "NaN"` | `400` |
| D21 | `QueryFailedError: duplicate key value violates unique constraint "UQ_..."` (23505) | `409` |
| D22 | `QueryFailedError: insert or update on "products" violates foreign key constraint` (23503) | `400` / `404` |
| D15 | `QueryFailedError: update or delete on "products" violates foreign key constraint ... on table "order_items"` (23503) | `409` |

This is the whole "vague or misleading error messages" symptom in one table.

---

## E. Slow / never completes

### D11 — Unbounded payment retry  ⚠️ partially reproducible

```bash
docker exec challenge-db psql -U postgres -d challengedb -c "UPDATE products SET stock=500 WHERE id=1;"

for i in $(seq 1 12); do
  OID=$(curl -s -X POST localhost:3000/orders -H "Content-Type: application/json" \
    -d '{"userId":1,"items":[{"productId":1,"quantity":1}]}' | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)
  curl -s -o /dev/null -w "%{time_total} " -X POST localhost:3000/orders/$OID/pay
done
```

**Observed:**
```
0.131 0.121 0.341 0.128 0.119 0.122 0.124 0.125 0.123 0.124 0.117 0.126
              ^^^^^ a retry fired: +~200ms
```

The retry path is real and measurable. **What you cannot reproduce here is the
symptom**, and it's worth being precise about why: the mock fails independently at
10%, so exhausting 1000 attempts has probability ~10⁻¹⁰⁰⁰. `maxRetries = 1000` with a
flat 100ms delay only bites when the provider is *persistently* down — then it is
1000 × ~200ms ≈ **200 seconds** on one HTTP request before it gives up. That is the
"never complete" report.

To see it, make the mock fail every time (`if (true)` in `processPayment`) and watch
one request hang. Revert afterwards.

---

### D12 — Search scans the whole table  🔍 not yet executed

**Status: procedure only.** D12 moved into scope
([C10](04-scope.md#c10-search-scans-the-whole-products-table)) after this runbook was
captured, and demonstrating it needs a table this stack was never seeded to have.
Everything else in this file is real captured output; this section is not. Marked
rather than quietly folded in.

```bash
# seed ~50k products
docker exec challenge-db psql -U postgres -d challengedb -c   "INSERT INTO products (name, description, price, stock, is_available)
   SELECT 'bulk-'||g, 'filler', 9.99, 100, true FROM generate_series(1,50000) g;"

# cold cache, then time a search that matches almost nothing
docker exec challenge-redis redis-cli -n 1 FLUSHDB
time curl -s 'localhost:3000/products/search?q=zzzz' | jq length
```

**Expected before the fix:** every request that misses the cache runs
`SELECT * FROM products` with the eager categories join, hydrates 50k entities, and
filters them in the event loop to return a handful of rows — hundreds of milliseconds
to seconds, and the event loop blocked for the duration. `q=` (empty) is the worse
case: `includes('')` matches every row, so the whole table is serialized into the
response *and* into the cache entry.

**Expected after C10:** tens of milliseconds, with `ILIKE` and `LIMIT` visible in the
SQL once `logging: ['query']` is enabled on the TypeORM config, and no
`SELECT * FROM products` without a WHERE clause.

**Why this matters more than the numbers suggest** — the timing above is the *cold
miss* cost, and until [C2](04-scope.md#c2-cache-never-reaches-redis) lands nearly
every request is a cold miss: the fallback cache is per-process and `nest start
--watch` wipes it on every file save. See [D1](#d1--the-cache-never-reaches-redis).

---

## Summary — what was actually observed

| Defect | Status |
|---|---|
| [D1](01-defect-analysis.md#d1) Redis never wired | ✅ Reproduced |
| [D2](01-defect-analysis.md#d2) Mass assignment destroys rows | ✅ Reproduced |
| [D3](01-defect-analysis.md#d3) Non-transactional order create | ✅ Reproduced |
| [D5](01-defect-analysis.md#d5) Constant search cache key | ✅ Reproduced |
| [D6](01-defect-analysis.md#d6) Circular JSON 500 | ✅ Reproduced |
| [D7](01-defect-analysis.md#d7) Category tree 500 | ✅ Reproduced |
| [D10](01-defect-analysis.md#d10) Cancelled order can be paid | ✅ Reproduced |
| [D13](01-defect-analysis.md#d13) Batch reports false success | ✅ Reproduced |
| [D14](01-defect-analysis.md#d14) Unvalidated status enum | ✅ Reproduced |
| [D15](01-defect-analysis.md#d15) FK violation on delete | ✅ Reproduced |
| [D17](01-defect-analysis.md#d17) No cache invalidation | ✅ Reproduced |
| [D20](01-defect-analysis.md#d20) NaN userId | ✅ Reproduced |
| [D21](01-defect-analysis.md#d21) Duplicate email | ✅ Reproduced |
| [D22](01-defect-analysis.md#d22) Dangling FK | ✅ Reproduced |
| [D4](01-defect-analysis.md#d4) Floating stock promise | ✅ Reproduced — 5 of 5 runs |
| [D8](01-defect-analysis.md#d8) Concurrent oversell | ⚠️ Intermittent — 1 of 3 runs |
| [D11](01-defect-analysis.md#d11) Unbounded retry | ⚠️ Retry observed; exhaustion needs a forced-failure mock |
| [D9](01-defect-analysis.md#d9) Non-atomic cancel | 🔍 By inspection — same race class as D8 |
| [D18](01-defect-analysis.md#d18) `db: 0` over `REDIS_DB` | 🔍 By inspection — inert until D1 is fixed |
| [D12](01-defect-analysis.md#d12) Search scans the whole table | 🔍 Not yet executed — moved into scope after this capture; needs a seeded 50k table |

**15 of 20 reproduced directly, 2 partially, 2 by code inspection, 1 not yet executed.**

D4 moved from "by inspection" to reproduced after the five-line-item construction
above was found. The two remaining inspection-only defects are D9 (needs concurrent
cancels; same mechanism as D8, already demonstrated) and D18 (100% masked by D1 —
nothing reaches Redis, so the `db` index has no effect to observe until C2 lands).
D12 is a separate case: not masked and not inspection-only, simply not yet run,
because it entered scope after this capture and needs a seeded table.

This supersedes the earlier caveat in the [README](README.md#limits-of-this-method)
that only 2 of 27 defects had been executed.

## After fixing

Every step above is also the acceptance test. Re-run the setup, then re-run the
section for whatever you changed — the *Expected* block is the pass condition.
