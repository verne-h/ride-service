import express, { type ErrorRequestHandler, type Request, type Response } from "express";
import type { ServiceConfig } from "./config.js";
import type { DriverDataset, Location, VehicleType } from "./resources/drivers/types.js";
import { assertSupportedStrategy } from "./resources/rides/matching.js";
import { RideService, ServiceError } from "./resources/rides/service.js";
import type { Ride } from "./resources/rides/types.js";

const vehicleTypes = new Set<VehicleType>(["economy", "comfort", "xl"]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLocation(value: unknown): value is Location {
  return isObject(value)
    && typeof value.lat === "number" && Number.isFinite(value.lat) && value.lat >= -90 && value.lat <= 90
    && typeof value.lng === "number" && Number.isFinite(value.lng) && value.lng >= -180 && value.lng <= 180;
}

function routeParam(value: string | string[]): string {
  return Array.isArray(value) ? value[0] ?? "" : value;
}

function parseRideInput(value: unknown) {
  if (!isObject(value)) throw new ServiceError(400, "invalid_request", "Request body must be an object");
  if (typeof value.rider_id !== "string" || !value.rider_id.trim()) {
    throw new ServiceError(400, "invalid_request", "rider_id must be a non-empty string");
  }
  if (!isLocation(value.pickup) || !isLocation(value.dropoff)) {
    throw new ServiceError(400, "invalid_request", "pickup and dropoff must contain valid lat and lng coordinates");
  }
  if (typeof value.vehicle_type !== "string" || !vehicleTypes.has(value.vehicle_type as VehicleType)) {
    throw new ServiceError(400, "invalid_request", "vehicle_type must be economy, comfort, or xl");
  }
  return {
    rider_id: value.rider_id.trim(),
    pickup: value.pickup,
    dropoff: value.dropoff,
    vehicle_type: value.vehicle_type as VehicleType,
  };
}

function serializeRide(ride: Ride) {
  return {
    ride_id: ride.ride_id,
    status: ride.status,
    ...(ride.driver ? {
      driver: {
        id: ride.driver.id,
        name: ride.driver.name,
        vehicle_type: ride.driver.vehicle_type,
        rating: ride.driver.rating,
      },
      pickup_eta_seconds: ride.pickup_eta_seconds,
    } : {}),
    offers: ride.offers.map(({ offer_id, driver_id, status, created_at, expires_at }) => ({
      offer_id,
      driver_id,
      status,
      created_at,
      expires_at,
    })),
  };
}

export function createApp(dataset: DriverDataset, config: ServiceConfig) {
  assertSupportedStrategy(config.strategy);
  const app = express();
  const rides = new RideService(dataset, config);
  app.use(express.json());

  app.post("/rides", (request: Request, response: Response) => {
    const ride = rides.createRide(parseRideInput(request.body));
    response.status(202).json({ ride_id: ride.ride_id, status: ride.status });
  });

  app.get("/rides/:ride_id/candidates", (request: Request, response: Response) => {
    response.json(rides.getCandidates(routeParam(request.params.ride_id)));
  });

  app.get("/rides/:ride_id", (request: Request, response: Response) => {
    response.json(serializeRide(requireRide(rides, routeParam(request.params.ride_id))));
  });

  app.post("/rides/:ride_id/cancel", (request: Request, response: Response) => {
    response.json(serializeRide(rides.cancelRide(routeParam(request.params.ride_id))));
  });

  app.get("/drivers/:driver_id/offers", (request: Request, response: Response) => {
    response.json(rides.getDriverOffers(routeParam(request.params.driver_id)));
  });

  app.post("/offers/:offer_id/accept", (request: Request, response: Response) => {
    response.json(rides.acceptOffer(routeParam(request.params.offer_id)));
  });

  app.post("/offers/:offer_id/decline", (request: Request, response: Response) => {
    response.json(rides.declineOffer(routeParam(request.params.offer_id)));
  });

  app.use((_request, response) => {
    response.status(404).json({ error: { code: "route_not_found", message: "Route not found" } });
  });

  const errorHandler: ErrorRequestHandler = (error: unknown, _request, response, _next) => {
    if (error instanceof ServiceError) {
      response.status(error.statusCode).json({ error: { code: error.code, message: error.message } });
      return;
    }
    if (isObject(error) && error.type === "entity.parse.failed") {
      response.status(400).json({ error: { code: "invalid_json", message: "Request body is not valid JSON" } });
      return;
    }
    console.error("Unhandled request error:", error);
    response.status(500).json({ error: { code: "internal_error", message: "An internal error occurred" } });
  };
  app.use(errorHandler);
  return app;
}

function requireRide(service: RideService, rideId: string): Ride {
  const ride = service.getRide(rideId);
  if (!ride) throw new ServiceError(404, "ride_not_found", "Ride not found");
  return ride;
}
