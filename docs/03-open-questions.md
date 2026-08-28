# 03 — Open Questions

Items that need a decision, or that qualify a claim made elsewhere in these docs.
Several fixes are blocked on these — noted inline where that's the case.

## Q1

All five reported symptoms map to at least one confirmed defect — no symptom is left unexplained. The thinnest mapping is 'cache behavior does not match expectations', which is carried entirely by the four defects in the cache theme; if operators report cache anomalies that survive step 3, that is a signal something beyond these four is in play.

## Q2

CORRECTION TO THE FRAMING WE WERE GIVEN: broken Redis wiring does NOT fully mask the cache-key collision. Because @nestjs/cache-manager falls back to an in-process Keyv (not a no-op), `GET /products/search?q=laptop` followed by `?q=shoes` reproduces the wrong-results bug TODAY within a single process. What the wiring defect actually masks is (a) the `db: 0` defect, entirely; (b) persistence across restarts — under `nest start --watch` every file save wipes the cache, which is why the bug reads as intermittent; (c) all cross-instance staleness; and (d) any redis-cli-based verification of a fix. The step ordering stands, but the design doc should state the masking precisely rather than claiming the key bug cannot reproduce.

## Q3

Which Redis remediation path? Swap to keyv + @keyv/redis (correct for the installed @nestjs/cache-manager 3.x / cache-manager 7.x, but adds/removes dependencies), or downgrade to @nestjs/cache-manager ^2 + cache-manager ^5 (the API cache-manager-ioredis-yet actually targets, keeping the existing dependency). Needs an owner decision before step 2 can start.

## Q4

Does switching to a real serializing Redis store break `UsersService.remove()`? Line 167 loads the user via the cached `findOne` and line 168 passes it to `usersRepository.remove(user)`. Today that is a live entity instance; after step 2 it is a deserialized plain object with `createdAt` as a string. Must be tested explicitly as part of step 2, not assumed.

## Q5

Delete semantics for referenced rows: 409 Conflict, or soft-delete via the existing `Product.isAvailable` / `User.isActive` columns? Both columns already exist and are currently unused by any endpoint, which hints soft-delete was the intent — but that changes what every list/search endpoint must filter on. Product decision required before step 9.

## Q6

Payment idempotency: the mock `processPayment(orderId, amount)` has no idempotency-key parameter, so the double-charge risk in the pay path cannot be fully closed inside this codebase. Is the real provider contract available, or should we key off orderId plus a stored transactionId?

## Q7

Should `POST /orders` with the same productId listed twice be merged into one line item or rejected as a 400? The atomic-decrement fix in step 4 makes the stock correct either way, but the resulting order shape differs and no requirement covers it.

## Q8

Should product search be paginated, and does the DB owner accept a trigram/GIN index on products(name, description)? Adding `take`/`skip` to search changes the response contract, and ILIKE without a trigram index will still seq-scan at scale.

## Q9

Is more than one app instance ever run in production? compose.yaml defines no app service and the README describes a single `pnpm start:dev` process. If single-instance is permanent, the cross-instance half of the cache defect is theoretical and step 2 can be scheduled on cost grounds rather than urgency — but it still gates verification of step 3.

## Q10

Is `parent` supposed to appear in the category tree payload at all? The current mixed up-and-down traversal is the source of the crash; if consumers only need the downward subtree, the fix is much smaller than a recursive CTE and the `parent` branch at products.service.ts:101-103 can simply be deleted.

## Q11

Are there existing API consumers that send extra body fields today? This determines whether step 1 can ship `forbidNonWhitelisted: true` immediately or must ship `whitelist: true` alone first and tighten later.

