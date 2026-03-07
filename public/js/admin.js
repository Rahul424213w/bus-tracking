// ─── Auth guard ───────────────────────────────────────────────────────────────
const adminToken = sessionStorage.getItem("adminToken");
if (!adminToken) location.href = "login-admin.html";

// ─── Shared utilities ─────────────────────────────────────────────────────────
function showToast(msg, type = "success") {
  const c = document.getElementById("toast-container");
  const t = document.createElement("div");
  t.className = `toast ${type}`;
  t.innerHTML = `<span>${type === "success" ? "✅" : "❌"}</span> ${msg}`;
  c.appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

function addLog(msg) {
  const box = document.getElementById("logBox");
  const ts  = new Date().toLocaleTimeString();
  box.innerHTML += `<div>[${ts}] ${msg}</div>`;
  box.scrollTop = box.scrollHeight;
}

function timeAgo(ts) {
  if (!ts) return "—";
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 5) return "just now";
  if (s < 60) return s + "s ago";
  return Math.round(s / 60) + "m ago";
}

function statusBadge(status) {
  const map = {
    running:     '<span class="badge badge-running">● Running</span>',
    stopped:     '<span class="badge badge-stopped">● Stopped</span>',
    maintenance: '<span class="badge badge-maintenance">● Maintenance</span>',
  };
  return map[status] || `<span class="badge">${status}</span>`;
}

// ─── Tab switching ────────────────────────────────────────────────────────────
function switchTab(name) {
  document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
  document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
  document.getElementById("tab-" + name).classList.add("active");
  document.getElementById("tabBtn" + name.charAt(0).toUpperCase() + name.slice(1))
    .classList.add("active");

  // Invalidate map size when switching to routes tab
  if (name === "routes") {
    setTimeout(() => routeMap.invalidateSize(), 50);
    renderRoutesOnMap();
  }
}

// ─── Fleet map ────────────────────────────────────────────────────────────────
const map = L.map("map").setView([15.8625695, 74.4665375], 13);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: "© OpenStreetMap contributors", maxZoom: 19
}).addTo(map);

const adminMarkers = {};
const BUS_COLORS   = ["#3b82f6","#10b981","#f59e0b","#ef4444","#8b5cf6","#06b6d4","#f97316","#ec4899"];
const SWATCH_COLORS = ["#3b82f6","#10b981","#f59e0b","#ef4444","#8b5cf6","#06b6d4","#f97316","#ec4899","#84cc16","#e11d48"];
let colorIdx = 0;
const busColorMap = {};

function getBusColor(id) {
  if (!busColorMap[id]) busColorMap[id] = BUS_COLORS[colorIdx++ % BUS_COLORS.length];
  return busColorMap[id];
}

