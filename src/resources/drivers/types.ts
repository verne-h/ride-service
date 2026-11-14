export type VehicleType = "economy" | "comfort" | "xl";
export type DriverStatus = "available" | "on_trip" | "offline";

export interface Location {
  lat: number;
  lng: number;
}

export interface Driver {
  id: string;
  name: string;
  status: DriverStatus;
  location: Location;
  vehicle_type: VehicleType;
  rating: number;
  last_location_update: string;
  current_trip: {
    dropoff: Location;
    eta_to_dropoff_seconds: number;
  } | null;
}

export interface DriverDataset {
  snapshotTime: number;
  drivers: Driver[];
  excludedRecords: Array<{ id: string | null; reason: string }>;
}
