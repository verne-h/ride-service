import { randomUUID } from "node:crypto";
import type { ServiceConfig } from "../../config.js";
import type { DriverDataset } from "../drivers/types.js";
import { rankCandidates, type CandidateList } from "./matching.js";
import type { CreateRideInput, Offer, Ride } from "./types.js";

interface Reservation {
  offerId: string;
  rideId: string;
  accepted: boolean;
}

interface OfferWaiter {
  resolve: () => void;
  timer: NodeJS.Timeout;
}

export class RideService {
  private readonly rides = new Map<string, Ride>();
  private readonly reservations = new Map<string, Reservation>();
  private readonly offerWaiters = new Map<string, OfferWaiter>();
  private readonly offerEtas = new Map<string, number>();

  constructor(
    private readonly dataset: DriverDataset,
    private readonly config: ServiceConfig,
  ) {}

  createRide(input: CreateRideInput): Ride {
    const ride: Ride = {
      ride_id: `ride_${randomUUID()}`,
      ...input,
      status: "matching",
      offers: [],
      triedDriverIds: new Set(),
    };
    this.rides.set(ride.ride_id, ride);
    setImmediate(() => {
      void this.dispatch(ride).catch((error: unknown) => {
        console.error(`Ride dispatch failed for ${ride.ride_id}:`, error);
      });
    });
    return ride;
  }

  getRide(rideId: string): Ride | undefined {
    const ride = this.rides.get(rideId);
    if (ride) this.expireOpenOffer(ride);
    return ride;
  }

  cancelRide(rideId: string): Ride {
    const ride = this.requireRide(rideId);
    if (ride.status === "accepted") throw new ServiceError(409, "ride_already_accepted", "An accepted ride cannot be cancelled");
    if (ride.status === "cancelled") return ride;
    ride.status = "cancelled";
    const offer = ride.offers.find((item) => item.status === "open");
    if (offer) this.closeOffer(offer, "withdrawn");
    return ride;
  }

  getDriverOffers(driverId: string): { driver_id: string; offers: Offer[] } {
    const driver = this.dataset.drivers.find((item) => item.id === driverId);
    if (!driver) throw new ServiceError(404, "driver_not_found", "Driver not found");
    const reservation = this.reservations.get(driverId);
    if (!reservation || reservation.accepted) return { driver_id: driverId, offers: [] };
    const ride = this.requireRide(reservation.rideId);
    this.expireOpenOffer(ride);
    const openOffer = ride.offers.find((item) => item.offer_id === reservation.offerId && item.status === "open");
    return { driver_id: driverId, offers: openOffer ? [openOffer] : [] };
  }

  acceptOffer(offerId: string): { offer_id: string; ride_id: string; status: "accepted" } {
    const { ride, offer } = this.requireOffer(offerId);
    this.expireOpenOffer(ride);
    if (offer.status === "accepted") return { offer_id: offer.offer_id, ride_id: ride.ride_id, status: "accepted" };
    if (ride.status === "cancelled") {
      throw new ServiceError(410, "offer_withdrawn", "This offer belongs to a cancelled ride");
    }
    if (offer.status === "timed_out") throw new ServiceError(410, "offer_expired", "This offer has expired");
    if (offer.status === "withdrawn") {
      throw new ServiceError(410, "offer_withdrawn", "This offer was withdrawn because the ride was cancelled");
    }
    if (offer.status !== "open") throw new ServiceError(409, "offer_not_open", `Offer is ${offer.status}`);
    if (ride.status !== "offered") throw new ServiceError(409, "ride_not_accepting_offers", "This ride is no longer accepting offers");

    offer.status = "accepted";
    ride.status = "accepted";
    ride.driver = this.dataset.drivers.find((driver) => driver.id === offer.driver_id);
    if (!ride.driver) throw new Error(`Driver ${offer.driver_id} disappeared from the dataset`);
    ride.pickup_eta_seconds = this.offerEtas.get(offer.offer_id);
    this.reservations.set(offer.driver_id, { offerId: offer.offer_id, rideId: ride.ride_id, accepted: true });
    this.resolveOffer(offer.offer_id);
    return { offer_id: offer.offer_id, ride_id: ride.ride_id, status: "accepted" };
  }

