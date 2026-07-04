const fs = require("fs");

const token = process.env.MAPBOX_ACCESS_TOKEN;

if (!token) {
  throw new Error("MAPBOX_ACCESS_TOKEN is required");
}

fs.writeFileSync(
  "mapbox-token.js",
  `window.MAPBOX_ACCESS_TOKEN = ${JSON.stringify(token)};\n`
);
