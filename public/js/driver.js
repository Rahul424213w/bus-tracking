// ─── Auth guard ───────────────────────────────────────────────────────────────
const driverToken = sessionStorage.getItem("driverToken");
if (!driverToken) location.href = "login-driver.html";

// ─── Utilities ────────────────────────────────────────────────────────────────
function showToast(msg, type = "success") {
  const c = document.getElementById("toast-container");
  const t = document.createElement("div");
  t.className = `toast ${type}`;
  t.innerHTML = `<span>${type === "success" ? "✅" : "❌"}</span> ${msg}`;
  c.appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

// ─── Map setup ────────────────────────────────────────────────────────────────
const map = L.map("map").setView([15.8625695, 74.4665375], 14);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: "© OpenStreetMap contributors", maxZoom: 19
}).addTo(map);

// ─── State ────────────────────────────────────────────────────────────────────
let tracking    = false;
let selectedBus = null;   // The bus object the driver selected
let watchId     = null;   // navigator.geolocation watchPosition ID
let driverMarker = null;

// ─── Socket ───────────────────────────────────────────────────────────────────
const socket = io();

socket.on("connect", () => {
  // Authenticate socket
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
  showToast(`Trip started for ${busId}`);
  document.getElementById("startBtn").disabled = true;
  document.getElementById("stopBtn").disabled  = false;
  document.getElementById("busSelect").disabled = true;
});

// Populate bus dropdown
socket.on("init", ({ buses }) => {
  const sel = document.getElementById("busSelect");
  sel.innerHTML = `<option value="">— Select your bus —</option>`;
  buses.forEach(b => {
    const opt = document.createElement("option");
    opt.value = b.id;
    opt.textContent = b.name || b.id;
    sel.appendChild(opt);
  });
});

// ─── Bus selection changed ────────────────────────────────────────────────────
function onBusChange() {
  const id = document.getElementById("busSelect").value;
  selectedBus = id || null;
  document.getElementById("startBtn").disabled = !selectedBus || tracking;
}

// ─── Start trip ───────────────────────────────────────────────────────────────
function startTrip() {
  if (!selectedBus) { showToast("Select a bus first", "error"); return; }
  if (!navigator.geolocation) {
    showToast("Geolocation not supported by this browser", "error");
    return;
  }

  tracking = true;
  document.getElementById("startBtn").disabled = true;
  document.getElementById("gpsStatus").textContent = "Acquiring…";

  // Tell server trip started
  socket.emit("startTrip", { token: driverToken, busId: selectedBus });

  // Watch GPS position
  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      const lat   = pos.coords.latitude;
      const lng   = pos.coords.longitude;
      const speed = pos.coords.speed != null
        ? pos.coords.speed * 3.6  // m/s → km/h
        : null;

      // Update marker on driver's own map
      if (!driverMarker) {
        driverMarker = L.marker([lat, lng]).addTo(map)
          .bindPopup(`<b>${selectedBus}</b><br>Your location`).openPopup();
      } else {
        driverMarker.setLatLng([lat, lng]);
      }
      map.setView([lat, lng], 16);

      // Update displays
      document.getElementById("gpsStatus").textContent = "✅ Active";
      document.getElementById("driverSpeed").textContent =
        speed != null ? speed.toFixed(1) + " km/h" : "—";

      // Emit to server
      socket.emit("updateLocation", {
        token: driverToken,
        id: selectedBus,
        lat, lng,
        speed: speed || 0
      });
    },
    (err) => {
      document.getElementById("gpsStatus").textContent = "❌ Error";
      if (err.code === 1) showToast("GPS permission denied. Enable location.", "error");
      else if (err.code === 2) showToast("GPS position unavailable", "error");
      else showToast("GPS timeout", "error");
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
  );
}

// ─── Stop trip ────────────────────────────────────────────────────────────────
function stopTrip() {
  if (!tracking) return;
  tracking = false;

  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }

  socket.emit("stopTrip", { token: driverToken, id: selectedBus });

  document.getElementById("startBtn").disabled  = false;
  document.getElementById("stopBtn").disabled   = true;
  document.getElementById("busSelect").disabled = false;
  document.getElementById("gpsStatus").textContent  = "—";
  document.getElementById("driverSpeed").textContent = "—";

  showToast("Trip ended. Location sharing stopped.");
}

// ─── Logout ───────────────────────────────────────────────────────────────────
function logout() {
  if (tracking) stopTrip();
  fetch("/api/logout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: driverToken })
  }).finally(() => {
    sessionStorage.removeItem("driverToken");
    location.href = "login-driver.html";
  });
}

// Stop sharing if page is closed/refreshed
window.addEventListener("beforeunload", () => {
  if (tracking && selectedBus) {
    socket.emit("stopTrip", { token: driverToken, id: selectedBus });
  }
});