  declineOffer(offerId: string): { offer_id: string; ride_id: string; status: "declined" } {
    const { ride, offer } = this.requireOffer(offerId);
    this.expireOpenOffer(ride);
    if (offer.status !== "open") {
      throw new ServiceError(offer.status === "timed_out" ? 410 : 409, "offer_not_open", `Offer is ${offer.status}`);
    }
    this.closeOffer(offer, "declined");
    return { offer_id: offer.offer_id, ride_id: ride.ride_id, status: "declined" };
  }

  getCandidates(rideId: string): CandidateList & {
    excluded_records: DriverDataset["excludedRecords"];
  } {
    const ride = this.requireRide(rideId);
    return {
      ...rankCandidates(ride, this.dataset, this.config, (driverId) => this.reservations.has(driverId)),
      excluded_records: this.dataset.excludedRecords,
    };
  }

  private async dispatch(ride: Ride): Promise<void> {
    while (ride.status === "matching" || ride.status === "offered") {
      if (ride.offers.length >= this.config.max_offer_attempts) {
        ride.status = "no_driver_found";
        return;
      }
      const next = rankCandidates(ride, this.dataset, this.config, (driverId) => this.reservations.has(driverId)).ranked[0];
      if (!next) {
        ride.status = "no_driver_found";
        return;
      }
      const now = Date.now();
      const offer: Offer = {
        offer_id: `ofr_${randomUUID()}`,
        driver_id: next.driver.id,
        status: "open",
        created_at: new Date(now).toISOString(),
        expires_at: new Date(now + this.config.offer_timeout_seconds * 1000).toISOString(),
      };
      this.offerEtas.set(offer.offer_id, next.pickup_eta_seconds);
      ride.offers.push(offer);
      ride.triedDriverIds.add(next.driver.id);
      ride.status = "offered";
      this.reservations.set(next.driver.id, { offerId: offer.offer_id, rideId: ride.ride_id, accepted: false });
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          if (offer.status === "open") this.closeOffer(offer, "timed_out");
          resolve();
        }, this.config.offer_timeout_seconds * 1000);
        this.offerWaiters.set(offer.offer_id, { resolve, timer });
      });
      if (ride.status !== "offered") return;
      ride.status = "matching";
    }
  }

  private closeOffer(offer: Offer, status: "declined" | "timed_out" | "withdrawn"): void {
    if (offer.status !== "open") return;
    offer.status = status;
    const reservation = this.reservations.get(offer.driver_id);
    if (reservation?.offerId === offer.offer_id) this.reservations.delete(offer.driver_id);
    this.resolveOffer(offer.offer_id);
  }

  private expireOpenOffer(ride: Ride): void {
    const offer = ride.offers.find((item) => item.status === "open");
    if (offer && Date.now() >= Date.parse(offer.expires_at)) this.closeOffer(offer, "timed_out");
  }

  private resolveOffer(offerId: string): void {
    const waiter = this.offerWaiters.get(offerId);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    this.offerWaiters.delete(offerId);
    waiter.resolve();
  }

  private requireRide(rideId: string): Ride {
    const ride = this.rides.get(rideId);
    if (!ride) throw new ServiceError(404, "ride_not_found", "Ride not found");
    return ride;
  }

  private requireOffer(offerId: string): { ride: Ride; offer: Offer } {
    for (const ride of this.rides.values()) {
      const offer = ride.offers.find((item) => item.offer_id === offerId);
      if (offer) return { ride, offer };
    }
    throw new ServiceError(404, "offer_not_found", "Offer not found");
  }
}

export class ServiceError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
