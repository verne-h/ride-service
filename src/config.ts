import { readFile } from "node:fs/promises";

export interface ServiceConfig {
  strategy: string;
  avg_speed_kmh: number;
  route_factor: number;
  max_pickup_eta_seconds: number;
  location_max_age_seconds: number;
  allow_on_trip_drivers: boolean;
  max_remaining_trip_seconds: number;
  offer_timeout_seconds: number;
  max_offer_attempts: number;
}

function readNumber(config: Record<string, unknown>, key: string, allowZero = false): number {
  const value = config[key];
  if (typeof value !== "number" || !Number.isFinite(value) || (allowZero ? value < 0 : value <= 0)) {
    const requirement = allowZero ? "a non-negative number" : "a positive number";
    throw new Error(`Configuration ${key} must be ${requirement}`);
  }
  return value;
}

export function validateConfig(value: unknown): ServiceConfig {
  if (!value || typeof value !== "object") throw new Error("Configuration must be a JSON object");
  const config = value as Record<string, unknown>;
  if (typeof config.strategy !== "string" || !config.strategy) {
    throw new Error("Configuration strategy must be a non-empty string");
  }
  if (typeof config.allow_on_trip_drivers !== "boolean") {
    throw new Error("Configuration allow_on_trip_drivers must be a boolean");
  }
  const maxOfferAttempts = readNumber(config, "max_offer_attempts");
  if (!Number.isInteger(maxOfferAttempts)) throw new Error("Configuration max_offer_attempts must be an integer");
  return {
    strategy: config.strategy,
    avg_speed_kmh: readNumber(config, "avg_speed_kmh"),
    route_factor: readNumber(config, "route_factor"),
    max_pickup_eta_seconds: readNumber(config, "max_pickup_eta_seconds", true),
    location_max_age_seconds: readNumber(config, "location_max_age_seconds", true),
    allow_on_trip_drivers: config.allow_on_trip_drivers,
    max_remaining_trip_seconds: readNumber(config, "max_remaining_trip_seconds", true),
    offer_timeout_seconds: readNumber(config, "offer_timeout_seconds"),
    max_offer_attempts: maxOfferAttempts,
  };
}

export async function loadConfig(path = "config.example.json"): Promise<ServiceConfig> {
  return validateConfig(JSON.parse(await readFile(path, "utf8")));
}
