(function () {
  mapboxgl.accessToken = window.MAPBOX_ACCESS_TOKEN || "";
  if (!mapboxgl.accessToken) {
    document.getElementById("map").innerHTML = '<div class="map-error">Missing Mapbox access token.</div>';
    return;
  }

  const venues = Array.isArray(window.PAINTS_VENUES) ? window.PAINTS_VENUES : [];
  const categories = [...new Set(venues.map((venue) => venue.category).filter(Boolean))].sort();
  const districts = [...new Set(venues.map((venue) => venue.district).filter(Boolean))].sort();
  const prices = ["$", "$$", "$$$", "unknown"];

  const colors = {
    "Show & Tell Drinks": "#2563eb",
    "Market Days": "#0f766e",
    "Creative Walks": "#65a30d",
    "Museum & Gallery Days": "#b45309",
    "Books & Coffee": "#be123c",
  };
  const clusterCategoryKeys = {
    "Show & Tell Drinks": "drinks_count",
    "Market Days": "markets_count",
    "Creative Walks": "walks_count",
    "Museum & Gallery Days": "museums_count",
    "Books & Coffee": "books_count",
  };
  const clusterMaxExpression = [
    "max",
    ["get", "drinks_count"],
    ["get", "markets_count"],
    ["get", "walks_count"],
    ["get", "museums_count"],
    ["get", "books_count"],
  ];
  const dominantClusterColor = [
    "case",
    [">=", ["get", "drinks_count"], clusterMaxExpression],
    colors["Show & Tell Drinks"],
    [">=", ["get", "markets_count"], clusterMaxExpression],
    colors["Market Days"],
    [">=", ["get", "walks_count"], clusterMaxExpression],
    colors["Creative Walks"],
    [">=", ["get", "museums_count"], clusterMaxExpression],
    colors["Museum & Gallery Days"],
    colors["Books & Coffee"],
  ];

  const state = {
    query: "",
    district: "",
    categories: new Set(categories),
    prices: new Set(prices),
  };

  const categoryFilters = document.getElementById("categoryFilters");
  const priceFilters = document.getElementById("priceFilters");
  const districtSelect = document.getElementById("districtSelect");
  const searchInput = document.getElementById("searchInput");
  const venueList = document.getElementById("venueList");
  const summaryList = document.getElementById("summaryList");
  const visibleCount = document.getElementById("visibleCount");
  const totalCount = document.getElementById("totalCount");

  let currentList = [];
  let mapReady = false;
  let popup = null;

  totalCount.textContent = venues.length.toLocaleString();

  const map = new mapboxgl.Map({
    container: "map",
    style: "mapbox://styles/mapbox/light-v11",
    center: [-0.1278, 51.5074],
    zoom: 9.15,
    minZoom: 8,
    maxZoom: 18,
    attributionControl: true,
    cooperativeGestures: false,
    pitchWithRotate: false,
  });
  window.PAINTS_MAP = map;

  map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), "top-left");

  districts.forEach((district) => {
    const option = document.createElement("option");
    option.value = district;
    option.textContent = district;
    districtSelect.appendChild(option);
  });

  function checkbox(label, value, checked, container, onChange) {
    const item = document.createElement("label");
    const input = document.createElement("input");
    const text = document.createElement("span");
    input.type = "checkbox";
    input.value = value;
    input.checked = checked;
    text.textContent = label;
    input.addEventListener("change", () => onChange(input));
    item.append(input, text);
    container.appendChild(item);
  }

  categories.forEach((category) => {
    checkbox(category, category, true, categoryFilters, (input) => {
      input.checked ? state.categories.add(input.value) : state.categories.delete(input.value);
      render();
    });
  });

  prices.forEach((price) => {
    checkbox(price, price, true, priceFilters, (input) => {
      input.checked ? state.prices.add(input.value) : state.prices.delete(input.value);
      render();
    });
  });

  districtSelect.addEventListener("change", () => {
    state.district = districtSelect.value;
    render(true);
  });

  searchInput.addEventListener("input", () => {
    state.query = searchInput.value.trim().toLowerCase();
    render(Boolean(state.query));
  });

  document.getElementById("resetButton").addEventListener("click", () => {
    state.query = "";
    state.district = "";
    state.categories = new Set(categories);
    state.prices = new Set(prices);
    searchInput.value = "";
    districtSelect.value = "";
    document.querySelectorAll('input[type="checkbox"]').forEach((input) => {
      input.checked = true;
    });
    render(true);
  });

  document.getElementById("fitButton").addEventListener("click", () => fitToVisible());

  map.on("load", async () => {
    mapReady = true;
    await addBoundaryLayer();
    addVenueLayers();
    wireMapEvents();
    render(true);
  });

  function addVenueLayers() {
    map.addSource("venues", {
      type: "geojson",
      data: featureCollection([]),
      cluster: true,
      clusterMaxZoom: 14,
      clusterRadius: 42,
      clusterProperties: {
        drinks_count: ["+", ["case", ["==", ["get", "category"], "Show & Tell Drinks"], 1, 0]],
        markets_count: ["+", ["case", ["==", ["get", "category"], "Market Days"], 1, 0]],
        walks_count: ["+", ["case", ["==", ["get", "category"], "Creative Walks"], 1, 0]],
        museums_count: ["+", ["case", ["==", ["get", "category"], "Museum & Gallery Days"], 1, 0]],
        books_count: ["+", ["case", ["==", ["get", "category"], "Books & Coffee"], 1, 0]],
      },
    });

    map.addLayer({
      id: "venue-cluster-halos",
      type: "circle",
      source: "venues",
      filter: ["has", "point_count"],
      paint: {
        "circle-color": dominantClusterColor,
        "circle-opacity": 0.18,
        "circle-radius": ["step", ["get", "point_count"], 24, 10, 31, 50, 40],
      },
    });

    map.addLayer({
      id: "venue-clusters",
      type: "circle",
      source: "venues",
      filter: ["has", "point_count"],
      paint: {
        "circle-color": dominantClusterColor,
        "circle-opacity": 0.94,
        "circle-stroke-color": "#ffffff",
        "circle-stroke-width": 2.8,
        "circle-radius": ["step", ["get", "point_count"], 14, 10, 19, 50, 24],
      },
    });

    map.addLayer({
      id: "venue-cluster-counts",
      type: "symbol",
      source: "venues",
      filter: ["has", "point_count"],
      layout: {
        "text-field": ["get", "point_count_abbreviated"],
        "text-font": ["Open Sans Bold", "Arial Unicode MS Bold"],
        "text-size": 12,
      },
      paint: {
        "text-color": "#ffffff",
      },
    });

    map.addLayer({
      id: "venue-points",
      type: "circle",
      source: "venues",
      filter: ["!", ["has", "point_count"]],
      paint: {
        "circle-color": ["get", "color"],
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 5, 14, 6.5, 17, 9],
        "circle-opacity": 0.96,
        "circle-stroke-color": "rgba(255,255,255,0.98)",
        "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 8, 1.8, 16, 2.8],
      },
    });
  }

  async function addBoundaryLayer() {
    const response = await fetch("./london-boroughs.geojson");
    const boundaries = await response.json();
    map.addSource("boroughs", {
      type: "geojson",
      data: boundaries,
    });

    map.addLayer({
      id: "borough-fill",
      type: "fill",
      source: "boroughs",
      paint: {
        "fill-color": "#2563eb",
        "fill-opacity": 0.025,
      },
    });

    map.addLayer({
      id: "borough-lines",
      type: "line",
      source: "boroughs",
      paint: {
        "line-color": "#1d4ed8",
        "line-opacity": 0.86,
        "line-width": ["interpolate", ["linear"], ["zoom"], 8, 1.25, 12, 2],
      },
    });

    map.addLayer({
      id: "borough-selected-fill",
      type: "fill",
      source: "boroughs",
      filter: ["==", ["get", "name"], ""],
      paint: {
        "fill-color": "#2563eb",
        "fill-opacity": 0.12,
      },
    });

    map.addLayer({
      id: "borough-selected-line",
      type: "line",
      source: "boroughs",
      filter: ["==", ["get", "name"], ""],
      paint: {
        "line-color": "#17202a",
        "line-opacity": 0.95,
        "line-width": ["interpolate", ["linear"], ["zoom"], 8, 2.2, 12, 3.5],
      },
    });

    map.addLayer({
      id: "borough-labels",
      type: "symbol",
      source: "boroughs",
      minzoom: 8.4,
      layout: {
        "text-field": ["get", "name"],
        "text-font": ["Open Sans Bold", "Arial Unicode MS Bold"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 8, 9, 12, 11],
        "text-allow-overlap": false,
        "text-ignore-placement": false,
      },
      paint: {
        "text-color": "rgba(51, 65, 85, 0.82)",
        "text-halo-color": "rgba(255,255,255,0.94)",
        "text-halo-width": 1.8,
      },
    });
  }

  function wireMapEvents() {
    map.on("click", "venue-clusters", (event) => {
      const features = map.queryRenderedFeatures(event.point, { layers: ["venue-clusters"] });
      const clusterId = features[0].properties.cluster_id;
      map.getSource("venues").getClusterExpansionZoom(clusterId, (error, zoom) => {
        if (error) return;
        map.easeTo({
          center: features[0].geometry.coordinates,
          zoom: Math.min(zoom + 0.4, 16),
          duration: 180,
        });
      });
    });

    map.on("click", "venue-points", (event) => {
      const feature = event.features[0];
      const venue = currentList.find((item) => String(item.id) === String(feature.properties.id));
      if (!venue) return;
      openPopup(venue, feature.geometry.coordinates);
    });

    ["venue-clusters", "venue-points"].forEach((layer) => {
      map.on("mouseenter", layer, () => {
        map.getCanvas().style.cursor = "pointer";
      });
      map.on("mouseleave", layer, () => {
        map.getCanvas().style.cursor = "";
      });
    });
  }

  function searchableText(venue) {
    return [
      venue.name,
      venue.district,
      venue.category,
      venue.price,
      venue.best_for,
      venue.vibe,
      venue.why_go,
      venue.opening_hours,
    ]
      .join(" ")
      .toLowerCase();
  }

  function filteredVenues() {
    return venues.filter((venue) => {
      if (state.district && venue.district !== state.district) return false;
      if (!state.categories.has(venue.category)) return false;
      if (!state.prices.has(venue.price || "unknown")) return false;
      if (state.query && !searchableText(venue).includes(state.query)) return false;
      return Number.isFinite(Number(venue.latitude)) && Number.isFinite(Number(venue.longitude));
    });
  }

  function featureCollection(list) {
    const coordinateGroups = new Map();
    list.forEach((venue) => {
      const key = `${Number(venue.latitude).toFixed(6)},${Number(venue.longitude).toFixed(6)}`;
      if (!coordinateGroups.has(key)) coordinateGroups.set(key, []);
      coordinateGroups.get(key).push(venue.id);
    });
    const duplicateIndex = new Map();
    coordinateGroups.forEach((ids) => ids.forEach((id, index) => duplicateIndex.set(String(id), { index, total: ids.length })));

    return {
      type: "FeatureCollection",
      features: list.map((venue) => {
        const spread = duplicateIndex.get(String(venue.id)) || { index: 0, total: 1 };
        const coordinates = spreadCoordinate(Number(venue.longitude), Number(venue.latitude), spread.index, spread.total);
        return {
          type: "Feature",
          geometry: {
            type: "Point",
            coordinates,
          },
          properties: {
            id: String(venue.id),
            name: venue.name,
            category: venue.category,
            category_count_key: clusterCategoryKeys[venue.category] || "other_count",
            district: venue.district,
            price: venue.price || "unknown",
            color: colors[venue.category] || "#475569",
          },
        };
      }),
    };
  }

  function spreadCoordinate(lon, lat, index, total) {
    if (total <= 1) return [lon, lat];
    const angle = (Math.PI * 2 * index) / total;
    const radiusMeters = total <= 3 ? 18 : 26;
    const latOffset = (Math.sin(angle) * radiusMeters) / 111320;
    const lonOffset = (Math.cos(angle) * radiusMeters) / (111320 * Math.cos((lat * Math.PI) / 180));
    return [lon + lonOffset, lat + latOffset];
  }

  function popupHtml(venue) {
    return `
      <div class="popup">
        <h3>${escapeHtml(venue.name)}</h3>
        <p><strong>${escapeHtml(venue.category)}</strong> · ${escapeHtml(venue.district)} · ${escapeHtml(venue.price || "unknown")}</p>
        <p>${escapeHtml(venue.why_go || "")}</p>
        <p><strong>Best for:</strong> ${escapeHtml(venue.best_for || "")}</p>
        <a href="${venue.google_location}" target="_blank" rel="noreferrer">Open in Google Maps</a>
      </div>
    `;
  }

  function openPopup(venue, coordinates) {
    if (popup) popup.remove();
    popup = new mapboxgl.Popup({
      closeButton: true,
      closeOnClick: true,
      maxWidth: "300px",
      offset: 12,
    })
      .setLngLat(coordinates)
      .setHTML(popupHtml(venue))
      .addTo(map);
  }

  function renderMarkers(list) {
    if (!mapReady || !map.getSource("venues")) return;
    map.getSource("venues").setData(featureCollection(list));
  }

  function renderSummary(list) {
    const counts = {};
    list.forEach((venue) => {
      counts[venue.category] = (counts[venue.category] || 0) + 1;
    });
    summaryList.innerHTML = "";
    categories.forEach((category) => {
      const row = document.createElement("div");
      row.className = "summary-item";
      row.innerHTML = `
        <span class="dot" style="background:${colors[category] || "#475569"}"></span>
        <span>${escapeHtml(category)}</span>
        <strong>${(counts[category] || 0).toLocaleString()}</strong>
      `;
      summaryList.appendChild(row);
    });
  }

  function renderList(list) {
    venueList.innerHTML = "";
    list.slice(0, 220).forEach((venue) => {
      const card = document.createElement("article");
      card.className = "venue-card";
      card.dataset.venueId = String(venue.id);
      card.innerHTML = `
        <div class="venue-title">${escapeHtml(venue.name)}</div>
        <div class="venue-meta">${escapeHtml(venue.category)} · ${escapeHtml(venue.district)} · ${escapeHtml(venue.price || "unknown")}</div>
        <div class="venue-note">${escapeHtml(venue.best_for || venue.why_go || "")}</div>
      `;
      card.addEventListener("click", () => {
        const coordinates = spreadCoordinate(Number(venue.longitude), Number(venue.latitude), 0, 1);
        map.easeTo({ center: coordinates, zoom: 15.5, duration: 180 });
        openPopup(venue, coordinates);
      });
      venueList.appendChild(card);
    });
    if (list.length > 220) {
      const note = document.createElement("p");
      note.className = "venue-note";
      note.textContent = `Showing first 220 list items. Refine filters to browse the remaining ${(list.length - 220).toLocaleString()}.`;
      venueList.appendChild(note);
    }
  }

  function fitToVisible() {
    if (!currentList.length) return;
    const bounds = new mapboxgl.LngLatBounds();
    currentList.forEach((venue) => bounds.extend([Number(venue.longitude), Number(venue.latitude)]));
    map.fitBounds(bounds, {
      padding: 36,
      maxZoom: state.district || state.query ? 13.5 : 10.2,
      duration: 180,
    });
  }

  function render(shouldFit = false) {
    currentList = filteredVenues();
    visibleCount.textContent = currentList.length.toLocaleString();
    renderMarkers(currentList);
    if (mapReady && map.getLayer("borough-selected-fill")) {
      const filter = state.district ? ["==", ["get", "name"], state.district] : ["==", ["get", "name"], ""];
      map.setFilter("borough-selected-fill", filter);
      map.setFilter("borough-selected-line", filter);
    }
    renderSummary(currentList);
    renderList(currentList);
    if (popup) popup.remove();
    if (mapReady && (shouldFit || state.district || state.query)) fitToVisible();
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  render();
})();