function makeBusIcon(color) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28">
    <circle cx="14" cy="14" r="9" fill="${color}" stroke="white" stroke-width="2"/>
    <text x="14" y="18" text-anchor="middle" font-size="10" fill="white">🚌</text>
  </svg>`;
  return L.divIcon({ html: svg, iconSize: [28, 28], iconAnchor: [14, 14], className: "" });
}

// ─── Route map ────────────────────────────────────────────────────────────────
const routeMap = L.map("routeMap").setView([15.8625695, 74.4665375], 14);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: "© OpenStreetMap contributors", maxZoom: 19
}).addTo(routeMap);

// Layers for all saved routes on the route map
const routeMapLayers = {}; // routeId → { polyline, markers[] }

// Editor state
let editingRouteId  = null;   // null = new route
let editingStops    = [];     // [{ lat, lng, name }]
let editorPolyline  = null;
let editorStopMarkers = [];
let isEditingRoute  = false;
let selectedColor   = "#3b82f6";

// ─── Socket ───────────────────────────────────────────────────────────────────
const socket = io();
let allBuses  = [];
let allRoutes = {};

socket.on("connect", () => {
  socket.emit("auth", { token: adminToken }, (res) => {
    if (!res || !res.ok) {
      showToast("Session expired", "error");
      setTimeout(() => location.href = "login-admin.html", 2000);
    } else {
      addLog("Connected as admin");
    }
  });
});

socket.on("connect_error", () => showToast("Connection lost", "error"));
socket.on("error", (msg) => { showToast(msg, "error"); addLog("ERROR: " + msg); });
socket.on("adminLog", (msg) => { addLog(msg); showToast(msg); });

socket.on("init", ({ buses, routes }) => {
  allBuses  = buses  || [];
  allRoutes = routes || {};
  renderFleet(allBuses);
  refreshRouteUI();
  addLog(`Loaded ${allBuses.length} bus(es), ${Object.keys(allRoutes).length} route(s)`);
});

socket.on("busData", (buses) => {
  allBuses = buses;
  renderFleet(buses);
  document.getElementById("syncTime").textContent = new Date().toLocaleTimeString();
});

socket.on("routeData", (routes) => {
  allRoutes = routes;
  refreshRouteUI();
  addLog("Routes updated");
});

socket.on("routeSaved", ({ id, isNew }) => {
  showToast(`Route "${id}" ${isNew ? "created" : "updated"} ✅`);
  cancelEdit();       // close editor form
  renderRoutesOnMap(); // redraw fresh
});

// ─── Fleet rendering ──────────────────────────────────────────────────────────
function renderFleet(buses) {
  updateStats(buses);
  updateTable(buses);
  updateFleetMapMarkers(buses);
}

function updateStats(buses) {
  document.getElementById("statTotal").textContent   = buses.length;
  document.getElementById("statRunning").textContent = buses.filter(b => b.status === "running").length;
  document.getElementById("statStopped").textContent = buses.filter(b => b.status !== "running").length;
}

function updateTable(buses) {
  const tbody = document.getElementById("busTableBody");
  if (!buses || buses.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" style="color:var(--muted);padding:20px;">
      No buses registered.</td></tr>`;
    return;
  }
  tbody.innerHTML = buses.map(bus => {
    const routeName = bus.route && allRoutes[bus.route]
      ? `<span style="display:inline-flex;align-items:center;gap:5px;">
           <span style="width:8px;height:8px;border-radius:50%;
             background:${allRoutes[bus.route].color || "#888"};display:inline-block;"></span>
           ${allRoutes[bus.route].name}
         </span>`
      : (bus.route || '—');
    return `<tr>
      <td><code style="color:var(--accent);">${bus.id}</code></td>
      <td>${bus.name || "—"}</td>
      <td>${routeName}</td>
      <td>${statusBadge(bus.status)}</td>
      <td style="font-size:12px;color:var(--muted);">
        ${bus.lat != null ? bus.lat.toFixed(5) + ", " + bus.lng.toFixed(5) : "No location"}
      </td>
      <td style="font-size:12px;color:var(--muted);">${timeAgo(bus.lastUpdate)}</td>
      <td>
        <div style="display:flex;gap:6px;">
          <button class="btn btn-amber" style="padding:5px 10px;font-size:12px;"
            onclick="setStatus('${bus.id}','maintenance')">🔧</button>
          <button class="btn btn-danger" style="padding:5px 10px;font-size:12px;"
            onclick="confirmRemove('${bus.id}')">🗑</button>
        </div>
      </td>
    </tr>`;
  }).join("");
}

function updateFleetMapMarkers(buses) {
  buses.forEach(bus => {
    if (!bus.lat || !bus.lng) return;
    const color = getBusColor(bus.id);
    const icon  = makeBusIcon(color);
    if (!adminMarkers[bus.id]) {
      adminMarkers[bus.id] = L.marker([bus.lat, bus.lng], { icon })
        .addTo(map)
        .bindPopup(`<b>${bus.name || bus.id}</b><br>${statusBadge(bus.status)}`);
    } else {
      adminMarkers[bus.id].setLatLng([bus.lat, bus.lng]);
      adminMarkers[bus.id].setIcon(icon);
      adminMarkers[bus.id].setPopupContent(
        `<b>${bus.name || bus.id}</b><br>${statusBadge(bus.status)}`);
    }
  });
  Object.keys(adminMarkers).forEach(id => {
    if (!buses.find(b => b.id === id)) {
      map.removeLayer(adminMarkers[id]);
      delete adminMarkers[id];
    }
  });
}

// ─── Route UI refresh ─────────────────────────────────────────────────────────
function refreshRouteUI() {
  renderRouteList();
  renderRoutesOnMap();
  populateRouteDropdowns();
  buildColorSwatches();
}

