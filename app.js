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
    mode: "venues",
    selectedEventId: "",
  };

  const db = {
    users: [],
    events: [],
    week: 1,
  };

  const elements = {
    categoryFilters: document.getElementById("categoryFilters"),
    priceFilters: document.getElementById("priceFilters"),
    districtSelect: document.getElementById("districtSelect"),
    searchInput: document.getElementById("searchInput"),
    list: document.getElementById("venueList"),
    listTitle: document.getElementById("listTitle"),
    summaryList: document.getElementById("summaryList"),
    visibleCount: document.getElementById("visibleCount"),
    totalCount: document.getElementById("totalCount"),
    weekLabel: document.getElementById("weekLabel"),
    agentLog: document.getElementById("agentLog"),
    addUserButton: document.getElementById("addUserButton"),
    runAgentsButton: document.getElementById("runAgentsButton"),
    resetSimButton: document.getElementById("resetSimButton"),
    userModal: document.getElementById("userModal"),
    userForm: document.getElementById("userForm"),
    userDistrictInput: document.getElementById("userDistrictInput"),
    userCategoryInput: document.getElementById("userCategoryInput"),
  };

  let currentList = [];
  let mapReady = false;
  let popup = null;
  let initialUsers = [];
  let initialEvents = [];

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

  boot();

  async function boot() {
    const [serverState, usersJson, eventsJson] = await Promise.all([
      loadJson("/api/state", null),
      loadJson("./data/users.json", []),
      loadJson("./data/events.json", []),
    ]);
    initialUsers = serverState?.users || usersJson;
    initialEvents = serverState?.events || eventsJson;
    loadDb(serverState);
    setupControls();
    elements.totalCount.textContent = venues.length.toLocaleString();
    render();
  }

  async function loadJson(path, fallback) {
    try {
      const response = await fetch(path);
      if (!response.ok) return fallback;
      return await response.json();
    } catch {
      return fallback;
    }
  }

  function loadDb(serverState = null) {
    const source = serverState || {};
    db.users = Array.isArray(source.users) ? source.users : clone(initialUsers);
    db.events = Array.isArray(source.events) ? source.events : clone(initialEvents);
    db.week = Number.isFinite(Number(source.week)) ? Number(source.week) : 1;
  }

  async function saveDb() {
    const saved = await postJson("/api/state", db);
    applyServerDb(saved);
  }

  async function postJson(path, payload = {}) {
    const response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Request failed");
    return result;
  }

  async function getJson(path) {
    const response = await fetch(path);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Request failed");
    return result;
  }

  function applyServerDb(result) {
    db.users = Array.isArray(result.users) ? result.users : db.users;
    db.events = Array.isArray(result.events) ? result.events : db.events;
    db.week = Number.isFinite(Number(result.week)) ? Number(result.week) : db.week;
  }

  function setupControls() {
    districts.forEach((district) => {
      addOption(elements.districtSelect, district, district);
      addOption(elements.userDistrictInput, district, district);
    });

    categories.forEach((category) => {
      checkbox(category, category, true, elements.categoryFilters, (input) => {
        input.checked ? state.categories.add(input.value) : state.categories.delete(input.value);
        render();
      });
      addOption(elements.userCategoryInput, category, category);
    });

    prices.forEach((price) => {
      checkbox(price, price, true, elements.priceFilters, (input) => {
        input.checked ? state.prices.add(input.value) : state.prices.delete(input.value);
        render();
      });
    });

    document.querySelectorAll(".mode-tab").forEach((button) => {
      button.addEventListener("click", () => setMode(button.dataset.mode));
    });

    elements.districtSelect.addEventListener("change", () => {
      state.district = elements.districtSelect.value;
      render(true);
    });

    elements.searchInput.addEventListener("input", () => {
      state.query = elements.searchInput.value.trim().toLowerCase();
      render(Boolean(state.query));
    });

    document.getElementById("resetButton").addEventListener("click", () => {
      state.query = "";
      state.district = "";
      state.categories = new Set(categories);
      state.prices = new Set(prices);
      elements.searchInput.value = "";
      elements.districtSelect.value = "";
      document.querySelectorAll('.controls input[type="checkbox"]').forEach((input) => {
        input.checked = true;
      });
      render(true);
    });

    document.getElementById("fitButton").addEventListener("click", () => fitToVisible());
    elements.addUserButton.addEventListener("click", () => elements.userModal.showModal());
    document.getElementById("closeUserModal").addEventListener("click", () => elements.userModal.close());
    elements.runAgentsButton.addEventListener("click", runAgentWeek);
    elements.resetSimButton.addEventListener("click", resetSimulation);
    elements.userForm.addEventListener("submit", addUserFromForm);
  }

  map.on("load", async () => {
    mapReady = true;
    await addBoundaryLayer();
    addVenueLayers();
    addUserLayers();
    addEventLayers();
    wireMapEvents();
    render(true);
  });

  function addOption(select, value, label) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    select.appendChild(option);
  }

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
      paint: { "text-color": "#ffffff" },
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

  function addUserLayers() {
    map.addSource("users", {
      type: "geojson",
      data: userFeatureCollection([]),
    });

    map.addSource("event-user-lines", {
      type: "geojson",
      data: eventUserLineFeatureCollection(null, []),
    });

    map.addLayer({
      id: "event-user-lines",
      type: "line",
      source: "event-user-lines",
      paint: {
        "line-color": "#7c3aed",
        "line-opacity": 0.72,
        "line-width": ["interpolate", ["linear"], ["zoom"], 8, 1.4, 14, 2.2, 17, 3],
        "line-dasharray": [1.2, 1.6],
      },
    });

    map.addLayer({
      id: "user-points",
      type: "circle",
      source: "users",
      paint: {
        "circle-color": "#7c3aed",
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 5, 14, 7, 17, 10],
        "circle-stroke-color": "#ffffff",
        "circle-stroke-width": 2,
        "circle-opacity": 0.92,
      },
    });

    map.addLayer({
      id: "user-labels",
      type: "symbol",
      source: "users",
      minzoom: 10,
      layout: {
        "text-field": ["get", "name"],
        "text-font": ["Open Sans Bold", "Arial Unicode MS Bold"],
        "text-size": 11,
        "text-offset": [0, 1.25],
      },
      paint: {
        "text-color": "#4c1d95",
        "text-halo-color": "rgba(255,255,255,0.95)",
        "text-halo-width": 1.4,
      },
    });
  }

  function addEventLayers() {
    map.addSource("events", {
      type: "geojson",
      data: eventFeatureCollection([]),
    });

    map.addSource("selected-event-backup-line", {
      type: "geojson",
      data: selectedEventBackupLineFeatureCollection(null),
    });

    map.addSource("selected-event-backup", {
      type: "geojson",
      data: selectedEventBackupFeatureCollection(null),
    });

    map.addLayer({
      id: "selected-event-backup-line",
      type: "line",
      source: "selected-event-backup-line",
      layout: { visibility: "none" },
      paint: {
        "line-color": "#475569",
        "line-opacity": 0.56,
        "line-width": ["interpolate", ["linear"], ["zoom"], 8, 1.2, 14, 2, 17, 2.8],
        "line-dasharray": [1.5, 1.5],
      },
    });

    map.addLayer({
      id: "selected-event-backup-point",
      type: "circle",
      source: "selected-event-backup",
      layout: { visibility: "none" },
      paint: {
        "circle-color": ["get", "color"],
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 6, 14, 8.5, 17, 12],
        "circle-opacity": 0.58,
        "circle-stroke-color": "#475569",
        "circle-stroke-opacity": 0.82,
        "circle-stroke-width": 2,
      },
    });

    map.addLayer({
      id: "selected-event-backup-label",
      type: "symbol",
      source: "selected-event-backup",
      layout: {
        visibility: "none",
        "text-field": "Backup",
        "text-font": ["Open Sans Bold", "Arial Unicode MS Bold"],
        "text-size": 11,
        "text-offset": [0, 1.45],
      },
      paint: {
        "text-color": "#334155",
        "text-halo-color": "rgba(255,255,255,0.95)",
        "text-halo-width": 1.6,
      },
    });

    map.addLayer({
      id: "event-points",
      type: "circle",
      source: "events",
      paint: {
        "circle-color": ["get", "color"],
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 7, 14, 10, 17, 14],
        "circle-stroke-color": "#111827",
        "circle-stroke-width": 2.4,
        "circle-opacity": 0.95,
      },
    });

    map.addLayer({
      id: "event-labels",
      type: "symbol",
      source: "events",
      minzoom: 11,
      layout: {
        "text-field": ["get", "group_size"],
        "text-font": ["Open Sans Bold", "Arial Unicode MS Bold"],
        "text-size": 11,
      },
      paint: { "text-color": "#ffffff" },
    });
  }

  async function addBoundaryLayer() {
    const response = await fetch("./london-boroughs.geojson");
    const boundaries = await response.json();
    map.addSource("boroughs", { type: "geojson", data: boundaries });
    map.addLayer({
      id: "borough-fill",
      type: "fill",
      source: "boroughs",
      paint: { "fill-color": "#2563eb", "fill-opacity": 0.025 },
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
      paint: { "fill-color": "#2563eb", "fill-opacity": 0.12 },
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
        map.easeTo({ center: features[0].geometry.coordinates, zoom: Math.min(zoom + 0.4, 16), duration: 180 });
      });
    });

    map.on("click", "venue-points", (event) => {
      const venue = venues.find((item) => String(item.id) === String(event.features[0].properties.id));
      if (venue) openPopup(popupHtmlForVenue(venue), event.features[0].geometry.coordinates);
    });

    map.on("click", "user-points", (event) => {
      const user = db.users.find((item) => item.id === event.features[0].properties.id);
      if (user) openPopup(popupHtmlForUser(user), event.features[0].geometry.coordinates);
    });

    map.on("click", "event-points", (event) => {
      event.originalEvent.stopPropagation();
      const matchedEvent = db.events.find((item) => item.id === event.features[0].properties.id);
      if (!matchedEvent) return;
      state.selectedEventId = matchedEvent.id;
      openPopup(popupHtmlForEvent(matchedEvent), event.features[0].geometry.coordinates);
      focusSelectedEvent(matchedEvent);
      render(false);
    });

    map.on("click", "selected-event-backup-point", (event) => {
      event.originalEvent.stopPropagation();
      const backup = venueById(event.features[0].properties.id);
      if (backup) openPopup(popupHtmlForVenue(backup), event.features[0].geometry.coordinates);
    });

    map.on("click", (event) => {
      const features = map.queryRenderedFeatures(event.point, { layers: ["event-points", "venue-points", "user-points", "venue-clusters"] });
      if (features.length) return;
      clearSelectedEvent();
    });

    ["venue-clusters", "venue-points", "user-points", "event-points", "selected-event-backup-point"].forEach((layer) => {
      map.on("mouseenter", layer, () => {
        map.getCanvas().style.cursor = "pointer";
      });
      map.on("mouseleave", layer, () => {
        map.getCanvas().style.cursor = "";
      });
    });
  }

  function setMode(mode) {
    state.mode = mode;
    state.selectedEventId = "";
    updateModeTabs();
    render(true);
  }

  function updateModeTabs() {
    document.querySelectorAll(".mode-tab").forEach((button) => {
      button.classList.toggle("active", button.dataset.mode === state.mode);
    });
  }

  function searchableText(item) {
    return [
      item.name,
      item.district,
      item.neighbourhood,
      item.category,
      item.tier,
      item.paint_score,
      item.price,
      item.best_for,
      item.vibe,
      item.why_go,
      item.opening_hours,
      item.availability,
      item.storyline,
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
      return validPoint(venue);
    });
  }

  function filteredUsers() {
    let users = db.users;
    if (state.selectedEventId) {
      const matchedEvent = db.events.find((event) => event.id === state.selectedEventId);
      users = users.filter((user) => matchedEvent?.user_ids.includes(user.id));
    }
    return users.filter((user) => {
      if (state.district && user.district !== state.district) return false;
      if (!state.categories.has(user.category)) return false;
      if (!state.prices.has(user.price_preference || "unknown")) return false;
      if (state.query && !searchableText(user).includes(state.query)) return false;
      return validPoint(user);
    });
  }

  function filteredEvents() {
    return db.events.filter((event) => {
      const primary = venueById(event.primary_venue_id);
      if (!primary) return false;
      if (state.district && event.area !== state.district && primary.district !== state.district) return false;
      if (!state.categories.has(event.category)) return false;
      if (!state.prices.has(primary.price || "unknown")) return false;
      if (state.query && !searchableText({ ...event, name: event.title, district: primary.district }).includes(state.query)) return false;
      return true;
    });
  }

  async function runAgentWeek() {
    if (db.users.length < 2) {
      elements.agentLog.textContent = "Add at least 2 users before running agents.";
      return;
    }
    elements.runAgentsButton.disabled = true;
    elements.runAgentsButton.textContent = "Running...";
    elements.agentLog.textContent = "Starting PAINTS agent job...";
    try {
      const started = await postJson("/api/run-agents", {
        users: db.users,
        events: db.events,
        week: db.week,
      });
      if (started.error) throw new Error(started.error);
      const result = await pollAgentJob(started.job_id);
      if (result.error) throw new Error(result.error);
      if (result.users || result.events) applyServerDb(result);
      elements.agentLog.textContent = result.log || "Agent run complete.";
      state.mode = "events";
      state.selectedEventId = "";
      updateModeTabs();
      render(true);
    } catch (error) {
      elements.agentLog.textContent = error.message;
    } finally {
      elements.runAgentsButton.disabled = false;
      elements.runAgentsButton.textContent = "Run agents";
    }
  }

  async function pollAgentJob(jobId) {
    if (!jobId) throw new Error("Agent job did not start.");
    for (;;) {
      const job = await getJson(`/api/jobs/${encodeURIComponent(jobId)}`);
      elements.agentLog.textContent = jobProgressText(job);
      if (["completed", "failed", "cancelled"].includes(job.status)) return job;
      await delay(1500);
    }
  }

  function jobProgressText(job) {
    const progress = job.progress || {};
    const parts = [
      job.log || "Running PAINTS agents...",
      `Groups: ${progress.groups_created || 0}`,
      `Planned: ${progress.planned_events || 0}`,
      `Events: ${progress.events_created || 0}/${progress.groups_total || 0}`,
      `Done: ${progress.event_groups_done || 0}`,
      `Failed: ${progress.failed_units || 0}`,
    ];
    return parts.join(" · ");
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function addUserFromForm(event) {
    event.preventDefault();
    const district = document.getElementById("userDistrictInput").value;
    const point = districtPoint(district);
    const user = {
      id: `u-${Date.now()}`,
      name: document.getElementById("userNameInput").value.trim(),
      age: Number(document.getElementById("userAgeInput").value),
      gender: document.getElementById("userGenderInput").value,
      district,
      category: document.getElementById("userCategoryInput").value,
      availability: document.getElementById("userAvailabilityInput").value,
      price_preference: document.getElementById("userPriceInput").value,
      gender_mix_preference: document.getElementById("userGenderMixInput").value,
      age_preference: document.getElementById("userAgePreferenceInput").value,
      travel_time_preference: document.getElementById("userTravelTimeInput").value,
      latitude: point.latitude,
      longitude: point.longitude,
      last_venue_ids: [],
      last_event_user_ids: [],
      last_event_feedback: null,
    };
    try {
      const result = await postJson("/api/users", { user });
      applyServerDb(result);
      elements.userForm.reset();
      elements.userModal.close();
      state.mode = "users";
      updateModeTabs();
      render(true);
    } catch (error) {
      elements.agentLog.textContent = error.message;
    }
  }

  async function resetSimulation() {
    try {
      const result = await postJson("/api/reset");
      applyServerDb(result);
      elements.agentLog.textContent = "Simulation reset.";
      render(true);
    } catch (error) {
      elements.agentLog.textContent = error.message;
    }
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
          geometry: { type: "Point", coordinates },
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

  function userFeatureCollection(list) {
    const duplicateIndex = duplicatePointIndex(list);
    return {
      type: "FeatureCollection",
      features: list.map((user) => {
        const spread = duplicateIndex.get(String(user.id)) || { index: 0, total: 1 };
        return {
          type: "Feature",
          geometry: { type: "Point", coordinates: spreadCoordinate(Number(user.longitude), Number(user.latitude), spread.index, spread.total) },
          properties: { id: user.id, name: user.name },
        };
      }),
    };
  }

  function eventFeatureCollection(list) {
    return {
      type: "FeatureCollection",
      features: list.map((event) => {
        const venue = venueById(event.primary_venue_id);
        return {
          type: "Feature",
          geometry: { type: "Point", coordinates: [Number(venue.longitude), Number(venue.latitude)] },
          properties: {
            id: event.id,
            group_size: String(event.user_ids.length),
            color: colors[event.category] || "#475569",
          },
        };
      }),
    };
  }

  function eventUserLineFeatureCollection(event, users) {
    const primary = event ? venueById(event.primary_venue_id) : null;
    if (!primary || !validPoint(primary)) {
      return { type: "FeatureCollection", features: [] };
    }
    const duplicateIndex = duplicatePointIndex(users);
    return {
      type: "FeatureCollection",
      features: users.filter(validPoint).map((user) => {
        const spread = duplicateIndex.get(String(user.id)) || { index: 0, total: 1 };
        return {
          type: "Feature",
          geometry: {
            type: "LineString",
            coordinates: [
              [Number(primary.longitude), Number(primary.latitude)],
              spreadCoordinate(Number(user.longitude), Number(user.latitude), spread.index, spread.total),
            ],
          },
          properties: {
            event_id: event.id,
            user_id: user.id,
          },
        };
      }),
    };
  }

  function selectedEventBackupFeatureCollection(event) {
    const backup = event ? venueById(event.backup_venue_id) : null;
    if (!backup || !validPoint(backup)) {
      return { type: "FeatureCollection", features: [] };
    }
    return {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [Number(backup.longitude), Number(backup.latitude)] },
          properties: {
            id: String(backup.id),
            name: backup.name,
            event_id: event.id,
            color: colors[event.category] || "#475569",
          },
        },
      ],
    };
  }

  function selectedEventBackupLineFeatureCollection(event) {
    const primary = event ? venueById(event.primary_venue_id) : null;
    const backup = event ? venueById(event.backup_venue_id) : null;
    if (!primary || !backup || !validPoint(primary) || !validPoint(backup)) {
      return { type: "FeatureCollection", features: [] };
    }
    return {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: {
            type: "LineString",
            coordinates: [
              [Number(primary.longitude), Number(primary.latitude)],
              [Number(backup.longitude), Number(backup.latitude)],
            ],
          },
          properties: {
            event_id: event.id,
            primary_venue_id: String(primary.id),
            backup_venue_id: String(backup.id),
          },
        },
      ],
    };
  }

  function render(shouldFit = false) {
    const venuesList = filteredVenues();
    const usersList = filteredUsers();
    const eventsList = filteredEvents();
    const selectedEvent = state.selectedEventId ? db.events.find((event) => event.id === state.selectedEventId) : null;
    const selectedEventUsers = selectedEvent ? selectedEvent.user_ids.map((id) => userById(id)).filter(Boolean) : [];
    currentList = state.mode === "users" ? usersList : state.mode === "events" ? eventsList : venuesList;

    elements.weekLabel.textContent = `Week ${db.week}`;
    elements.visibleCount.textContent = currentList.length.toLocaleString();
    elements.totalCount.textContent = (state.mode === "users" ? db.users.length : state.mode === "events" ? db.events.length : venues.length).toLocaleString();
    elements.listTitle.textContent = state.mode === "users" ? "Users" : state.mode === "events" ? "Events" : "Venues";

    if (mapReady) {
      map.getSource("venues")?.setData(featureCollection(venuesList));
      map.getSource("users")?.setData(userFeatureCollection(selectedEvent ? selectedEventUsers : usersList));
      map.getSource("events")?.setData(eventFeatureCollection(eventsList));
      map.getSource("event-user-lines")?.setData(eventUserLineFeatureCollection(selectedEvent, selectedEventUsers));
      map.getSource("selected-event-backup")?.setData(selectedEventBackupFeatureCollection(selectedEvent));
      map.getSource("selected-event-backup-line")?.setData(selectedEventBackupLineFeatureCollection(selectedEvent));
      setLayerVisibility(["venue-cluster-halos", "venue-clusters", "venue-cluster-counts", "venue-points"], state.mode === "venues");
      setLayerVisibility(["event-user-lines"], Boolean(selectedEvent));
      setLayerVisibility(["selected-event-backup-line", "selected-event-backup-point", "selected-event-backup-label"], Boolean(selectedEvent));
      setLayerVisibility(["user-points", "user-labels"], state.mode === "users" || Boolean(selectedEvent));
      setLayerVisibility(["event-points", "event-labels"], state.mode === "events");
      if (map.getLayer("borough-selected-fill")) {
        const filter = state.district ? ["==", ["get", "name"], state.district] : ["==", ["get", "name"], ""];
        map.setFilter("borough-selected-fill", filter);
        map.setFilter("borough-selected-line", filter);
      }
    }

    renderSummary();
    renderList();
    if (popup && !state.selectedEventId) popup.remove();
    if (mapReady && shouldFit) fitToVisible();
  }

  function renderSummary() {
    elements.summaryList.innerHTML = "";
    if (state.mode === "events") {
      summaryRow("Events", db.events.length, "#111827");
      summaryRow("Users matched", db.events.reduce((sum, event) => sum + event.user_ids.length, 0), "#7c3aed");
      summaryRow("Current week", db.week, "#0f766e");
      return;
    }
    if (state.mode === "users") {
      categories.forEach((category) => summaryRow(category, db.users.filter((user) => user.category === category).length, colors[category]));
      return;
    }
    categories.forEach((category) => summaryRow(category, currentList.filter((venue) => venue.category === category).length, colors[category]));
  }

  function summaryRow(label, count, color) {
    const row = document.createElement("div");
    row.className = "summary-item";
    row.innerHTML = `
      <span class="dot" style="background:${color || "#475569"}"></span>
      <span>${escapeHtml(label)}</span>
      <strong>${Number(count || 0).toLocaleString()}</strong>
    `;
    elements.summaryList.appendChild(row);
  }

  function renderList() {
    elements.list.innerHTML = "";
    currentList.slice(0, 220).forEach((item) => {
      if (state.mode === "events") renderEventCard(item);
      else if (state.mode === "users") renderUserCard(item);
      else renderVenueCard(item);
    });
  }

  function renderVenueCard(venue) {
    const card = document.createElement("article");
    card.className = "venue-card";
    card.innerHTML = `
      <div class="venue-card-top">
        <div class="venue-title">${escapeHtml(venue.name)}</div>
        <div class="score-badge">${escapeHtml(formatScore(venue.paint_score))}</div>
      </div>
      <div class="venue-meta">${escapeHtml(venue.category)} · ${escapeHtml(venue.district)} · ${escapeHtml(venue.price || "unknown")} · ${escapeHtml(venue.tier || "Tier n/a")}</div>
      <div class="venue-note">${escapeHtml(venue.best_for || venue.why_go || "")}</div>
    `;
    card.addEventListener("click", () => focusPoint(venue, popupHtmlForVenue(venue)));
    elements.list.appendChild(card);
  }

  function renderUserCard(user) {
    const card = document.createElement("article");
    card.className = "venue-card";
    card.innerHTML = `
      <div class="venue-card-top">
        <div class="venue-title">${escapeHtml(user.name)}</div>
        <div class="score-badge">${escapeHtml(String(user.age))}</div>
      </div>
      <div class="venue-meta">${escapeHtml(user.category)} · ${escapeHtml(user.district)} · ${escapeHtml(user.availability)}</div>
      <div class="venue-note">Last venues: ${escapeHtml((user.last_venue_ids || []).join(", ") || "none")}</div>
    `;
    card.addEventListener("click", () => focusPoint(user, popupHtmlForUser(user)));
    elements.list.appendChild(card);
  }

  function renderEventCard(event) {
    const primary = venueById(event.primary_venue_id);
    const backup = venueById(event.backup_venue_id);
    const card = document.createElement("article");
    card.className = "venue-card";
    card.innerHTML = `
      <div class="venue-card-top">
        <div class="venue-title">${escapeHtml(event.title)}</div>
        <div class="score-badge">${event.user_ids.length}</div>
      </div>
      <div class="venue-meta">${escapeHtml(event.category)} · ${escapeHtml(event.date_time)} · ${escapeHtml(primary?.district || "")}</div>
      <div class="venue-note">${escapeHtml(primary?.name || "")} · backup: ${escapeHtml(backup?.name || "")}</div>
    `;
    card.addEventListener("click", () => {
      state.selectedEventId = event.id;
      if (primary) openPopup(popupHtmlForEvent(event), [Number(primary.longitude), Number(primary.latitude)]);
      focusSelectedEvent(event);
      render(false);
    });
    elements.list.appendChild(card);
  }

  function fitToVisible() {
    const points = state.mode === "events" ? filteredEvents().map((event) => venueById(event.primary_venue_id)).filter(Boolean) : currentList;
    if (!points.length) return;
    const bounds = new mapboxgl.LngLatBounds();
    points.forEach((point) => bounds.extend([Number(point.longitude), Number(point.latitude)]));
    map.fitBounds(bounds, { padding: 36, maxZoom: state.district || state.query ? 13.5 : 10.2, duration: 180 });
  }

  function focusPoint(item, html) {
    const coordinates = [Number(item.longitude), Number(item.latitude)];
    map.easeTo({ center: coordinates, zoom: 15.5, duration: 180 });
    openPopup(html, coordinates);
  }

  function focusSelectedEvent(event) {
    const primary = venueById(event.primary_venue_id);
    const backup = venueById(event.backup_venue_id);
    const points = [primary, backup].filter(validPoint);
    if (points.length < 2) {
      if (primary) map.easeTo({ center: [Number(primary.longitude), Number(primary.latitude)], zoom: 15.5, duration: 180 });
      return;
    }
    const bounds = new mapboxgl.LngLatBounds();
    points.forEach((point) => bounds.extend([Number(point.longitude), Number(point.latitude)]));
    map.fitBounds(bounds, {
      padding: { top: 110, right: 360, bottom: 90, left: 90 },
      maxZoom: 15.2,
      duration: 180,
    });
  }

  function openPopup(html, coordinates) {
    if (popup) popup.remove();
    popup = new mapboxgl.Popup({ closeButton: true, closeOnClick: true, maxWidth: "320px", offset: 12 })
      .setLngLat(coordinates)
      .setHTML(html)
      .addTo(map);
  }

  function popupHtmlForVenue(venue) {
    return `
      <div class="popup">
        <h3>${escapeHtml(venue.name)}</h3>
        <p><strong>${escapeHtml(venue.category)}</strong> · ${escapeHtml(venue.district)} · ${escapeHtml(venue.price || "unknown")} · Score ${escapeHtml(formatScore(venue.paint_score))}</p>
        <p>${escapeHtml(venue.why_go || "")}</p>
        <p><strong>Best for:</strong> ${escapeHtml(venue.best_for || "")}</p>
        <p><strong>Walk-in:</strong> ${escapeHtml(venue.walk_in_policy || "unknown")}</p>
        <a href="${venue.google_location}" target="_blank" rel="noreferrer">Open in Google Maps</a>
      </div>
    `;
  }

  function popupHtmlForUser(user) {
    const otherEvents = eventsForUser(user.id)
      .map((event) => event.title)
      .join(", ");
    return `
      <div class="popup">
        <h3>${escapeHtml(user.name)}</h3>
        <p><strong>${escapeHtml(user.category)}</strong> · ${escapeHtml(user.district)} · ${escapeHtml(user.availability)}</p>
        <p>Age ${escapeHtml(user.age)} · ${escapeHtml(user.gender_mix_preference)} · ${escapeHtml(user.price_preference)} · ${escapeHtml(user.travel_time_preference || "travel flexible")}</p>
        <p><strong>Other current events:</strong> ${escapeHtml(otherEvents || "none")}</p>
        <p><strong>Last 4 venues:</strong> ${escapeHtml((user.last_venue_ids || []).join(", ") || "none")}</p>
        <p><strong>Recent people met:</strong> ${escapeHtml((user.last_event_user_ids || []).join(", ") || "none")}</p>
      </div>
    `;
  }

  function popupHtmlForEvent(event) {
    const primary = venueById(event.primary_venue_id);
    const backup = venueById(event.backup_venue_id);
    const users = event.user_ids.map((id) => userById(id)?.name || id).join(", ");
    return `
      <div class="popup">
        <h3>${escapeHtml(event.title)}</h3>
        <p><strong>${escapeHtml(event.category)}</strong> · ${escapeHtml(event.date_time)}</p>
        <p><strong>Primary:</strong> ${escapeHtml(primary?.name || "")}</p>
        <p><strong>Backup:</strong> ${escapeHtml(backup?.name || "")}</p>
        <p><strong>Users:</strong> ${escapeHtml(users)}</p>
        <p>${escapeHtml(event.storyline || "")}</p>
      </div>
    `;
  }

  function setLayerVisibility(layers, visible) {
    layers.forEach((layer) => {
      if (map.getLayer(layer)) map.setLayoutProperty(layer, "visibility", visible ? "visible" : "none");
    });
  }

  function duplicatePointIndex(list) {
    const coordinateGroups = new Map();
    list.filter(validPoint).forEach((item) => {
      const key = `${Number(item.latitude).toFixed(5)},${Number(item.longitude).toFixed(5)}`;
      if (!coordinateGroups.has(key)) coordinateGroups.set(key, []);
      coordinateGroups.get(key).push(item.id);
    });
    const duplicateIndex = new Map();
    coordinateGroups.forEach((ids) => ids.forEach((id, index) => duplicateIndex.set(String(id), { index, total: ids.length })));
    return duplicateIndex;
  }

  function eventsForUser(userId) {
    return db.events.filter((event) => event.user_ids.includes(userId));
  }

  function clearSelectedEvent() {
    if (!state.selectedEventId) return;
    state.selectedEventId = "";
    if (popup) popup.remove();
    render(false);
  }

  function spreadCoordinate(lon, lat, index, total) {
    if (total <= 1) return [lon, lat];
    const angle = (Math.PI * 2 * index) / total;
    const radiusMeters = total <= 3 ? 18 : 26;
    const latOffset = (Math.sin(angle) * radiusMeters) / 111320;
    const lonOffset = (Math.cos(angle) * radiusMeters) / (111320 * Math.cos((lat * Math.PI) / 180));
    return [lon + lonOffset, lat + latOffset];
  }

  function districtCluster(district) {
    const clusters = {
      "Kensington and Chelsea": "West London",
      "Hammersmith and Fulham": "West London",
      Westminster: "Central London",
      Camden: "Central London",
      Islington: "North London",
      Hackney: "East London",
      Newham: "East London",
      Greenwich: "South East London",
      Southwark: "South London",
      Lambeth: "South London",
      Wandsworth: "South West London",
      Richmond: "South West London",
    };
    return clusters[district] || district || "London";
  }

  function districtPoint(district) {
    const matches = venues.filter((venue) => venue.district === district && validPoint(venue));
    if (!matches.length) return { latitude: 51.5074, longitude: -0.1278 };
    return averagePoint(matches);
  }

  function averagePoint(items) {
    const valid = items.filter(validPoint);
    if (!valid.length) return { latitude: 51.5074, longitude: -0.1278 };
    return {
      latitude: valid.reduce((sum, item) => sum + Number(item.latitude), 0) / valid.length,
      longitude: valid.reduce((sum, item) => sum + Number(item.longitude), 0) / valid.length,
    };
  }

  function venueById(id) {
    return venues.find((venue) => String(venue.id) === String(id));
  }

  function userById(id) {
    return db.users.find((user) => user.id === id);
  }

  function validPoint(item) {
    return Number.isFinite(Number(item.latitude)) && Number.isFinite(Number(item.longitude));
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function formatScore(value) {
    const score = Number(value);
    if (!Number.isFinite(score)) return "n/a";
    return String(Math.round(score));
  }
})();
