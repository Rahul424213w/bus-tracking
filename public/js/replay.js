// ─── Replay module ────────────────────────────────────────────────────────────
// Called from admin.html or a dedicated replay page.
// Requires: map (Leaflet instance), socket (Socket.IO)

(function () {
  let replayMarker  = null;
  let replayPath    = null;
  let replayData    = [];
  let replayIndex   = 0;
  let replayTimer   = null;
  let replaySpeed   = 500; // ms between steps
  let isPlaying     = false;

  function initReplayUI(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = `
      <div class="replay-bar">
        <label style="color:var(--muted);font-size:13px;white-space:nowrap;">Replay Bus:</label>
        <select class="input" id="replayBusSelect" style="width:160px;"></select>
        <button class="btn btn-primary" onclick="loadReplay()">Load</button>
        <button class="btn btn-success" id="replayPlayBtn" onclick="playReplay()" disabled>▶ Play</button>
        <button class="btn btn-ghost" id="replayPauseBtn" onclick="pauseReplay()" disabled>⏸ Pause</button>
        <button class="btn btn-ghost" id="replayResetBtn" onclick="resetReplay()" disabled>⏮ Reset</button>
        <input type="range" id="replaySlider" min="0" max="100" value="0"
          oninput="seekReplay(this.value)" style="flex:1;accent-color:var(--accent);" disabled>
        <span id="replayProgress" style="color:var(--muted);font-size:12px;white-space:nowrap;">—</span>
        <label style="color:var(--muted);font-size:13px;">Speed:</label>
        <select class="input" id="replaySpeedSel" style="width:90px;" onchange="setReplaySpeed(this.value)">
          <option value="1000">0.5×</option>
          <option value="500" selected>1×</option>
          <option value="250">2×</option>
          <option value="100">5×</option>
        </select>
      </div>`;
  }

  window.populateReplayBuses = function(buses) {
    const sel = document.getElementById("replayBusSelect");
    if (!sel) return;
    sel.innerHTML = "";
    buses.forEach(b => {
      const opt = document.createElement("option");
      opt.value = b.id; opt.textContent = b.name || b.id;
      sel.appendChild(opt);
    });
  };

  window.loadReplay = function() {
    const id = document.getElementById("replayBusSelect")?.value;
    if (!id) return;
    socket.emit("getHistory", id);
    socket.once("history", (data) => {
      if (!data || data.length === 0) {
        alert("No history for this bus yet.");
        return;
      }
      replayData  = data;
      replayIndex = 0;
      isPlaying   = false;
      if (replayTimer) clearInterval(replayTimer);

      // Draw full path on map
      if (replayPath) map.removeLayer(replayPath);
      const latlngs = data.map(p => [p.lat, p.lng]);
      replayPath = L.polyline(latlngs, { color: "#8b5cf6", weight: 3, opacity: 0.7 }).addTo(map);
      map.fitBounds(replayPath.getBounds(), { padding: [30, 30] });

      // Place marker at start
      if (!replayMarker) {
        replayMarker = L.marker(latlngs[0], {
          icon: L.divIcon({
            html: `<div style="font-size:22px;">🚌</div>`,
            className: "", iconAnchor: [11, 11]
          })
        }).addTo(map);
      } else {
        replayMarker.setLatLng(latlngs[0]);
      }

      // Update UI
      const slider = document.getElementById("replaySlider");
      slider.max   = data.length - 1;
      slider.value = 0;
      slider.disabled = false;
      document.getElementById("replayPlayBtn").disabled  = false;
      document.getElementById("replayResetBtn").disabled = false;
      updateReplayProgress(0);
    });
  };

  window.playReplay = function() {
    if (isPlaying || replayData.length === 0) return;
    isPlaying = true;
    document.getElementById("replayPlayBtn").disabled  = true;
    document.getElementById("replayPauseBtn").disabled = false;

    replayTimer = setInterval(() => {
      if (replayIndex >= replayData.length) {
        pauseReplay();
        return;
      }
      const p = replayData[replayIndex];
      replayMarker.setLatLng([p.lat, p.lng]);
      map.panTo([p.lat, p.lng], { animate: true, duration: 0.3 });
      document.getElementById("replaySlider").value = replayIndex;
      updateReplayProgress(replayIndex);
      replayIndex++;
    }, replaySpeed);
  };

  window.pauseReplay = function() {
    isPlaying = false;
    clearInterval(replayTimer);
    document.getElementById("replayPlayBtn").disabled  = false;
    document.getElementById("replayPauseBtn").disabled = true;
  };

  window.resetReplay = function() {
    pauseReplay();
    replayIndex = 0;
    if (replayData.length > 0) {
      replayMarker.setLatLng([replayData[0].lat, replayData[0].lng]);
      document.getElementById("replaySlider").value = 0;
      updateReplayProgress(0);
    }
  };

  window.seekReplay = function(val) {
    replayIndex = parseInt(val);
    if (replayData[replayIndex]) {
      const p = replayData[replayIndex];
      replayMarker.setLatLng([p.lat, p.lng]);
      updateReplayProgress(replayIndex);
    }
  };

  window.setReplaySpeed = function(ms) {
    replaySpeed = parseInt(ms);
    if (isPlaying) { pauseReplay(); playReplay(); }
  };

  function updateReplayProgress(i) {
    const el = document.getElementById("replayProgress");
    if (!el || !replayData[i]) return;
    const ts = new Date(replayData[i].time).toLocaleTimeString();
    el.textContent = `${i + 1} / ${replayData.length} · ${ts}`;
  }

  // Auto-init if container exists
  document.addEventListener("DOMContentLoaded", () => {
    initReplayUI("replayContainer");
  });
})();