// ─── Render saved-routes list ─────────────────────────────────────────────────
function renderRouteList() {
  const container = document.getElementById("routeList");
  const ids = Object.keys(allRoutes);
  if (ids.length === 0) {
    container.innerHTML = `<p style="color:var(--muted);font-size:13px;">No routes saved yet.</p>`;
    return;
  }
  container.innerHTML = ids.map(id => {
    const r = allRoutes[id];
    return `<div class="route-list-item" id="routeItem-${id}">
      <span class="route-color-dot" style="background:${r.color || '#888'};"></span>
      <div class="route-list-info">
        <div class="route-list-name">${r.name || id}</div>
        <div class="route-list-meta">${(r.stops || []).length} stop(s) · ID: ${id}</div>
      </div>
      <div style="display:flex;gap:4px;">
        <button class="btn btn-ghost" style="padding:4px 8px;font-size:11px;"
          onclick="editRoute('${id}')">✏️ Edit</button>
        <button class="btn btn-danger" style="padding:4px 8px;font-size:11px;"
          onclick="deleteRoute('${id}')">🗑</button>
      </div>
    </div>`;
  }).join("");
}

// ─── Draw all saved routes on the route map ───────────────────────────────────
function renderRoutesOnMap() {
  // Clear old layers
  Object.values(routeMapLayers).forEach(({ polyline, markers }) => {
    if (polyline) routeMap.removeLayer(polyline);
    markers.forEach(m => routeMap.removeLayer(m));
  });
  Object.keys(routeMapLayers).forEach(k => delete routeMapLayers[k]);

  Object.entries(allRoutes).forEach(([id, route]) => {
    const stops   = route.stops || [];
    const color   = route.color || "#3b82f6";
    const latlngs = stops.map(s => [s.lat, s.lng]);
    const markers = [];

    if (latlngs.length >= 2) {
      const poly = L.polyline(latlngs, { color, weight: 4, opacity: 0.8 }).addTo(routeMap);
      routeMapLayers[id] = { polyline: poly, markers };
    } else {
      routeMapLayers[id] = { polyline: null, markers };
    }

    stops.forEach((stop, i) => {
      const icon = L.divIcon({
        html: `<div style="background:${color};border:2px solid white;border-radius:50%;
                     width:20px;height:20px;display:flex;align-items:center;justify-content:center;
                     font-size:10px;font-weight:700;color:white;">${i + 1}</div>`,
        className: "", iconSize: [20, 20], iconAnchor: [10, 10]
      });
      const m = L.marker([stop.lat, stop.lng], { icon })
        .addTo(routeMap)
        .bindPopup(`<b>${stop.name || "Stop " + (i + 1)}</b><br>
          <small>${route.name}</small><br>
          <small>${stop.lat.toFixed(5)}, ${stop.lng.toFixed(5)}</small>`);
      markers.push(m);
    });
  });
}

// ─── Populate dropdowns ───────────────────────────────────────────────────────
function populateRouteDropdowns() {
  const ids = Object.keys(allRoutes);

  // new-bus-route dropdown
  const newBusRoute = document.getElementById("newBusRoute");
  const prevNew = newBusRoute.value;
  newBusRoute.innerHTML = `<option value="">— None —</option>` +
    ids.map(id => `<option value="${id}">${allRoutes[id].name || id}</option>`).join("");
  newBusRoute.value = prevNew;

  // assign route dropdown
  const assignRoute = document.getElementById("assignRouteSelect");
  const prevAssign  = assignRoute.value;
  assignRoute.innerHTML = `<option value="">Select route…</option>` +
    ids.map(id => `<option value="${id}">${allRoutes[id].name || id}</option>`).join("");
  assignRoute.value = prevAssign;

  // assign bus dropdown
  const assignBus = document.getElementById("assignBusSelect");
  const prevBus   = assignBus.value;
  assignBus.innerHTML = `<option value="">Select bus…</option>` +
    allBuses.map(b => `<option value="${b.id}">${b.name || b.id}</option>`).join("");
  assignBus.value = prevBus;
}

// ─── Color swatches ───────────────────────────────────────────────────────────
function buildColorSwatches() {
  const container = document.getElementById("colorSwatches");
  if (!container) return;
  container.innerHTML = SWATCH_COLORS.map(c =>
    `<div class="swatch${c === selectedColor ? " selected" : ""}"
       style="background:${c};"
       onclick="pickSwatch('${c}')" title="${c}"></div>`
  ).join("");
}

