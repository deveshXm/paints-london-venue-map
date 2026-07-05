import fs from "node:fs";

const appSource = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(appSource.includes('map.addSource("selected-event-backup"'), "Selected event backup venue source should exist.");
assert(appSource.includes('map.addSource("selected-event-backup-line"'), "Selected event backup link source should exist.");
assert(appSource.includes("selectedEventBackupFeatureCollection(selectedEvent)"), "Render should populate backup venue only for selected event.");
assert(appSource.includes("selectedEventBackupLineFeatureCollection(selectedEvent)"), "Render should populate backup link only for selected event.");
assert(appSource.includes('setLayerVisibility(["selected-event-backup-line", "selected-event-backup-point"'), "Backup venue overlay should only be visible with a selected event.");
assert(appSource.includes("focusSelectedEvent(event)"), "Selecting an event from the list should fit the primary and backup venues together.");

console.log("selected event backup ui ok");
