import type { ServiceConfig } from "../../config.js";
import type { Driver, DriverDataset, Location } from "../drivers/types.js";
import type { Ride } from "./types.js";

const earthRadiusMeters = 6_371_000;

export function distanceMeters(from: Location, to: Location): number {
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const lat1 = radians(from.lat);
  const lat2 = radians(to.lat);
  const deltaLat = lat2 - lat1;
  const deltaLng = radians(to.lng - from.lng);
  const a = Math.min(1, Math.sin(deltaLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) ** 2);
  return Math.round(earthRadiusMeters * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

export interface Candidate {
  driver: Driver;
  distance_meters: number;
  pickup_eta_seconds: number;
}

interface EvaluatedCandidate {
  driver_id: string;
  eligible: boolean;
  reasons: string[];
  distance_meters: number | null;
  pickup_eta_seconds: number | null;
}

function evaluate(
  driver: Driver,
  ride: Ride,
  dataset: DriverDataset,
  config: ServiceConfig,
  strategy: string,
  isReserved: (driverId: string) => boolean,
): { candidate?: Candidate; result: EvaluatedCandidate } {
  const reasons: string[] = [];
  const distance = distanceMeters(driver.location, ride.pickup);
  let eta = 0;
  if (driver.status === "offline") reasons.push("offline");
  if (driver.vehicle_type !== ride.vehicle_type) reasons.push("vehicle_type_mismatch");
  const ageSeconds = Math.round((dataset.snapshotTime - Date.parse(driver.last_location_update)) / 1000);
  if (ageSeconds > config.location_max_age_seconds) reasons.push("location_too_old");
  if (driver.status === "on_trip") {
    if (strategy !== "fastest_eta") reasons.push("strategy_requires_available_driver");
    if (!config.allow_on_trip_drivers) reasons.push("on_trip_drivers_disabled");
    const trip = driver.current_trip;
    if (!trip || Math.round(trip.eta_to_dropoff_seconds) > config.max_remaining_trip_seconds) {
      reasons.push("trip_exceeds_max_remaining_time");
    } else {
      const onwardDistance = distanceMeters(trip.dropoff, ride.pickup);
      const onwardTime = Math.round(onwardDistance * config.route_factor / (config.avg_speed_kmh * 1000 / 3600));
      eta = Math.round(trip.eta_to_dropoff_seconds) + onwardTime;
    }
  } else {
    eta = Math.round(distance * config.route_factor / (config.avg_speed_kmh * 1000 / 3600));
  }
  if (driver.status !== "available" && driver.status !== "on_trip") reasons.push("unavailable");
  if (isReserved(driver.id)) reasons.push("driver_has_open_offer_or_accepted_ride");
  if (ride.triedDriverIds.has(driver.id)) reasons.push("already_offered_this_ride");
  if (!reasons.includes("trip_exceeds_max_remaining_time") && eta > config.max_pickup_eta_seconds) {
    reasons.push("pickup_eta_exceeds_limit");
  }
  const eligible = reasons.length === 0;
  return {
    candidate: eligible ? { driver, distance_meters: distance, pickup_eta_seconds: eta } : undefined,
    result: {
      driver_id: driver.id,
      eligible,
      reasons,
      distance_meters: distance,
      pickup_eta_seconds: Number.isFinite(eta) ? eta : null,
    },
  };
}

export interface CandidateList {
  ranked: Candidate[];
  evaluated: EvaluatedCandidate[];
}

type Strategy = (left: Candidate, right: Candidate) => number;

const strategies: Record<string, Strategy> = {
  nearest: (left, right) =>
    left.distance_meters - right.distance_meters
      || left.pickup_eta_seconds - right.pickup_eta_seconds
      || compareIds(left.driver.id, right.driver.id),
  fastest_eta: (left, right) =>
    left.pickup_eta_seconds - right.pickup_eta_seconds
      || compareIds(left.driver.id, right.driver.id),
};

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function assertSupportedStrategy(strategy: string): void {
  if (!strategies[strategy]) throw new Error(`Unsupported matching strategy: ${strategy}`);
}

export function rankCandidates(
  ride: Ride,
  dataset: DriverDataset,
  config: ServiceConfig,
  isReserved: (driverId: string) => boolean,
): CandidateList {
  const strategy = strategies[config.strategy];
  if (!strategy) throw new Error(`Unsupported matching strategy: ${config.strategy}`);
  const ranked: Candidate[] = [];
  const evaluated: EvaluatedCandidate[] = [];
  for (const driver of dataset.drivers) {
    const result = evaluate(driver, ride, dataset, config, config.strategy, isReserved);
    evaluated.push(result.result);
    if (result.candidate) ranked.push(result.candidate);
  }
  ranked.sort(strategy);
  return { ranked, evaluated };
}
