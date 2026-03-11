// ─── Auth guard ───────────────────────────────────────────────────────────────
const driverToken = sessionStorage.getItem("driverToken");
if (!driverToken) location.href = "login-driver.html";

// ─── Utilities ────────────────────────────────────────────────────────────────
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

// ─── Map setup ────────────────────────────────────────────────────────────────
const map = L.map("map", { zoomControl: false })
  .setView([15.8625695, 74.4665375], 14);
L.control.zoom({ position: "bottomright" }).addTo(map);

// ✅ Correct OpenStreetMap tiles — English labels worldwide
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  maxZoom: 19,
  crossOrigin: true,
}).addTo(map);

// ─── State ────────────────────────────────────────────────────────────────────
let tracking      = false;
let selectedBus   = null;
let watchId       = null;
let driverMarker  = null;
let tripStartTime = null;
let durationInterval = null;

// ─── Socket ───────────────────────────────────────────────────────────────────
const socket = io();

socket.on("connect", () => {
  socket.emit("auth", { token: driverToken }, (res) => {
    if (!res || !res.ok) {
      showToast("Session expired, please login again", "error");
      setTimeout(() => location.href = "login-driver.html", 2000);
    }
  });
});

socket.on("connect_error", () => showToast("Connection lost", "error"));
socket.on("error", (msg) => showToast(msg, "error"));

socket.on("tripStarted", ({ busId }) => {
  showToast(`Trip started for ${busId}`, "success");
  document.getElementById("startBtn").disabled   = true;
  document.getElementById("stopBtn").disabled    = false;
  document.getElementById("busSelect").disabled  = true;
  document.getElementById("tripBanner").style.display = "flex";
  document.getElementById("speedDisplay").classList.add("show");
});

socket.on("init", ({ buses, routes }) => {
  // Populate bus dropdown
  const sel = document.getElementById("busSelect");
  sel.innerHTML = `<option value="">— Select your bus —</option>`;
  buses.forEach(b => {
    const opt = document.createElement("option");
    opt.value = b.id;
    opt.textContent = b.name || b.id;
    sel.appendChild(opt);
  });

  // Draw all routes on the driver map — Google Maps navigation style
  if (routes) {
    Object.values(routes).forEach(route => {
      const stops = route.stops || [];
      if (stops.length < 2) return;
      const ll    = stops.map(s => [s.lat, s.lng]);
      const color = route.color || "#2563EB";
      // White underline + coloured route line
      L.polyline(ll, { color:"white", weight:10, opacity:0.4, lineCap:"round", lineJoin:"round" }).addTo(map);
      L.polyline(ll, { color, weight:6, opacity:0.7, lineCap:"round", lineJoin:"round" }).addTo(map);
    });
  }
});

// ─── Bus selection ────────────────────────────────────────────────────────────
function onBusChange() {
  const id = document.getElementById("busSelect").value;
  selectedBus = id || null;
  document.getElementById("startBtn").disabled = !selectedBus || tracking;
  document.getElementById("driverBusLabel").textContent = id || "—";
}

// ─── Start trip ───────────────────────────────────────────────────────────────
function startTrip() {
  if (!selectedBus) { showToast("Select a bus first","error"); return; }
  if (!navigator.geolocation) { showToast("Geolocation not supported","error"); return; }

  tracking      = true;
  tripStartTime = Date.now();
  document.getElementById("startBtn").disabled = true;
  document.getElementById("gpsStatus").textContent = "Acquiring…";

  durationInterval = setInterval(() => {
    const e = Math.floor((Date.now()-tripStartTime)/1000);
    const m = Math.floor(e/60), s = e%60;
    document.getElementById("driverDuration").textContent = `${m}:${s.toString().padStart(2,"0")}`;
  }, 1000);

  socket.emit("startTrip", { token: driverToken, busId: selectedBus });

  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      const { latitude:lat, longitude:lng, speed:rawSpeed } = pos.coords;
      const speed = rawSpeed != null ? rawSpeed * 3.6 : null;

      // Driver marker — green location dot
      const driverIcon = L.divIcon({
        html:`<div style="width:18px;height:18px;background:#10B981;border-radius:50%;border:3px solid white;box-shadow:0 0 14px rgba(16,185,129,.7);"></div>`,
        iconAnchor:[9,9], className:""
      });
      if (!driverMarker) {
        driverMarker = L.marker([lat,lng],{icon:driverIcon,zIndexOffset:2000})
          .addTo(map)
          .bindPopup(`<b>${selectedBus}</b><br>Your location`)
          .openPopup();
      } else {
        driverMarker.setLatLng([lat,lng]);
      }
      map.setView([lat,lng], 16, { animate:true });

      // Update panel
      document.getElementById("gpsStatus").textContent       = "✅ Active";
      document.getElementById("driverSpeed").textContent     = speed!=null ? speed.toFixed(1)+" km/h" : "—";
      document.getElementById("speedBig").textContent        = Math.round(speed||0);
      document.getElementById("driverCoords").textContent    = lat.toFixed(5)+", "+lng.toFixed(5);

      socket.emit("updateLocation", {
        token: driverToken, id: selectedBus, lat, lng, speed: speed||0
      });
    },
    (err) => {
      document.getElementById("gpsStatus").textContent = "❌ Error";
      if (err.code===1)      showToast("GPS permission denied. Enable location.","error");
      else if (err.code===2) showToast("GPS position unavailable","error");
      else                   showToast("GPS timeout","error");
    },
    { enableHighAccuracy:true, timeout:15000, maximumAge:0 }
  );
}

// ─── Stop trip ────────────────────────────────────────────────────────────────
function stopTrip() {
  if (!tracking) return;
  tracking = false;

  if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
  if (durationInterval) { clearInterval(durationInterval); durationInterval = null; }

  socket.emit("stopTrip", { token: driverToken, id: selectedBus });

  document.getElementById("startBtn").disabled   = false;
  document.getElementById("stopBtn").disabled    = true;
  document.getElementById("busSelect").disabled  = false;
  document.getElementById("gpsStatus").textContent      = "—";
  document.getElementById("driverSpeed").textContent    = "— km/h";
  document.getElementById("speedBig").textContent       = "0";
  document.getElementById("driverCoords").textContent   = "—";
  document.getElementById("driverDuration").textContent = "—";
  document.getElementById("tripBanner").style.display   = "none";
  document.getElementById("speedDisplay").classList.remove("show");

  showToast("Trip ended. Location sharing stopped.");
}

// ─── Logout ───────────────────────────────────────────────────────────────────
function logout() {
  if (tracking) stopTrip();
  fetch("/api/logout",{
    method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({token:driverToken})
  }).finally(() => {
    sessionStorage.removeItem("driverToken");
    location.href = "login-driver.html";
  });
}

window.addEventListener("beforeunload", () => {
  if (tracking && selectedBus)
    socket.emit("stopTrip", { token:driverToken, id:selectedBus });
});