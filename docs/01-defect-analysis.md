# 01 — Defect Analysis

27 confirmed defects, ranked by severity then blast radius. Each was
adversarially verified against the actual source.

Confidence is the verifier's, not the finder's: **certain** means the mechanism was
traced end to end in the installed code; **likely** means the mechanism is sound but
one link rests on documented library behaviour rather than a read of the code.

## Index

| # | Severity | Defect | Location |
|---|---|---|---|
| [D1](#d1) | 🔴 Critical | Redis cache store never wired: `store` vs `stores` silently falls back to an in-process Map | `src/app.module.ts` |
| [D2](#d2) | 🔴 Critical | Global ValidationPipe has no whitelist: POST bodies mass-assign entity columns and turn create into UPDATE | `src/main.ts` |
| [D3](#d3) | 🔴 Critical | Order creation is non-transactional: mid-loop failure leaves orphaned order and partial items | `src/orders/orders.service.ts` |
| [D4](#d4) | 🔴 Critical | Stock decrement is a floating promise: updateStock is never awaited in create() | `src/orders/orders.service.ts` |
| [D5](#d5) | 🔴 Critical | searchProducts uses one constant cache key for every query | `src/products/products.service.ts` |
| [D6](#d6) | 🔴 Critical | GET /orders/:id/full builds a self-referential graph and JSON.stringify's it | `src/orders/orders.service.ts` |
| [D7](#d7) | 🔴 Critical | buildCategoryTree dereferences category.parent, which is never loaded for children | `src/products/products.service.ts` |
| [D8](#d8) | 🟠 High | updateStock is a non-atomic absolute-value read-modify-write: lost updates and oversell | `src/products/products.service.ts` |
| [D9](#d9) | 🟠 High | cancel() restores stock non-atomically and non-idempotently | `src/orders/orders.service.ts` |
| [D10](#d10) | 🟠 High | processPayment has no order-status guard: cancelled orders are resurrected and double-charged | `src/orders/orders.service.ts` |
| [D11](#d11) | 🟠 High | Payment retry loop: maxRetries = 1000 with flat delay and a non-HttpException rethrow | `src/orders/orders.service.ts` |
| [D12](#d12) | 🟠 High | searchProducts loads the whole products table and filters in Node | `src/products/products.service.ts` |
| [D13](#d13) | 🟠 High | processProductBatch swallows per-item errors and always reports success: true | `src/products/products.service.ts` |
| [D14](#d14) | 🟠 High | PATCH /orders/:id/status accepts any body value: no DTO, no enum validation | `src/orders/orders.controller.ts` |
| [D15](#d15) | 🟠 High | DELETE on referenced products/users leaks a raw Postgres FK violation as a 500 | `src/products/products.service.ts` |
| [D16](#d16) | 🟡 Medium | Collection endpoints have no pagination and pull the full eager graph | `src/orders/orders.service.ts` |
| [D17](#d17) | 🟡 Medium | No product write path invalidates the product-search cache | `src/products/products.service.ts` |
| [D18](#d18) | 🟡 Medium | Redis db index hardcoded to 0, ignoring REDIS_DB=1 | `src/app.module.ts` |
| [D19](#d19) | 🟡 Medium | POST /products/batch binds an inline structural type, so validation is skipped and the real error is masked | `src/products/products.controller.ts` |
| [D20](#d20) | 🟡 Medium | GET /orders?userId=<non-numeric> yields NaN in the WHERE clause and a 500 | `src/orders/orders.controller.ts` |
| [D21](#d21) | 🟡 Medium | Duplicate-email user creation surfaces as a bare 500 instead of 409 | `src/users/users.service.ts` |
| [D22](#d22) | 🟡 Medium | Dangling categoryId/parentId is caught by Postgres, not the API, producing a raw 500 | `src/products/dto/create-product.dto.ts` |
| [D23](#d23) | 🟡 Medium | CreateOrderDto accepts an empty items array and non-integer productId/quantity | `src/orders/dto/create-order.dto.ts` |
| [D24](#d24) | 🟡 Medium | CreateProductDto validates price/stock as loose numbers | `src/products/dto/create-product.dto.ts` |
| [D25](#d25) | 🟡 Medium | Decimal columns come back from Postgres as strings | `src/products/product.entity.ts` |
| [D26](#d26) | ⚪ Low | Product.category is eager: true, forcing a categories join on every product read | `src/products/product.entity.ts` |
| [D27](#d27) | ⚪ Low | getCategoryTree loads every product of the category and never uses them | `src/products/products.service.ts` |

---

## D1 — Redis cache store never wired: `store` vs `stores` silently falls back to an in-process Map
<a id="d1"></a>

| | |
|---|---|
| **Severity** | 🔴 Critical |
| **Theme** | Cache correctness & wiring |
| **Location** | `src/app.module.ts` |
| **Confidence** | certain |

**Symptom it explains** — Cache behavior does not match expectations; Redis is empty while the app reports hits; cache dies on every restart and is not shared between instances.

### Why it's broken

app.module.ts:32-39 returns `{ store: await redisStore({...}) }`. Installed @nestjs/cache-manager is 3.1.3, whose dist/cache.providers.js reads ONLY the plural `options.stores`: `const stores = Array.isArray(options.stores) ? ... : options.stores ? [...] : undefined;` — with `stores` undefined it calls `createCache({ ttl, refreshThreshold, nonBlocking })` with no store. cache-manager 7.2.9 (dist/index.cjs) then does `const keyv$1 = new Keyv(); keyv$1.serialize = void 0; keyv$1.deserialize = void 0; const stores = options?.stores?.length ? options.stores : [keyv$1];` — an unbounded in-process Map with serialization disabled. No type error surfaces because `CacheOptions<StoreConfig> = CacheManagerOptions & StoreConfig` accepts arbitrary keys. Two secondary consequences: `ttl: 60000` at line 37 is nested inside the discarded store args so the module-level default TTL is undefined (masked only because all three call sites pass an explicit 60000), and `await redisStore(...)` still opens a live ioredis socket that is never read from and never closed (onModuleDestroy early-returns when `stores` is undefined).

### How it fails

Warm any cache entry, then `redis-cli -n 1 KEYS '*'` returns nothing while GET /users still reports hits. `pnpm start:dev` (nest start --watch) restarts on every file save and wipes the entire cache. With more than one instance, `cacheManager.del('users:all')` (users.service.ts:49,169) cannot reach a peer, so a deleted user keeps being served — this is the multi-instance half of 'data is sometimes inconsistent or missing'. Because serialization is disabled, `findAll` hands the caller the same `User[]` instance that is in the cache, so any caller mutating a returned entity silently rewrites the cached value with no `set()`.

### Evidence

src/app.module.ts:33 `store: await redisStore({` (singular). node_modules/@nestjs/cache-manager/dist/cache.providers.js — `stores` derived only from `options.stores`. node_modules/cache-manager/dist/index.cjs — `const stores = options?.stores?.length ? options.stores : [keyv$1];`. Installed versions: @nestjs/cache-manager 3.1.3, cache-manager 7.2.9. cache-manager-ioredis-yet/dist/index.d.ts:2 imports `{ Cache, Store, Config }` from 'cache-manager', which v7 no longer exports — invisible only because tsconfig.json sets `skipLibCheck: true`.

### Proposed fix

Do NOT simply rename `store` to `stores`. Nest wraps a raw store in `new Keyv({ store })`, which requires `delete`/`clear`; cache-manager-ioredis-yet's builder exposes `del`/`reset`, so every `cacheManager.del(...)` at users.service.ts:49,56,57 would throw `store.delete is not a function`. Replace the dependency: drop `cache-manager-ioredis-yet`, add `keyv` + `@keyv/redis`, and use `CacheModule.registerAsync({ isGlobal: true, useFactory: async () => ({ ttl: 60000, stores: [new Keyv({ store: new KeyvRedis(`redis://${process.env.REDIS_HOST||'localhost'}:${process.env.REDIS_PORT||6379}/${process.env.REDIS_DB||0}`) })] }) })` — plural `stores`, TTL hoisted to module level, REDIS_DB honoured. Lower-churn alternative: keep ioredis and wrap with cache-manager's exported `KeyvAdapter`.

### How we'll know it's fixed

`redis-cli -n 1 -p 6380 FLUSHDB; curl -s localhost:3000/users > /dev/null; redis-cli -n 1 -p 6380 KEYS '*'` must now list `users:all`. Then `curl -X POST localhost:3000/users -H 'content-type: application/json' -d '{"email":"t@t.co","name":"T"}'` and confirm `redis-cli -n 1 -p 6380 EXISTS users:all` returns 0 (the del path works and does not throw). Restart the process and confirm a previously warmed key survives.

---

## D2 — Global ValidationPipe has no whitelist: POST bodies mass-assign entity columns and turn create into UPDATE
<a id="d2"></a>

| | |
|---|---|
| **Severity** | 🔴 Critical |
| **Theme** | Input validation & mass assignment |
| **Location** | `src/main.ts` |
| **Confidence** | certain |

**Symptom it explains** — Data is sometimes inconsistent or missing — an existing row is silently overwritten and the endpoint still answers 201.

### Why it's broken

main.ts:7 is `app.useGlobalPipes(new ValidationPipe({ transform: true }));` with neither `whitelist: true` nor `forbidNonWhitelisted: true`. class-transformer 0.5.1 defaults to the `exposeAll` strategy, so `getKeys()` returns `Object.keys(object)` and every body property is copied onto the DTO instance; class-validator only checks decorated fields, so the extras pass unexamined. That instance goes straight into `this.usersRepository.create(createUserDto)` (users.service.ts:47) and `this.productsRepository.create(createProductDto)` (products.service.ts:37), and TypeORM's plain-object transformer assigns every property that maps to a column — including `@PrimaryGeneratedColumn() id`, `User.isActive` (user.entity.ts:15), `Product.isAvailable` (product.entity.ts:22). `save()` on an entity carrying a populated PK loads the row and issues an UPDATE instead of an INSERT.

### How it fails

`POST /users {"email":"bob@x.com","name":"Bob","id":1,"isActive":false}` validates fine (both declared fields are valid), and `save()` emits `UPDATE users SET email=..., name=... WHERE id=1`. The API returns 201 Created while user #1 has been destroyed and no new user exists. `POST /products {"name":"X","price":1,"id":5,"isAvailable":false}` likewise overwrites product 5's name and price and flips a column no DTO exposes.

### Evidence

src/main.ts:5-9 verbatim — line 7 `app.useGlobalPipes(new ValidationPipe({ transform: true }));`. src/users/dto/create-user.dto.ts declares only `email` and `name`; src/users/user.entity.ts:6-22 has `id`, `isActive`, `createdAt` as columns. src/products/dto/create-product.dto.ts declares no `id`; src/products/product.entity.ts:7 `@PrimaryGeneratedColumn() id: number;`. Runtime probe: `plainToInstance(CreateUserDto, {email,name,id:7,isActive:false})` returns all four properties with constructor `CreateUserDto`.

### Proposed fix

src/main.ts:7 → `app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));`. `whitelist` strips undecorated properties before `repository.create()` ever sees them, which is what closes this defect. `forbidNonWhitelisted: true` would additionally turn such a body into an explicit 400 rather than a silent drop — it is the correct end state but is **deliberately not shipped in C1**, because it converts previously-tolerated requests into errors for callers that cannot be surveyed; see [Q11](03-open-questions.md#q11). Belt-and-braces: build entities from explicit fields in the services instead of passing the DTO object through.

### How we'll know it's fixed

`curl -s localhost:3000/products/5` and note the name. Then `curl -i -X POST localhost:3000/products -H 'content-type: application/json' -d '{"id":5,"name":"PWNED","price":1}'` must return **201 carrying a new id**, not id 5 — the `id` is stripped, so the write lands as an INSERT instead of an UPDATE — and `curl -s localhost:3000/products/5` must show the original name unchanged. Repeat for `POST /users` with an extra `id` and `isActive`. **A 400 here is a failure, not a pass:** [Q11](03-open-questions.md#q11) ships `whitelist: true` alone, so undeclared properties are stripped silently. A 400 would mean `forbidNonWhitelisted` was enabled against that decision.

---

## D3 — Order creation is non-transactional: mid-loop failure leaves orphaned order and partial items
<a id="d3"></a>

| | |
|---|---|
| **Severity** | 🔴 Critical |
| **Theme** | Transactional integrity & concurrency |
| **Location** | `src/orders/orders.service.ts` |
| **Confidence** | certain |

**Symptom it explains** — Data is sometimes inconsistent or missing.

### Why it's broken

`create()` issues 3+N independently auto-committed writes with no transaction and no pre-validation pass. The parent Order is INSERTed at line 70 while `total` is still the column default 0, before a single line item has been validated. Each OrderItem is INSERTed one at a time at line 87 and stock is mutated at line 89, all inside the loop opened at line 73. The stock guard at lines 76-78 sits INSIDE that loop, so the BadRequestException for item N is thrown after items 1..N-1 and their stock decrements are already committed. `total` is only written at lines 92-93 and is never reached. There is no `manager.transaction(`, no `queryRunner` and no `QueryRunner` token anywhere in the file. The same window is open for any mid-loop failure: a NotFoundException from `productsService.findOne` (line 74), a driver error on line 87 (a fractional quantity into the integer `quantity` column, order-item.entity.ts:24-25), or a process restart between lines 87 and 93.

### How it fails

Product A stock 100, product B stock 0. `POST /orders {"userId":1,"items":[{"productId":A,"quantity":1},{"productId":B,"quantity":1}]}` returns 400 'Not enough stock for B'. The client believes nothing happened, but the DB permanently holds an `orders` row (status 'pending', total 0.00), one `order_items` row for A, and A's stock has been decremented for an order the caller was told had failed. `GET /orders?userId=1` then lists a phantom zero-total order indistinguishable from a real one.

### Evidence

orders.service.ts:70 `const savedOrder = await this.ordersRepository.save(order);` — committed before any validation. :73 `for (const itemDto of createOrderDto.items) {`. :76-78 `if (product.stock < itemDto.quantity) { throw new BadRequestException(...) }` — inside the loop. :87 `await this.orderItemsRepository.save(orderItem);` — per iteration. :92-93 `savedOrder.total = total; await this.ordersRepository.save(savedOrder);` — last.

### Proposed fix

Wrap the entire body in one transaction and validate every item before writing anything: `return this.ordersRepository.manager.transaction(async (em) => { ... })`, resolving and stock-checking all items first, computing `total` before the single Order INSERT (removing the INSERT-then-UPDATE), and performing every save and stock adjustment through `em`. No new DI is needed — `ordersRepository.manager` is already available. Must land together with the await/atomic-decrement fixes below, since the stock write has to run inside the same `em`.

### How we'll know it's fixed

With product B at stock 0: `curl -s -X POST localhost:3000/orders -H 'content-type: application/json' -d '{"userId":1,"items":[{"productId":A,"quantity":1},{"productId":B,"quantity":1}]}'` → 400. Then `psql -p 5434 -U postgres -d challengedb -c "select count(*) from orders where total=0 and status='pending'"` must not have increased, `select count(*) from order_items` must be unchanged, and `curl -s localhost:3000/products/A` must show the original stock.

---

## D4 — Stock decrement is a floating promise: updateStock is never awaited in create()
<a id="d4"></a>

| | |
|---|---|
| **Severity** | 🔴 Critical |
| **Theme** | Transactional integrity & concurrency |
| **Location** | `src/orders/orders.service.ts` |
| **Confidence** | certain |

**Symptom it explains** — Data is sometimes inconsistent or missing; intermittent worker crashes.

### Why it's broken

Line 89 is `this.productsService.updateStock(product.id, product.stock - itemDto.quantity);` with no `await` and no `.catch()`, while the structurally identical call in `cancel()` at line 135 IS awaited — confirming the omission is planted, not house style. Three consequences. (1) The write may still be in flight when line 95's `findOne` re-reads the graph, so the 201 response can report pre-decrement `items[].product.stock`. (2) If the same productId appears twice in `items`, iteration 2's `findOne` at line 74 re-reads the row before iteration 1's un-awaited write has committed, and `updateStock` writes an ABSOLUTE value (products.service.ts:43 `product.stock = quantity`), so the second write clobbers the first and only one decrement survives. (3) A rejection — product deleted concurrently, or a driver error — becomes an unhandled promise rejection, which under Node's default `--unhandled-rejections=throw` terminates the worker after the client has already received a 201.

### How it fails

`POST /orders {"userId":1,"items":[{"productId":7,"quantity":3},{"productId":7,"quantity":3}]}` with product 7 at stock 10: two order_items totalling 6 units are persisted and billed, but `products.stock` ends at 7 instead of 4 — 3 units sold with no inventory behind them. Separately, if product 7 is deleted between line 74 and the fire-and-forget write, the NotFoundException escapes as an unhandled rejection and can kill the process.

### Evidence

orders.service.ts:87-89 verbatim:
87  await this.orderItemsRepository.save(orderItem);
88  total += product.price * itemDto.quantity;
89  this.productsService.updateStock(product.id, product.stock - itemDto.quantity);
Contrast :135 `await this.productsService.updateStock(product.id, product.stock + item.quantity);`

### Proposed fix

`await` the call, execute it through the transaction manager from the fix above, and replace the absolute-value write with an atomic guarded decrement (see the updateStock defect). Adding `await` alone is necessary but not sufficient — it removes the intra-request duplicate-product bug and the unhandled rejection, but leaves the cross-request race open.

### How we'll know it's fixed

`curl -s -X POST localhost:3000/orders -H 'content-type: application/json' -d '{"userId":1,"items":[{"productId":7,"quantity":3},{"productId":7,"quantity":3}]}'` against product 7 at stock 10, then `curl -s localhost:3000/products/7 | jq .stock` must read 4, not 7. Also confirm the 201 response body's `items[].product.stock` already reflects the decrement.

---

## D5 — searchProducts uses one constant cache key for every query
<a id="d5"></a>

| | |
|---|---|
| **Severity** | 🔴 Critical |
| **Theme** | Cache correctness & wiring |
| **Location** | `src/products/products.service.ts` |
| **Confidence** | certain |

**Symptom it explains** — Cache behavior does not match expectations; search returns another query's results, so data looks inconsistent or missing.

### Why it's broken

Line 53 is `const cacheKey = 'product-search';` — a literal constant that does not incorporate the `query` argument. Lines 54-57 return `cached` before `query` is read at all; `query` only influences the result at lines 60-63. The cached value is therefore a function of whichever term happened to warm the key first, not of the caller's input. The first miss populates that single key with its own filtered array (line 65, TTL 60000ms) and every subsequent search of any term short-circuits and returns it without touching the DB.

### How it fails

`GET /products/search?q=laptop` → [Laptop Pro], cached under `product-search`. Within 60s `GET /products/search?q=shoes` returns [Laptop Pro], and so does any nonsense term. Symmetrically, if the first call in the window matches nothing, `[]` is cached and every search returns empty for 60s. `GET /products/search` with no `q` (controller line 66 turns it into '') likewise returns whatever is cached rather than the full list. Which query 'wins' depends on which one warms the key, so the wrongness reads as intermittent.

### Evidence

src/products/products.service.ts:52-66 verbatim:
52  async searchProducts(query: string): Promise<Product[]> {
53    const cacheKey = 'product-search';
54    const cached = await this.cacheManager.get<Product[]>(cacheKey);
55    if (cached) { return cached; }
...
65    await this.cacheManager.set(cacheKey, results, 60000);
Contrast users.service.ts:19 `'users:all'` and :144 `` `user:${id}` `` which correctly key by input.

### Proposed fix

Namespace the key by the normalized query at line 53: `const normalized = query.trim().toLowerCase(); const cacheKey = `product-search:${normalized}`;` and reuse `normalized` in the comparisons at lines 61-62. Include any future filter/paging parameters in the key.

### How we'll know it's fixed

After the Redis fix: `redis-cli -n 1 -p 6380 FLUSHDB; curl -s 'localhost:3000/products/search?q=laptop'; curl -s 'localhost:3000/products/search?q=shoes'` must return two different result sets, and `redis-cli -n 1 -p 6380 KEYS 'product-search*'` must list two distinct keys.

---

## D6 — GET /orders/:id/full builds a self-referential graph and JSON.stringify's it
<a id="d6"></a>

| | |
|---|---|
| **Severity** | 🔴 Critical |
| **Theme** | Error handling & diagnosability |
| **Location** | `src/orders/orders.service.ts` |
| **Confidence** | certain |

**Symptom it explains** — Intermittent errors in certain flows; failures produce vague or misleading error messages.

### Why it's broken

Line 152 makes `enriched` a shallow copy of `order`; line 153 makes `enriched.user` a shallow copy of `order.user`; line 154 assigns `enriched.user.latestOrder = enriched`, closing the cycle enriched → user → latestOrder → enriched. Line 156 then calls `JSON.parse(JSON.stringify(enriched))` on that graph with no cycle-breaking replacer, so it throws `TypeError: Converting circular structure to JSON` unconditionally. `Order.user` is a non-nullable eager ManyToOne (order.entity.ts:24-29), so `order.user` is always present and the cycle always forms — and even if it were undefined, `{...undefined}` yields `{}` and the cycle is still created. The TypeError is not an HttpException, so Nest's default filter renders a bare 500.

### How it fails

`GET /orders/1/full` for any existing order returns 500 `{"statusCode":500,"message":"Internal server error"}`, 100% of the time. `GET /orders/999/full` for a nonexistent id correctly returns 404 (line 149) — so from the caller's point of view the endpoint works only for orders that do not exist, and the error message gives no hint that the order was in fact fetched successfully.

### Evidence

src/orders/orders.service.ts:152-156 verbatim:
152  const enriched: any = { ...order };
153  enriched.user = { ...order.user };
154  enriched.user.latestOrder = enriched;
155
156  return JSON.parse(JSON.stringify(enriched));
Route confirmed at src/orders/orders.controller.ts:23-26.

### Proposed fix

Remove the self-reference. Simplest correct fix: delete lines 152-154 and `return order;` — Nest serializes the eagerly-loaded graph. If a `latestOrder` field is genuinely wanted, point it at a non-cyclic projection: `enriched.user = { ...order.user, latestOrder: { id: order.id, status: order.status, total: order.total, createdAt: order.createdAt } }` and `return enriched;`, dropping the pointless deep-clone round-trip on line 156.

### How we'll know it's fixed

`curl -i -s localhost:3000/orders/1/full` must return 200 with the order body (currently 500). `curl -i -s localhost:3000/orders/999999/full` must still return 404 with `Order #999999 not found`.

---

## D7 — buildCategoryTree dereferences category.parent, which is never loaded for children
<a id="d7"></a>

| | |
|---|---|
| **Severity** | 🔴 Critical |
| **Theme** | Error handling & diagnosability |
| **Location** | `src/products/products.service.ts` |
| **Confidence** | certain |

**Symptom it explains** — Intermittent errors occur in certain flows; failures produce a vague 500 'Internal server error'.

### Why it's broken

`buildCategoryTree` decides whether to recurse on the FK COLUMN (`if (category.parentId)`, line 101) but then dereferences the RELATION OBJECT (`category.parent`, line 102). `findCategory` at lines 73-82 loads `relations: ['parent','children','products']` — exactly one level deep. For each entity in `category.children`, TypeORM selects the `parent_id` column (Category.parentId is a plain `@Column`, category.entity.ts:15-16) so `child.parentId` is truthy, but it does NOT back-populate the inverse side, so `child.parent` is `undefined`. The recursive call at line 102 therefore receives `undefined` and line 96 (`id: category.id`) throws `TypeError: Cannot read properties of undefined (reading 'id')`. Nothing catches it, so Nest returns a bare 500. The same crash occurs one level up when the loaded `category.parent` itself has a non-null `parentId` (depth ≥ 2). The mixed up-and-down traversal with no visited set and no depth cap is the latent design flaw behind the crash; the often-claimed infinite recursion is NOT reachable under this loading strategy because the undefined-parent TypeError always fires first.

### How it fails

Create category A, then category B with `parentId: A`. `GET /categories/{A}/tree` → line 106 maps over children → `buildCategoryTree(B)` → `B.parentId` truthy, `B.parent` undefined → `buildCategoryTree(undefined)` → TypeError → HTTP 500 with no usable message. `GET /categories/{B}/tree` in a three-level chain A→B→C fails identically via `C.parent`. A childless root category returns 200, so callers experience it as intermittent.

### Evidence

src/products/products.service.ts:76 `relations: ['parent', 'children', 'products'],`; :95-99 the tree literal reading `category.id`; :101-103 `if (category.parentId) { tree.parent = this.buildCategoryTree(category.parent); }`; :105-106 `tree.children = category.children.map(child => this.buildCategoryTree(child));`. src/products/category.entity.ts:18-23 shows `parentId` as a plain column while `parent`/`children` are relations that must be explicitly requested.

### Proposed fix

Minimal correct fix: guard on the loaded relation rather than the FK column — line 101 becomes `if (category.parent) {`. Proper fix: stop walking both directions from one partially-loaded entity. Give the tree path its own query that loads the subtree it needs (a TypeORM TreeRepository / `@Tree('closure-table')` on Category, or one recursive CTE) and recurse downward over `children` only, carrying a `visited: Set<number>` so a row emitted twice cannot be linked twice. A depth bound is deliberately not added: no endpoint can create a cycle in `parent_id`, so it would guard a state the API cannot reach. If the ancestor chain is genuinely wanted, walk it iteratively (`while (node.parentId)` with an explicit findOne per hop).

### How we'll know it's fixed

`curl -X POST localhost:3000/categories -d '{"name":"A"}' -H 'content-type: application/json'` then `curl -X POST localhost:3000/categories -d '{"name":"B","parentId":<A>}' -H 'content-type: application/json'`, then `curl -i -s localhost:3000/categories/<A>/tree` must return 200 with B in `children` (currently 500). Add C under B and confirm `GET /categories/<A>/tree` shows the grandchild — the minimal one-line guard alone will NOT, which is the unmasking noted in the fix order.

---

## D8 — updateStock is a non-atomic absolute-value read-modify-write: lost updates and oversell
<a id="d8"></a>

| | |
|---|---|
| **Severity** | 🟠 High |
| **Theme** | Transactional integrity & concurrency |
| **Location** | `src/products/products.service.ts` |
| **Confidence** | certain |

**Symptom it explains** — Data is sometimes inconsistent or missing; inventory oversold or inflated.

### Why it's broken

`updateStock` loads the whole entity via `findOne` (line 42), assigns an ABSOLUTE value the caller computed (line 43 `product.stock = quantity`) and saves the row back (line 44). There is no transaction, no pessimistic or optimistic lock, no `@VersionColumn` on Product, and no `UPDATE ... SET stock = stock - :n WHERE stock >= :n`. The caller in orders.service.ts SELECTs the product at line 74, checks `product.stock < itemDto.quantity` at line 76 and computes the new absolute value at line 89 — read and write separated by an unprotected window. Two concurrent callers read the same starting value and the later save wins; the check at line 76 is advisory, not a reservation. `save()` also rewrites every changed column, clobbering concurrent edits to other fields. This is distinct from, and survives fixing, the missing `await`: awaiting narrows the window but does not close it across requests.

### How it fails

Product 5 has stock 10. Two simultaneous `POST /orders` each for quantity 10: both read 10, both pass the line 76 check, both write 0 — twenty units sold against ten units of inventory. With unequal quantities (A buys 4, B buys 6) the final stock is 6 or 4 instead of 0, so `order_items` no longer reconcile with `products.stock`.

### Evidence

src/products/products.service.ts:41-45 verbatim:
41  async updateStock(id: number, quantity: number): Promise<Product> {
42    const product = await this.findOne(id);
43    product.stock = quantity;
44    return this.productsRepository.save(product);
45  }
src/orders/orders.service.ts:76-78 (check) and :89 (absolute-value write). src/products/product.entity.ts:1-40 has no @VersionColumn.

### Proposed fix

Do the arithmetic in the database. Add `adjustStock(em, id, delta)` implemented as `em.createQueryBuilder().update(Product).set({ stock: () => 'stock + :delta' }).where('id = :id AND stock + :delta >= 0', { id, delta }).execute()` and treat `affected === 0` as insufficient stock (throw BadRequestException) — the WHERE clause becomes the check, so the guard at orders.service.ts:76-78 can go. Call it inside the create() transaction. Keep the absolute-set `updateStock` only for admin flows, wrapped in a transaction with `SELECT ... FOR UPDATE`.

### How we'll know it's fixed

Product 5 at stock 10. Run two concurrent orders for 10 units each: `for i in 1 2; do curl -s -X POST localhost:3000/orders -H 'content-type: application/json' -d '{"userId":1,"items":[{"productId":5,"quantity":10}]}' & done; wait`. Exactly one must return 201 and one must return 400 'Not enough stock'; `curl -s localhost:3000/products/5 | jq .stock` must read 0, never a negative number and never 0 with two 201s.

---

## D9 — cancel() restores stock non-atomically and non-idempotently
<a id="d9"></a>

| | |
|---|---|
| **Severity** | 🟠 High |
| **Theme** | Transactional integrity & concurrency |
| **Location** | `src/orders/orders.service.ts` |
| **Confidence** | certain |

**Symptom it explains** — Data is sometimes inconsistent or missing; inventory inflated with phantom units.

### Why it's broken

The guard reads status at line 129, the restore loop runs at 133-136, and the status is only written at 138-139 — a wide check-then-act window with no transaction anywhere in the file. Two concurrent cancels both observe PENDING and both run the restore loop. The restore itself repeats the absolute-value read-modify-write: line 135 passes `product.stock + item.quantity` computed from the value read at line 134 into `updateStock`, which writes it absolutely (products.service.ts:43), so a concurrent purchase's decrement landing in that window is silently overwritten. If the loop throws partway — e.g. `productsService.findOne` at line 134 raises NotFoundException for a deleted product — some items are restored while the order stays PENDING, and a retried cancel restores those items a second time.

### How it fails

(a) Serialized double-cancel: order 1 holds 3 units of product 9 (stock 5). Two `POST /orders/1/cancel` calls that both pass the line 129 guard before either reaches line 138 — the first reads 5 and writes 8, the second reads 8 and writes 11 — leave stock at 11 instead of 8, creating 3 phantom units. (b) Lost update against a concurrent sale: cancel reads stock=5 at line 134, a concurrent order writes 3, cancel then writes 5+3=8, silently refunding the buyer's 2 units to inventory.

### Evidence

src/orders/orders.service.ts:127-139 verbatim:
127  const order = await this.findOne(id);
129  if (order.status !== OrderStatus.PENDING) {
130    throw new BadRequestException('Only pending orders can be cancelled');
133  for (const item of order.items) {
134    const product = await this.productsService.findOne(item.productId);
135    await this.productsService.updateStock(product.id, product.stock + item.quantity);
138  order.status = OrderStatus.CANCELLED;
139  return this.ordersRepository.save(order);

### Proposed fix

Run the method in one transaction and flip the status FIRST with a conditional UPDATE, restoring stock only if it won: `const res = await em.update(Order, { id, status: OrderStatus.PENDING }, { status: OrderStatus.CANCELLED }); if (res.affected !== 1) throw new BadRequestException('Only pending orders can be cancelled');` — this makes the operation idempotent. Then restore with the atomic increment `adjustStock(em, productId, +qty)` from the updateStock fix instead of the read-modify-write at lines 134-135.

### How we'll know it's fixed

Order 1 pending with 3 units of product 9 at stock 5. `for i in 1 2; do curl -s -X POST localhost:3000/orders/1/cancel & done; wait` — exactly one 200 and one 400, and `curl -s localhost:3000/products/9 | jq .stock` must read 8, not 11. Repeat the cancel serially afterwards: must return 400 and leave stock at 8.

---

## D10 — processPayment has no order-status guard: cancelled orders are resurrected and double-charged
<a id="d10"></a>

| | |
|---|---|
| **Severity** | 🟠 High |
| **Theme** | Transactional integrity & concurrency |
| **Location** | `src/orders/orders.service.ts` |
| **Confidence** | certain |

**Symptom it explains** — Data is sometimes inconsistent or missing.

### Why it's broken

`processPayment` loads the order at line 105 and unconditionally assigns `order.status = OrderStatus.CONFIRMED` at line 113 on the first successful payment, with no check of the current status and no idempotency key. `cancel()` DOES guard (lines 129-131), so the omission here is deliberate rather than a house pattern. Any order in `confirmed`, `shipped`, `delivered` or `cancelled` can be charged again and forced back to `confirmed`. For a cancelled order this is worst: `cancel()` has already returned that order's units to inventory (lines 133-136), so re-confirming yields a paid, confirmed order whose goods are back on the shelf. The status write at line 114 is a plain `save(order)` rather than a conditional UPDATE, so two concurrent pay calls both read PENDING and both confirm.

### How it fails

`POST /orders/1/cancel` (stock restored, status → cancelled), then `POST /orders/1/pay`: payment succeeds, status flips to confirmed, and the order is confirmed with zero stock reserved behind it. Independently, a double-submitted `POST /orders/1/pay` invokes `paymentService.processPayment` twice with no idempotency key and charges the customer twice.

### Evidence

src/orders/orders.service.ts:104-116:
105  const order = await this.findOne(orderId);
...
112    if (result.success) {
113      order.status = OrderStatus.CONFIRMED;
114      await this.ordersRepository.save(order);
No status check between 105 and 113. Compare the guard at :129-131 in cancel().

### Proposed fix

Guard immediately after line 105: `if (order.status !== OrderStatus.PENDING) throw new BadRequestException(`Order #${orderId} cannot be paid in status ${order.status}`);`, and persist the transition conditionally instead of line 114: `const res = await this.ordersRepository.update({ id: orderId, status: OrderStatus.PENDING }, { status: OrderStatus.CONFIRMED }); if (res.affected !== 1) throw new BadRequestException('Order state changed');` so concurrent pay calls cannot both confirm. Pass an idempotency key to the provider so a retried charge is deduplicated.

### How we'll know it's fixed

`curl -s -X POST localhost:3000/orders/1/cancel` then `curl -i -s -X POST localhost:3000/orders/1/pay` must return 400 naming the current status, and `curl -s localhost:3000/orders/1 | jq .status` must still read `cancelled`. Then on a fresh pending order: `for i in 1 2; do curl -s -X POST localhost:3000/orders/2/pay & done; wait` — exactly one 200 and one 400.

---

## D11 — Payment retry loop: maxRetries = 1000 with flat delay and a non-HttpException rethrow
<a id="d11"></a>

| | |
|---|---|
| **Severity** | 🟠 High |
| **Theme** | Unbounded & wasted work |
| **Location** | `src/orders/orders.service.ts` |
| **Confidence** | certain |

**Symptom it explains** — Requests can be extremely slow; vague or misleading error messages.

### Why it's broken

`private maxRetries = 1000;` (line 26) drives the loop at line 108 whose body costs ~100ms in the provider call (line 14) plus a flat 100ms sleep on failure (line 119) — an unbounded ~200-second retry budget on a single HTTP request, holding the request, a timer and a pool connection, with no exponential backoff and no jitter, so a real outage is hammered rather than backed off. `lastError` is assigned a plain `Error('Payment service unavailable')` (line 17), not an HttpException, so exhaustion surfaces as a bare 500 rather than 502/503. Two latent hazards sit behind the same code: the loop has no terminal branch for a `{success:false}` result (it would spin 1000 tight iterations), and `throw lastError!` at line 123 would throw `undefined` on that path — the `!` silences the strictNullChecks error. Both are unreachable against the in-file mock (lines 12-22 only ever throw or return `success: true`), and with a 10% independent failure rate P(1000 consecutive failures) ≈ 1e-1000, so today the loop merely adds ~100-200ms. The planted defect is the retry policy itself, and the dead error path becomes live the moment maxRetries is lowered.

### How it fails

Against a genuinely unavailable provider (the mock's failure branch made persistent), `POST /orders/1/pay` blocks the caller for up to ~200s and then returns a bare 500 with nothing indicating that payment was the cause. Retries also re-invoke `processPayment` with no idempotency key, so a provider that succeeded then timed out is charged repeatedly.

### Evidence

src/orders/orders.service.ts:26 `private maxRetries = 1000;`; :107 `let lastError: Error;`; :108 `for (let attempt = 0; attempt < this.maxRetries; attempt++) {`; :117-120 `catch (error) { lastError = error; await new Promise(resolve => setTimeout(resolve, 100)); }`; :123 `throw lastError!;`. Mock at :12-22 returns `{ success: true, ... }` on every non-throwing path.

### Proposed fix

Bound `maxRetries` to 3 (line 26), use exponential backoff at line 119 (`await new Promise(r => setTimeout(r, 2 ** attempt * 100))`), declare `let lastError: Error | undefined` at line 107 and drop the `!`, add an explicit terminal branch after line 112 (`if (!result.success) throw new BadRequestException('Payment declined')`) so the loop cannot spin, and map the rethrow at line 123 to `throw new ServiceUnavailableException(lastError?.message ?? 'Payment failed')`. The bound and the error mapping MUST ship together — see the fix order.

### How we'll know it's fixed

Temporarily set the mock's failure probability to 1 (`if (true) throw ...` at line 16) and `time curl -i -s -X POST localhost:3000/orders/1/pay`: must complete in under ~1s (3 attempts with backoff) and return 503 with 'Payment service unavailable', not 500 and not ~200s. Revert the mock; a normal pay must still return 200 within a few hundred ms.

---

## D12 — searchProducts loads the whole products table and filters in Node
<a id="d12"></a>

| | |
|---|---|
| **Severity** | 🟠 High |
| **Theme** | Unbounded & wasted work |
| **Location** | `src/products/products.service.ts` |
| **Confidence** | certain |

**Symptom it explains** — Some requests are extremely slow or never complete.

### Why it's broken

Line 59 is `const products = await this.productsRepository.find();` — no where, no take, no skip: `SELECT * FROM products` plus a LEFT JOIN on categories (Product.category is `eager: true`, product.entity.ts:28), with every row hydrated into an entity. The actual matching happens in JavaScript at lines 60-63. Cost is O(table size) in time, memory and network on every cache miss regardless of selectivity, and the returned array is unbounded.

### How it fails

With 500k products, `GET /products/search?q=xyz` pulls all 500k rows plus joined categories into the event loop, blocks it during `.filter()` and JSON serialization, and can exhaust the heap or hit the request timeout while returning 3 rows. With an empty `q` (controller line 66 passes ''), `includes('')` is true for every row, so the entire table is serialized into the HTTP response and stored in the cache entry at line 65.

### Evidence

src/products/products.service.ts:59-63 verbatim:
59  const products = await this.productsRepository.find();
60  const results = products.filter(p =>
61    p.name.toLowerCase().includes(query.toLowerCase()) ||
62    (p.description || '').toLowerCase().includes(query.toLowerCase())
63  );
src/products/products.controller.ts:16 `return this.productsService.searchProducts(query || '');`

### Proposed fix

Push the predicate into Postgres: `this.productsRepository.find({ where: [{ name: ILike(`%${query}%`) }, { description: ILike(`%${query}%`) }] })`. Note that a `take` bound is *not* part of this — truncating a result set silently is its own defect, and the scope note below withdraws the whole change in any case.

**Scope note — out of scope.** This was briefly promoted to a tenth commit and has been withdrawn. Measured on the seeded dataset the SQL predicate and the JavaScript filter both answer in 6–20ms; the gap only appears after inserting 50,000 synthetic rows, which is a table this system does not have and no user has reported waiting on. That is the definition of latent-at-scale, which [04](04-scope.md#the-in-scope-test) excludes. See [04](04-scope.md#decided-search-scan) for the full reversal.

### How we'll know it's fixed

Seed ~50k products, then `time curl -s 'localhost:3000/products/search?q=zzz' | jq length` on a cold cache — must return in tens of milliseconds with a small array. Enable `logging: ['query']` on the TypeORM config and confirm the emitted SQL contains `ILIKE` and `LIMIT`, and that no `SELECT * FROM products` without a WHERE clause is issued.

---

## D13 — processProductBatch swallows per-item errors and always reports success: true
<a id="d13"></a>

| | |
|---|---|
| **Severity** | 🟠 High |
| **Theme** | Error handling & diagnosability |
| **Location** | `src/products/products.service.ts` |
| **Confidence** | certain |

**Symptom it explains** — Failures produce vague or misleading error messages; data is sometimes inconsistent or missing.

### Why it's broken

The per-item catch at lines 122-124 discards the caught `error` object entirely and logs the constant string `'Error processing product'` — no product id, no message, no stack — so a failed item is invisible in the logs. `processed` is incremented only on success (line 121), but the return at line 130 hardcodes `success: true` and never reports which ids failed or how many were attempted, so the caller cannot distinguish 'all 50 saved' from '0 of 50 saved'. The outer catch at lines 126-128 rewrites anything that does escape into the equally contentless `BadRequestException('Batch processing failed')`, destroying the real cause and never logging it.

### How it fails

`POST /products/batch {"productIds":[9001,9002,9003]}` with no such products: each `findOne` throws NotFoundException (line 118 → line 31), each is swallowed, and the endpoint answers 201 `{"success":true,"processed":0}` — the caller is told the batch succeeded. The server log holds three identical id-less lines, so the failure is undiagnosable from either end.

### Evidence

src/products/products.service.ts:117-130 verbatim:
117  try {
118    const product = await this.findOne(id);
...
121    processed++;
122  } catch (error) {
123    console.log('Error processing product');
124  }
...
126  } catch (error) {
127    throw new BadRequestException('Batch processing failed');
128  }
130  return { success: true, processed };

### Proposed fix

Collect failures instead of dropping them: `const failed: { id: number; reason: string }[] = []`, push `{ id, reason: error.message }` in the catch and log it through a real `Logger` with the id, then `return { success: failed.length === 0, processed, failed }`. Remove the outer try/catch at 126-128 (or rethrow preserving `{ cause: error }`) so a genuine internal error is not disguised as a 400. If the batch is meant to be all-or-nothing, run it in a single transaction and rethrow.

### How we'll know it's fixed

`curl -s -X POST localhost:3000/products/batch -H 'content-type: application/json' -d '{"productIds":[1,9001,9002]}'` must return `{"success":false,"processed":1,"failed":[{"id":9001,...},{"id":9002,...}]}` and the server log must name both ids with their NotFoundException messages.

---

## D14 — PATCH /orders/:id/status accepts any body value: no DTO, no enum validation
<a id="d14"></a>

| | |
|---|---|
| **Severity** | 🟠 High |
| **Theme** | Input validation & mass assignment |
| **Location** | `src/orders/orders.controller.ts` |
| **Confidence** | certain |

**Symptom it explains** — Data is sometimes inconsistent or missing; vague or misleading error messages.

### Why it's broken

`@Body('status') status: OrderStatus` at line 41 extracts one raw property with no pipe and no DTO class. For a string enum the emitted `design:paramtype` is `String`, which ValidationPipe's `toValidate()` treats as a native type and skips entirely, so nothing is checked. The raw value flows into `updateStatus`, which assigns it to the Postgres `enum` column (order.entity.ts:18) and saves. Every other id in this controller uses `ParseIntPipe` (lines 19, 24, 34, 40, 47), so the omission is inconsistent as well as unsafe. There is also no state-machine check: any status can jump to any other.

### How it fails

(a) `PATCH /orders/1/status {"status":"banana"}` → `order.status = 'banana'` → save → Postgres `invalid input value for enum orders_status_enum: "banana"` → HTTP 500 instead of a 400 naming the allowed values. (b) `PATCH /orders/1/status {}` → `status` is `undefined`; TypeORM ignores undefined properties when computing changed columns, so no UPDATE is issued and the endpoint returns 200 with the unchanged order — a client that mistyped the field name gets a success response for a write that never happened.

### Evidence

src/orders/orders.controller.ts:38-44 verbatim:
38  @Patch(':id/status')
39  updateStatus(
40    @Param('id', ParseIntPipe) id: number,
41    @Body('status') status: OrderStatus,
42  ) {
43    return this.ordersService.updateStatus(id, status);
src/orders/order.entity.ts:18 `@Column({ type: 'enum', enum: OrderStatus, default: OrderStatus.PENDING })`.

### Proposed fix

Add `class UpdateOrderStatusDto { @IsEnum(OrderStatus) status: OrderStatus; }` and bind the whole body (`@Body() dto: UpdateOrderStatusDto`), or minimally `@Body('status', new ParseEnumPipe(OrderStatus)) status: OrderStatus` — both turn each case into a 400 that names the valid statuses.

### How we'll know it's fixed

`curl -i -s -X PATCH localhost:3000/orders/1/status -H 'content-type: application/json' -d '{"status":"banana"}'` must return 400 listing the valid enum values (currently 500). `curl -i -s -X PATCH localhost:3000/orders/1/status -H 'content-type: application/json' -d '{}'` must return 400, not a 200 with an unchanged order.

---

## D15 — DELETE on referenced products/users leaks a raw Postgres FK violation as a 500
<a id="d15"></a>

| | |
|---|---|
| **Severity** | 🟠 High |
| **Theme** | Error handling & diagnosability |
| **Location** | `src/products/products.service.ts` |
| **Confidence** | certain |

**Symptom it explains** — Intermittent errors occur in certain flows; failures produce vague or misleading error messages.

### Why it's broken

Both delete paths call `repository.remove(entity)` with no reference check and no try/catch, so a Postgres FK violation escapes as an unmapped TypeORM `QueryFailedError` and Nest's default filter renders a bare 500. `OrderItem.product` is a ManyToOne with a NOT NULL `product_id` join column and no `onDelete` (order-item.entity.ts:10-22), and `Order.user` is the same shape on `user_id` (order.entity.ts:24-29), so `synchronize: true` (app.module.ts:28) creates both FKs with the default `ON DELETE NO ACTION`. Note that `cascade: true` on `Order.items` (order.entity.ts:31) is TypeORM's persistence cascade for insert/update, not a database `ON DELETE CASCADE`, and it is on the wrong entity anyway.

### How it fails

Create a product, place an order containing it, then `DELETE /products/{id}` → `update or delete on table "products" violates foreign key constraint ... on table "order_items"` → HTTP 500 'Internal server error'. Identically, create a user, create an order for them, then `DELETE /users/{id}` → violation on `orders` → 500. Deleting an unreferenced product or an order-less user on the same endpoint returns 200, so callers experience the failure as random and cannot tell 'still referenced' from 'server crashed'.

### Evidence

src/products/products.service.ts:47-50 `const product = await this.findOne(id); await this.productsRepository.remove(product);`. src/users/users.service.ts:53-58 `const user = await this.findOne(id); await this.usersRepository.remove(user);`. src/orders/order-item.entity.ts:10-22 `@ManyToOne(() => Product, { eager: true })` / `@JoinColumn({ name: 'product_id' })` / `@Column({ name: 'product_id' }) productId: number;` — no onDelete, not nullable. src/orders/order.entity.ts:24-29 same shape for user_id.

### Proposed fix

Decide and encode the semantics in both services rather than letting the driver decide. Either count referencing rows first and `throw new ConflictException(`Product #${id} is referenced by existing orders`)` / `... User #${id} has existing orders ...` (409), or soft-delete using the columns that already exist — `Product.isAvailable` (product.entity.ts:22) and `User.isActive` (user.entity.ts:15) — evicting the cache keys on that path. Do NOT add `onDelete: 'CASCADE'`, which would destroy historical order lines.

### How we'll know it's fixed

Place an order for product P by user U, then `curl -i -s -X DELETE localhost:3000/products/P` must return 409 with a message naming the constraint in business terms (currently 500), and `curl -i -s -X DELETE localhost:3000/users/U` likewise. Deleting an unreferenced product must still return 200.

---

## D16 — Collection endpoints have no pagination and pull the full eager graph
<a id="d16"></a>

| | |
|---|---|
| **Severity** | 🟡 Medium |
| **Theme** | Unbounded & wasted work |
| **Location** | `src/orders/orders.service.ts` |
| **Confidence** | certain |

**Symptom it explains** — Some requests are extremely slow or never complete.

### Why it's broken

Three collection reads have no `take`, no `skip`, no ordering and no upper bound of any kind. `GET /orders` with no query param falls through to `findAll()` (orders.controller.ts:15), an unbounded `find({ relations: ['user','items','items.product'] })`. Every relation in that graph is ALREADY `eager: true` — Order.user (order.entity.ts:24), Order.items (order.entity.ts:31), OrderItem.product (order-item.entity.ts:17) and Product.category (product.entity.ts:28) — so the explicit `relations` array is redundant and TypeORM builds a five-table LEFT JOIN over the entire orders table and hydrates the whole graph in one request. `findByUser` (56-61) has the same shape, merely narrowed by userId, and `ProductsService.findAll` (21-23) is the same unbounded pattern on products.

### How it fails

With 100k orders averaging 3 items, `GET /orders` produces ~300k joined rows and hydrates ~1M entity objects — the request blows past the statement timeout or the Node heap, 500s or OOMs the worker, and holds a pool connection throughout, starving every other endpoint. `GET /products` against a 1M-row table serializes a multi-hundred-MB JSON body and pins the event loop during serialization; a few concurrent calls exhaust the heap.

### Evidence

src/orders/orders.service.ts:39-43 verbatim:
39  async findAll(): Promise<Order[]> {
40    return this.ordersRepository.find({
41      relations: ['user', 'items', 'items.product']
42    });
43  }
:57-59 same shape with `where: { userId }`. src/products/products.service.ts:22 `return this.productsRepository.find({ relations: ['category'] });`. Eager flags at order.entity.ts:24,71; order-item.entity.ts:17; product.entity.ts:28.

### Proposed fix

Add mandatory pagination driven by validated query params with a sane default and a hard maximum: `find({ take: Math.min(limit ?? 50, 100), skip: offset ?? 0, order: { id: 'ASC' } })` in all three methods, threading `@Query('limit')`/`@Query('offset')` from orders.controller.ts:10-16 and products.controller.ts:9-12. Drop the now-redundant `relations` arrays at orders.service.ts:40-42 and :59 since all four relations are already eager.

### How we'll know it's fixed

`curl -s 'localhost:3000/orders' | jq length` must return at most the default page size against a seeded table of several thousand orders, and `curl -s 'localhost:3000/orders?limit=5&offset=10' | jq length` must return 5. `curl -s 'localhost:3000/orders?limit=100000' | jq length` must be capped at the hard maximum. Same three checks on `/products`.

---

## D17 — No product write path invalidates the product-search cache
<a id="d17"></a>

| | |
|---|---|
| **Severity** | 🟡 Medium |
| **Theme** | Cache correctness & wiring |
| **Location** | `src/products/products.service.ts` |
| **Confidence** | likely |

**Symptom it explains** — Cache behavior does not match expectations; data is sometimes inconsistent or missing.

### Why it's broken

`searchProducts` writes a 60s cache entry at line 65, but none of the write paths touch the cache: `create` (36-39), `updateStock` (41-45), `remove` (47-50) and `processProductBatch` (112-131) all persist changes and return without any `cacheManager.del`. Grepping `cacheManager` across src/products/products.service.ts returns only lines 18, 54 and 65 — no `del` anywhere in the file — while the users module DOES invalidate on every write (users.service.ts:49, 169, 170). That asymmetry is the tell that the invalidation was deliberately omitted here. `updateStock` is also reached from the order flow (orders.service.ts:89 and :135), so ordinary order traffic desynchronises the search cache.

### How it fails

`GET /products/search?q=widget` caches a Widget. `DELETE /products/42` removes it. For up to 60s the search endpoint still lists it, and a client that follows through to `GET /products/42` gets a 404 from products.service.ts:31 for an item search just advertised — a user-visible contradiction between two endpoints. A newly created product is invisible to search for up to 60s, and stock drawn to 0 by an order still shows as in stock. Staleness is bounded at 60 seconds in every case.

### Evidence

src/products/products.service.ts:36-39, :41-45, :47-50, :112-131 — none reference `cacheManager`; :65 `await this.cacheManager.set(cacheKey, results, 60000);`. `grep -n cacheManager src/products/products.service.ts` → 18, 54, 65 only. Contrast src/users/users.service.ts:49 `await this.cacheManager.del('users:all');` and :169-170.

### Proposed fix

Evict from the mutating paths after the save/remove. Since Keyv/cache-manager has no wildcard delete, combine this with the per-query keys from the cache-key fix using a versioned prefix — `product-search:v{n}:{query}` — and bump `n` at the end of `create`, `updateStock`, `remove` and `processProductBatch`; or track the emitted key set explicitly. Mirror the pattern already used at users.service.ts:49-170.

### How we'll know it's fixed

After the Redis and cache-key fixes: `curl -s 'localhost:3000/products/search?q=widget' | jq length` (warms), then `curl -X DELETE localhost:3000/products/42`, then immediately re-run the search — product 42 must be absent without waiting 60s. Also create a new matching product and confirm it appears in the next search immediately.

---

## D18 — Redis db index hardcoded to 0, ignoring REDIS_DB=1
<a id="d18"></a>

| | |
|---|---|
| **Severity** | 🟡 Medium |
| **Theme** | Cache correctness & wiring |
| **Location** | `src/app.module.ts` |
| **Confidence** | certain |

**Symptom it explains** — Cache behavior does not match expectations; the cache appears empty or un-flushable when inspected on the configured DB.

### Why it's broken

Lines 34 and 35 both read the environment (`process.env.REDIS_HOST`, `process.env.REDIS_PORT`), but line 36 is a literal `db: 0`, and `process.env.REDIS_DB` appears nowhere in src/ (`grep -rn REDIS_DB src/` → no hits). Both .env:13 and .env.sample:13 set `REDIS_DB=1`. The `db` key is the sole outlier in an otherwise fully env-driven object. It is currently 100% masked by the store-wiring defect — nothing reaches Redis at all — and becomes live the moment that is fixed, so it must be repaired in the same change.

### How it fails

After the store wiring is repaired: an operator provisions `REDIS_DB=1` per .env, verifies caching with `redis-cli -n 1 KEYS '*'` (empty), or clears a poisoned entry with `redis-cli -n 1 FLUSHDB` (a no-op). The app is reading and writing db 0, so the stale `product-search` key survives the flush and keeps being served. Two services sharing one Redis instance but intending different logical DBs also collide in db 0.

### Evidence

src/app.module.ts:33-38 verbatim:
33        store: await redisStore({
34          host: process.env.REDIS_HOST || 'localhost',
35          port: parseInt(process.env.REDIS_PORT || '6379', 10),
36          db: 0,
37          ttl: 60000,
38        }),
.env:13 `REDIS_DB=1`; .env.sample:13 `REDIS_DB=1`; `grep -rn REDIS_DB src/` → no matches.

### Proposed fix

src/app.module.ts:36 → `db: parseInt(process.env.REDIS_DB || '0', 10),`. If applying the @keyv/redis migration, encode the index in the connection URL instead: `redis://${host}:${port}/${process.env.REDIS_DB || 0}`. Do not leave this unfixed while fixing the store wiring.

### How we'll know it's fixed

`redis-cli -n 1 -p 6380 FLUSHDB; redis-cli -n 0 -p 6380 FLUSHDB; curl -s localhost:3000/users > /dev/null; redis-cli -n 1 -p 6380 KEYS '*'` must list `users:all` and `redis-cli -n 0 -p 6380 KEYS '*'` must be empty.

---

## D19 — POST /products/batch binds an inline structural type, so validation is skipped and the real error is masked
<a id="d19"></a>

| | |
|---|---|
| **Severity** | 🟡 Medium |
| **Theme** | Input validation & mass assignment |
| **Location** | `src/products/products.controller.ts` |
| **Confidence** | certain |

**Symptom it explains** — Failures produce vague or misleading error messages; requests can be extremely slow.

### Why it's broken

`@Body() body: { productIds: number[] }` is an anonymous TypeScript structural type, so the emitted metatype is `Object`; ValidationPipe's `toValidate()` treats that as a native type and skips validation entirely — an inline type carries no class-validator metadata for the global pipe to work with. `body.productIds` therefore reaches `processProductBatch` unchecked, and `for (const id of productIds)` at products.service.ts:116 throws `TypeError: productIds is not iterable` when it is undefined or a non-array. That TypeError is inside the outer try opened at line 115, so the catch at line 127 rewrites it as a generic `BadRequestException('Batch processing failed')`. There is also no cap on array length, and each id costs a `findOne` SELECT plus a `save` (lines 118-120) issued strictly serially.

### How it fails

`POST /products/batch {}` or `POST /products/batch {"productIds":"1,2,3"}` returns HTTP 400 `{"message":"Batch processing failed"}` — no indication that `productIds` is missing or not an array, and the identical message is produced by unrelated failures inside the batch. Separately, `POST /products/batch` with 50,000 ids issues tens of thousands of sequential round-trips on one request, holding the connection open for minutes with no cap and no progress.

### Evidence

src/products/products.controller.ts:29-32 verbatim:
79  @Post('batch')
80  processBatch(@Body() body: { productIds: number[] }) {
81    return this.productsService.processProductBatch(body.productIds);
82  }
src/products/products.service.ts:116 `for (const id of productIds) {` inside the try opened at :115; :126-128 the rewriting catch.

### Proposed fix

Declare `class ProcessBatchDto { @IsArray() @ArrayNotEmpty() @ArrayMaxSize(500) @IsInt({ each: true }) @Min(1, { each: true }) productIds: number[]; }` and bind `@Body() body: ProcessBatchDto`, so the global pipe rejects a bad body with a field-level 400 before the service runs and the length cap bounds the work. Load the ids in one `In(productIds)` query instead of per-id `findOne`.

### How we'll know it's fixed

`curl -i -s -X POST localhost:3000/products/batch -H 'content-type: application/json' -d '{}'` must return 400 with `productIds should not be empty` / `productIds must be an array` (currently 400 'Batch processing failed'). `curl -i -s -X POST localhost:3000/products/batch -H 'content-type: application/json' -d '{"productIds":"1,2,3"}'` must return 400 naming the type error. A 600-element array must return 400 citing the max size.

---

## D20 — GET /orders?userId=<non-numeric> yields NaN in the WHERE clause and a 500
<a id="d20"></a>

| | |
|---|---|
| **Severity** | 🟡 Medium |
| **Theme** | Input validation & mass assignment |
| **Location** | `src/orders/orders.controller.ts` |
| **Confidence** | certain |

**Symptom it explains** — Vague or misleading error messages.

### Why it's broken

`userId` is declared `string` and converted with a bare `parseInt(userId, 10)` at line 13 — no `ParseIntPipe`, no NaN check — inconsistent with every `:id` param in the same controller, which all use `ParseIntPipe` (lines 19, 24, 34, 40, 47). A non-numeric value yields `NaN`, which flows into `findByUser` → `find({ where: { userId: NaN } })` (orders.service.ts:57-58); node-postgres serializes NaN as the literal 'NaN' for the `user_id` integer column and Postgres rejects it with `invalid input syntax for type integer`. That error is not an HttpException, so Nest maps it to 500 instead of the 400 the request deserves. `parseInt` also accepts a numeric prefix, so garbage that starts with digits is silently accepted. Note the empty-string case `?userId=` is falsy at line 12 and correctly falls through to `findAll()`.

### How it fails

`GET /orders?userId=abc` returns 500 'Internal server error' with a Postgres driver message in the logs instead of 400 'Validation failed (numeric string is expected)' — the caller cannot distinguish a bad request from a server outage. Worse and silently: `GET /orders?userId=3abc` parses to 3 and returns user 3's orders to a caller who asked for something else, and `?userId=1,2` returns user 1's orders with no error.

### Evidence

src/orders/orders.controller.ts:10-16 verbatim:
10  @Get()
11  findAll(@Query('userId') userId?: string) {
12    if (userId) {
13      return this.ordersService.findByUser(parseInt(userId, 10));
14    }
15    return this.ordersService.findAll();
16  }
Compare lines 19, 24, 34, 40, 47 — all `@Param('id', ParseIntPipe)`.

### Proposed fix

Use the pipe the rest of the controller already uses and drop the manual parse: `findAll(@Query('userId', new ParseIntPipe({ optional: true })) userId?: number)`, testing `if (userId !== undefined)` instead of the truthiness check on line 12 (which also mishandles `userId=0`). This rejects both `abc` and `3abc` with a 400.

### How we'll know it's fixed

`curl -i -s 'localhost:3000/orders?userId=abc'` must return 400 'Validation failed (numeric string is expected)' (currently 500). `curl -i -s 'localhost:3000/orders?userId=3abc'` must also return 400, not user 3's orders. `curl -i -s 'localhost:3000/orders'` must still return the (now paginated) full list.

---

## D21 — Duplicate-email user creation surfaces as a bare 500 instead of 409
<a id="d21"></a>

| | |
|---|---|
| **Severity** | 🟡 Medium |
| **Theme** | Error handling & diagnosability |
| **Location** | `src/users/users.service.ts` |
| **Confidence** | certain |

**Symptom it explains** — Failures produce vague or misleading error messages.

### Why it's broken

src/users/user.entity.ts:9-10 declares `@Column({ unique: true }) email: string;` and `synchronize: true` (app.module.ts:28) materialises that unique index. `create()` is `const user = this.usersRepository.create(createUserDto); const saved = await this.usersRepository.save(user);` with no pre-check and no try/catch anywhere in the method. A Postgres unique violation surfaces as TypeORM's `QueryFailedError` (SQLSTATE 23505), which is not an HttpException, so Nest's default exception filter maps it to `500 {"statusCode":500,"message":"Internal server error"}` and logs it as a server fault. There is also no global exception filter — main.ts registers only the ValidationPipe on line 7.

### How it fails

`POST /users {"email":"alice@x.com","name":"Alice"}` succeeds. A double-submit, or a client retry after a timed-out first attempt, returns 500 'Internal server error' rather than 409 Conflict — the caller cannot distinguish 'already exists' from a genuine outage, and retry logic keeps hammering an inherently unretryable request.

### Evidence

src/users/users.service.ts:46-51 (no try/catch): `const user = this.usersRepository.create(createUserDto); const saved = await this.usersRepository.save(user); await this.cacheManager.del('users:all'); return saved;`. src/users/user.entity.ts:9-10 `@Column({ unique: true })`. src/app.module.ts:28 `synchronize: true,`. src/main.ts:5-9 registers no exception filter.

### Proposed fix

Translate the driver error at the write rather than pre-checking with a SELECT (which is racy): wrap the save in `try { ... } catch (e) { if ((e as any).code === '23505') throw new ConflictException(`User with email ${createUserDto.email} already exists`); throw e; }`, importing `ConflictException` from `@nestjs/common`.

### How we'll know it's fixed

`curl -X POST localhost:3000/users -H 'content-type: application/json' -d '{"email":"dup@x.com","name":"A"}'` then repeat the identical request: the second must return 409 with 'User with email dup@x.com already exists' (currently 500).

---

## D22 — Dangling categoryId/parentId is caught by Postgres, not the API, producing a raw 500
<a id="d22"></a>

| | |
|---|---|
| **Severity** | 🟡 Medium |
| **Theme** | Input validation & mass assignment |
| **Location** | `src/products/dto/create-product.dto.ts` |
| **Confidence** | certain |

**Symptom it explains** — Failures produce vague or misleading error messages; data is sometimes inconsistent.

### Why it's broken

`CreateProductDto.categoryId` carries only `@IsNumber() @IsOptional()` — no existence check, no `@IsInt()`, no `@Min(1)` — and `CreateCategoryDto.parentId` has the same shape. `create()` (products.service.ts:36-39) and `createCategory()` (84-87) pass the value straight into `repository.create()`/`save()`. Both columns have real FK constraints generated by `synchronize: true` from the `@ManyToOne` + `@JoinColumn` pairs (product.entity.ts:25-30, category.entity.ts:18-20), so a dangling id is caught by Postgres rather than by the API, and the unmapped `QueryFailedError` (SQLSTATE 23503) becomes a 500.

### How it fails

`POST /products {"name":"X","price":1,"categoryId":99999}` → `insert or update on table "products" violates foreign key constraint` → HTTP 500, where the correct answer is a 400/404 'Category #99999 not found'. `POST /categories {"name":"X","parentId":99999}` fails identically. A fractional id such as `1.5` also passes `@IsNumber()` and dies at the driver with `invalid input syntax for type integer`.

### Evidence

src/products/dto/create-product.dto.ts — `@IsNumber()` / `@IsOptional()` / `categoryId?: number;` and the same shape for `parentId` in CreateCategoryDto. src/products/products.service.ts:36-38 `const product = this.productsRepository.create(createProductDto); return this.productsRepository.save(product);`; :85-86 identical for categories. src/products/product.entity.ts:25-30; src/products/category.entity.ts:18-20.

### Proposed fix

Validate the reference before persisting: in `ProductsService.create()` add `if (dto.categoryId != null) await this.findCategory(dto.categoryId);` — which already raises a clear NotFoundException at line 79 — and the same for `parentId` in `createCategory()`. Tighten both DTO fields to `@IsInt() @Min(1)`.

### How we'll know it's fixed

`curl -i -s -X POST localhost:3000/products -H 'content-type: application/json' -d '{"name":"X","price":1,"categoryId":99999}'` must return 404 'Category #99999 not found' (currently 500). `curl -i -s -X POST localhost:3000/categories -H 'content-type: application/json' -d '{"name":"X","parentId":99999}'` likewise. `"categoryId":1.5` must return 400 naming the field.

---

## D23 — CreateOrderDto accepts an empty items array and non-integer productId/quantity
<a id="d23"></a>

| | |
|---|---|
| **Severity** | 🟡 Medium |
| **Theme** | Input validation & mass assignment |
| **Location** | `src/orders/dto/create-order.dto.ts` |
| **Confidence** | certain |

**Symptom it explains** — Data is sometimes inconsistent or missing.

### Why it's broken

`items` carries `@IsArray()` and `@ValidateNested({ each: true })` but no `@ArrayNotEmpty()`/`@ArrayMinSize(1)`, and `@ValidateNested({ each: true })` is vacuously satisfied by an empty array — so `items: []` passes validation and `create()` runs a zero-iteration loop at line 73, persisting an order row with `total = 0` and no line items. Separately `productId` and `quantity` use `@IsNumber()` rather than `@IsInt()`, so 2.5 passes `@Min(1)`; `OrderItem.quantity` is a plain integer column (order-item.entity.ts:24-25), so the awaited insert at orders.service.ts:87 rejects with a Postgres `invalid input syntax for type integer` — a 500, and (per the transaction defect) an orphaned pending order row left behind.

### How it fails

`POST /orders {"userId":1,"items":[]}` → 201 with a permanent phantom order (status pending, total 0.00, zero items) polluting order history and reporting, and `POST /orders/{id}/pay` will happily 'charge' 0. `POST /orders {"userId":1,"items":[{"productId":1,"quantity":2.5}]}` → 500 with a raw driver message plus an orphaned order row. `"productId": 1.5` passes validation and then fails at `findOne(1.5)` with the same driver error.

### Evidence

src/orders/dto/create-order.dto.ts:4-192 verbatim:
176  export class OrderItemDto {
177    @IsNumber()
178    productId: number;
180    @IsNumber()
181    @Min(1)
182    quantity: number;
...
189    @IsArray()
190    @ValidateNested({ each: true })
191    @Type(() => OrderItemDto)
192    items: OrderItemDto[];
src/orders/order-item.entity.ts:24-25 `@Column() quantity: number;` (integer). src/orders/orders.service.ts:73 the loop.

### Proposed fix

Add `@ArrayNotEmpty()` alongside `@IsArray()` on the `items` field, and change `productId` and `quantity` (and `userId`) from `@IsNumber()` to `@IsInt()`, keeping `@Min(1)` on quantity and adding `@Min(1)` to productId and userId.

### How we'll know it's fixed

`curl -i -s -X POST localhost:3000/orders -H 'content-type: application/json' -d '{"userId":1,"items":[]}'` must return 400 'items should not be empty' (currently 201). `... -d '{"userId":1,"items":[{"productId":1,"quantity":2.5}]}'` must return 400 naming quantity (currently 500), and `select count(*) from orders where total=0` must not increase after either call.

---

## D24 — CreateProductDto validates price/stock as loose numbers
<a id="d24"></a>

| | |
|---|---|
| **Severity** | 🟡 Medium |
| **Theme** | Input validation & mass assignment |
| **Location** | `src/products/dto/create-product.dto.ts` |
| **Confidence** | likely |

**Symptom it explains** — Data is sometimes inconsistent or missing.

### Why it's broken

`price` is `@IsNumber() @Min(0)` with no `{ maxDecimalPlaces: 2 }` while the column is `decimal(10,2)` (product.entity.ts:16), so Postgres silently rounds anything more precise — and because `save()` returns the in-memory entity, the create response echoes the unrounded value the DB did not store. `stock` is `@IsNumber() @Min(0) @IsOptional()` rather than `@IsInt()` while the column is a plain `@Column({ default: 0 })` on a `number` field (product.entity.ts:19-20), which TypeORM maps to `integer`; a fractional value passes validation and is rejected by the driver as a 500.

### How it fails

(a) `POST /products {"name":"X","price":19.999}` returns 201 echoing `"price": 19.999`, while `GET /products/{id}` afterwards returns `"20.00"` — the create response and the stored row disagree, and a client that trusts the 201 body has wrong data. (b) `POST /products {"name":"X","price":1,"stock":2.5}` passes validation and then fails with `invalid input syntax for type integer: "2.5"` → HTTP 500 instead of a 400 naming the field.

### Evidence

src/products/dto/create-product.dto.ts:11-18 verbatim:
204    @IsNumber()
205    @Min(0)
206    price: number;
208    @IsNumber()
209    @Min(0)
210    @IsOptional()
211    stock?: number;
src/products/product.entity.ts:16 `@Column({ type: 'decimal', precision: 10, scale: 2 })`; :19 `@Column({ default: 0 }) stock: number;` → integer.

### Proposed fix

`@IsNumber({ maxDecimalPlaces: 2 }) @Min(0) price: number;` and `@IsInt() @Min(0) @IsOptional() stock?: number;`, so both are rejected at the edge with a field-level 400 rather than being silently rounded or dying in the driver.

### How we'll know it's fixed

`curl -i -s -X POST localhost:3000/products -H 'content-type: application/json' -d '{"name":"X","price":19.999}'` must return 400 citing maxDecimalPlaces (currently 201 echoing 19.999). `... -d '{"name":"X","price":1,"stock":2.5}'` must return 400 naming stock (currently 500).

---

## D25 — Decimal columns come back from Postgres as strings
<a id="d25"></a>

| | |
|---|---|
| **Severity** | 🟡 Medium |
| **Theme** | Schema & type fidelity |
| **Location** | `src/products/product.entity.ts` |
| **Confidence** | certain |

**Symptom it explains** — Data is sometimes inconsistent or missing (money fields have different JSON types on write and read).

### Why it's broken

All three money columns are declared `@Column({ type: 'decimal', precision: 10, scale: 2 })` with a TypeScript type of `number` and no `transformer`. node-postgres has no lossless JS type for `numeric`, so it returns these values as strings and TypeORM passes them through unchanged — the declared `number` type is unenforced at runtime. Values just written (the in-memory entity `save()` returns) are numbers, while values read back from the DB are strings, so the same field has two types depending on the code path. `Number(order.total)` at orders.service.ts:110 is the codebase's own local band-aid, confirming the mismatch is live and that every other path is unguarded.

### How it fails

`POST /products {"name":"Widget","price":19.99}` returns 201 with `"price": 19.99` (a JSON number), while `GET /products/1` on the same row returns `"price": "19.99"` (a JSON string). Feeding a fetched object back into `POST /products` is rejected 400 by `@IsNumber()`. A client computing `order.total + shipping` gets `"39.98" + 5 === "39.985"`. Server-side arithmetic survives only by accident: `total += product.price * itemDto.quantity` (orders.service.ts:88) works because `*` coerces, but any `+` on the same value would concatenate.

### Evidence

src/products/product.entity.ts:16-17 `@Column({ type: 'decimal', precision: 10, scale: 2 })` / `price: number;`; src/orders/order.entity.ts:21-22 same for `total`; src/orders/order-item.entity.ts:27-28 same for `price`; src/orders/orders.service.ts:110 `await paymentService.processPayment(orderId, Number(order.total));`.

### Proposed fix

Add a transformer to all three decimal columns: `@Column({ type: 'decimal', precision: 10, scale: 2, transformer: { to: (v: number) => v, from: (v: string | null) => (v === null ? null : parseFloat(v)) } })`, so reads match the declared type and the DTO contract. The `Number()` cast at orders.service.ts:110 then becomes unnecessary. Schedule this last — it changes the JSON type of every money field and needs client coordination.

### How we'll know it's fixed

`ID=$(curl -s -X POST localhost:3000/products -H 'content-type: application/json' -d '{"name":"W","price":19.99}' | jq -r .id); curl -s localhost:3000/products/$ID | jq '.price|type'` must print `number` (currently `string`). Same check on `curl -s localhost:3000/orders/1 | jq '.total|type'` and `.items[0].price|type`.

---

## D26 — Product.category is eager: true, forcing a categories join on every product read
<a id="d26"></a>

| | |
|---|---|
| **Severity** | ⚪ Low |
| **Theme** | Unbounded & wasted work |
| **Location** | `src/products/product.entity.ts` |
| **Confidence** | likely |

**Symptom it explains** — Some requests are extremely slow.

### Why it's broken

`{ eager: true }` on the ManyToOne makes TypeORM add a LEFT JOIN to `categories` for every `find`/`findOne` on Product anywhere in the codebase, with no per-call-site opt-out, and TypeORM also joins the eager relations of already-joined entities. It silently inflates every bulk read: searchProducts' full-table find (products.service.ts:59), findAll (:22), and every nested product load elsewhere (orders.service.ts:41, 48, 59 all load `items.product`, so each order also drags category rows). A ManyToOne join does not multiply row counts — it widens each row and adds hydration work — so this is an amplifier of the unbounded-read defects rather than an independent root cause, which is why it is scored low.

### How it fails

`GET /orders` joins user + items + products + categories even though no consumer of that endpoint reads `product.category`; every search cache miss (products.service.ts:59) pays a categories join across the entire table on top of the full scan.

### Evidence

src/products/product.entity.ts:28-30 verbatim:
28  @ManyToOne(() => Category, (category) => category.products, { eager: true })
29  @JoinColumn({ name: 'category_id' })
30  category: Category;
src/products/products.service.ts:22 and :28 already pass `relations: ['category']` explicitly, making the eager flag redundant at exactly the call sites that want it.

### Proposed fix

Drop `eager: true` (leave `@ManyToOne(() => Category, (category) => category.products)`) and let each call site ask for `relations: ['category']` when it needs it — findAll (products.service.ts:22) and findOne (:28) already do. Verify no other call site silently depended on it before removing.

### How we'll know it's fixed

Enable `logging: ['query']` in the TypeORM config, then `curl -s localhost:3000/orders/1 > /dev/null` and confirm the emitted SQL no longer contains a join to `categories`. `curl -s localhost:3000/products/1 | jq .category` must still be populated (that call site requests the relation explicitly).

---

## D27 — getCategoryTree loads every product of the category and never uses them
<a id="d27"></a>

| | |
|---|---|
| **Severity** | ⚪ Low |
| **Theme** | Unbounded & wasted work |
| **Location** | `src/products/products.service.ts` |
| **Confidence** | certain |

**Symptom it explains** — Some requests are extremely slow.

### Why it's broken

`getCategoryTree` (89-92) delegates to `findCategory`, whose relation list at line 76 includes `'products'`. `buildCategoryTree` reads only `id`, `name`, `parent` and `children` (lines 95-107) and never touches `category.products`, so every product is fetched, hydrated — each dragging its own eager category join (product.entity.ts:28) — and thrown away. The join is unbounded in the number of products in the category. The relation is legitimately needed by `GET /categories/:id` (products.controller.ts:49-52), just not by the tree path.

### How it fails

`GET /categories/3/tree` for an 'Electronics' category holding 200k products issues a join returning 200k rows to build a payload of a few category nodes; the request spends tens of seconds on wasted I/O and hydration before it even reaches the undefined-parent crash.

### Evidence

src/products/products.service.ts:74-77 `const category = await this.categoriesRepository.findOne({ where: { id }, relations: ['parent', 'children', 'products'] });`; :90-91 `const category = await this.findCategory(categoryId); return this.buildCategoryTree(category);`; :95-107 `buildCategoryTree` never reads `category.products`.

### Proposed fix

Give the tree path its own lookup that selects only what it needs — `this.categoriesRepository.findOne({ where: { id }, relations: ['parent', 'children'] })` — and keep the `products` relation on the detail endpoint only (paginated). This folds naturally into the buildCategoryTree rewrite.

### How we'll know it's fixed

Seed a category with several thousand products, enable `logging: ['query']`, then `curl -s localhost:3000/categories/3/tree > /dev/null` and confirm no join to `products` appears in the emitted SQL and the response time drops accordingly. `curl -s localhost:3000/categories/3 | jq '.products|length'` must still be populated.

---

