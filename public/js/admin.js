// ─── Auth guard ───────────────────────────────────────────────────────────────
const adminToken = sessionStorage.getItem("adminToken");
if (!adminToken) location.href = "login-admin.html";

// ─── Utilities ────────────────────────────────────────────────────────────────
function showToast(msg, type="success") {
  const c = document.getElementById("toast-container");
  const t = document.createElement("div");
  t.className = `toast ${type}`;
  t.innerHTML = `<span>${type==="success"?"✅":"❌"}</span> ${msg}`;
  c.appendChild(t);
  setTimeout(() => {
    t.style.opacity="0"; t.style.transform="translateX(24px)";
    t.style.transition="all 0.25s"; setTimeout(()=>t.remove(),250);
  }, 3200);
}

function addLog(msg) {
  const box = document.getElementById("logBox");
  const ts  = new Date().toLocaleTimeString();
  box.innerHTML += `<div><span style="color:#475569;">[${ts}]</span> ${msg}</div>`;
  box.scrollTop  = box.scrollHeight;
}

function timeAgo(ts) {
  if (!ts) return "—";
  const s = Math.round((Date.now()-ts)/1000);
  if (s < 5) return "just now";
  if (s < 60) return s+"s ago";
  return Math.round(s/60)+"m ago";
}

function statusBadge(status) {
  const m = {
    running:     '<span class="badge badge-running badge-dot">Running</span>',
    stopped:     '<span class="badge badge-stopped badge-dot">Stopped</span>',
    maintenance: '<span class="badge badge-maintenance badge-dot">Maintenance</span>',
  };
  return m[status] || `<span class="badge">${status}</span>`;
}

// ─── Tabs ─────────────────────────────────────────────────────────────────────
function switchTab(name) {
  document.querySelectorAll(".tab-panel").forEach(p=>p.classList.remove("active"));
  document.querySelectorAll(".tab-btn").forEach(b=>b.classList.remove("active"));
  document.getElementById("tab-"+name).classList.add("active");
  document.getElementById("tabBtn"+name[0].toUpperCase()+name.slice(1)).classList.add("active");
  if (name==="routes") { setTimeout(()=>routeMap.invalidateSize(),50); renderRoutesOnMap(); }
}

// ─── Fleet map ────────────────────────────────────────────────────────────────
const map = L.map("map",{zoomControl:false}).setView([15.8625695,74.4665375],13);
L.control.zoom({position:"bottomright"}).addTo(map);

// ✅ Correct OSM tiles
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png",{
  attribution:'© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  maxZoom:19, crossOrigin:true
}).addTo(map);

const adminMarkers  = {};
const BUS_COLORS    = ["#2563EB","#059669","#D97706","#DC2626","#7C3AED","#0891B2","#EA580C","#BE185D"];
const SWATCH_COLORS = ["#2563EB","#059669","#D97706","#DC2626","#7C3AED","#0891B2","#EA580C","#BE185D","#65A30D","#0F172A"];
let colorIdx = 0;
const busColorMap = {};

