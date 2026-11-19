/*
 * Camera check for the meeting details page.
 *
 * Reads available cameras, lets the participant test and switch devices before
 * joining, and always releases the camera when they stop the preview or leave
 * the page. The room page reuses the saved device id.
 */
(function () {
  "use strict";

  const startBtn = document.getElementById("camera-check-start");
  if (!startBtn) return;

  const preview = document.getElementById("camera-preview");
  const placeholder = document.getElementById("camera-preview-placeholder");
  const select = document.getElementById("camera-device");
  const status = document.getElementById("camera-check-status");
  const stopBtn = document.getElementById("camera-check-stop");

  let stream = null;

  function setStatus(text) {
    if (status) status.textContent = text;
  }

  function showPreview(on) {
    if (!preview || !placeholder) return;
    preview.classList.toggle("hidden", !on);
    placeholder.classList.toggle("hidden", on);
  }

  function stopPreview() {
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
      stream = null;
    }
    if (preview) preview.srcObject = null;
    showPreview(false);
    if (stopBtn) stopBtn.classList.add("hidden");
    startBtn.textContent = "Test camera";
  }

  function errorMessage(error) {
    switch (error && error.name) {
      case "NotAllowedError":
      case "PermissionDeniedError":
        return "Camera permission was denied. Allow it in the browser's address bar, then try again.";
      case "NotFoundError":
      case "DevicesNotFoundError":
        return "No camera was detected on this device.";
      case "NotReadableError":
      case "TrackStartError":
      case "AbortError":
        return "The camera is being used by another application. Close it and try again.";
      case "SecurityError":
        return "Camera access needs HTTPS (or localhost).";
      default:
        return "The camera could not be started. Check the device and browser permission.";
    }
  }

  async function listDevices() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices || !select) {
      return;
    }
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const cameras = devices.filter((device) => device.kind === "videoinput");
      if (!cameras.length) {
        select.classList.add("hidden");
        return;
      }
      const saved = localStorage.getItem("vanguardCameraId") || "";
      select.textContent = "";
      cameras.forEach((camera, index) => {
        const option = document.createElement("option");
        option.value = camera.deviceId;
        option.textContent = camera.label || "Camera " + (index + 1);
        if (camera.deviceId === saved) option.selected = true;
        select.appendChild(option);
      });
      select.classList.remove("hidden");
    } catch {
      /* the selector is optional */
    }
  }

  async function startPreview() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setStatus(
        window.isSecureContext
          ? "This browser does not support camera preview."
          : "Camera preview needs HTTPS (or localhost)."
      );
      return;
    }

    stopPreview();
    setStatus("Requesting camera access…");
    startBtn.disabled = true;

    const deviceId = (select && select.value) || localStorage.getItem("vanguardCameraId");
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: deviceId
          ? { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }
          : { width: { ideal: 1280 }, height: { ideal: 720 } },
      });
      const track = stream.getVideoTracks()[0];
      if (!track) throw new Error("No video track");
      if (preview) {
        preview.srcObject = stream;
        preview.play().catch(() => {});
      }
      showPreview(true);
      if (stopBtn) stopBtn.classList.remove("hidden");
      startBtn.textContent = "Restart camera";
      const settings = track.getSettings ? track.getSettings() : {};
      if (settings.deviceId) localStorage.setItem("vanguardCameraId", settings.deviceId);
      setStatus("Camera is working. You can join the live classroom now.");
      await listDevices();
      if (select && settings.deviceId) select.value = settings.deviceId;
    } catch (error) {
      stopPreview();
      setStatus(errorMessage(error));
    } finally {
      startBtn.disabled = false;
    }
  }

  startBtn.addEventListener("click", startPreview);
  if (stopBtn) {
    stopBtn.addEventListener("click", () => {
      stopPreview();
      setStatus("Camera preview stopped. The camera is released.");
    });
  }
  if (select) {
    select.addEventListener("change", () => {
      localStorage.setItem("vanguardCameraId", select.value);
      startPreview();
    });
  }

  window.addEventListener("pagehide", stopPreview);

  listDevices();
})();
