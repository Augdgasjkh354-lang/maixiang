export function createToastController(element) {
  let timeout = null;
  let lastMessage = "";
  let lastShownAt = 0;
  let destroyed = false;

  return {
    show(message, duration = 2600, kind = "info") {
      if (destroyed || !element) return;
      const text = String(message ?? "");
      const now = Date.now();
      if (text === lastMessage && now - lastShownAt < 500) return;
      lastMessage = text;
      lastShownAt = now;
      element.textContent = text;
      element.dataset.kind = kind;
      element.classList.add("show");
      clearTimeout(timeout);
      timeout = setTimeout(() => element.classList.remove("show"), duration);
    },
    destroy() {
      destroyed = true;
      clearTimeout(timeout);
      timeout = null;
      element?.classList.remove("show");
    }
  };
}
