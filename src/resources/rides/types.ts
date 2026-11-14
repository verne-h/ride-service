import type { Location, VehicleType } from "../drivers/types.js";
import type { Driver } from "../drivers/types.js";

export type RideStatus = "matching" | "offered" | "accepted" | "cancelled" | "no_driver_found";
export type OfferStatus = "open" | "accepted" | "declined" | "timed_out" | "withdrawn";

export interface CreateRideInput {
  rider_id: string;
  pickup: Location;
  dropoff: Location;
  vehicle_type: VehicleType;
}

export interface Offer {
  offer_id: string;
  driver_id: string;
  status: OfferStatus;
  created_at: string;
  expires_at: string;
}

export interface Ride {
  ride_id: string;
  rider_id: string;
  pickup: Location;
  dropoff: Location;
  vehicle_type: VehicleType;
  status: RideStatus;
  offers: Offer[];
  triedDriverIds: Set<string>;
  driver?: Driver;
  pickup_eta_seconds?: number;
}
