import { readFile } from "node:fs/promises";
import type { Driver, DriverDataset, DriverStatus, Location, VehicleType } from "./types.js";

const vehicleTypes = new Set<VehicleType>(["economy", "comfort", "xl"]);
const statuses = new Set<DriverStatus>(["available", "on_trip", "offline"]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLocation(value: unknown): value is Location {
  if (!isObject(value)) return false;
  return typeof value.lat === "number" && Number.isFinite(value.lat) && value.lat >= -90 && value.lat <= 90
    && typeof value.lng === "number" && Number.isFinite(value.lng) && value.lng >= -180 && value.lng <= 180;
}

function parseDriver(value: unknown, snapshotTime: number): { driver?: Driver; reason?: string; id: string | null } {
  const id = isObject(value) && typeof value.id === "string" ? value.id : null;
  if (!isObject(value)) return { id, reason: "record is not an object" };
  if (!id || typeof value.name !== "string" || !value.name) return { id, reason: "missing id or name" };
  if (typeof value.status !== "string" || !statuses.has(value.status as DriverStatus)) {
    return { id, reason: "invalid status" };
  }
  if (!isLocation(value.location)) return { id, reason: "invalid location" };
  if (typeof value.vehicle_type !== "string" || !vehicleTypes.has(value.vehicle_type as VehicleType)) {
    return { id, reason: "invalid vehicle_type" };
  }
  if (typeof value.speed_kmh !== "number" || !Number.isFinite(value.speed_kmh) || value.speed_kmh < 0) {
    return { id, reason: "invalid speed_kmh" };
  }
  if (value.heading_deg !== null && (typeof value.heading_deg !== "number"
    || !Number.isFinite(value.heading_deg) || value.heading_deg < 0 || value.heading_deg >= 360)) {
    return { id, reason: "invalid heading_deg" };
  }
  if (typeof value.rating !== "number" || !Number.isFinite(value.rating) || value.rating < 1 || value.rating > 5) {
    return { id, reason: "invalid rating" };
  }
  if (typeof value.acceptance_rate !== "number" || !Number.isFinite(value.acceptance_rate)
    || value.acceptance_rate < 0 || value.acceptance_rate > 1) {
    return { id, reason: "invalid acceptance_rate" };
  }
  const updateTime = typeof value.last_location_update === "string" ? Date.parse(value.last_location_update) : NaN;
  if (!Number.isFinite(updateTime) || updateTime > snapshotTime) {
    return { id, reason: "invalid last_location_update" };
  }

  let currentTrip: Driver["current_trip"] = null;
  if (value.status === "on_trip") {
    if (!isObject(value.current_trip) || !isLocation(value.current_trip.dropoff)
      || typeof value.current_trip.eta_to_dropoff_seconds !== "number"
      || !Number.isFinite(value.current_trip.eta_to_dropoff_seconds)
      || value.current_trip.eta_to_dropoff_seconds < 0) {
      return { id, reason: "invalid current_trip" };
    }
    currentTrip = {
      dropoff: value.current_trip.dropoff,
      eta_to_dropoff_seconds: value.current_trip.eta_to_dropoff_seconds,
    };
  } else if (value.current_trip !== null) {
    return { id, reason: "non-trip driver has a current_trip" };
  }

  return {
    id,
    driver: {
      id,
      name: value.name,
      status: value.status as DriverStatus,
      location: value.location,
      vehicle_type: value.vehicle_type as VehicleType,
      rating: value.rating,
      last_location_update: value.last_location_update as string,
      current_trip: currentTrip,
    },
  };
}

export async function loadDrivers(path = "drivers.json"): Promise<DriverDataset> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!isObject(parsed) || !Array.isArray(parsed.drivers) || typeof parsed.snapshot_time !== "string") {
    throw new Error("drivers.json must contain snapshot_time and a drivers array");
  }
  const snapshotTime = Date.parse(parsed.snapshot_time);
  if (!Number.isFinite(snapshotTime)) throw new Error("drivers.json snapshot_time is invalid");

  const excludedRecords: DriverDataset["excludedRecords"] = [];
  const valid: Driver[] = [];
  for (const record of parsed.drivers) {
    const result = parseDriver(record, snapshotTime);
    if (result.driver) valid.push(result.driver);
    else excludedRecords.push({ id: result.id, reason: result.reason ?? "invalid record" });
  }

  const newestById = new Map<string, Driver>();
  for (const driver of valid) {
    const existing = newestById.get(driver.id);
    if (!existing) {
      newestById.set(driver.id, driver);
      continue;
    }
    if (Date.parse(driver.last_location_update) > Date.parse(existing.last_location_update)) {
      excludedRecords.push({ id: existing.id, reason: "superseded by a newer duplicate" });
      newestById.set(driver.id, driver);
    } else {
      excludedRecords.push({ id: driver.id, reason: "superseded by a newer duplicate" });
    }
  }
  return { snapshotTime, drivers: [...newestById.values()], excludedRecords };
}
