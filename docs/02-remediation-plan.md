# 02 — Remediation Plan

The fixes are **not** independent. Several of them unmask, invalidate, or actively
worsen each other when applied in the wrong order. This document is the ordering and
the reasoning behind it.

## Why order matters here

Three relationships drive the whole sequence:

1. **Masking** — the Redis store is never actually wired up ([D1](01-defect-analysis.md#d1)),
   so the app silently falls back to a per-process in-memory cache. Any cache fix is
   unverifiable until that is corrected.
2. **Worsening in isolation** — awaiting the floating stock update
   ([D4](01-defect-analysis.md#d4)) *without* the surrounding transaction
   ([D3](01-defect-analysis.md#d3)) makes partial commits more deterministic, not less.
3. **Waking dead code** — the payment retry bound and its error mapping
   ([D11](01-defect-analysis.md#d11)) must ship together, because lowering the retry
   count is what makes the unreachable rethrow path reachable.

## The order

### Step 1

- [D2](01-defect-analysis.md#d2) Global ValidationPipe has no whitelist: POST bodies mass-assign entity columns and turn create into UPDATE

First because it is a single line in src/main.ts:7, has zero dependencies on anything else, and is the only defect actively destroying pre-existing rows on every POST. It also has to land BEFORE the DTO-tightening work in step 9: without `whitelist`, tightening decorators only constrains the fields the DTO happens to declare, and undeclared columns still sail through. ROLLOUT RISK: `forbidNonWhitelisted: true` converts previously-tolerated extra fields into 400s, so check existing clients before enabling that half; `whitelist: true` alone (silent strip) is the safe first move if that is uncertain.

### Step 2

- [D1](01-defect-analysis.md#d1) Redis cache store never wired: `store` vs `stores` silently falls back to an in-process Map
- [D18](01-defect-analysis.md#d18) Redis db index hardcoded to 0, ignoring REDIS_DB=1

These two must ship as ONE change and must precede all other cache work. This is the masking relationship the whole plan hinges on: because `options.stores` is undefined, cache-manager falls back to a per-process Keyv, so (a) `db: 0` is 100% inert today and silently starts writing to the wrong logical DB the instant the store is wired, and (b) every cache observation is currently unfalsifiable — `redis-cli` shows nothing, `nest start --watch` wipes the cache on every file save, and no cross-instance behavior exists to test. You cannot verify a cache-key or invalidation fix until Redis is genuinely in the path. TWO TRAPS: renaming `store`→`stores` alone is NOT a fix — Nest wraps a raw store in `new Keyv({ store })` which calls `delete`/`clear`, while cache-manager-ioredis-yet exposes `del`/`reset`, so every `cacheManager.del(...)` at users.service.ts:49,56,57 would start throwing `store.delete is not a function`; the store package must be swapped for @keyv/redis (or bridged with cache-manager's exported KeyvAdapter). And a real Redis store SERIALIZES values, where the current fallback has serialization disabled — so cached reads become plain objects rather than live entity instances, which must be checked against `UsersService.remove()` (users.service.ts:54-55 feeds a cached object into `usersRepository.remove`).

### Step 3

- [D5](01-defect-analysis.md#d5) searchProducts uses one constant cache key for every query
- [D17](01-defect-analysis.md#d17) No product write path invalidates the product-search cache

UNMASKED BY STEP 2. The constant key still produces wrong results within a single process today, but its full behavior — persistence across restarts, sharing across instances, and any redis-cli-based verification — is masked until the store is wired, and the invalidation defect has no observable footprint at all until then. Sequence them together because the invalidation fix depends on the key scheme chosen here: with per-query keys there is no wildcard delete in Keyv, so eviction must use a versioned prefix (`product-search:v{n}:{q}`) bumped by every product write. Doing invalidation before the key fix would be wasted work.

### Step 4

- [D3](01-defect-analysis.md#d3) Order creation is non-transactional: mid-loop failure leaves orphaned order and partial items
- [D4](01-defect-analysis.md#d4) Stock decrement is a floating promise: updateStock is never awaited in create()
- [D8](01-defect-analysis.md#d8) updateStock is a non-atomic absolute-value read-modify-write: lost updates and oversell

One indivisible change to `OrdersService.create()` plus `ProductsService.updateStock`. They cannot be sequenced apart: adding `await` on orders.service.ts:89 alone makes the partial commit MORE deterministic (stock is now certainly written before the line-77 throw fires on a later item), so it makes the data-integrity symptom worse in isolation. Conversely the transaction alone is insufficient because the absolute-value read-modify-write still loses concurrent updates across separate transactions. The correct single change is: wrap the body in `ordersRepository.manager.transaction`, validate all items up front, compute `total` before the single Order INSERT, and replace lines 76-78 + 89 with one atomic `UPDATE products SET stock = stock - :q WHERE id = :id AND stock >= :q` executed through the transaction manager, treating `affected !== 1` as insufficient stock.

### Step 5

- [D9](01-defect-analysis.md#d9) cancel() restores stock non-atomically and non-idempotently
- [D10](01-defect-analysis.md#d10) processPayment has no order-status guard: cancelled orders are resurrected and double-charged

Depends on step 4: both fixes reuse the atomic stock-adjust helper introduced there, and both replace a read-then-save with a conditional UPDATE on the status column. Doing them together makes the order state machine coherent in one pass — cancel flips PENDING→CANCELLED conditionally before restoring stock (making it idempotent), and pay flips PENDING→CONFIRMED conditionally, which is what stops a cancelled order being resurrected. Fixing pay's guard without cancel's conditional flip leaves the double-restore bug; fixing cancel without pay's guard leaves the resurrection path open.

### Step 6

- [D11](01-defect-analysis.md#d11) Payment retry loop: maxRetries = 1000 with flat delay and a non-HttpException rethrow

MUTUAL UNMASKING — the retry bound and the error mapping must be one commit. Today `throw lastError!` at line 123 is unreachable dead code: the mock fails independently at 10% and 1000 consecutive failures has probability ~1e-1000, so exhaustion never happens. Lowering maxRetries to 3 raises that to ~1e-3 per request, which makes the bare-500 rethrow (and, if a provider ever returns `{success:false}`, the `throw undefined` path) LIVE for the first time. Shipping the bound without the ServiceUnavailableException mapping and the explicit non-success terminal branch would convert a latency defect into a fresh production 500.

### Step 7

- [D6](01-defect-analysis.md#d6) GET /orders/:id/full builds a self-referential graph and JSON.stringify's it
- [D7](01-defect-analysis.md#d7) buildCategoryTree dereferences category.parent, which is never loaded for children
- [D27](01-defect-analysis.md#d27) getCategoryTree loads every product of the category and never uses them

Two routes that 500 on essentially every valid request; independent of everything above, so they can land any time, but grouped here because both are pure-read crash fixes. UNMASKING INSIDE THIS STEP: the one-line guard `if (category.parent)` stops the TypeError but immediately reveals that grandchildren are silently missing from the tree, because findCategory loads relations exactly one level deep — so the crash was hiding an incompleteness bug. Fix both together by giving the tree path its own subtree query (recursive CTE or TreeRepository) with a visited-set and depth cap, which is also the natural place to drop the unused `products` relation.

### Step 8

- [D19](01-defect-analysis.md#d19) POST /products/batch binds an inline structural type, so validation is skipped and the real error is masked
- [D13](01-defect-analysis.md#d13) processProductBatch swallows per-item errors and always reports success: true

STRICTLY ORDERED WITHIN THE STEP: the DTO must land before the outer catch is removed. The catch at products.service.ts:126-128 is currently the only thing converting `TypeError: productIds is not iterable` into a 400; remove it first and a malformed body becomes a 500 instead of a vague 400 — worse, not better. Add `ProcessBatchDto` (with `@ArrayMaxSize` to bound the serial round-trips), THEN delete the masking catch, THEN change the return shape to report per-item failures. Note the return-shape change is API-breaking for any existing consumer keying on `success`.

### Step 9

- [D14](01-defect-analysis.md#d14) PATCH /orders/:id/status accepts any body value: no DTO, no enum validation
- [D20](01-defect-analysis.md#d20) GET /orders?userId=<non-numeric> yields NaN in the WHERE clause and a 500
- [D15](01-defect-analysis.md#d15) DELETE on referenced products/users leaks a raw Postgres FK violation as a 500
- [D21](01-defect-analysis.md#d21) Duplicate-email user creation surfaces as a bare 500 instead of 409
- [D22](01-defect-analysis.md#d22) Dangling categoryId/parentId is caught by Postgres, not the API, producing a raw 500
- [D23](01-defect-analysis.md#d23) CreateOrderDto accepts an empty items array and non-integer productId/quantity
- [D24](01-defect-analysis.md#d24) CreateProductDto validates price/stock as loose numbers

The error-mapping and edge-validation sweep. Deliberately after step 1 (whitelist) because tightening individual decorators is only meaningful once undeclared properties are stripped. Deliberately after step 4 because the empty-items and fractional-quantity DTO fixes remove the INPUTS that produce phantom/orphaned orders, while step 4 removes the MECHANISM — the symptom only fully clears when both are in. The three FK/unique-violation mappings (products, users, categories, duplicate email) share one pattern and should be one commit: catch the QueryFailedError, switch on SQLSTATE (23503 / 23505), and translate to 409/404 with a business-language message. Requires a product decision first (see open questions) on delete semantics.

### Step 10

- [D12](01-defect-analysis.md#d12) searchProducts loads the whole products table and filters in Node
- [D16](01-defect-analysis.md#d16) Collection endpoints have no pagination and pull the full eager graph
- [D26](01-defect-analysis.md#d26) Product.category is eager: true, forcing a categories join on every product read

Performance last, because these change response shapes and API contracts (pagination envelopes, capped result counts) and are far safer to land once correctness is settled and there is a regression suite behind steps 1-9. Internal ordering matters: push the search predicate into SQL BEFORE removing the eager flag, so you can confirm from query logs that the join disappearing is the eager change and not the new WHERE clause. Removing `eager: true` requires auditing every call site that currently gets `category` for free — products.service.ts:22 and :28 already request it explicitly, but nested loads through `items.product` do not.

### Step 11

- [D25](01-defect-analysis.md#d25) Decimal columns come back from Postgres as strings

Genuinely last. Adding a transformer changes the JSON type of every money field on every read (`"19.99"` → `19.99`) across products, orders and order items simultaneously — a breaking change for any client currently string-handling those values, and it makes the `Number(order.total)` cast at orders.service.ts:110 dead code. It fixes no crash and no data loss on its own, so it should follow a client-coordination window rather than lead one. Doing it earlier would also churn the expected values in every test written for steps 4-9.


## Verification per defect

| # | Defect | How to verify the fix |
|---|---|---|
| [D1](01-defect-analysis.md#d1) | Redis cache store never wired: `store` vs `stores` silently falls back to an in-process Map | `redis-cli -n 1 -p 6380 FLUSHDB; curl -s localhost:3000/users > /dev/null; redis-cli -n 1 -p 6380 KEYS '*'` must now list `users:all`. Then `curl -X POST localhost:3000/users -H 'content-type: application/json' -d '{"email":"t@t.co","name":"T"}'` and confirm `redis-cli -n 1 -p 6380 EXISTS users:all` returns 0 (the del path works and does not throw). Restart the process and confirm a previously warmed key survives. |
| [D2](01-defect-analysis.md#d2) | Global ValidationPipe has no whitelist: POST bodies mass-assign entity columns and turn create into UPDATE | `curl -s localhost:3000/products/5` and note the name. Then `curl -i -X POST localhost:3000/products -H 'content-type: application/json' -d '{"id":5,"name":"PWNED","price":1}'` must return 400 with `property id should not exist`, and `curl -s localhost:3000/products/5` must show the original name unchanged. Repeat for `POST /users` with an extra `id` and `isActive`. |
| [D3](01-defect-analysis.md#d3) | Order creation is non-transactional: mid-loop failure leaves orphaned order and partial items | With product B at stock 0: `curl -s -X POST localhost:3000/orders -H 'content-type: application/json' -d '{"userId":1,"items":[{"productId":A,"quantity":1},{"productId":B,"quantity":1}]}'` → 400. Then `psql -p 5434 -U postgres -d challengedb -c "select count(*) from orders where total=0 and status='pending'"` must not have increased, `select count(*) from order_items` must be unchanged, and `curl -s localhost:3000/products/A` must show the original stock. |
| [D4](01-defect-analysis.md#d4) | Stock decrement is a floating promise: updateStock is never awaited in create() | `curl -s -X POST localhost:3000/orders -H 'content-type: application/json' -d '{"userId":1,"items":[{"productId":7,"quantity":3},{"productId":7,"quantity":3}]}'` against product 7 at stock 10, then `curl -s localhost:3000/products/7 \| jq .stock` must read 4, not 7. Also confirm the 201 response body's `items[].product.stock` already reflects the decrement. |
| [D5](01-defect-analysis.md#d5) | searchProducts uses one constant cache key for every query | After the Redis fix: `redis-cli -n 1 -p 6380 FLUSHDB; curl -s 'localhost:3000/products/search?q=laptop'; curl -s 'localhost:3000/products/search?q=shoes'` must return two different result sets, and `redis-cli -n 1 -p 6380 KEYS 'product-search*'` must list two distinct keys. |
| [D6](01-defect-analysis.md#d6) | GET /orders/:id/full builds a self-referential graph and JSON.stringify's it | `curl -i -s localhost:3000/orders/1/full` must return 200 with the order body (currently 500). `curl -i -s localhost:3000/orders/999999/full` must still return 404 with `Order #999999 not found`. |
| [D7](01-defect-analysis.md#d7) | buildCategoryTree dereferences category.parent, which is never loaded for children | `curl -X POST localhost:3000/categories -d '{"name":"A"}' -H 'content-type: application/json'` then `curl -X POST localhost:3000/categories -d '{"name":"B","parentId":<A>}' -H 'content-type: application/json'`, then `curl -i -s localhost:3000/categories/<A>/tree` must return 200 with B in `children` (currently 500). Add C under B and confirm `GET /categories/<A>/tree` shows the grandchild — the minimal one-line guard alone will NOT, which is the unmasking noted in the fix order. |
| [D8](01-defect-analysis.md#d8) | updateStock is a non-atomic absolute-value read-modify-write: lost updates and oversell | Product 5 at stock 10. Run two concurrent orders for 10 units each: `for i in 1 2; do curl -s -X POST localhost:3000/orders -H 'content-type: application/json' -d '{"userId":1,"items":[{"productId":5,"quantity":10}]}' & done; wait`. Exactly one must return 201 and one must return 400 'Not enough stock'; `curl -s localhost:3000/products/5 \| jq .stock` must read 0, never a negative number and never 0 with two 201s. |
| [D9](01-defect-analysis.md#d9) | cancel() restores stock non-atomically and non-idempotently | Order 1 pending with 3 units of product 9 at stock 5. `for i in 1 2; do curl -s -X POST localhost:3000/orders/1/cancel & done; wait` — exactly one 200 and one 400, and `curl -s localhost:3000/products/9 \| jq .stock` must read 8, not 11. Repeat the cancel serially afterwards: must return 400 and leave stock at 8. |
| [D10](01-defect-analysis.md#d10) | processPayment has no order-status guard: cancelled orders are resurrected and double-charged | `curl -s -X POST localhost:3000/orders/1/cancel` then `curl -i -s -X POST localhost:3000/orders/1/pay` must return 400 naming the current status, and `curl -s localhost:3000/orders/1 \| jq .status` must still read `cancelled`. Then on a fresh pending order: `for i in 1 2; do curl -s -X POST localhost:3000/orders/2/pay & done; wait` — exactly one 200 and one 400. |
| [D11](01-defect-analysis.md#d11) | Payment retry loop: maxRetries = 1000 with flat delay and a non-HttpException rethrow | Temporarily set the mock's failure probability to 1 (`if (true) throw ...` at line 16) and `time curl -i -s -X POST localhost:3000/orders/1/pay`: must complete in under ~1s (3 attempts with backoff) and return 503 with 'Payment service unavailable', not 500 and not ~200s. Revert the mock; a normal pay must still return 200 within a few hundred ms. |
| [D12](01-defect-analysis.md#d12) | searchProducts loads the whole products table and filters in Node | Seed ~50k products, then `time curl -s 'localhost:3000/products/search?q=zzz' \| jq length` on a cold cache — must return in tens of milliseconds with a small array. Enable `logging: ['query']` on the TypeORM config and confirm the emitted SQL contains `ILIKE` and `LIMIT`, and that no `SELECT * FROM products` without a WHERE clause is issued. |
| [D13](01-defect-analysis.md#d13) | processProductBatch swallows per-item errors and always reports success: true | `curl -s -X POST localhost:3000/products/batch -H 'content-type: application/json' -d '{"productIds":[1,9001,9002]}'` must return `{"success":false,"processed":1,"failed":[{"id":9001,...},{"id":9002,...}]}` and the server log must name both ids with their NotFoundException messages. |
| [D14](01-defect-analysis.md#d14) | PATCH /orders/:id/status accepts any body value: no DTO, no enum validation | `curl -i -s -X PATCH localhost:3000/orders/1/status -H 'content-type: application/json' -d '{"status":"banana"}'` must return 400 listing the valid enum values (currently 500). `curl -i -s -X PATCH localhost:3000/orders/1/status -H 'content-type: application/json' -d '{}'` must return 400, not a 200 with an unchanged order. |
| [D15](01-defect-analysis.md#d15) | DELETE on referenced products/users leaks a raw Postgres FK violation as a 500 | Place an order for product P by user U, then `curl -i -s -X DELETE localhost:3000/products/P` must return 409 with a message naming the constraint in business terms (currently 500), and `curl -i -s -X DELETE localhost:3000/users/U` likewise. Deleting an unreferenced product must still return 200. |
| [D16](01-defect-analysis.md#d16) | Collection endpoints have no pagination and pull the full eager graph | `curl -s 'localhost:3000/orders' \| jq length` must return at most the default page size against a seeded table of several thousand orders, and `curl -s 'localhost:3000/orders?limit=5&offset=10' \| jq length` must return 5. `curl -s 'localhost:3000/orders?limit=100000' \| jq length` must be capped at the hard maximum. Same three checks on `/products`. |
| [D17](01-defect-analysis.md#d17) | No product write path invalidates the product-search cache | After the Redis and cache-key fixes: `curl -s 'localhost:3000/products/search?q=widget' \| jq length` (warms), then `curl -X DELETE localhost:3000/products/42`, then immediately re-run the search — product 42 must be absent without waiting 60s. Also create a new matching product and confirm it appears in the next search immediately. |
| [D18](01-defect-analysis.md#d18) | Redis db index hardcoded to 0, ignoring REDIS_DB=1 | `redis-cli -n 1 -p 6380 FLUSHDB; redis-cli -n 0 -p 6380 FLUSHDB; curl -s localhost:3000/users > /dev/null; redis-cli -n 1 -p 6380 KEYS '*'` must list `users:all` and `redis-cli -n 0 -p 6380 KEYS '*'` must be empty. |
| [D19](01-defect-analysis.md#d19) | POST /products/batch binds an inline structural type, so validation is skipped and the real error is masked | `curl -i -s -X POST localhost:3000/products/batch -H 'content-type: application/json' -d '{}'` must return 400 with `productIds should not be empty` / `productIds must be an array` (currently 400 'Batch processing failed'). `curl -i -s -X POST localhost:3000/products/batch -H 'content-type: application/json' -d '{"productIds":"1,2,3"}'` must return 400 naming the type error. A 600-element array must return 400 citing the max size. |
| [D20](01-defect-analysis.md#d20) | GET /orders?userId=<non-numeric> yields NaN in the WHERE clause and a 500 | `curl -i -s 'localhost:3000/orders?userId=abc'` must return 400 'Validation failed (numeric string is expected)' (currently 500). `curl -i -s 'localhost:3000/orders?userId=3abc'` must also return 400, not user 3's orders. `curl -i -s 'localhost:3000/orders'` must still return the (now paginated) full list. |
| [D21](01-defect-analysis.md#d21) | Duplicate-email user creation surfaces as a bare 500 instead of 409 | `curl -X POST localhost:3000/users -H 'content-type: application/json' -d '{"email":"dup@x.com","name":"A"}'` then repeat the identical request: the second must return 409 with 'User with email dup@x.com already exists' (currently 500). |
| [D22](01-defect-analysis.md#d22) | Dangling categoryId/parentId is caught by Postgres, not the API, producing a raw 500 | `curl -i -s -X POST localhost:3000/products -H 'content-type: application/json' -d '{"name":"X","price":1,"categoryId":99999}'` must return 404 'Category #99999 not found' (currently 500). `curl -i -s -X POST localhost:3000/categories -H 'content-type: application/json' -d '{"name":"X","parentId":99999}'` likewise. `"categoryId":1.5` must return 400 naming the field. |
| [D23](01-defect-analysis.md#d23) | CreateOrderDto accepts an empty items array and non-integer productId/quantity | `curl -i -s -X POST localhost:3000/orders -H 'content-type: application/json' -d '{"userId":1,"items":[]}'` must return 400 'items should not be empty' (currently 201). `... -d '{"userId":1,"items":[{"productId":1,"quantity":2.5}]}'` must return 400 naming quantity (currently 500), and `select count(*) from orders where total=0` must not increase after either call. |
| [D24](01-defect-analysis.md#d24) | CreateProductDto validates price/stock as loose numbers | `curl -i -s -X POST localhost:3000/products -H 'content-type: application/json' -d '{"name":"X","price":19.999}'` must return 400 citing maxDecimalPlaces (currently 201 echoing 19.999). `... -d '{"name":"X","price":1,"stock":2.5}'` must return 400 naming stock (currently 500). |
| [D25](01-defect-analysis.md#d25) | Decimal columns come back from Postgres as strings | `ID=$(curl -s -X POST localhost:3000/products -H 'content-type: application/json' -d '{"name":"W","price":19.99}' \| jq -r .id); curl -s localhost:3000/products/$ID \| jq '.price\|type'` must print `number` (currently `string`). Same check on `curl -s localhost:3000/orders/1 \| jq '.total\|type'` and `.items[0].price\|type`. |
| [D26](01-defect-analysis.md#d26) | Product.category is eager: true, forcing a categories join on every product read | Enable `logging: ['query']` in the TypeORM config, then `curl -s localhost:3000/orders/1 > /dev/null` and confirm the emitted SQL no longer contains a join to `categories`. `curl -s localhost:3000/products/1 \| jq .category` must still be populated (that call site requests the relation explicitly). |
| [D27](01-defect-analysis.md#d27) | getCategoryTree loads every product of the category and never uses them | Seed a category with several thousand products, enable `logging: ['query']`, then `curl -s localhost:3000/categories/3/tree > /dev/null` and confirm no join to `products` appears in the emitted SQL and the response time drops accordingly. `curl -s localhost:3000/categories/3 \| jq '.products\|length'` must still be populated. |