function pickSwatch(color) {
  selectedColor = color;
  document.getElementById("editRouteColor").value = color;
  buildColorSwatches();
  refreshEditorPolyline();
}

function onColorInput(color) {
  selectedColor = color;
  // Deselect swatches since user picked custom colour
  document.querySelectorAll(".swatch").forEach(s => s.classList.remove("selected"));
  refreshEditorPolyline();
}

// ─── Start new route ──────────────────────────────────────────────────────────
function startNewRoute() {
  editingRouteId = null;
  editingStops   = [];
  selectedColor  = "#3b82f6";
  isEditingRoute = true;

  document.getElementById("editorTitle").textContent = "✏️ New Route";
  document.getElementById("editRouteId").value       = "";
  document.getElementById("editRouteId").disabled    = false;
  document.getElementById("editRouteName").value     = "";
  document.getElementById("editRouteColor").value    = selectedColor;
  document.getElementById("routeEditorForm").style.display = "block";
  document.getElementById("mapHint").classList.remove("hidden");

  buildColorSwatches();
  clearEditorLayers();
  renderStopList();

  // Switch to routes tab if not already there
  switchTab("routes");
  setTimeout(() => routeMap.invalidateSize(), 80);
}

// ─── Edit existing route ──────────────────────────────────────────────────────
function editRoute(id) {
  const r = allRoutes[id];
  if (!r) return;

  editingRouteId = id;
  editingStops   = JSON.parse(JSON.stringify(r.stops || []));
  selectedColor  = r.color || "#3b82f6";
  isEditingRoute = true;

  document.getElementById("editorTitle").textContent     = `✏️ Editing: ${r.name || id}`;
  document.getElementById("editRouteId").value           = id;
  document.getElementById("editRouteId").disabled        = true; // can't rename ID
  document.getElementById("editRouteName").value         = r.name || "";
  document.getElementById("editRouteColor").value        = selectedColor;
  document.getElementById("routeEditorForm").style.display = "block";
  document.getElementById("mapHint").classList.remove("hidden");

  buildColorSwatches();
  clearEditorLayers();
  renderStopList();
  refreshEditorPolyline();

  // Fit map to stops
  if (editingStops.length >= 1) {
    const bounds = L.latLngBounds(editingStops.map(s => [s.lat, s.lng]));
    routeMap.fitBounds(bounds, { padding: [40, 40] });
  }
}

// ─── Cancel editing ───────────────────────────────────────────────────────────
function cancelEdit() {
  isEditingRoute = false;
  editingStops   = [];
  editingRouteId = null;

  document.getElementById("routeEditorForm").style.display = "none";
  document.getElementById("mapHint").classList.add("hidden");

  clearEditorLayers();
  renderRoutesOnMap(); // Restore saved routes
}

// ─── Map click → add stop ─────────────────────────────────────────────────────
routeMap.on("click", (e) => {
  if (!isEditingRoute) return;
  const stop = { lat: e.latlng.lat, lng: e.latlng.lng, name: "Stop " + (editingStops.length + 1) };
  editingStops.push(stop);
  renderStopList();
  refreshEditorPolyline();
});

// ─── Render stop list in editor ───────────────────────────────────────────────
function renderStopList() {
  const container = document.getElementById("stopList");
  document.getElementById("stopCount").textContent = editingStops.length + " stop(s)";

  if (editingStops.length === 0) {
    container.innerHTML = `<p style="color:var(--muted);font-size:12px;text-align:center;
      padding:12px;">Click on the map to add stops.</p>`;
    return;
  }

  container.innerHTML = editingStops.map((stop, i) => `
    <div class="stop-item" id="stopItem-${i}">
      <div class="stop-num">${i + 1}</div>
      <input class="stop-name-input" value="${stop.name}"
        oninput="renameStop(${i}, this.value)" placeholder="Stop name">
      <span class="stop-coords">${stop.lat.toFixed(4)},${stop.lng.toFixed(4)}</span>
      <button class="stop-del-btn" onclick="deleteStop(${i})" title="Remove stop">×</button>
    </div>`).join("");
}

function renameStop(i, name) {
  if (editingStops[i]) editingStops[i].name = name;
}

