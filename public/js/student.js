// ─── Shared utilities ────────────────────────────────────────────────────────
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function timeAgo(ts) {
  if (!ts) return "—";
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 5)  return "just now";
  if (s < 60) return s + "s ago";
  return Math.round(s / 60) + "m ago";
}

function showToast(msg, type = "success") {
  const c = document.getElementById("toast-container");
  const t = document.createElement("div");
  t.className = `toast ${type}`;
  t.innerHTML = `<span>${type === "success" ? "✅" : "❌"}</span> ${msg}`;
  c.appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

function statusBadge(status) {
  const map = {
    running:     '<span class="badge badge-running">● Running</span>',
    stopped:     '<span class="badge badge-stopped">● Stopped</span>',
    maintenance: '<span class="badge badge-maintenance">● Maintenance</span>',
  };
  return map[status] || `<span class="badge">${status}</span>`;
}

// ─── Bus colour palette ───────────────────────────────────────────────────────
const BUS_COLORS = ["#3b82f6","#10b981","#f59e0b","#ef4444","#8b5cf6","#06b6d4","#f97316","#ec4899"];

function busColor(index) {
  return BUS_COLORS[index % BUS_COLORS.length];
}

function makeBusIcon(color, isRunning) {
  const pulse = isRunning ? `
    <circle cx="16" cy="16" r="12" fill="${color}" fill-opacity="0.2">
      <animate attributeName="r" values="12;18;12" dur="2s" repeatCount="indefinite"/>
      <animate attributeName="fill-opacity" values="0.2;0;0.2" dur="2s" repeatCount="indefinite"/>
    </circle>` : "";
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
      ${pulse}
      <circle cx="16" cy="16" r="10" fill="${color}" stroke="white" stroke-width="2"/>
      <text x="16" y="20" text-anchor="middle" font-size="12" fill="white">🚌</text>
    </svg>`;
  return L.divIcon({
    html: svg,
    iconSize: [32, 32],
    iconAnchor: [16, 16],
    className: ""
  });
}

// ─── Map setup ────────────────────────────────────────────────────────────────
const DEFAULT_LAT = 15.8625695, DEFAULT_LNG = 74.4665375;

const map = L.map("map").setView([DEFAULT_LAT, DEFAULT_LNG], 14);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: "© OpenStreetMap contributors",
  maxZoom: 19
}).addTo(map);

// College gate marker (reference stop)
const COLLEGE_STOP = { lat: DEFAULT_LAT, lng: DEFAULT_LNG, name: "College Gate" };
L.marker([COLLEGE_STOP.lat, COLLEGE_STOP.lng], {
  icon: L.divIcon({
    html: `<div style="background:#1e293b;border:2px solid #3b82f6;border-radius:8px;
                padding:4px 8px;font-size:11px;font-weight:700;color:white;white-space:nowrap;">
              🏫 College Gate</div>`,
    className: "", iconAnchor: [40, 12]
  })
}).addTo(map);

// ─── State ────────────────────────────────────────────────────────────────────
let selectedBusId = null;
let allBuses      = [];
let allRoutes     = {};
const markers     = {};
let busColorMap   = {};
let routePolylines = {}; // routeId → L.polyline  (drawn on student map)
let activeRouteLine = null; // currently highlighted route

// ─── Socket ───────────────────────────────────────────────────────────────────
const socket = io();

socket.on("connect", () => console.log("Connected:", socket.id));
socket.on("connect_error", () => showToast("Connection lost", "error"));

// Initial data
socket.on("init", ({ buses, routes }) => {
  allBuses  = buses;
  allRoutes = routes || {};
  buses.forEach((b, i) => { busColorMap[b.id] = busColor(i); });
  renderBusList(buses);
  drawAllRoutes();
});

// Route updates from admin
socket.on("routeData", (routes) => {
  allRoutes = routes;
  drawAllRoutes();
});

// Draw all route polylines faintly on the student map
function drawAllRoutes() {
  Object.values(routePolylines).forEach(l => map.removeLayer(l));
  Object.keys(routePolylines).forEach(k => delete routePolylines[k]);
  Object.entries(allRoutes).forEach(([id, route]) => {
    const stops = route.stops || [];
    if (stops.length < 2) return;
    const ll = stops.map(s => [s.lat, s.lng]);
    routePolylines[id] = L.polyline(ll, {
      color: route.color || "#3b82f6", weight: 3, opacity: 0.35, dashArray: "6,4"
    }).addTo(map);
    // Add stop markers (small)
    stops.forEach(stop => {
      L.circleMarker([stop.lat, stop.lng], {
        radius: 5, fillColor: route.color || "#3b82f6", color: "#fff",
        weight: 1.5, fillOpacity: 0.9
      }).addTo(map).bindPopup(`<b>${stop.name}</b><br><small>${route.name}</small>`);
    });
  });
}

// Live updates
socket.on("busData", (buses) => {
  allBuses = buses;
  updateMarkers(buses);
  if (selectedBusId) updateInfoBar(buses.find(b => b.id === selectedBusId));
  renderBusList(buses);  // refresh status badges
});

// ─── Render bus list ──────────────────────────────────────────────────────────
function renderBusList(buses) {
  const container = document.getElementById("busList");
  if (!buses || buses.length === 0) {
    container.innerHTML = `<p style="color:var(--muted);font-size:13px;">No buses registered.</p>`;
    return;
  }
  container.innerHTML = buses.map(bus => {
    const color   = busColorMap[bus.id] || "#3b82f6";
    const active  = bus.id === selectedBusId ? "active" : "";
    const running = bus.status === "running";
    return `
      <div class="bus-item ${active}" onclick="selectBus('${bus.id}')">
        <span class="bus-icon" style="color:${color};">🚌</span>
        <div class="bus-info">
          <div class="bus-name">${bus.name || bus.id}</div>
          <div class="bus-route">${bus.route ? "Route: " + bus.route : "No route set"}</div>
        </div>
        <span class="badge ${running ? "badge-running" : "badge-stopped"}">
          ${running ? "●" : "○"}
        </span>
      </div>`;
  }).join("");
}

// ─── Select a bus ─────────────────────────────────────────────────────────────
// BUG FIX: This was the root of bus switching not working.
// Old code had selectedBus = "BUS1" (uppercase) but server used "bus1" (lowercase)
// and used a single `marker` variable that got overwritten.
function selectBus(id) {
  selectedBusId = id;
  const bus = allBuses.find(b => b.id === id);
  if (bus && bus.lat && bus.lng) {
    map.flyTo([bus.lat, bus.lng], 16, { duration: 1 });
  }

  // Highlight this bus's route
  Object.entries(routePolylines).forEach(([routeId, line]) => {
    const isActive = bus && bus.route === routeId;
    line.setStyle({ opacity: isActive ? 0.9 : 0.25, weight: isActive ? 5 : 3 });
  });

  renderBusList(allBuses);
  updateInfoBar(bus);
  showToast(`Tracking ${bus?.name || id}`, "success");
}

// ─── Update all markers ───────────────────────────────────────────────────────
function updateMarkers(buses) {
  buses.forEach(bus => {
    if (!bus.lat || !bus.lng) return;

    const color   = busColorMap[bus.id] || "#3b82f6";
    const running = bus.status === "running";
    const icon    = makeBusIcon(color, running);
    const popupHtml = `
      <b>${bus.name || bus.id}</b><br>
      ${statusBadge(bus.status)}<br>
      <small>Speed: ${bus.speed != null ? bus.speed.toFixed(1) + " km/h" : "—"}</small>`;

    if (!markers[bus.id]) {
      markers[bus.id] = L.marker([bus.lat, bus.lng], { icon })
        .addTo(map)
        .bindPopup(popupHtml)
        .on("click", () => selectBus(bus.id));
    } else {
      markers[bus.id].setLatLng([bus.lat, bus.lng]);
      markers[bus.id].setIcon(icon);
      markers[bus.id].setPopupContent(popupHtml);
    }
  });

  // Remove markers for buses that no longer exist
  Object.keys(markers).forEach(id => {
    if (!buses.find(b => b.id === id)) {
      map.removeLayer(markers[id]);
      delete markers[id];
    }
  });
}

// ─── Update info bar ──────────────────────────────────────────────────────────
function updateInfoBar(bus) {
  if (!bus) {
    document.getElementById("busName").textContent    = "—";
    document.getElementById("status").textContent     = "—";
    document.getElementById("speed").textContent      = "—";
    document.getElementById("dist").textContent       = "—";
    document.getElementById("eta").textContent        = "—";
    document.getElementById("lastUpdate").textContent = "—";
    return;
  }

  document.getElementById("busName").textContent = bus.name || bus.id;
  document.getElementById("status").innerHTML    = statusBadge(bus.status);
  document.getElementById("speed").textContent   =
    bus.speed != null ? bus.speed.toFixed(1) + " km/h" : "—";
  document.getElementById("lastUpdate").textContent = timeAgo(bus.lastUpdate);

  if (bus.lat && bus.lng) {
    const d   = haversine(bus.lat, bus.lng, COLLEGE_STOP.lat, COLLEGE_STOP.lng);
    const spd = (bus.speed && bus.speed > 0) ? bus.speed : 30; // default 30 km/h
    const eta = Math.round((d / spd) * 60);
    document.getElementById("dist").textContent = d.toFixed(2) + " km";
    document.getElementById("eta").textContent  = eta + " min";
  } else {
    document.getElementById("dist").textContent = "—";
    document.getElementById("eta").textContent  = "—";
  }
}

// Update "last update" clock every 10s
setInterval(() => {
  if (selectedBusId) {
    const bus = allBuses.find(b => b.id === selectedBusId);
    if (bus) document.getElementById("lastUpdate").textContent = timeAgo(bus.lastUpdate);
  }
}, 10000);