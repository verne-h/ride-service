# Ride dispatch service

A small in-memory Node.js, TypeScript, and Express API. Driver data and configuration are loaded once at startup from `drivers.json` and `config.example.json`; the driver's snapshot timestamp is used as the reference time for location freshness.

## Run

```sh
npm start
```

`npm start` intalls the dependencies, builds the TypeScript service, and starts it. For watch-mode development, use `npm run dev`. The service listens on port `3000` by default; set `PORT` to change it. Run `npm test` for the focused tests or `npm run build` to build without starting the service.

## API

- `POST /rides` — create a ride (`202 Accepted`) and start matching asynchronously.
- `GET /rides/:ride_id` — poll ride status and offer history.
- `POST /rides/:ride_id/cancel` — cancel before acceptance; withdraws any open offer.
- `GET /rides/:ride_id/candidates` — inspect ranked eligible candidates, rejected-driver reasons, and excluded input records.
- `GET /drivers/:driver_id/offers` — poll the driver's open offer.
- `POST /offers/:offer_id/accept` — accept an open offer; repeated acceptance is idempotent.
- `POST /offers/:offer_id/decline` — decline an open offer.

Errors use `{ "error": { "code": "...", "message": "..." } }`. Invalid input returns `400`, missing resources return `404`, conflicting state returns `409`, and expired or withdrawn offers return `410`.

## Matching behavior

Eligibility is checked before ranking: offline and wrong-vehicle drivers, stale locations, busy drivers, drivers over the pickup ETA limit, and disallowed/long-running trips are excluded. Distances use Haversine distance rounded to metres; road distance applies `route_factor`; ETA is rounded to seconds before threshold checks and ranking. On-trip ETAs include their remaining trip time and travel from dropoff to pickup.

`nearest` ranks eligible available drivers by straight-line distance. `fastest_eta` ranks available and eligible on-trip drivers by pickup time. Ties use pickup ETA and then driver ID. Strategies are registered in the matching module; dispatch itself only consumes the ranked candidates, so its offer flow does not need strategy-specific logic.

Matching offers one driver at a time. An open offer reserves its driver across rides; declines and timeouts are recorded so the ride will not offer to that driver again. Accepted drivers remain reserved for the process lifetime. State and reservations are in memory and are not shared across multiple service processes.

## Input data quality

Malformed driver entries are excluded individually rather than preventing startup; their IDs and exclusion reasons are available from the candidate debug endpoint. Valid duplicate IDs retain the record with the newest `last_location_update`; other duplicates are excluded. A tie keeps the first record for deterministic behavior. Driver record validation checks the fields needed for matching, coordinate ranges, status/trip consistency, and timestamps. Locations later than the dataset snapshot are treated as invalid.

## What I would change if running several copies in production

Before running multiple copies in production, I would replace the in-memory state with shared, durable storage. Each process currently keeps rides, offers, and driver reservations in local memory, so requests routed to different instances can see inconsistent state, and a restart loses it.

I would persist rides, offers, and tried-driver history in a shared database, and use transactions or conditional updates to ensure only one instance can reserve a driver or accept an offer at a time. Driver availability and locations should also come from a shared, regularly updated source rather than a snapshot loaded only at startup.

I would move dispatch and offer timeouts to a durable queue or database-backed worker so jobs can be retried or recovered after a process failure. Then I would run the instances behind a load balancer with health checks, graceful shutdown, and centralized logging and metrics. Sticky sessions would not solve the shared-state problem.

Finally, I would add request idempotency to `POST /rides` so client retries do not create duplicate rides. The existing UUID-based ride and offer IDs are already suitable for multiple instances.

## With more time

Given more time I would implement the optional extras from the instructions pdf:
- Support live locations: Let drivers update their location and availability so matching doesn’t rely on a startup snapshot.
- Add real-time notifications: Use Server-Sent Events or WebSockets to reduce reliance on polling.

I would also focus on the following improvements:
- Expand testing: Add focused tests for matching, ETA and freshness boundaries, invalid requests, and competing actions; use a controllable clock for reliable timeout tests.
- State handling: Centralize and test ride and offer transitions to make cancellation, timeouts, and responses easier to reason about.
- Operations: Add structured logs and metrics, and define cleanup or retention for completed rides and offer data.
- Improve API security and documentation: Add authentication, authorization, request validation, and OpenAPI documentation.
- Production scaling: Use shared durable storage and atomic updates across instances, plus a durable queue for dispatch work.