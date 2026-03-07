const express = require("express");
const app     = express();
const http    = require("http").createServer(app);
const io      = require("socket.io")(http);
const fs      = require("fs");
const path    = require("path");
const crypto  = require("crypto");

// ─── Config ────────────────────────────────────────────────────────────────────
const DATA_DIR      = path.join(__dirname, "data");
const BUSES_FILE    = path.join(DATA_DIR, "buses.json");
const HISTORY_FILE  = path.join(DATA_DIR, "history.json");
const ROUTES_FILE   = path.join(DATA_DIR, "routes.json");
const SESSIONS_FILE = path.join(DATA_DIR, "sessions.json");

const MAX_HISTORY_PER_BUS = 500;
const SAVE_INTERVAL_MS    = 5000;

// ─── Password hashing ──────────────────────────────────────────────────────────
const ADMIN_PASS_HASH  = hashPassword("admin123");
const DRIVER_PASS_HASH = hashPassword("driver123");

function hashPassword(plain) {
  return crypto.createHash("sha256").update(plain).digest("hex");
}

// ─── Load data ─────────────────────────────────────────────────────────────────
function loadJSON(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    console.error(`Failed to load ${file}:`, e.message);
  }
  return fallback;
}

let buses    = loadJSON(BUSES_FILE,    []);
let history  = loadJSON(HISTORY_FILE,  {});
let routes   = loadJSON(ROUTES_FILE,   {});
let sessions = loadJSON(SESSIONS_FILE, {});

// ─── Debounced save ────────────────────────────────────────────────────────────
let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.writeFileSync(BUSES_FILE,    JSON.stringify(buses,    null, 2));
      fs.writeFileSync(HISTORY_FILE,  JSON.stringify(history,  null, 2));
      fs.writeFileSync(ROUTES_FILE,   JSON.stringify(routes,   null, 2));
      fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
    } catch (e) {
      console.error("Save error:", e.message);
    }
  }, SAVE_INTERVAL_MS);
}

// ─── Session helpers ───────────────────────────────────────────────────────────
function createSession(role) {
  const token = crypto.randomBytes(32).toString("hex");
  sessions[token] = { role, ts: Date.now() };
  scheduleSave();
  return token;
}

function getSession(token) {
  const s = sessions[token];
  if (!s) return null;
  if (Date.now() - s.ts > 12 * 60 * 60 * 1000) { delete sessions[token]; return null; }
  return s;
}

// ─── Middleware ────────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// ─── Auth REST endpoints ───────────────────────────────────────────────────────
app.post("/api/login", (req, res) => {
  const { role, password } = req.body || {};
  if (!role || !password) return res.json({ ok: false, error: "Missing fields" });
  const hash = hashPassword(password);
  if (role === "admin"  && hash === ADMIN_PASS_HASH)  return res.json({ ok: true, token: createSession("admin") });
  if (role === "driver" && hash === DRIVER_PASS_HASH) return res.json({ ok: true, token: createSession("driver") });
  return res.json({ ok: false, error: "Invalid credentials" });
});

app.post("/api/logout", (req, res) => {
  const { token } = req.body || {};
  if (token) delete sessions[token];
  res.json({ ok: true });
});

