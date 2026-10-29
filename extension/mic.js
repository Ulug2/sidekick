const status = document.getElementById("status");

document.getElementById("allow").onclick = async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach(t => t.stop()); // we only needed the permission
    status.textContent = "Done. You can close this tab and press the mic in Sidekick.";
    setTimeout(() => window.close(), 1800);
  } catch (err) {
    status.textContent =
      err.name === "NotAllowedError"
        ? "Blocked. Click the icon at the left of the address bar, set Microphone to Allow, then try again."
        : `Couldn't access the microphone: ${err.message}`;
  }
};
