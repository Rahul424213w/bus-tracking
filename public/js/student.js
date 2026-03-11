// ─── Utilities ───────────────────────────────────────────────────────────────
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 +
    Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function timeAgo(ts) {
  if (!ts) return "—";
  const s = Math.round((Date.now()-ts)/1000);
  if (s < 5)  return "just now";
  if (s < 60) return s + "s ago";
  return Math.round(s/60) + "m ago";
}

function showToast(msg, type="success") {
  const c = document.getElementById("toast-container");
  const t = document.createElement("div");
  t.className = `toast ${type}`;
  t.innerHTML = `<span>${type==="success"?"✅":"❌"}</span> ${msg}`;
  c.appendChild(t);
  setTimeout(() => {
    t.style.opacity="0"; t.style.transform="translateX(24px)";
    t.style.transition="all 0.25s";
    setTimeout(()=>t.remove(), 250);
  }, 3200);
}

function statusBadge(status) {
  const m = {
    running:     '<span class="badge badge-running badge-dot">Running</span>',
    stopped:     '<span class="badge badge-stopped badge-dot">Stopped</span>',
    maintenance: '<span class="badge badge-maintenance badge-dot">Maintenance</span>',
  };
  return m[status] || `<span class="badge">${status}</span>`;
}

// ─── Bus colours (professional, distinct) ────────────────────────────────────
const BUS_COLORS = [
  "#2563EB",  // blue
  "#059669",  // emerald
  "#D97706",  // amber
  "#DC2626",  // red
  "#7C3AED",  // violet
  "#0891B2",  // cyan
  "#EA580C",  // orange
  "#BE185D",  // pink
];
function busColor(i) { return BUS_COLORS[i % BUS_COLORS.length]; }

// ─── Bus marker — clean, minimal pin like Google Maps ────────────────────────
function makeBusIcon(color, isRunning) {
  // Pin shape with bus icon inside
  const glow = isRunning
    ? `<circle cx="20" cy="20" r="16" fill="${color}" opacity="0.15"><animate attributeName="r" values="16;24;16" dur="2.5s" repeatCount="indefinite"/><animate attributeName="opacity" values="0.15;0;0.15" dur="2.5s" repeatCount="indefinite"/></circle>`
    : "";
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="40" height="48" viewBox="0 0 40 48">
      ${glow}
      <!-- Drop shadow -->
      <ellipse cx="20" cy="46" rx="8" ry="3" fill="rgba(0,0,0,0.25)"/>
      <!-- Pin body -->
      <path d="M20 2 C11.2 2 4 9.2 4 18 C4 28.5 20 44 20 44 C20 44 36 28.5 36 18 C36 9.2 28.8 2 20 2Z"
            fill="${color}" stroke="white" stroke-width="2"/>
      <!-- Bus icon (white text) -->
      <text x="20" y="22" text-anchor="middle" font-size="15" fill="white" font-family="system-ui">🚌</text>
    </svg>`;
  return L.divIcon({
    html: svg,
    iconSize: [40, 48],
    iconAnchor: [20, 44],   // tip of pin at bus position
    popupAnchor: [0, -44],
    className: ""
  });
}

// Stop dot marker — small numbered circle like Google Maps
function makeStopIcon(color, num) {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 26 26">
      <circle cx="13" cy="13" r="11" fill="${color}" stroke="white" stroke-width="2.5"/>
      <text x="13" y="17" text-anchor="middle" font-size="10" font-weight="700" fill="white" font-family="system-ui">${num}</text>
    </svg>`;
  return L.divIcon({
    html: svg,
    iconSize: [26,26], iconAnchor: [13,13], popupAnchor: [0,-13],
    className: ""
  });
}

// ─── Map setup ────────────────────────────────────────────────────────────────
const DEFAULT_LAT = 15.8625695, DEFAULT_LNG = 74.4665375;

const map = L.map("map", { zoomControl: false })
  .setView([DEFAULT_LAT, DEFAULT_LNG], 14);

L.control.zoom({ position: "bottomright" }).addTo(map);