// ─── Socket.IO ─────────────────────────────────────────────────────────────────
io.on("connection", (socket) => {

  // Send full state on connect — includes routes now
  socket.emit("init", { buses, routes });

  // ── Auth ────────────────────────────────────────────────────────────────────
  socket.on("auth", ({ token }, ack) => {
    const session = getSession(token);
    if (!session) return ack && ack({ ok: false, error: "Invalid or expired session" });
    socket.session = session;
    ack && ack({ ok: true, role: session.role });
  });

  // ── Driver: start trip ──────────────────────────────────────────────────────
  socket.on("startTrip", ({ token, busId }) => {
    const session = getSession(token);
    if (!session || session.role !== "driver") return socket.emit("error", "Unauthorized");
    const bus = buses.find(b => b.id === busId);
    if (!bus) return socket.emit("error", "Bus not found");
    bus.status = "running";
    bus.driverSocket = socket.id;
    socket.driverBusId = busId;
    scheduleSave();
    io.emit("busData", buses);
    socket.emit("tripStarted", { busId });
  });

  // ── Driver: update location ─────────────────────────────────────────────────
  socket.on("updateLocation", ({ token, id, lat, lng, speed }) => {
    const session = getSession(token);
    if (!session || session.role !== "driver") return socket.emit("error", "Unauthorized");
    if (typeof lat !== "number" || typeof lng !== "number" ||
        lat < -90 || lat > 90 || lng < -180 || lng > 180)
      return socket.emit("error", "Invalid coordinates");
    const bus = buses.find(b => b.id === id);
    if (!bus) return socket.emit("error", "Bus not found");
    bus.lat = lat; bus.lng = lng;
    bus.speed  = typeof speed === "number" ? Math.max(0, speed) : null;
    bus.status = "running";
    bus.lastUpdate = Date.now();
    if (!history[id]) history[id] = [];
    history[id].push({ lat, lng, speed: bus.speed, time: Date.now() });
    if (history[id].length > MAX_HISTORY_PER_BUS)
      history[id] = history[id].slice(-MAX_HISTORY_PER_BUS);
    scheduleSave();
    io.emit("busData", buses);
  });

  // ── Driver: stop trip ───────────────────────────────────────────────────────
  socket.on("stopTrip", ({ token, id }) => {
    const session = getSession(token);
    if (!session || session.role !== "driver") return socket.emit("error", "Unauthorized");
    const bus = buses.find(b => b.id === id);
    if (bus) { bus.status = "stopped"; bus.speed = 0; bus.lastUpdate = Date.now(); }
    scheduleSave();
    io.emit("busData", buses);
  });

  // ── Admin: add bus ──────────────────────────────────────────────────────────
  socket.on("addBus", ({ token, id, name, route }) => {
    const session = getSession(token);
    if (!session || session.role !== "admin") return socket.emit("error", "Unauthorized");
    const cleanId = String(id).trim().toLowerCase().replace(/\s+/g, "_");
    if (!cleanId) return socket.emit("error", "Invalid bus ID");
    if (buses.find(b => b.id === cleanId)) return socket.emit("error", "Bus already exists");
    buses.push({
      id: cleanId, name: name || cleanId,
      route: route || null,
      lat: null, lng: null, status: "stopped", speed: 0, lastUpdate: null
    });
    scheduleSave();
    io.emit("busData", buses);
    socket.emit("adminLog", `Bus "${cleanId}" added`);
  });

  // ── Admin: remove bus ───────────────────────────────────────────────────────
  socket.on("removeBus", ({ token, id }) => {
    const session = getSession(token);
    if (!session || session.role !== "admin") return socket.emit("error", "Unauthorized");
    buses = buses.filter(b => b.id !== id);
    scheduleSave();
    io.emit("busData", buses);
    socket.emit("adminLog", `Bus "${id}" removed`);
  });

  // ── Admin: set bus status ───────────────────────────────────────────────────
  socket.on("setBusStatus", ({ token, id, status }) => {
    const session = getSession(token);
    if (!session || session.role !== "admin") return socket.emit("error", "Unauthorized");
    const allowed = ["running", "stopped", "maintenance"];
    if (!allowed.includes(status)) return socket.emit("error", "Invalid status");
    const bus = buses.find(b => b.id === id);
    if (bus) bus.status = status;
    scheduleSave();
    io.emit("busData", buses);
  });

  // ── Admin: save route (create or update) ────────────────────────────────────
  socket.on("saveRoute", ({ token, id, name, color, stops }) => {
    const session = getSession(token);
    if (!session || session.role !== "admin") return socket.emit("error", "Unauthorized");

    // Validate
    if (!id || typeof id !== "string") return socket.emit("error", "Invalid route ID");
    const cleanId = id.trim().toLowerCase().replace(/\s+/g, "_");
    if (!cleanId) return socket.emit("error", "Invalid route ID");
    if (!name || typeof name !== "string") return socket.emit("error", "Route name required");
    if (!Array.isArray(stops) || stops.length < 2) return socket.emit("error", "At least 2 stops required");

    // Validate each stop
    for (const s of stops) {
      if (typeof s.lat !== "number" || typeof s.lng !== "number" ||
          s.lat < -90 || s.lat > 90 || s.lng < -180 || s.lng > 180)
        return socket.emit("error", "Invalid stop coordinates");
    }

    const isNew = !routes[cleanId];
    routes[cleanId] = {
      name:  name.trim(),
      color: color || "#3b82f6",
      stops: stops.map(s => ({
        name: (s.name || "").trim() || "Stop",
        lat:  +s.lat.toFixed(7),
        lng:  +s.lng.toFixed(7)
      }))
    };

    scheduleSave();
    io.emit("routeData", routes);
    io.emit("busData", buses); // bus table shows route names

    const action = isNew ? "created" : "updated";
    socket.emit("adminLog", `Route "${cleanId}" ${action}`);
    showRouteSuccess(socket, cleanId, isNew);
  });

  // ── Admin: delete route ─────────────────────────────────────────────────────
  socket.on("deleteRoute", ({ token, id }) => {
    const session = getSession(token);
    if (!session || session.role !== "admin") return socket.emit("error", "Unauthorized");
    if (!routes[id]) return socket.emit("error", "Route not found");

    delete routes[id];

    // Unassign route from any buses that used it
    buses.forEach(bus => { if (bus.route === id) bus.route = null; });

    scheduleSave();
    io.emit("routeData", routes);
    io.emit("busData", buses);
    socket.emit("adminLog", `Route "${id}" deleted`);
  });

  // ── Admin: assign route to bus ──────────────────────────────────────────────
  socket.on("assignRoute", ({ token, busId, routeId }) => {
    const session = getSession(token);
    if (!session || session.role !== "admin") return socket.emit("error", "Unauthorized");
    const bus = buses.find(b => b.id === busId);
    if (!bus) return socket.emit("error", "Bus not found");
    if (routeId && !routes[routeId]) return socket.emit("error", "Route not found");
    bus.route = routeId || null;
    scheduleSave();
    io.emit("busData", buses);
    const msg = routeId
      ? `Route "${routeId}" assigned to ${busId}`
      : `Route unassigned from ${busId}`;
    socket.emit("adminLog", msg);
    showToastToSocket(socket, msg);
  });

  // ── History replay ──────────────────────────────────────────────────────────
  socket.on("getHistory", (id) => {
    const cleanId = String(id).trim().toLowerCase();
    socket.emit("history", history[cleanId] || []);
  });

  // ── Disconnect cleanup ──────────────────────────────────────────────────────
  socket.on("disconnect", () => {
    if (socket.driverBusId) {
      const bus = buses.find(b => b.id === socket.driverBusId);
      if (bus && bus.status === "running") {
        bus.status = "stopped";
        bus.lastUpdate = Date.now();
        scheduleSave();
        io.emit("busData", buses);
      }
    }
  });
});

// Helper: emit a toast back to the admin socket
function showToastToSocket(socket, msg) {
  // The adminLog event already triggers a toast in admin.js — no extra needed
}
function showRouteSuccess(socket, id, isNew) {
  socket.emit("routeSaved", { id, isNew });
}

// Listen for routeSaved in admin.js via socket.on("routeSaved")
// (handled client-side to close editor and show toast)

// ─── Periodic sync ─────────────────────────────────────────────────────────────
setInterval(() => { io.emit("busData", buses); }, 10000);

// ─── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
  console.log(`🚌 Bus Tracker running → http://localhost:${PORT}`);
});