function getBusColor(id) {
  if (!busColorMap[id]) busColorMap[id] = BUS_COLORS[colorIdx++%BUS_COLORS.length];
  return busColorMap[id];
}
function makeBusIconAdmin(color) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="34" height="40" viewBox="0 0 34 40">
    <ellipse cx="17" cy="38" rx="6" ry="2.5" fill="rgba(0,0,0,0.2)"/>
    <path d="M17 2 C9.8 2 4 7.8 4 15 C4 24 17 36 17 36 C17 36 30 24 30 15 C30 7.8 24.2 2 17 2Z" fill="${color}" stroke="white" stroke-width="2"/>
    <text x="17" y="19" text-anchor="middle" font-size="13" fill="white">🚌</text>
  </svg>`;
  return L.divIcon({html:svg, iconSize:[34,40], iconAnchor:[17,36], popupAnchor:[0,-36], className:""});
}

// ─── Route map ────────────────────────────────────────────────────────────────
const routeMap = L.map("routeMap",{zoomControl:false}).setView([15.8625695,74.4665375],14);
L.control.zoom({position:"bottomright"}).addTo(routeMap);

// ✅ Same correct tiles for route editor
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png",{
  attribution:'© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  maxZoom:19, crossOrigin:true
}).addTo(routeMap);

const routeMapLayers  = {};
let editingRouteId    = null;
let editingStops      = [];
let editorPolyline    = null;
let editorUnderline   = null;
let editorStopMarkers = [];
let isEditingRoute    = false;
let selectedColor     = "#2563EB";

// ─── Socket ───────────────────────────────────────────────────────────────────
const socket = io();
let allBuses  = [];
let allRoutes = {};

socket.on("connect", () => {
  socket.emit("auth",{token:adminToken},(res)=>{
    if (!res||!res.ok){
      showToast("Session expired","error");
      setTimeout(()=>location.href="login-admin.html",2000);
    } else { addLog("Connected as admin"); }
  });
});
socket.on("connect_error", ()=>showToast("Connection lost","error"));
socket.on("error",   (msg)=>{ showToast(msg,"error"); addLog("ERROR: "+msg); });
socket.on("adminLog",(msg)=>{ addLog(msg); showToast(msg); });

socket.on("init",({buses,routes})=>{
  allBuses=buses||[]; allRoutes=routes||{};
  renderFleet(allBuses); refreshRouteUI();
  addLog(`Loaded ${allBuses.length} bus(es), ${Object.keys(allRoutes).length} route(s)`);
});
socket.on("busData",(buses)=>{
  allBuses=buses; renderFleet(buses);
  document.getElementById("syncTime").textContent    = new Date().toLocaleTimeString();
  document.getElementById("lastRefresh").textContent = "Updated "+new Date().toLocaleTimeString();
});
socket.on("routeData",(routes)=>{ allRoutes=routes; refreshRouteUI(); addLog("Routes updated"); });
socket.on("routeSaved",({id,isNew})=>{ showToast(`Route "${id}" ${isNew?"created":"updated"} ✅`); cancelEdit(); renderRoutesOnMap(); });

// ─── Fleet ────────────────────────────────────────────────────────────────────
function renderFleet(buses) { updateStats(buses); updateTable(buses); updateFleetMapMarkers(buses); }

function updateStats(buses) {
  document.getElementById("statTotal").textContent   = buses.length;
  document.getElementById("statRunning").textContent = buses.filter(b=>b.status==="running").length;
  document.getElementById("statStopped").textContent = buses.filter(b=>b.status!=="running").length;
}

function updateTable(buses) {
  const tbody = document.getElementById("busTableBody");
  if (!buses||!buses.length) {
    tbody.innerHTML=`<tr><td colspan="7" style="color:var(--text-3);padding:28px;text-align:center;">No buses registered.</td></tr>`;
    return;
  }
  tbody.innerHTML = buses.map(bus=>{
    const color = getBusColor(bus.id);
    const rName = bus.route && allRoutes[bus.route]
      ? `<span style="display:inline-flex;align-items:center;gap:5px;">
           <span style="width:8px;height:8px;border-radius:50%;background:${allRoutes[bus.route].color||"#888"};display:inline-block;flex-shrink:0;"></span>
           ${allRoutes[bus.route].name}
         </span>`
      : (bus.route||"—");
    return `<tr>
      <td>
        <div style="display:flex;align-items:center;gap:9px;">
          <div style="width:28px;height:28px;border-radius:7px;background:${color}1A;display:flex;align-items:center;justify-content:center;">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <rect x="2" y="5" width="20" height="14" rx="3" fill="${color}"/>
              <rect x="5" y="8" width="4" height="4" rx="1" fill="white" opacity=".9"/>
              <rect x="10" y="8" width="4" height="4" rx="1" fill="white" opacity=".9"/>
              <rect x="15" y="8" width="4" height="4" rx="1" fill="white" opacity=".9"/>
            </svg>
          </div>
          <div>
            <div style="font-weight:600;font-size:13px;">${bus.name||bus.id}</div>
            <div style="font-size:10px;color:var(--text-3);font-family:'SF Mono',monospace;">${bus.id}</div>
          </div>
        </div>
      </td>
      <td>${rName}</td>
      <td>${statusBadge(bus.status)}</td>
      <td style="font-family:'Plus Jakarta Sans',sans-serif;font-weight:700;">${bus.speed!=null?bus.speed.toFixed(1)+" km/h":"—"}</td>
      <td style="font-size:11px;color:var(--text-3);">${bus.lat!=null?bus.lat.toFixed(5)+", "+bus.lng.toFixed(5):"No location"}</td>
      <td style="font-size:12px;color:var(--text-3);">${timeAgo(bus.lastUpdate)}</td>
      <td>
        <div style="display:flex;gap:5px;">
          <button class="btn btn-amber" style="padding:5px 9px;font-size:11px;" onclick="setStatus('${bus.id}','maintenance')" title="Maintenance">🔧</button>
          <button class="btn btn-danger" style="padding:5px 9px;font-size:11px;" onclick="confirmRemove('${bus.id}')" title="Remove">🗑</button>
        </div>
      </td>
    </tr>`;
  }).join("");
}

function updateFleetMapMarkers(buses) {
  buses.forEach(bus=>{
    if (!bus.lat||!bus.lng) return;
    const color = getBusColor(bus.id);
    const icon  = makeBusIconAdmin(color);
    const popup = `<div style="font-family:'Inter',sans-serif;min-width:150px;"><b style="font-size:13.5px;">${bus.name||bus.id}</b><br>${statusBadge(bus.status)}<br><small style="color:#94A3B8;">Speed: ${bus.speed!=null?bus.speed.toFixed(1)+" km/h":"—"}</small></div>`;
    if (!adminMarkers[bus.id]) {
      adminMarkers[bus.id]=L.marker([bus.lat,bus.lng],{icon}).addTo(map).bindPopup(popup);
    } else {
      adminMarkers[bus.id].setLatLng([bus.lat,bus.lng]);
      adminMarkers[bus.id].setIcon(icon);
      adminMarkers[bus.id].setPopupContent(popup);
    }
  });
  Object.keys(adminMarkers).forEach(id=>{
    if (!buses.find(b=>b.id===id)){ map.removeLayer(adminMarkers[id]); delete adminMarkers[id]; }
  });
}

// ─── Route UI ─────────────────────────────────────────────────────────────────
function refreshRouteUI() { renderRouteList(); renderRoutesOnMap(); populateRouteDropdowns(); buildColorSwatches(); }

function renderRouteList() {
  const el = document.getElementById("routeList");
  const ids = Object.keys(allRoutes);
  if (!ids.length) { el.innerHTML=`<div style="color:var(--text-3);font-size:13px;padding:6px 0;">No routes saved yet.</div>`; return; }
  el.innerHTML = ids.map(id=>{
    const r=allRoutes[id];
    return `<div class="route-list-item">
      <span class="route-color-dot" style="background:${r.color||"#888"};"></span>
      <div style="flex:1;min-width:0;">
        <div class="route-list-name">${r.name||id}</div>
        <div class="route-list-meta">${(r.stops||[]).length} stops · ${id}</div>
      </div>
      <div style="display:flex;gap:4px;">
        <button class="btn btn-ghost" style="padding:4px 8px;font-size:11px;" onclick="editRoute('${id}')">✏️</button>
        <button class="btn btn-danger" style="padding:4px 8px;font-size:11px;" onclick="deleteRoute('${id}')">🗑</button>
      </div>
    </div>`;
  }).join("");
}

// Google Maps style routes in the route editor
function renderRoutesOnMap() {
  Object.values(routeMapLayers).forEach(({polyline,underline,markers})=>{
    if (polyline)   routeMap.removeLayer(polyline);
    if (underline)  routeMap.removeLayer(underline);
    markers.forEach(m=>routeMap.removeLayer(m));
  });
  Object.keys(routeMapLayers).forEach(k=>delete routeMapLayers[k]);

  Object.entries(allRoutes).forEach(([id,route])=>{
    const stops   = route.stops||[];
    const color   = route.color||"#2563EB";
    const latlngs = stops.map(s=>[s.lat,s.lng]);
    const markers = [];
    let polyline=null, underline=null;

    if (latlngs.length>=2) {
      underline = L.polyline(latlngs,{color:"white",weight:11,opacity:0.5,lineCap:"round",lineJoin:"round"}).addTo(routeMap);
      polyline  = L.polyline(latlngs,{color,weight:7,opacity:0.9,lineCap:"round",lineJoin:"round"}).addTo(routeMap);
    }

    stops.forEach((stop,i)=>{
      const isEnd = i===0||i===stops.length-1;
      const icon  = isEnd
        ? L.divIcon({
            html:`<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28"><circle cx="14" cy="14" r="11" fill="white" stroke="${color}" stroke-width="3"/><circle cx="14" cy="14" r="5" fill="${color}"/></svg>`,
            iconSize:[28,28],iconAnchor:[14,14],popupAnchor:[0,-14],className:""
          })
        : L.divIcon({
            html:`<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="${color}" stroke="white" stroke-width="2"/><text x="12" y="16" text-anchor="middle" font-size="9" font-weight="700" fill="white" font-family="system-ui">${i+1}</text></svg>`,
            iconSize:[24,24],iconAnchor:[12,12],popupAnchor:[0,-12],className:""
          });
      const m=L.marker([stop.lat,stop.lng],{icon}).addTo(routeMap)
        .bindPopup(`<div style="font-family:'Inter',sans-serif;"><b>${stop.name||"Stop "+(i+1)}</b><br><small style="color:#94A3B8;">${route.name} · ${stop.lat.toFixed(5)}, ${stop.lng.toFixed(5)}</small></div>`);
      markers.push(m);
    });

    routeMapLayers[id]={polyline,underline,markers};
  });
}

