(() => {
  "use strict";

  const objects = [
    {
      name: "Cigarette and ashtray",
      file: "fixedcig+animation.glb",
      latitude: 40.000680,
      longitude: -83.011150,
      delay: 0,
      repetitions: 3,
      primary: "Cube.003Action",
      width: 0.22,
    },
    {
      name: "Laptop",
      file: "animatedLaptop.glb",
      latitude: 40.000638,
      longitude: -83.011154,
      delay: 4000,
      width: 0.35,
      repetitions: Infinity,
    },
  ];

  const unlockRadius = 15;
  const maxGpsError = 30;
  const modes = new URLSearchParams(window.location.search);
  const preview = modes.has("preview");
  const scout = !preview && modes.has("scout");
  const demo = !preview && !scout && modes.has("fake");

  const byId = (id) => document.getElementById(id);
  const startButton = byId("go");
  const nearbyButton = byId("open-nearby");
  const closeButton = byId("close-model");
  const retryButton = byId("retry-model");
  const markButton = byId("mark");
  const status = byId("status");
  const coords = byId("coords");
  const stage = byId("object-stage");
  const models = byId("models");
  const arButton = byId("launch-ar");
  let cameraTools;

  const discovered = new Set();
  let lastPosition = null;
  let gpsWatch = null;
  let demoTimer = null;
  let active = null;
  let waitForTap = false;

  startButton.addEventListener("click", start);
  closeButton.addEventListener("click", close);
  retryButton.addEventListener("click", () => {
    if (active) open(active.object, true);
  });
  nearbyButton.addEventListener("click", () => {
    if (!lastPosition) return;
    waitForTap = false;
    updateExplore(lastPosition);
  });
  markButton.addEventListener("click", saveSpot);

  if (preview) {
    document.body.classList.add("preview");
    open(objects[Number(modes.get("preview")) - 1] ?? objects[0]);
  } else if (scout) {
    document.querySelector("h1").textContent = "Scout the Oval";
    document.querySelector("#panel p").textContent = "Walk around and mark the spots you like.";
  }

  function start() {
    if (startButton.hidden) return;
    startButton.hidden = true;
    if (demo) {
      startDemo();
      return;
    }
    if (!window.isSecureContext) {
      showGpsError({ message: "Open the HTTPS version to use GPS." });
      return;
    }
    if (!navigator.geolocation) {
      showGpsError({ message: "Location access is unavailable in this browser." });
      return;
    }
    if (scout) {
      byId("scout").classList.add("on");
      showSpots();
    }
    status.textContent = "Waiting for GPS…";
    gpsWatch = navigator.geolocation.watchPosition(
      ({ coords: position }) => scout ? updateScout(position) : updateExplore(position),
      showGpsError,
      { enableHighAccuracy: true, timeout: 15000 },
    );
  }

  function stopGps() {
    if (gpsWatch === null) return;
    navigator.geolocation.clearWatch(gpsWatch);
    gpsWatch = null;
  }

  function showGpsError({ message }) {
    stopGps();
    lastPosition = null;
    coords.textContent = "";
    nearbyButton.hidden = true;
    markButton.disabled = true;
    status.textContent = "GPS error: " + message;
    startButton.textContent = "Try again";
    startButton.hidden = false;
  }

  function updateExplore(position, candidates = objects) {
    lastPosition = position;
    coords.textContent = `you: ${formatCoordinates(position)} · ±${Math.round(position.accuracy)} m`;
    if (active) return;

    nearbyButton.hidden = true;
    let nearest = null;
    for (const object of candidates) {
      if (discovered.has(object)) continue;
      const distance = distanceBetween(position, object);
      if (!nearest || distance < nearest.distance) nearest = { object, distance };
    }

    if (!nearest) {
      finish();
    } else if (position.accuracy > maxGpsError) {
      status.textContent = "Waiting for a more accurate GPS fix…";
    } else if (nearest.distance > unlockRadius) {
      waitForTap = false;
      status.textContent = `${Math.round(nearest.distance)} m away · head ${directionTo(position, nearest.object)}`;
    } else if (waitForTap) {
      status.textContent = "An object is nearby.";
      nearbyButton.hidden = false;
    } else {
      status.textContent = "Found it.";
      open(nearest.object);
    }
  }

  function finish() {
    stopGps();
    clearInterval(demoTimer);
    demoTimer = null;
    nearbyButton.hidden = true;
    startButton.hidden = true;
    status.textContent = "You've found every object.";
  }

  function startDemo() {
    let lastTarget;
    let metresAway = 60;
    function tick() {
      if (active) return;
      const target = objects.find((object) => !discovered.has(object));
      if (!target) {
        finish();
        return;
      }
      if (lastTarget !== target) {
        lastTarget = target;
        metresAway = 60;
      }
      // Simulate a new approach for each spot even when their GPS circles overlap.
      updateExplore({
        latitude: target.latitude - metresAway / 111320,
        longitude: target.longitude,
        accuracy: 0,
      }, [target]);
      metresAway = Math.max(0, metresAway - 10);
    }
    demoTimer = setInterval(tick, 400);
    tick();
  }

  function open(object, reload = false) {
    dispose();
    const viewer = document.createElement("model-viewer");
    viewer.setAttribute("alt", object.name);
    viewer.setAttribute("camera-controls", "");
    viewer.setAttribute("shadow-intensity", "1");
    // The longest cigarette track runs as primary so the others finish all three loops.
    if (object.primary) viewer.setAttribute("animation-name", object.primary);



    const controller = new AbortController();
    const { signal } = controller;
    const session = { object, viewer, controller, loadTimer: null, playTimer: null, failed: false };
    active = session;
    stage.classList.add("open");
    showModelMessage("Loading " + object.name + "…");

    function fail() {
      session.failed = true;
      clearTimeout(session.loadTimer);
      clearTimeout(session.playTimer);
      arButton.hidden = true;
      showModelMessage("Could not load the model. Check your connection and try again.", true);
    }

    viewer.addEventListener("load", () => {
      if (session.failed) return;
      clearTimeout(session.loadTimer);
      if (!preview) discovered.add(object);
      showModelMessage("");
      loadCameraTools(session);
      session.playTimer = setTimeout(() => play(viewer, object), object.delay);
    }, { once: true, signal });
    viewer.addEventListener("error", fail, { once: true, signal });
    const url = new URL("models/" + object.file, document.baseURI);
    if (reload) url.searchParams.set("retry", Date.now());
    session.loadTimer = setTimeout(fail, 25000);
    viewer.setAttribute("src", url.href);
    models.append(viewer);
    if (!preview) closeButton.focus();
  }

  function loadCameraTools(session) {
    arButton.hidden = false;
    arButton.disabled = true;
    arButton.textContent = "Loading camera tools…";
    if (!cameraTools) {
      cameraTools = import("./ar.js").then(async (camera) => {
        const engine = await camera.prepareCamera();
        return { camera, engine };
      }).catch((error) => {
        cameraTools = null;
        throw error;
      });
    }
    cameraTools.then(({ camera, engine }) => {
      if (active !== session || session.failed) return;
      showModelMessage("");
      arButton.disabled = false;
      arButton.textContent = "Open camera AR";
      arButton.onclick = () => camera.startCamera(engine, session.object, arButton);
    }).catch((error) => {
      if (active !== session || session.failed) return;
      arButton.textContent = "Retry camera setup";
      arButton.disabled = false;
      arButton.onclick = () => loadCameraTools(session);
      showModelMessage(error.message || "Camera tools could not load.", false, true);
    });
  }

  function play(viewer, object) {
    const clips = viewer.availableAnimations;
    if (!clips.length) return;
    const primary = object.primary ?? clips[0];
    viewer.play({ repetitions: object.repetitions });
    for (const clip of clips) {
      if (clip !== primary) viewer.appendAnimation(clip, { repetitions: object.repetitions });
    }
  }

  function showModelMessage(message, allowRetry = false, arError = false) {
    const box = byId("model-message");
    byId("model-status").textContent = message;
    box.hidden = !message;
    box.classList.toggle("ar-error", arError);
    retryButton.hidden = !allowRetry;
  }

  function dispose() {
    if (!active) return;
    const { viewer, controller, loadTimer, playTimer } = active;
    active = null;
    arButton.hidden = true;
    arButton.onclick = null;
    controller.abort();
    clearTimeout(loadTimer);
    clearTimeout(playTimer);
    if (viewer.loaded) viewer.pause();
    viewer.remove();
  }

  function close() {
    if (!active) return;
    dispose();
    stage.classList.remove("open");
    if (discovered.size === objects.length) {
      finish();
    } else if (!demo && lastPosition) {
      waitForTap = true;
      updateExplore(lastPosition);
      if (!nearbyButton.hidden) nearbyButton.focus();
    }
  }

  function updateScout(position) {
    lastPosition = position;
    markButton.disabled = false;
    const quality = position.accuracy <= 10 ? "good" : "wait…";
    status.textContent = `±${Math.round(position.accuracy)} m · ${quality}`;
    coords.textContent = formatCoordinates(position);
  }

  function saveSpot() {
    if (!lastPosition) return;
    const note = window.prompt("Note for this spot (e.g. 'bench by Orton Hall'):");
    if (note === null) return;
    const { latitude, longitude, accuracy } = lastPosition;
    const spots = readSpots();
    spots.push({
      lat: Number(latitude.toFixed(6)),
      lon: Number(longitude.toFixed(6)),
      acc: Math.round(accuracy),
      note,
      time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    });
    try {
      localStorage.setItem("spots", JSON.stringify(spots));
      showSpots();
    } catch {
      status.textContent = "Could not save this spot. Copy the coordinates shown below.";
    }
  }

  function readSpots() {
    try {
      const spots = JSON.parse(localStorage.getItem("spots"));
      if (!Array.isArray(spots)) return [];
      return spots.filter((spot) => spot && Number.isFinite(spot.lat) && Number.isFinite(spot.lon));
    } catch {
      return [];
    }
  }

  function showSpots() {
    const rows = readSpots().map((spot, index) => {
      const row = document.createElement("li");
      const title = document.createElement("b");
      title.textContent = `${index + 1}. ${spot.note || "spot"}`;
      row.append(title, ` · ${spot.time} · ±${spot.acc} m`, document.createElement("br"),
        `{ lat: ${spot.lat}, lon: ${spot.lon} }`);
      return row;
    });
    byId("spots").replaceChildren(...rows.reverse());
  }

  function formatCoordinates({ latitude, longitude }) {
    return `${latitude.toFixed(6)}, ${longitude.toFixed(6)}`;
  }

  function distanceBetween(from, to) {
    const r = Math.PI / 180;
    const a = Math.sin((to.latitude - from.latitude) * r / 2) ** 2 +
      Math.cos(from.latitude * r) * Math.cos(to.latitude * r) *
      Math.sin((to.longitude - from.longitude) * r / 2) ** 2;
    return 12742000 * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  function directionTo(from, to) {
    const r = Math.PI / 180;
    const deltaLon = (to.longitude - from.longitude) * r;
    const lat1 = from.latitude * r;
    const lat2 = to.latitude * r;
    const y = Math.sin(deltaLon) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLon);
    const degrees = (Math.atan2(y, x) / r + 360) % 360;
    return ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(degrees / 45) % 8];
  }
})();
