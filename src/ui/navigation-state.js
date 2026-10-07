const MAIN_PANELS = new Set(["build", "residents", "business", "policy", "settings"]);

export function isChoosingBuildPlot(state) {
  return state?.activePanel === "build" && Boolean(state.buildType) && !state.previewPlotId;
}

export function createNavigationState() {
  const state = {
    activePanel: null,
    selectedSite: null,
    buildType: null,
    previewPlotId: null,
    returnPanel: null,
    eventsExpanded: false,
    eventsDismissed: false
  };

  function clearBuild() {
    state.buildType = null;
    state.previewPlotId = null;
  }

  return {
    state,
    openPanel(name, toggle = false) {
      if (!MAIN_PANELS.has(name)) return;
      if (toggle && state.activePanel === name) {
        state.activePanel = null;
        state.selectedSite = null;
        clearBuild();
        return;
      }
      state.activePanel = name;
      state.selectedSite = null;
      state.returnPanel = null;
      if (name !== "build") clearBuild();
      else state.previewPlotId = null;
    },
    openSite(site) {
      state.returnPanel = state.activePanel;
      state.activePanel = "site";
      state.selectedSite = site;
      clearBuild();
    },
    backFromSite() {
      state.activePanel = state.returnPanel || null;
      state.returnPanel = null;
      state.selectedSite = null;
    },
    closePanel() {
      state.activePanel = null;
      state.selectedSite = null;
      state.returnPanel = null;
      clearBuild();
    },
    chooseBuild(typeId) {
      state.activePanel = "build";
      state.selectedSite = null;
      state.buildType = typeId;
      state.previewPlotId = null;
      state.returnPanel = null;
    },
    choosePlot(plotId) {
      if (state.activePanel === "build" && state.buildType) state.previewPlotId = plotId;
    },
    reselectBuildPlot() {
      if (state.activePanel === "build" && state.buildType) state.previewPlotId = null;
    },
    cancelBuild() {
      clearBuild();
    },
    finishBuild() {
      clearBuild();
      state.activePanel = "build";
      state.selectedSite = null;
    },
    revealEvents() {
      state.eventsDismissed = false;
    },
    dismissEvents() {
      state.eventsDismissed = true;
      state.eventsExpanded = false;
    },
    resetView() {
      state.activePanel = null;
      state.selectedSite = null;
      state.returnPanel = null;
      state.eventsExpanded = false;
      state.eventsDismissed = false;
      clearBuild();
    }
  };
}
