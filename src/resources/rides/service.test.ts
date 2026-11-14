import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { createApp } from "../../app.js";
import { loadConfig } from "../../config.js";
import { loadDrivers } from "../drivers/repository.js";

test("driver loading excludes broken records and keeps the newest duplicate", async () => {
  const dataset = await loadDrivers();
  assert.equal(dataset.drivers.length, 36);
  assert.equal(dataset.excludedRecords.length, 3);
  assert.equal(
    dataset.drivers.find((driver) => driver.id === "drv_020")?.last_location_update,
    "2026-11-10T14:59:55Z",
  );
  assert.equal(dataset.drivers.some((driver) => driver.id === "drv_010"), false);
  assert.equal(dataset.drivers.some((driver) => driver.id === "drv_011"), false);
});

test("ride offers can be polled and accepted idempotently", async (context) => {
  const [dataset, config] = await Promise.all([loadDrivers(), loadConfig()]);
  const server = createServer(createApp(dataset, config));
  server.listen(0);
  await once(server, "listening");
  context.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const createdResponse = await fetch(`${baseUrl}/rides`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      rider_id: "rdr_test",
      pickup: { lat: 48.3809, lng: -89.2477 },
      dropoff: { lat: 48.4201, lng: -89.2302 },
      vehicle_type: "economy",
    }),
  });
  assert.equal(createdResponse.status, 202);
  const created = await createdResponse.json() as { ride_id: string };

  type PolledRide = { status: string; offers: Array<{ offer_id: string; driver_id: string }> };
  let ride: PolledRide | undefined;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await fetch(`${baseUrl}/rides/${created.ride_id}`);
    ride = await response.json() as typeof ride;
    if (ride?.status === "offered") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(ride?.status, "offered");
  assert.equal(ride?.offers.length, 1);
  const firstOffer = ride!.offers[0]!;

  const driverOffersResponse = await fetch(`${baseUrl}/drivers/${firstOffer.driver_id}/offers`);
  const driverOffers = await driverOffersResponse.json() as { offers: Array<{ offer_id: string }> };
  assert.equal(driverOffers.offers[0]?.offer_id, firstOffer.offer_id);

  const secondCreatedResponse = await fetch(`${baseUrl}/rides`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      rider_id: "rdr_concurrent",
      pickup: { lat: 48.3809, lng: -89.2477 },
      dropoff: { lat: 48.4201, lng: -89.2302 },
      vehicle_type: "economy",
    }),
  });
  const secondCreated = await secondCreatedResponse.json() as { ride_id: string };
  let secondRide: PolledRide | undefined;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await fetch(`${baseUrl}/rides/${secondCreated.ride_id}`);
    secondRide = await response.json() as typeof ride;
    if (secondRide?.status === "offered") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(secondRide?.status, "offered");
  assert.notEqual(secondRide?.offers[0]?.driver_id, firstOffer.driver_id);
  await fetch(`${baseUrl}/rides/${secondCreated.ride_id}/cancel`, { method: "POST" });

  assert.equal((await fetch(`${baseUrl}/offers/${firstOffer.offer_id}/decline`, { method: "POST" })).status, 200);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await fetch(`${baseUrl}/rides/${created.ride_id}`);
    ride = await response.json() as typeof ride;
    if (ride?.offers.length === 2) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(ride?.offers.length, 2);
  const offer = ride!.offers[1]!;
  assert.notEqual(offer.driver_id, firstOffer.driver_id);
  const acceptUrl = `${baseUrl}/offers/${offer.offer_id}/accept`;
  assert.equal((await fetch(acceptUrl, { method: "POST" })).status, 200);
  assert.equal((await fetch(acceptUrl, { method: "POST" })).status, 200);
  const acceptedResponse = await fetch(`${baseUrl}/rides/${created.ride_id}`);
  const accepted = await acceptedResponse.json() as { status: string; driver?: { id: string }; pickup_eta_seconds?: number };
  assert.equal(accepted.status, "accepted");
  assert.equal(accepted.driver?.id, offer.driver_id);
  assert.equal(typeof accepted.pickup_eta_seconds, "number");
});

test("cancelling an offered ride withdraws the offer", async (context) => {
  const [dataset, config] = await Promise.all([loadDrivers(), loadConfig()]);
  const server = createServer(createApp(dataset, config));
  server.listen(0);
  await once(server, "listening");
  context.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const createdResponse = await fetch(`${baseUrl}/rides`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      rider_id: "rdr_cancel",
      pickup: { lat: 48.3809, lng: -89.2477 },
      dropoff: { lat: 48.4201, lng: -89.2302 },
      vehicle_type: "economy",
    }),
  });
  const created = await createdResponse.json() as { ride_id: string };
  let offered: { status: string; offers: Array<{ offer_id: string }> } | undefined;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await fetch(`${baseUrl}/rides/${created.ride_id}`);
    offered = await response.json() as typeof offered;
    if (offered?.status === "offered") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(offered?.status, "offered");
  assert.equal(offered?.offers.length, 1);
  const offerId = offered!.offers[0]!.offer_id;
  const cancelledResponse = await fetch(`${baseUrl}/rides/${created.ride_id}/cancel`, { method: "POST" });
  assert.equal(cancelledResponse.status, 200);
  const cancelled = await cancelledResponse.json() as { status: string; offers: unknown[] };
  assert.equal(cancelled.status, "cancelled");
  assert.equal((cancelled.offers[0] as { status: string }).status, "withdrawn");
  const lateAccept = await fetch(`${baseUrl}/offers/${offerId}/accept`, { method: "POST" });
  assert.equal(lateAccept.status, 410);
});

test("timed-out offers count toward the configured attempt limit", async (context) => {
  const [dataset, baseConfig] = await Promise.all([loadDrivers(), loadConfig()]);
  const config = { ...baseConfig, offer_timeout_seconds: 0.02, max_offer_attempts: 1 };
  const server = createServer(createApp(dataset, config));
  server.listen(0);
  await once(server, "listening");
  context.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const createdResponse = await fetch(`${baseUrl}/rides`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      rider_id: "rdr_timeout",
      pickup: { lat: 48.3809, lng: -89.2477 },
      dropoff: { lat: 48.4201, lng: -89.2302 },
      vehicle_type: "economy",
    }),
  });
  const created = await createdResponse.json() as { ride_id: string };
  let finalRide: { status: string; offers: Array<{ offer_id: string; status: string }> } | undefined;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await fetch(`${baseUrl}/rides/${created.ride_id}`);
    finalRide = await response.json() as typeof finalRide;
    if (finalRide?.status === "no_driver_found") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(finalRide?.status, "no_driver_found");
  assert.equal(finalRide?.offers[0]?.status, "timed_out");
  const lateAccept = await fetch(`${baseUrl}/offers/${finalRide!.offers[0]!.offer_id}/accept`, { method: "POST" });
  assert.equal(lateAccept.status, 410);
});
