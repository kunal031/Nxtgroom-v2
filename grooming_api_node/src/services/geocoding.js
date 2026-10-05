import { coreCollection } from "../stores/coreStore.js";

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/reverse";
const USER_AGENT = "FacultyTrack/1.0 (instructor attendance; niat_instructors_mentors@nxtwave.in)";
const REQUEST_TIMEOUT_MS = 8000;
const MIN_INTERVAL_MS = 1100;

let lastRequestAt = 0;
let throttleTail = Promise.resolve();

async function throttle() {
  const turn = throttleTail.then(async () => {
    const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastRequestAt = Date.now();
  });
  throttleTail = turn.catch(() => {});
  await turn;
}

export function summariseAddress(payload) {
  const address = payload?.address;
  if (!address) return payload?.display_name || null;

  const locality = address.suburb
    || address.neighbourhood
    || address.residential
    || address.village
    || null;
  const city = address.city || address.town || address.state_district || address.county || null;

  const parts = [
    address.amenity || address.building || address.office || null,
    address.road || null,
    locality,
    city && city !== locality ? city : null,
  ].filter(Boolean);

  const unique = [...new Set(parts)];
  return unique.length ? unique.slice(0, 3).join(", ") : payload.display_name || null;
}

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