// ✅ Correct English-language OSM tiles (no Korean/regional text)
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  maxZoom: 19,
  crossOrigin: true,
}).addTo(map);

// College gate — Google Maps style destination pin
const COLLEGE_STOP = { lat: DEFAULT_LAT, lng: DEFAULT_LNG, name: "College Gate" };
const collegeIcon = L.divIcon({
  html: `
    <div style="
      background:#111827;
      border:2px solid #2563EB;
      border-radius:10px;
      padding:5px 10px;
      font-size:11px;
      font-weight:700;
      color:white;
      white-space:nowrap;
      box-shadow:0 3px 12px rgba(37,99,235,.45);
      font-family:'Inter',sans-serif;
      display:flex;align-items:center;gap:5px;
    ">🏫 College Gate</div>`,
  className: "", iconAnchor: [52, 14]
});
L.marker([COLLEGE_STOP.lat, COLLEGE_STOP.lng], { icon: collegeIcon }).addTo(map);

// ─── State ────────────────────────────────────────────────────────────────────
let selectedBusId  = null;
let allBuses       = [];
let allRoutes      = {};
const markers      = {};
let busColorMap    = {};
const routeLayers  = {};  // routeId → { polyline, stops: [...L.Marker] }
let userMarker     = null;
let stopMarkers    = [];  // temp store of non-route stop markers

// ─── Socket ───────────────────────────────────────────────────────────────────
const socket = io();

socket.on("connect", () => {
  setConnStatus("live");
});
socket.on("connect_error", () => {
  setConnStatus("offline");
  showToast("Connection lost", "error");
});
socket.on("disconnect", () => {
  setConnStatus("connecting");
});

socket.on("init", ({ buses, routes }) => {
  allBuses  = buses;
  allRoutes = routes || {};
  buses.forEach((b, i) => { busColorMap[b.id] = busColor(i); });
  renderBusList(buses);
  updateQuickStats(buses);
  drawAllRoutes();
});

socket.on("routeData", (routes) => {
  allRoutes = routes;
  drawAllRoutes();
});

socket.on("busData", (buses) => {
  allBuses = buses;
  updateMarkers(buses);
  updateQuickStats(buses);
  if (selectedBusId) {
    const bus = buses.find(b => b.id === selectedBusId);
    updateInfoPanel(bus);
    updateSelectedBusCard(bus);
  }
  renderBusList(buses);
});

function setConnStatus(state) {
  const dot   = document.getElementById("connDot");
  const label = document.getElementById("connLabel");
  if (state === "live") {
    dot.style.background = "var(--green)"; dot.style.animation = "";
    label.textContent = "Live";
  } else if (state === "offline") {
    dot.style.background = "var(--red)"; dot.style.animation = "none";
    label.textContent = "Offline";
  } else {
    dot.style.background = "var(--amber)"; dot.style.animation = "none";
    label.textContent = "Connecting";
  }
}

// ─── Quick stats ──────────────────────────────────────────────────────────────
function updateQuickStats(buses) {
  document.getElementById("qsTotal").textContent   = buses.length;
  document.getElementById("qsRunning").textContent = buses.filter(b=>b.status==="running").length;
}