function populateRouteDropdowns() {
  const ids=Object.keys(allRoutes);
  [
    {el:"newBusRoute",   def:"— None —"},
    {el:"assignRouteSelect", def:"Select route…"}
  ].forEach(({el,def})=>{
    const s=document.getElementById(el), prev=s.value;
    s.innerHTML=`<option value="">${def}</option>`+ids.map(id=>`<option value="${id}">${allRoutes[id].name||id}</option>`).join("");
    s.value=prev;
  });
  const ab=document.getElementById("assignBusSelect"), prevB=ab.value;
  ab.innerHTML=`<option value="">Select bus…</option>`+allBuses.map(b=>`<option value="${b.id}">${b.name||b.id}</option>`).join("");
  ab.value=prevB;
}

function buildColorSwatches() {
  const el=document.getElementById("colorSwatches"); if(!el)return;
  el.innerHTML=SWATCH_COLORS.map(c=>
    `<div class="swatch${c===selectedColor?" selected":""}" style="background:${c};" onclick="pickSwatch('${c}')" title="${c}"></div>`
  ).join("");
}
function pickSwatch(c){ selectedColor=c; document.getElementById("editRouteColor").value=c; buildColorSwatches(); refreshEditorPolyline(); }
function onColorInput(c){ selectedColor=c; document.querySelectorAll(".swatch").forEach(s=>s.classList.remove("selected")); refreshEditorPolyline(); }