function deleteStop(i) {
  editingStops.splice(i, 1);
  renderStopList();
  refreshEditorPolyline();
}

// ─── Draw editor polyline + markers ──────────────────────────────────────────
function refreshEditorPolyline() {
  clearEditorLayers();

  const color   = selectedColor;
  const latlngs = editingStops.map(s => [s.lat, s.lng]);

  if (latlngs.length >= 2) {
    editorPolyline = L.polyline(latlngs, { color, weight: 4, opacity: 0.9, dashArray: "8,4" })
      .addTo(routeMap);
  }

  editorStopMarkers = editingStops.map((stop, i) => {
    const icon = L.divIcon({
      html: `<div style="background:${color};border:2px solid white;border-radius:50%;
               width:22px;height:22px;display:flex;align-items:center;justify-content:center;
               font-size:11px;font-weight:700;color:white;cursor:move;">${i + 1}</div>`,
      className: "", iconSize: [22, 22], iconAnchor: [11, 11]
    });
    return L.marker([stop.lat, stop.lng], { icon, draggable: true })
      .addTo(routeMap)
      .bindTooltip(stop.name || `Stop ${i + 1}`, { permanent: false })
      .on("dragend", (e) => {
        const ll = e.target.getLatLng();
        editingStops[i].lat = ll.lat;
        editingStops[i].lng = ll.lng;
        renderStopList();
        refreshEditorPolyline();
      });
  });
}

function clearEditorLayers() {
  if (editorPolyline) { routeMap.removeLayer(editorPolyline); editorPolyline = null; }
  editorStopMarkers.forEach(m => routeMap.removeLayer(m));
  editorStopMarkers = [];
}

// ─── Save route ───────────────────────────────────────────────────────────────
function saveRoute() {
  const id    = document.getElementById("editRouteId").value.trim()
                  .toLowerCase().replace(/\s+/g, "_");
  const name  = document.getElementById("editRouteName").value.trim();
  const color = document.getElementById("editRouteColor").value;

  if (!id)   { showToast("Route ID is required", "error"); return; }
  if (!name) { showToast("Route Name is required", "error"); return; }
  if (editingStops.length < 2) {
    showToast("Add at least 2 stops on the map", "error"); return;
  }

  socket.emit("saveRoute", {
    token: adminToken,
    id,
    name,
    color,
    stops: editingStops
  });
}

// ─── Delete route ─────────────────────────────────────────────────────────────
function deleteRoute(id) {
  if (!confirm(`Delete route "${allRoutes[id]?.name || id}"?\nBuses on this route will be unassigned.`)) return;
  socket.emit("deleteRoute", { token: adminToken, id });
}

// ─── Assign route to bus ──────────────────────────────────────────────────────
function assignRoute() {
  const busId   = document.getElementById("assignBusSelect").value;
  const routeId = document.getElementById("assignRouteSelect").value;
  if (!busId)   { showToast("Select a bus", "error"); return; }
  socket.emit("assignRoute", { token: adminToken, busId, routeId });
}

// ─── Fleet actions ────────────────────────────────────────────────────────────
function addBus() {
  const id    = document.getElementById("newBusId").value.trim();
  const name  = document.getElementById("newBusName").value.trim();
  const route = document.getElementById("newBusRoute").value;
  if (!id) { showToast("Bus ID required", "error"); return; }
  socket.emit("addBus", { token: adminToken, id, name, route });
  document.getElementById("newBusId").value    = "";
  document.getElementById("newBusName").value  = "";
  document.getElementById("newBusRoute").value = "";
}

function removeBus() {
  const id = document.getElementById("removeBusId").value.trim();
  if (!id) { showToast("Enter a bus ID to remove", "error"); return; }
  confirmRemove(id);
}

function confirmRemove(id) {
  if (!confirm(`Remove bus "${id}"? This cannot be undone.`)) return;
  socket.emit("removeBus", { token: adminToken, id });
  document.getElementById("removeBusId").value = "";
}

function setStatus(id, status) {
  socket.emit("setBusStatus", { token: adminToken, id, status });
}

function logout() {
  fetch("/api/logout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: adminToken })
  }).finally(() => {
    sessionStorage.removeItem("adminToken");
    location.href = "login-admin.html";
  });
}