// ─── Render bus list ──────────────────────────────────────────────────────────
function renderBusList(buses) {
  const el = document.getElementById("busList");
  if (!buses || buses.length === 0) {
    el.innerHTML = `<div style="padding:24px 8px;text-align:center;color:var(--text-3);">
      <div style="font-size:28px;margin-bottom:8px;">🚌</div>
      <div style="font-weight:600;font-size:13px;color:var(--text-2);">No buses registered</div>
      <div style="font-size:11px;margin-top:3px;">Contact your admin</div>
    </div>`;
    return;
  }
  el.innerHTML = buses.map(bus => {
    const color   = busColorMap[bus.id] || "#2563EB";
    const active  = bus.id === selectedBusId ? "active" : "";
    const running = bus.status === "running";
    const rName   = allRoutes[bus.route]?.name || bus.route || "No route assigned";
    return `
      <div class="bus-item ${active}" onclick="selectBus('${bus.id}')">
        <div class="bus-icon-wrap" style="background:${color}1A;">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <rect x="2" y="5" width="20" height="14" rx="3" fill="${color}"/>
            <rect x="5" y="8" width="4" height="4" rx="1" fill="white" opacity=".9"/>
            <rect x="10" y="8" width="4" height="4" rx="1" fill="white" opacity=".9"/>
            <rect x="15" y="8" width="4" height="4" rx="1" fill="white" opacity=".9"/>
            <circle cx="7" cy="20" r="2" fill="${color}"/>
            <circle cx="17" cy="20" r="2" fill="${color}"/>
          </svg>
        </div>
        <div class="bus-info">
          <div class="bus-name">${bus.name || bus.id}</div>
          <div class="bus-meta">${rName}</div>
        </div>
        <span class="badge ${running?"badge-running":"badge-stopped"} badge-dot"
          style="font-size:10px;padding:2px 7px;"></span>
      </div>`;
  }).join("");
}

// ─── Select a bus ─────────────────────────────────────────────────────────────
function selectBus(id) {
  selectedBusId = id;
  const bus = allBuses.find(b => b.id === id);

  if (bus && bus.lat && bus.lng) {
    map.flyTo([bus.lat, bus.lng], 15, { duration: 1.2, easeLinearity: 0.3 });
  }

  // Highlight selected route — dim others
  Object.entries(routeLayers).forEach(([routeId, layers]) => {
    const active = bus && bus.route === routeId;
    if (layers.polyline) {
      layers.polyline.setStyle({
        opacity: active ? 1 : 0.15,
        weight:  active ? 7 : 3,
      });
    }
    layers.stops.forEach(m => {
      const el = m.getElement();
      if (el) el.style.opacity = active ? "1" : "0.25";
    });
  });

  renderBusList(allBuses);
  updateInfoPanel(bus);
  updateSelectedBusCard(bus);
  updateStopsStrip(bus);
}

// ─── Draw all routes — Google Maps navigation style ───────────────────────────
function drawAllRoutes() {
  // Clear old layers
  Object.values(routeLayers).forEach(({ polyline, stops }) => {
    if (polyline) map.removeLayer(polyline);
    stops.forEach(m => map.removeLayer(m));
  });
  Object.keys(routeLayers).forEach(k => delete routeLayers[k]);

  Object.entries(allRoutes).forEach(([id, route]) => {
    const stops  = route.stops || [];
    const color  = route.color || "#2563EB";
    const layers = { polyline: null, stops: [] };

    if (stops.length >= 2) {
      const latlngs = stops.map(s => [s.lat, s.lng]);

      // Google Maps style: thick white stroke underneath, coloured line on top
      L.polyline(latlngs, {
        color: "white", weight: 11, opacity: 0.5,
        lineCap: "round", lineJoin: "round"
      }).addTo(map);

      layers.polyline = L.polyline(latlngs, {
        color: color, weight: 7, opacity: 0.9,
        lineCap: "round", lineJoin: "round"
      }).addTo(map);

      // Direction arrows (Google Maps traffic-style arrowheads)
      const arrowDecorator = createArrows(latlngs, color);
      if (arrowDecorator) arrowDecorator.addTo(map);
    }

    // Stop markers
    stops.forEach((stop, i) => {
      const isFirst = i === 0, isLast = i === stops.length - 1;
      let icon;
      if (isFirst || isLast) {
        // Terminal stop — larger outlined circle
        icon = L.divIcon({
          html: `
            <svg xmlns="http://www.w3.org/2000/svg" width="30" height="30" viewBox="0 0 30 30">
              <circle cx="15" cy="15" r="12" fill="white" stroke="${color}" stroke-width="3"/>
              <circle cx="15" cy="15" r="6"  fill="${color}"/>
            </svg>`,
          iconSize: [30,30], iconAnchor: [15,15], popupAnchor: [0,-15],
          className: ""
        });
      } else {
        icon = makeStopIcon(color, i+1);
      }
      const m = L.marker([stop.lat, stop.lng], { icon })
        .addTo(map)
        .bindPopup(`
          <div style="font-family:'Inter',sans-serif;">
            <div style="font-weight:700;margin-bottom:4px;">${stop.name}</div>
            <div style="color:#94A3B8;font-size:11px;">${route.name}</div>
            ${isFirst ? '<div style="color:#10B981;font-size:11px;margin-top:4px;">🟢 Start</div>' : ""}
            ${isLast  ? '<div style="color:#EF4444;font-size:11px;margin-top:4px;">🔴 End</div>'   : ""}
          </div>`);
      layers.stops.push(m);
    });

    routeLayers[id] = layers;
  });
}