// ─── Route editor ─────────────────────────────────────────────────────────────
function startNewRoute() {
  editingRouteId=null; editingStops=[]; selectedColor="#2563EB"; isEditingRoute=true;
  document.getElementById("editorTitle").textContent="✏️ New Route";
  document.getElementById("editRouteId").value=""; document.getElementById("editRouteId").disabled=false;
  document.getElementById("editRouteName").value=""; document.getElementById("editRouteColor").value=selectedColor;
  document.getElementById("routeEditorForm").style.display="block";
  document.getElementById("mapHint").classList.remove("hidden");
  buildColorSwatches(); clearEditorLayers(); renderStopList();
  switchTab("routes"); setTimeout(()=>routeMap.invalidateSize(),80);
}

function editRoute(id) {
  const r=allRoutes[id]; if(!r)return;
  editingRouteId=id; editingStops=JSON.parse(JSON.stringify(r.stops||[]));
  selectedColor=r.color||"#2563EB"; isEditingRoute=true;
  document.getElementById("editorTitle").textContent=`✏️ Editing: ${r.name||id}`;
  document.getElementById("editRouteId").value=id; document.getElementById("editRouteId").disabled=true;
  document.getElementById("editRouteName").value=r.name||""; document.getElementById("editRouteColor").value=selectedColor;
  document.getElementById("routeEditorForm").style.display="block";
  document.getElementById("mapHint").classList.remove("hidden");
  buildColorSwatches(); clearEditorLayers(); renderStopList(); refreshEditorPolyline();
  if (editingStops.length>=1)
    routeMap.fitBounds(L.latLngBounds(editingStops.map(s=>[s.lat,s.lng])),{padding:[40,40]});
}

function cancelEdit() {
  isEditingRoute=false; editingStops=[]; editingRouteId=null;
  document.getElementById("routeEditorForm").style.display="none";
  document.getElementById("mapHint").classList.add("hidden");
  clearEditorLayers(); renderRoutesOnMap();
}

routeMap.on("click",(e)=>{
  if (!isEditingRoute) return;
  editingStops.push({lat:e.latlng.lat,lng:e.latlng.lng,name:"Stop "+(editingStops.length+1)});
  renderStopList(); refreshEditorPolyline();
});

function renderStopList() {
  const el=document.getElementById("stopList");
  document.getElementById("stopCount").textContent=editingStops.length+" stop(s)";
  if (!editingStops.length) {
    el.innerHTML=`<div style="color:var(--text-3);font-size:12px;text-align:center;padding:16px;">Click on the map to add stops.</div>`;
    return;
  }
  el.innerHTML=editingStops.map((stop,i)=>`
    <div class="stop-item">
      <div class="stop-num">${i+1}</div>
      <input class="stop-name-input" value="${stop.name}" oninput="renameStop(${i},this.value)" placeholder="Stop name">
      <span class="stop-coords">${stop.lat.toFixed(4)},${stop.lng.toFixed(4)}</span>
      <button class="stop-del-btn" onclick="deleteStop(${i})">×</button>
    </div>`).join("");
}

