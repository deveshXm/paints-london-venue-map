# PAINTS London Venue Map

Interactive Mapbox-powered venue explorer for the PAINTS London sourcing dataset.

## Local Run

```bash
python3 -m http.server 8765
```

Then open:

```text
http://127.0.0.1:8765/
```

## Contents

- `index.html` - static app shell
- `styles.css` - UI styling
- `app.js` - Mapbox map, filters, clusters, popups
- `venues-data.js` - embedded venue dataset
- `london-boroughs.geojson` - London borough boundaries