// Direction arrows along the route (like Google Maps)
function createArrows(latlngs, color) {
  if (latlngs.length < 2) return null;
  // Use SVG chevron markers along the polyline at intervals
  const arrows = [];
  const interval = 3; // every 3 points
  for (let i = interval; i < latlngs.length; i += interval) {
    const a = latlngs[i-1], b = latlngs[i];
    const angle = Math.atan2(b[1]-a[1], b[0]-a[0]) * 180/Math.PI;
    const midLat = (a[0]+b[0])/2, midLng = (a[1]+b[1])/2;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14">
      <polygon points="7,1 13,13 7,9 1,13" fill="white" opacity="0.9" transform="rotate(${angle+90},7,7)"/>
    </svg>`;
    const icon = L.divIcon({ html: svg, iconSize:[14,14], iconAnchor:[7,7], className:"" });
    arrows.push(L.marker([midLat, midLng], { icon, interactive: false }));
  }
  const group = L.layerGroup(arrows);
  return group;
}

// ─── Update bus markers ───────────────────────────────────────────────────────
function updateMarkers(buses) {
  buses.forEach(bus => {
    if (!bus.lat || !bus.lng) return;
    const color   = busColorMap[bus.id] || "#2563EB";
    const running = bus.status === "running";
    const icon    = makeBusIcon(color, running);
    const popup   = `
      <div style="font-family:'Inter',sans-serif;min-width:160px;">
        <div style="font-weight:700;font-size:14px;margin-bottom:6px;">${bus.name||bus.id}</div>
        ${statusBadge(bus.status)}
        <div style="margin-top:8px;font-size:12px;color:#94A3B8;">
          ${bus.speed!=null ? "🚀 "+bus.speed.toFixed(1)+" km/h" : "Speed: —"}
        </div>
        <div style="font-size:11px;color:#475569;margin-top:3px;">
          ${bus.route ? "Route: "+(allRoutes[bus.route]?.name||bus.route) : "No route"}
        </div>
      </div>`;

    if (!markers[bus.id]) {
      markers[bus.id] = L.marker([bus.lat, bus.lng], { icon, zIndexOffset: 1000 })
        .addTo(map)
        .bindPopup(popup)
        .on("click", () => selectBus(bus.id));
    } else {
      markers[bus.id].setLatLng([bus.lat, bus.lng]);
      markers[bus.id].setIcon(icon);
      markers[bus.id].setPopupContent(popup);
    }
  });

  // Remove stale markers
  Object.keys(markers).forEach(id => {
    if (!buses.find(b => b.id === id)) {
      map.removeLayer(markers[id]);
      delete markers[id];
    }
  });
}

// ─── Info panel ───────────────────────────────────────────────────────────────
function updateInfoPanel(bus) {
  if (!bus) {
    ["busName","speed","dist","eta","lastUpdate"].forEach(id=>{
      const el = document.getElementById(id);
      if (el) el.textContent = "—";
    });
    const st = document.getElementById("status");
    if (st) st.innerHTML = "—";
    return;
  }
  document.getElementById("busName").textContent    = bus.name || bus.id;
  document.getElementById("status").innerHTML       = statusBadge(bus.status);
  document.getElementById("speed").textContent      = bus.speed!=null ? bus.speed.toFixed(1)+" km/h" : "—";
  document.getElementById("lastUpdate").textContent = timeAgo(bus.lastUpdate);

  if (bus.lat && bus.lng) {
    const d   = haversine(bus.lat, bus.lng, COLLEGE_STOP.lat, COLLEGE_STOP.lng);
    const spd = (bus.speed && bus.speed > 0) ? bus.speed : 30;
    const eta = Math.round((d/spd)*60);
    document.getElementById("dist").textContent = d.toFixed(2)+" km";
    document.getElementById("eta").textContent  = eta+" min";
  } else {
    document.getElementById("dist").textContent = "—";
    document.getElementById("eta").textContent  = "—";
  }
}

// ─── Selected bus card ────────────────────────────────────────────────────────
function updateSelectedBusCard(bus) {
  const card = document.getElementById("selectedBusCard");
  if (!bus) { card.classList.remove("show"); return; }
  card.classList.add("show");

  const color = busColorMap[bus.id] || "#2563EB";
  document.getElementById("sbcIcon").style.background = `linear-gradient(135deg,${color},${color}BB)`;
  document.getElementById("sbcName").textContent  = bus.name || bus.id;
  document.getElementById("sbcRoute").textContent = allRoutes[bus.route]?.name || bus.route || "No route";
  document.getElementById("sbcBadge").innerHTML   = statusBadge(bus.status);
  document.getElementById("sbcSpeed").textContent = bus.speed!=null ? bus.speed.toFixed(1)+" km/h" : "—";

  if (bus.lat && bus.lng) {
    const d   = haversine(bus.lat, bus.lng, COLLEGE_STOP.lat, COLLEGE_STOP.lng);
    const spd = (bus.speed && bus.speed > 0) ? bus.speed : 30;
    const eta = Math.round((d/spd)*60);
    document.getElementById("sbcDist").textContent = d.toFixed(1)+" km";
    document.getElementById("sbcEta").textContent  = eta+" min";
    document.getElementById("sbcEtaBar").style.width =
      Math.max(5, Math.min(100, (1 - eta/60)*100)) + "%";
  } else {
    document.getElementById("sbcDist").textContent = "—";
    document.getElementById("sbcEta").textContent  = "—";
  }
}

// ─── Stops strip ──────────────────────────────────────────────────────────────
function updateStopsStrip(bus) {
  const strip = document.getElementById("stopsStrip");
  if (!bus || !bus.route || !allRoutes[bus.route]) {
    strip.innerHTML = `<div style="color:var(--text-3);font-size:12px;">No route assigned to this bus</div>`;
    return;
  }
  const route = allRoutes[bus.route];
  strip.innerHTML = (route.stops||[]).map((stop,i) =>
    `<div class="stop-chip">
      <div class="stop-dot ${i===0?"passed":""}"></div>
      <div class="stop-name">${stop.name}</div>
    </div>`
  ).join("");
}

// ─── Locate me ────────────────────────────────────────────────────────────────
function locateMe() {
  if (!navigator.geolocation) { showToast("Geolocation not supported","error"); return; }
  navigator.geolocation.getCurrentPosition(pos => {
    const { latitude:lat, longitude:lng } = pos.coords;
    const userIcon = L.divIcon({
      html:`<div style="width:14px;height:14px;background:#2563EB;border-radius:50%;border:2.5px solid white;box-shadow:0 0 10px rgba(37,99,235,.7);"></div>`,
      iconAnchor:[7,7], className:""
    });
    if (!userMarker) {
      userMarker = L.marker([lat,lng],{icon:userIcon}).addTo(map).bindPopup("📍 You are here");
    } else {
      userMarker.setLatLng([lat,lng]);
    }
    map.flyTo([lat,lng], 15, {duration:1});
    showToast("Found your location");
  }, () => showToast("Couldn't get your location","error"));
}

// ─── Clock ────────────────────────────────────────────────────────────────────
setInterval(() => {
  if (!selectedBusId) return;
  const bus = allBuses.find(b => b.id === selectedBusId);
  if (bus) document.getElementById("lastUpdate").textContent = timeAgo(bus.lastUpdate);
}, 10000);