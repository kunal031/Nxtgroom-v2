import { coreCollection } from "../stores/coreStore.js";

/**
 * Turns check-in coordinates into a human-readable address.
 *
 * Uses OpenStreetMap's Nominatim service: no API key, no billing account, and
 * free at this volume. Its usage policy requires an identifying User-Agent and
 * at most one request per second, both of which are honoured below.
 *
 * The lookup runs once per check-in and the result is stored, rather than
 * geocoding on every page view. That keeps one request per attendance record
 * instead of thousands, keeps the address readable when Nominatim is
 * unavailable, and freezes the address as it was on the day.
 */

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/reverse";
/** Nominatim asks for a contact address so they can reach operators who misbehave. */
const USER_AGENT = "FacultyTrack/1.0 (instructor attendance; niat_instructors_mentors@nxtwave.in)";
const REQUEST_TIMEOUT_MS = 8000;
/** Their policy is one request per second; this is the gap we enforce. */
const MIN_INTERVAL_MS = 1100;

let lastRequestAt = 0;
let throttleTail = Promise.resolve();

/** Serialises calls so bursts of check-ins cannot exceed the rate limit. */
async function throttle() {
  const turn = throttleTail.then(async () => {
    const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastRequestAt = Date.now();
  });
  // Keep the chain usable even when a future implementation of a turn throws.
  throttleTail = turn.catch(() => {});
  await turn;
}

/**
 * Builds a short address from Nominatim's parts rather than using
 * display_name, which runs to a full postal address with country and postcode
 * and is far too long for a table cell.
 */
export function summariseAddress(payload) {
  const address = payload?.address;
  if (!address) return payload?.display_name || null;

  // city_district is deliberately excluded: in Hyderabad it returns
  // "Greater Hyderabad Municipal Corporation West Zone", an administrative
  // boundary nobody navigates by.
  const locality = address.suburb
    || address.neighbourhood
    || address.residential
    || address.village
    || null;
  const city = address.city || address.town || address.state_district || address.county || null;

  const parts = [
    // A named building or campus is the most useful line when present.
    address.amenity || address.building || address.office || null,
    address.road || null,
    locality,
    city && city !== locality ? city : null,
  ].filter(Boolean);

  // Duplicates are common: "Gachibowli" can appear as both suburb and city.
  const unique = [...new Set(parts)];
  return unique.length ? unique.slice(0, 3).join(", ") : payload.display_name || null;
}

/**
 * Reverse geocodes "lat,lon". Returns null on any failure: an address is
 * supplementary, and a geocoding outage must never affect attendance.
 */
export async function reverseGeocode(coordinates) {
  if (!coordinates || typeof coordinates !== "string") return null;
  const [latitude, longitude] = coordinates.split(",").map((value) => Number(value.trim()));
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;

  try {
    await throttle();
    const url = `${NOMINATIM_URL}?format=jsonv2&lat=${latitude}&lon=${longitude}`
      + "&zoom=18&addressdetails=1";
    const response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      console.warn(`Nominatim returned ${response.status} for ${coordinates}`);
      return null;
    }
    const payload = await response.json();
    const summary = summariseAddress(payload);
    if (!summary) return null;
    return {
      address: summary,
      full_address: payload.display_name || null,
      geocoded_at: new Date(),
    };
  } catch (error) {
    console.warn(`Reverse geocoding failed for ${coordinates}: ${error?.name || "Error"}`);
    return null;
  }
}

/**
 * Looks up an address and stores it on the attendance record.
 *
 * Deliberately fire-and-forget: check-in has already responded by the time
 * this runs, so a slow or failing lookup cannot delay the submission or fail
 * it. The record simply keeps its coordinates and no address.
 */
/**
 * Turns stored coordinates into a place name.
 *
 * Each half keeps its own address. They are different places — someone checks
 * in at one campus and out from another — and writing both into one field
 * would show the morning's location under a check-out heading.
 */
export async function attachAddressToAttendance(db, attendanceId, coordinates, kind = "checkin") {
  const result = await reverseGeocode(coordinates);
  if (!result) return null;
  const prefix = kind === "checkout" ? "check_out_" : "";
  try {
    await coreCollection(db, "attendance").updateOne(
      { _id: attendanceId },
      {
        $set: {
          [`${prefix}location_address`]: result.address,
          [`${prefix}location_address_full`]: result.full_address,
          [`${prefix}location_geocoded_at`]: result.geocoded_at,
        },
      }
    );
    return result;
  } catch (error) {
    console.warn(`Could not store address for ${attendanceId}: ${error?.name || "Error"}`);
    return null;
  }
}
