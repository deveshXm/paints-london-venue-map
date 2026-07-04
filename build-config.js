const fs = require("fs");
const path = require("path");

const token = process.env.MAPBOX_ACCESS_TOKEN;

if (!token) {
  throw new Error("MAPBOX_ACCESS_TOKEN is required");
}

const publicDir = path.join(__dirname, "public");
fs.rmSync(publicDir, { recursive: true, force: true });
fs.mkdirSync(publicDir, { recursive: true });

for (const file of [
  "index.html",
  "styles.css",
  "app.js",
  "venues-data.js",
  "london-boroughs.geojson",
]) {
  fs.copyFileSync(path.join(__dirname, file), path.join(publicDir, file));
}

fs.writeFileSync(
  path.join(publicDir, "mapbox-token.js"),
  `window.MAPBOX_ACCESS_TOKEN = ${JSON.stringify(token)};\n`
);
