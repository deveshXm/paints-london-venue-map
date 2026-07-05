import fs from "node:fs";
import path from "node:path";

const source = fs.readFileSync(new URL("../venues-data.js", import.meta.url), "utf8");
const venues = JSON.parse(source.replace(/^window\.PAINTS_VENUES\s*=\s*/, "").replace(/;\s*$/, ""));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function validPoint(item) {
  return Number.isFinite(Number(item.latitude)) && Number.isFinite(Number(item.longitude));
}

function toRad(value) {
  return (value * Math.PI) / 180;
}

function distanceKm(lat1, lon1, lat2, lon2) {
  const earthRadius = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const x =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return earthRadius * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function walkingMinutes(a, b) {
  return (distanceKm(Number(a.latitude), Number(a.longitude), Number(b.latitude), Number(b.longitude)) / 4.8) * 60;
}

function reservationKey(dateTime, venueId) {
  return `${dateTime}|${String(venueId)}`;
}

function areaFilterText(area) {
  const rawAreaText = String(area || "").trim().toLowerCase();
  return ["", "all", "any", "london", "all london", "whole london", "citywide"].includes(rawAreaText) ? "" : rawAreaText;
}

function searchUsersForAgent(batchUsers, { district, near, price, age_min, age_max, limit = 50 }) {
  const districtText = String(district || "").trim().toLowerCase();
  return batchUsers
    .filter((user) => !districtText || String(user.district || "").toLowerCase().includes(districtText))
    .filter((user) => !price || user.price_preference === price)
    .filter((user) => !Number.isFinite(Number(age_min)) || Number(user.age) >= Number(age_min))
    .filter((user) => !Number.isFinite(Number(age_max)) || Number(user.age) <= Number(age_max))
    .map((user) => ({
      user,
      distance: near && validPoint(user)
        ? distanceKm(Number(near.lat), Number(near.lng), Number(user.latitude), Number(user.longitude))
        : 0,
    }))
    .filter(({ distance }) => !near || distance <= Number(near.radius_km))
    .sort((a, b) => a.distance - b.distance || Number(a.user.age || 0) - Number(b.user.age || 0))
    .slice(0, limit)
    .map(({ user }) => user);
}

function isSafeStaticPath(root, requested) {
  const fullPath = path.normalize(path.join(root, requested));
  const relative = path.relative(root, fullPath);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function averagePoint(items) {
  const valid = items.filter(validPoint);
  return {
    latitude: valid.reduce((sum, item) => sum + Number(item.latitude), 0) / valid.length,
    longitude: valid.reduce((sum, item) => sum + Number(item.longitude), 0) / valid.length,
  };
}

function primaryVenueOptionsForGroup(group, users, reservations, { area, category, district, near, price, min_score, limit }) {
  const groupUsers = group.user_ids.map((id) => users.find((user) => user.id === id)).filter(Boolean);
  const areaText = areaFilterText(area);
  const categoryText = String(category || "").toLowerCase();
  const districtText = String(district || "").trim().toLowerCase();
  const dateTime = `${group.availability} · Week 1`;
  const center = near ? { latitude: Number(near.lat), longitude: Number(near.lng) } : averagePoint(groupUsers);
  return venues
    .filter(validPoint)
    .filter((venue) => !categoryText || String(venue.category || "").toLowerCase() === categoryText)
    .filter((venue) => !districtText || String(venue.district || "").toLowerCase().includes(districtText))
    .filter((venue) => !price || venue.price === price)
    .filter((venue) => !Number.isFinite(Number(min_score)) || Number(venue.paint_score || 0) >= Number(min_score))
    .filter((venue) => !reservations.has(reservationKey(dateTime, venue.id)))
    .filter((venue) => !areaText || `${venue.name} ${venue.district} ${venue.neighbourhood}`.toLowerCase().includes(areaText))
    .map((venue) => ({
      ...venue,
      distance: distanceKm(center.latitude, center.longitude, Number(venue.latitude), Number(venue.longitude)),
    }))
    .filter((venue) => !near || venue.distance <= Number(near.radius_km))
    .sort((a, b) => a.distance - b.distance || Number(b.paint_score || 0) - Number(a.paint_score || 0))
    .slice(0, limit);
}

function backupOptionsForPrimary(group, primaryVenueId, reservations, { backup_minutes_min, backup_minutes_max, category, limit }) {
  const primary = venues.find((venue) => String(venue.id) === String(primaryVenueId));
  const categoryText = String(category || "").toLowerCase();
  return venues
    .filter((venue) => String(venue.id) !== String(primary.id))
    .filter((venue) => !categoryText || String(venue.category || "").toLowerCase() === categoryText)
    .filter(validPoint)
    .map((venue) => ({
      venue,
      walkMinutes: walkingMinutes(primary, venue),
    }))
    .filter(({ walkMinutes }) => walkMinutes >= backup_minutes_min && walkMinutes <= backup_minutes_max)
    .sort((a, b) => a.walkMinutes - b.walkMinutes || Number(b.venue.paint_score) - Number(a.venue.paint_score))
    .slice(0, limit)
    .map(({ venue }) => venue);
}

function validatePrimaryVenue(group, primaryVenueId, reservations) {
  const primary = venues.find((venue) => String(venue.id) === String(primaryVenueId));
  if (!primary) return { ok: false };
  if (!validPoint(primary)) return { ok: false };
  if (!hasEnoughCapacity(primary, group.user_ids.length)) return { ok: false };
  const key = reservationKey(`${group.availability} · Week 1`, primary.id);
  if (reservations.has(key)) return { ok: false, conflict: true };
  return { ok: true };
}

function validateBackupVenue(group, primaryVenueId, backupVenueId, choice = {}) {
  const primary = venues.find((venue) => String(venue.id) === String(primaryVenueId));
  const backup = venues.find((venue) => String(venue.id) === String(backupVenueId));
  if (!primary || !backup) return { ok: false };
  if (String(primary.id) === String(backup.id)) return { ok: false };
  if (!validPoint(backup)) return { ok: false };
  if (!hasEnoughCapacity(backup, group.user_ids.length)) return { ok: false };
  return { ok: true };
}

function hasEnoughCapacity(venue, groupSize) {
  const capacities = [venue.capacity_table, venue.capacity_seated, venue.capacity_total, venue.capacity_standing]
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0);
  if (!capacities.length) return true;
  return Math.max(...capacities) >= groupSize;
}

const users = [
  { id: "u1", latitude: 51.546, longitude: -0.103 },
  { id: "u2", latitude: 51.55, longitude: -0.1 },
  { id: "u3", latitude: 51.539, longitude: -0.143 },
];
const group = {
  id: "g1",
  category: "Books & Coffee",
  availability: "Thursday 7pm",
  user_ids: users.map((user) => user.id),
};

const reservations = new Set();
const booksWithCoords = venues.filter((venue) => venue.category === "Books & Coffee" && validPoint(venue)).length;
const allVenuesWithCoords = venues.filter(validPoint).length;
const citywideUsers = [
  { id: "city-1", district: "Islington", age: 29, price_preference: "$$", latitude: 51.546, longitude: -0.103 },
  { id: "city-2", district: "Bromley", age: 41, price_preference: "$", latitude: 51.406, longitude: 0.014 },
  { id: "city-3", district: "Croydon", age: 34, price_preference: "$$$", latitude: 51.376, longitude: -0.098 },
];

for (const area of ["London", "all", "any", "all london", "whole london", "citywide", ""]) {
  const results = primaryVenueOptionsForGroup(group, users, reservations, { area, limit: 999 });
  assert(results.length === allVenuesWithCoords, `Area "${area}" should not narrow free citywide venue search. Got ${results.length}, expected ${allVenuesWithCoords}`);
}

assert(primaryVenueOptionsForGroup(group, users, reservations, { area: "London", category: "Books & Coffee", limit: 999 }).length === booksWithCoords, "Category should narrow only when the agent asks for category");
assert(searchUsersForAgent(citywideUsers, { limit: 999 }).length === citywideUsers.length, "User search without filters should show the whole available pool");
assert(searchUsersForAgent(citywideUsers, { district: "Islington", limit: 999 }).length === 1, "Specific user district search should narrow results");
assert(searchUsersForAgent(citywideUsers, { price: "$$", limit: 999 }).length === 1, "Specific user price search should narrow results");
assert(searchUsersForAgent(citywideUsers, { age_min: 30, age_max: 40, limit: 999 }).length === 1, "Specific user age search should narrow results");
assert(isSafeStaticPath("/tmp/paints-app", "/index.html"), "Normal static path should be allowed");
assert(!isSafeStaticPath("/tmp/paints-app", "../paints-app-secret/file.txt"), "Sibling prefix path should be rejected");
assert(!isSafeStaticPath("/tmp/paints-app", "/../paints-app-secret/file.txt"), "Absolute-looking traversal path should be rejected");

const islington = primaryVenueOptionsForGroup(group, users, reservations, { district: "Islington", limit: 999 });
assert(islington.length > 0, "Islington search should return local venues");
assert(islington.length < allVenuesWithCoords, "Specific district search should narrow results");

const museumFallback = primaryVenueOptionsForGroup(group, users, reservations, { area: "London", category: "Museum & Gallery Days", limit: 999 });
assert(museumFallback.length > 0, "Agent should be able to search adjacent categories");

const primary = primaryVenueOptionsForGroup(group, users, reservations, { area: "London", limit: 1 })[0];
assert(validatePrimaryVenue(group, primary.id, reservations).ok, "Unreserved primary should be claimable");
reservations.add(reservationKey(`${group.availability} · Week 1`, primary.id));
assert(validatePrimaryVenue(group, primary.id, reservations).conflict, "Reserved primary should conflict");

const strictBackups = backupOptionsForPrimary(group, primary.id, reservations, { backup_minutes_min: 5, backup_minutes_max: 10, limit: 999 });
const expandedBackups = backupOptionsForPrimary(group, primary.id, reservations, { backup_minutes_min: 3, backup_minutes_max: 15, limit: 999 });
assert(expandedBackups.length >= strictBackups.length, "Expanded backup search should not return fewer options than strict search");
assert(expandedBackups.every((backup) => String(backup.id) !== String(primary.id)), "Backup search must exclude primary venue");

if (strictBackups[0]) {
  assert(validateBackupVenue(group, primary.id, strictBackups[0].id).ok, "Strict backup should validate");
}

const backup = expandedBackups[0];
assert(backup, "Expanded backup search should find at least one backup for selected primary");
reservations.add(reservationKey(`${group.availability} · Week 1`, backup.id));
assert(validateBackupVenue(group, primary.id, backup.id, { match_quality: "fallback" }).ok, "Backup reuse should not conflict because backup is not a hard booking lock");

const farBackup = venues
  .filter((venue) => String(venue.id) !== String(primary.id))
  .filter(validPoint)
  .map((venue) => ({ venue, walkMinutes: walkingMinutes(primary, venue) }))
  .find(({ walkMinutes }) => walkMinutes > 45);
assert(farBackup, "Test data should include a far backup candidate");
assert(validateBackupVenue(group, primary.id, farBackup.venue.id).ok, "Backup distance should be a soft preference, not a backend hard filter");

const tinyVenue = { id: "tiny", latitude: 51.5, longitude: -0.1, capacity_seated: 1 };
assert(!hasEnoughCapacity(tinyVenue, 2), "Explicitly tiny venues should fail capacity checks");
assert(hasEnoughCapacity({ id: "unknown", latitude: 51.5, longitude: -0.1 }, 12), "Unknown capacity should remain agent-verifiable, not invented");

console.log("venue tool behavior ok");
