import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const panel = document.getElementById("ar-panel");
const canvas = document.getElementById("ar-canvas");
const instruction = document.getElementById("ar-instruction");
const placeButton = document.getElementById("ar-place");
const closeButton = document.getElementById("ar-close");
const reticle = document.getElementById("ar-reticle");
const engineScript = document.getElementById("xr-engine");
let activeSession;

window.THREE = THREE;
const engineReady = new Promise((resolve, reject) => {
  if (window.XR8) {
    resolve(window.XR8);
    return;
  }
  const events = new AbortController();
  const { signal } = events;
  const timeout = setTimeout(() => fail("The camera engine took too long to load."), 15000);
  function fail(message) {
    clearTimeout(timeout);
    events.abort();
    reject(new Error(message));
  }
  window.addEventListener("xrloaded", () => {
    clearTimeout(timeout);
    events.abort();
    resolve(window.XR8);
  }, { once: true, signal });
  engineScript.addEventListener("error", () => fail("The camera engine did not load."), { once: true, signal });
});

export async function prepareCamera() {
  if (!window.isSecureContext) throw new Error("Open this page over HTTPS to use the phone camera.");
  const engine = await engineReady;
  await engine.loadChunk("slam");
  return engine;
}

closeButton.addEventListener("click", () => activeSession?.close());
window.addEventListener("pagehide", () => activeSession?.close());
placeButton.addEventListener("click", () => activeSession?.place());

export function startCamera(engine, object, returnFocus) {
  if (activeSession) return;
  panel.hidden = false;
  closeButton.focus();
  placeButton.hidden = false;
  placeButton.disabled = true;
  reticle.hidden = true;
  message("Allow camera access to begin.");

  const raycaster = new THREE.Raycaster();
  const screenCentre = new THREE.Vector2(0, 0);
  const ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const point = new THREE.Vector3();
  const anchor = new THREE.Group();
  anchor.visible = false;
  let scene;
  let camera;
  let model;
  let mixer;
  let clips;
  let targetReady = false;
  let placed = false;
  let playAt = Infinity;
  let previousTime;
  let modules;
  let stopped = false;
  let started = false;
  const startupTimer = setTimeout(() => fail("Camera startup timed out. Check camera access and try again."), 30000);
  let modelTimer;

  function message(text) {
    if (instruction.textContent !== text) instruction.textContent = text;
  }

  function stopEngine() {
    if (stopped) return;
    stopped = true;
    clearTimeout(startupTimer);
    clearTimeout(modelTimer);
    if (started) {
      try { engine.stop(); } catch (error) { console.warn(error); }
    }
    if (modules) {
      try { engine.removeCameraPipelineModules(modules.map(({ name }) => name)); }
      catch (error) { console.warn(error); }
    }
    if (mixer && model) {
      mixer.stopAllAction();
      mixer.uncacheRoot(model);
    }
    if (model) releaseModel(model);
    anchor.removeFromParent();
  }

  function fail(text) {
    if (stopped) return;
    message(text);
    placeButton.hidden = true;
    reticle.hidden = true;
    queueMicrotask(stopEngine);
  }

  activeSession = {
    close() {
      stopEngine();
      activeSession = null;
      panel.hidden = true;
      returnFocus?.focus();
    },
    place() {
      if (stopped || placed || !targetReady) return;
      placed = true;
      anchor.position.copy(point);
      anchor.visible = true;
      placeButton.hidden = true;
      reticle.hidden = true;
      message("Walk around the object to view it.");
      playAt = performance.now() + object.delay;
    },
  };

  try {
    engine.XrController.configure({ scale: "absolute", disableWorldTracking: false });
    modules = [
      engine.GlTextureRenderer.pipelineModule(),
      engine.Threejs.pipelineModule(),
      engine.XrController.pipelineModule(),
      {
        name: "oval-ground-placement",
        onCameraStatusChange: ({ status }) => {
          if (status === "failed") fail("Could not open the camera. Check your browser permissions.");
        },
        onException: (error) => {
          console.warn(error);
          fail("This browser could not start 8th Wall. Try Safari or Chrome on a phone.");
        },
        onStart: () => {
          if (stopped) return;
          clearTimeout(startupTimer);
          ({ scene, camera } = engine.Threejs.xrScene());
          camera.position.set(0, 1.6, 0);
          engine.XrController.updateCameraProjectionMatrix({
            origin: camera.position,
            facing: camera.quaternion,
          });
          scene.add(anchor);
          scene.add(new THREE.HemisphereLight(0xffffff, 0x777463, 2.1));
          const sun = new THREE.DirectionalLight(0xffffff, 2.0);
          sun.position.set(2, 4, 3);
          scene.add(sun);

          message("Loading the model…");
          modelTimer = setTimeout(() => fail("The model took too long to load. Close and try again."), 20000);
          const source = new URL("models/" + object.file, document.baseURI);
          new GLTFLoader().load(source.href, ({ scene: root, animations }) => {
            if (stopped) {
              releaseModel(root);
              return;
            }
            clearTimeout(modelTimer);
            model = root;
            clips = animations;
            mixer = new THREE.AnimationMixer(root);
            const bounds = new THREE.Box3().setFromObject(root);
            const centre = bounds.getCenter(new THREE.Vector3());
            const size = bounds.getSize(new THREE.Vector3());
            const fit = new THREE.Group();
            const scale = object.width / Math.max(size.x, size.z, 0.001);
            fit.scale.setScalar(scale);
            fit.position.set(-centre.x * scale, -bounds.min.y * scale, -centre.z * scale);
            fit.add(root);
            anchor.add(fit);
          }, undefined, () => fail("Could not load the model. Close and try again."));
        },
        onUpdate: ({ processCpuResult }) => {
          if (stopped || !model || !camera) return;
          const now = performance.now();
          const seconds = previousTime === undefined ? 0 : Math.min((now - previousTime) / 1000, 0.1);
          previousTime = now;
          if (placed) {
            if (now >= playAt) {
              playAt = Infinity;
              for (const clip of clips) {
                const action = mixer.clipAction(clip);
                action.setLoop(THREE.LoopRepeat, object.repetitions);
                action.clampWhenFinished = Number.isFinite(object.repetitions);
                action.play();
              }
            }
            mixer.update(seconds);
            return;
          }

          targetReady = false;
          const tracking = processCpuResult?.reality?.trackingStatus === "NORMAL";
          if (tracking) {
            camera.updateMatrixWorld();
            raycaster.setFromCamera(screenCentre, camera);
            const hit = raycaster.ray.intersectPlane(ground, point);
            if (hit) {
              const distance = raycaster.ray.origin.distanceTo(point);
              targetReady = distance > 0.3 && distance < 5;
            }
          }
          placeButton.disabled = !targetReady;
          reticle.hidden = !tracking;
          reticle.classList.toggle("ready", targetReady);
          message(targetReady ? "Tap Place here to set the object on the ground."
            : "Point at the ground and slowly move your phone.");
        },
      },
    ];
    engine.addCameraPipelineModules(modules);
    started = true;
    engine.run({ canvas });
  } catch (error) {
    console.warn(error);
    fail("Could not start 8th Wall. Close and try again.");
  }
}

function releaseModel(root) {
  root.traverse((node) => {
    node.geometry?.dispose();
    if (!node.material) return;
    const materials = Array.isArray(node.material) ? node.material : [node.material];
    for (const material of materials) {
      for (const value of Object.values(material)) {
        if (value?.isTexture) value.dispose();
      }
      material.dispose();
    }
  });
}