function renameStop(i,n){ if(editingStops[i])editingStops[i].name=n; }
function deleteStop(i)  { editingStops.splice(i,1); renderStopList(); refreshEditorPolyline(); }

function refreshEditorPolyline() {
  clearEditorLayers();
  const color=selectedColor, latlngs=editingStops.map(s=>[s.lat,s.lng]);
  if (latlngs.length>=2) {
    editorUnderline = L.polyline(latlngs,{color:"white",weight:11,opacity:0.5,lineCap:"round",lineJoin:"round"}).addTo(routeMap);
    editorPolyline  = L.polyline(latlngs,{color,weight:7,opacity:0.9,lineCap:"round",lineJoin:"round"}).addTo(routeMap);
  }
  editorStopMarkers=editingStops.map((stop,i)=>{
    const isEnd=i===0||i===editingStops.length-1;
    const icon=isEnd
      ? L.divIcon({html:`<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28"><circle cx="14" cy="14" r="11" fill="white" stroke="${color}" stroke-width="3"/><circle cx="14" cy="14" r="5" fill="${color}"/></svg>`,iconSize:[28,28],iconAnchor:[14,14],className:""})
      : L.divIcon({html:`<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="${color}" stroke="white" stroke-width="2"/><text x="12" y="16" text-anchor="middle" font-size="9" font-weight="700" fill="white" font-family="system-ui">${i+1}</text></svg>`,iconSize:[24,24],iconAnchor:[12,12],className:""});
    return L.marker([stop.lat,stop.lng],{icon,draggable:true}).addTo(routeMap)
      .bindTooltip(stop.name||`Stop ${i+1}`)
      .on("dragend",e=>{
        const ll=e.target.getLatLng();
        editingStops[i].lat=ll.lat; editingStops[i].lng=ll.lng;
        renderStopList(); refreshEditorPolyline();
      });
  });
}

function clearEditorLayers() {
  if (editorPolyline)  { routeMap.removeLayer(editorPolyline);  editorPolyline=null; }
  if (editorUnderline) { routeMap.removeLayer(editorUnderline); editorUnderline=null; }
  editorStopMarkers.forEach(m=>routeMap.removeLayer(m));
  editorStopMarkers=[];
}

function saveRoute() {
  const id   =document.getElementById("editRouteId").value.trim().toLowerCase().replace(/\s+/g,"_");
  const name =document.getElementById("editRouteName").value.trim();
  const color=document.getElementById("editRouteColor").value;
  if (!id)   { showToast("Route ID required","error"); return; }
  if (!name) { showToast("Route Name required","error"); return; }
  if (editingStops.length<2) { showToast("Add at least 2 stops","error"); return; }
  socket.emit("saveRoute",{token:adminToken,id,name,color,stops:editingStops});
}
function deleteRoute(id) {
  if (!confirm(`Delete route "${allRoutes[id]?.name||id}"?\nBuses will be unassigned.`)) return;
  socket.emit("deleteRoute",{token:adminToken,id});
}
function assignRoute() {
  const busId=document.getElementById("assignBusSelect").value;
  const routeId=document.getElementById("assignRouteSelect").value;
  if (!busId){showToast("Select a bus","error");return;}
  socket.emit("assignRoute",{token:adminToken,busId,routeId});
}
function addBus() {
  const id=document.getElementById("newBusId").value.trim();
  const name=document.getElementById("newBusName").value.trim();
  const route=document.getElementById("newBusRoute").value;
  if (!id){showToast("Bus ID required","error");return;}
  socket.emit("addBus",{token:adminToken,id,name,route});
  ["newBusId","newBusName"].forEach(x=>document.getElementById(x).value="");
  document.getElementById("newBusRoute").value="";
}
function removeBus()         { const id=document.getElementById("removeBusId").value.trim(); if(!id){showToast("Enter a Bus ID","error");return;} confirmRemove(id); }
function confirmRemove(id)   { if(!confirm(`Remove bus "${id}"?`))return; socket.emit("removeBus",{token:adminToken,id}); document.getElementById("removeBusId").value=""; }
function setStatus(id,status){ socket.emit("setBusStatus",{token:adminToken,id,status}); }
function logout()            { fetch("/api/logout",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({token:adminToken})}).finally(()=>{ sessionStorage.removeItem("adminToken"); location.href="login-admin.html"; }); }