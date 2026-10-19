import { ipcRenderer } from "electron";

window.addEventListener("DOMContentLoaded", () => {
  let dragged = false;
  document.getElementById("app")?.addEventListener("pointerdown", () => {
    dragged = false;
  });
  document.getElementById("app")?.addEventListener("dragstart", (event) => {
    event.preventDefault();
    dragged = true;
    ipcRenderer.send("mac-permission:drag");
  });
  document.getElementById("app")?.addEventListener("click", (event) => {
    if (!dragged || event.detail === 0) ipcRenderer.send("mac-permission:reveal");
  });
  document.getElementById("back")?.addEventListener("click", () => {
    ipcRenderer.send("mac-permission:back");
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") ipcRenderer.send("mac-permission:back");
  });
});
