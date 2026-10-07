import { simulation } from "../engine.js";
import { exportState } from "../persistence/storage.js";
import { classifyPersistenceError } from "../persistence/save-manager.js";
import { createIndexedSaveManager, SAVE_DB_NAME } from "../persistence/indexed-save-manager.js";
import { createAutosaveCoordinator } from "../persistence/autosave-coordinator.js";
import { createInitialState } from "../core/state.js";
import { SimulationClock } from "./simulation-clock.js";
import { SHELL_HTML } from "./shell.js";
import { mapSignature, renderMap, updateMapMotion } from "./map.js";
import { createMapCamera } from "./map-camera.js";
import { drawVillageMapCanvas } from "./map-canvas.js";
import { createMapModel } from "./map-model.js";
import { createNavigationState, isChoosingBuildPlot } from "./navigation-state.js";
import { sound } from "./audio.js";
import { createToastController } from "./toast.js";
import { renderBuild, setBuildCategory } from "./panel-build.js";
import { renderResidents } from "./panel-residents.js";
import { renderEconomy } from "./panel-economy.js";
import { econMiniSummary, renderEconMini } from "./econ-mini.js";
import { macroPanelSummary, renderMacroPanel } from "./macro-panel.js";
import { renderPolicy } from "./panel-policy.js";
import { renderSite } from "./panel-site.js";
import { renderSettings } from "./panel-settings.js";
import { compact, escapeHtml, number, numberMax, moneyUnit } from "./format.js";
import { parseNumericDraft, shouldCommitNumericDraftOnChange, shouldDeferNumericPanelRender } from "./numeric-drafts.js";
import { createDashboardViewCache } from "./dashboard-view-cache.js";
import { APP_VERSION, BUILD_ID } from "../content/version.js";

function closest(element, selector) {
  return element && typeof element.closest === "function" ? element.closest(selector) : null;
}

export function mountGame(root) {
  document.title = `麦乡 ${APP_VERSION} · ${BUILD_ID}`;
  root.dataset.appVersion = APP_VERSION;
  root.dataset.buildId = BUILD_ID;
  root.innerHTML = SHELL_HTML;
  let storage = null;
  let saves = null;
  let persistenceIssue = null;
  let persistenceBusy = true;
  try { storage = window.localStorage; }
  catch (error) {
    persistenceIssue = classifyPersistenceError(error, "访问 localStorage");
    console.error("[麦乡存档] localStorage 访问失败", error, error?.cause || "");
  }
  const clock = new SimulationClock(simulation.content);
  const navigation = createNavigationState();
  const dashboardViews = createDashboardViewCache((currentState, selection) => simulation.selectDashboard(currentState, selection));
  const $ = selector => root.querySelector(selector);
  const mapCamera = createMapCamera($("#mapStage"), $("#mapWorld"));
  sound.restorePreference(storage);
  const toast = createToastController($("#toast"));
  let state = null;
  let activeId = null;
  let managerOpen = false;
  let pendingAction = null;
  let saveNotice = "尚未保存";
  let saveWarning = null;
  const numericDrafts = new Map();
  let startupError = null;
  let dirty = false;
  let stateRevision = 0;
  let saveSession = 0;
  let saveWarningShown = false;
  let transientMode = false;
  let previousFrame = performance.now();
  let animationFrame = 0;
  let animationTime = 0;
  let lastCanvasFrame = 0;
  let renderedMapSignature = "";
  let renderedEventsSignature = "";
  let latestEventKey = null;
  let upgradePreviewId = null;
  let demolitionPreviewId = null;
  let rightSalePreviewId = null;
  let currencyPreview = null;
  let listingPreview = null;
  let stockListingPreview = null;
  let sharePreviewCompanyId = null;
  let buybackPreview = null;
  let companyLevelPreview = null;
  let reformFinishConfirm = false;
  let lastBuildPreviewPlotId = null;
  let latestView = null;
  let latestMapModel = null;

  managerOpen = true;
  navigation.openPanel("settings");

  latestEventKey = eventKey(state?.events?.[0]);

  function eventKey(event) {
    return event ? `${event.year}:${event.day}:${event.text}` : "";
  }

  function showToast(message, duration = 2600) {
    toast.show(message, duration);
  }

  const autosave = createAutosaveCoordinator({
    capture: () => state && saves && activeId && !transientMode
      ? { state, slotId: activeId, revision: stateRevision, session: saveSession, dirty }
      : null,
    save: snapshot => saves.saveCurrent(snapshot.state, snapshot.slotId),
    onSuccess: (snapshot, saved) => {
      if (snapshot.session !== saveSession || snapshot.slotId !== activeId) return;
      if (snapshot.revision === stateRevision) dirty = false;
      saveWarningShown = false;
      saveNotice = `最近保存：${new Date(saved.savedAt).toLocaleString("zh-CN", { hour12: false })} · 成功`;
      const indicator = $("#saveStatus");
      if (indicator) indicator.textContent = saveNotice;
      const slotTime = root.querySelector(".save-slot.is-current [data-slot-time]");
      if (slotTime) slotTime.textContent = new Date(saved.savedAt).toLocaleString("zh-CN", { hour12: false });
    },
    onFailure: (snapshot, error) => {
      if (snapshot.session !== saveSession || snapshot.slotId !== activeId) return;
      persistenceIssue = error;
      console.error("[麦乡存档] 保存失败", error, error?.cause || "");
      saveNotice = `保存失败：${error.message}`;
      const indicator = $("#saveStatus");
      if (indicator) indicator.textContent = saveNotice;
      if (!saveWarningShown) {
        showToast(saveNotice, 5000);
        saveWarningShown = true;
      }
    }
  });

  // 自动存档时钟：按游戏时间（每月/每3月/每半年）触发，不再按现实时间频繁写入。
  let lastAutosaveAbsDay = 0;
  function absoluteGameDay() {
    if (!state) return 0;
    return (state.year - 1) * (simulation.content.rules.daysPerYear || 365) + state.day;
  }
  function resetAutosaveClock() {
    lastAutosaveAbsDay = absoluteGameDay();
  }

  async function saveIfDirty(force = false) {
    if (!state || (!dirty && !force)) return true;
    if (transientMode) {
      dirty = true;
      saveNotice = "临时游玩：当前进度仅保存在本页内存中；刷新后不会保留。";
      const indicator = $("#saveStatus");
      if (indicator) indicator.textContent = saveNotice;
      return true;
    }
    if (!saves) return false;
    return autosave.request({ force });
  }

  function invalidateStateView() {
    dashboardViews.invalidateState();
  }

  function changed(forceSave = false) {
    dirty = true;
    stateRevision += 1;
    invalidateStateView();
    if (forceSave) void saveIfDirty();
  }

  function dashboardSelection() {
    const nav = navigation.state;
    return {
      panel: nav.activePanel || "none",
      site: nav.selectedSite,
      build: nav.activePanel === "build" ? nav.buildType : null,
      plotId: nav.activePanel === "build" ? nav.previewPlotId : null,
      paused: clock.paused,
      speed: clock.speed
    };
  }

  function buildView() {
    if (!state) return null;
    const base = dashboardViews.get(state, dashboardSelection());
    return {
      ...base,
      numericDrafts: Object.fromEntries(numericDrafts),
      upgradePreviewId,
      demolitionPreviewId,
      rightSalePreviewId,
      currencyPreview,
      listingPreview,
      stockListingPreview,
      sharePreviewCompanyId,
      buybackPreview,
      companyLevelPreview,
      reformFinishConfirm
    };
  }

  function renderHeader(view) {
    const season = view.season;
    $("#dateLabel").textContent = `第${number(view.year)}年 · ${season.name} · 第${number(season.index)}天`;
    $("#timeLabel").textContent = `${season.field} · ${view.paused ? "暂停" : `${view.speed}×`}`;
    $("#populationStat").textContent = number(view.people.total);
    $("#idleStat").textContent = number(view.labor.idle);
    $("#residentStat").textContent = compact(view.accounts.residents.qeq);
    $("#townStat").textContent = compact(view.accounts.town.qeq);
    $("#forecastMap").textContent = `${number(view.forecast)}斤`;
    $("#daysMap").textContent = `${numberMax(view.residentFoodDays, 1)}天`;
    $("#mapStage").dataset.season = season.key;
    // 经济迷你面板（用户 0.1.11）：摘要常显失业率，展开看走势。
    const econSummary = $("#econSummary");
    const econBody = $("#econBody");
    if (econSummary) econSummary.textContent = econMiniSummary();
    if (econBody) {
      const html = renderEconMini(view);
      if (econBody.innerHTML !== html) econBody.innerHTML = html;
    }
    // 宏观面板（金融扩展第一期）：右上角透明，摘要常显失业率。
    const macroSummary = $("#macroSummary");
    const macroBody = $("#macroBody");
    if (macroSummary) macroSummary.textContent = macroPanelSummary(view);
    if (macroBody) {
      const html = renderMacroPanel(view);
      if (macroBody.innerHTML !== html) macroBody.innerHTML = html;
    }
    $("#pauseBtn").classList.toggle("selected", view.paused);
    $("#pauseBtn").setAttribute("aria-pressed", String(view.paused));
    root.querySelectorAll("[data-speed]").forEach(button => {
      const selected = !view.paused && Number(button.dataset.speed) === view.speed;
      button.classList.toggle("selected", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
    const nav = navigation.state;
    const selectedConstruction = nav.buildType
      ? view.constructionOptions.find(option => option.id === nav.buildType)
      : null;
    const materialShortage = selectedConstruction?.materials
      ?.filter(row => row.missing > 0)
      .map(row => `还缺${number(row.missing)}${row.name}`)
      .join("、");
    const instruction = nav.activePanel === "build" && nav.buildType
      ? nav.previewPlotId
        ? materialShortage ? `地块已选；${materialShortage}` : "地块已选；可确认开工"
        : "点一处虚线空地选址；再次点“建设”可取消"
      : "";
    // 默认操作提示不再常驻地图，只在选址等需要指引时出现。
    const hint = $("#mapHint");
    hint.textContent = instruction;
    hint.hidden = !instruction;
  }

  function renderEvents(view) {
    const nav = navigation.state;
    const newest = view.events[0];
    const nextEventKey = eventKey(newest);
    const isNewEvent = Boolean(latestEventKey && nextEventKey && nextEventKey !== latestEventKey);
    if (isNewEvent) navigation.revealEvents();
    const signature = `${nav.eventsExpanded}|${nav.eventsDismissed}|${view.events.map(event => `${event.year}:${event.day}:${event.text}`).join("|")}`;
    if (signature === renderedEventsSignature) return;
    renderedEventsSignature = signature;
    const bubble = $("#eventFloat");
    bubble.hidden = nav.eventsDismissed;
    if (isNewEvent && /收获|秋收/.test(newest?.text || "")) {
      sound.playHarvest();
    }
    latestEventKey = nextEventKey;
    $("#latestEvent").textContent = newest?.text || "镇上平静，日子照常向前。";
    $("#eventToggle").setAttribute("aria-expanded", String(nav.eventsExpanded));
    const history = $("#eventHistory");
    history.hidden = !nav.eventsExpanded;
    history.innerHTML = nav.eventsExpanded
      ? view.events.slice(0, 5).map(event => `<div class="event-line"><time>第${number(event.year)}年 · 第${number(event.day)}${event.untilDay && event.untilDay > event.day ? `–${number(event.untilDay)}` : ""}日</time>${escapeHtml(event.text)}</div>`).join("")
      : "";
  }

  function panelMarkup(view) {
    const settingsUi = () => {
      let slots = [];
      try { slots = saves?.list().slots || []; }
      catch (error) {
        persistenceIssue = error;
        console.error("[麦乡存档] 读取存档列表失败", error, error?.cause || "");
      }
      let legacyArtifacts = [];
      let storageStats = null;
      try {
        legacyArtifacts = saves?.legacyArtifacts?.() || [];
        storageStats = saves?.storageStats?.() || null;
      } catch {}
      return { soundMuted: sound.isMuted, slots, warning: saveWarning, saveStatus: saveNotice,
        managerOpen, pending: pendingAction, transientMode, persistenceIssue, persistenceBusy, legacyArtifacts, storageStats,
        appVersion: APP_VERSION, buildId: BUILD_ID, pageAddress: window.location.href };
    };
    if (startupError || !state) return renderSettings(view, startupError?.message || null, settingsUi());
    switch (navigation.state.activePanel) {
      case "build": return renderBuild(view);
      case "residents": return renderResidents(view);
      case "business": return renderEconomy(view);
      case "policy": return renderPolicy(view);
      case "site": return renderSite(view);
      case "settings": return renderSettings(view, null, settingsUi());
      default: return "";
    }
  }

  function numericInputFor(key, preferred = null) {
    if (preferred?.dataset?.draftKey === key) return preferred;
    return Array.from(root.querySelectorAll("[data-draft-key]"))
      .find(input => input.dataset.draftKey === key) || null;
  }

  function setDraftError(key, error, input = null) {
    const previous = numericDrafts.get(key) || { value: input?.value ?? "" };
    numericDrafts.set(key, { ...previous, error });
    for (const field of root.querySelectorAll("[data-draft-key]")) {
      if (field.dataset.draftKey === key) field.setAttribute("aria-invalid", "true");
    }
    for (const message of root.querySelectorAll("[data-draft-error]")) {
      if (message.dataset.draftError !== key) continue;
      message.textContent = error;
      message.hidden = false;
    }
    showToast(error, 3600);
  }

  function readStagedNumber(key, options = {}) {
    const input = numericInputFor(key);
    const rawValue = numericDrafts.has(key) ? numericDrafts.get(key).value : input?.value;
    const parsed = parseNumericDraft(rawValue, {
      label: options.label || input?.dataset.draftLabel || "数值",
      minimum: options.minimum ?? Number(input?.dataset.draftMinimum ?? 0),
      maximum: options.maximum ?? (input?.dataset.draftMaximum !== undefined ? Number(input.dataset.draftMaximum) : undefined),
      integer: options.integer ?? input?.dataset.draftInteger === "true",
      positive: options.positive ?? input?.dataset.draftPositive === "true"
    });
    if (!parsed.ok) {
      setDraftError(key, parsed.reason, input);
      return null;
    }
    return parsed.value;
  }

  function commitNumericDraft(key, preferredInput = null) {
    if (!state) return false;
    const input = numericInputFor(key, preferredInput);
    if (!input) return false;
    const rawValue = numericDrafts.has(key) ? numericDrafts.get(key).value : input.value;
    const kind = input.dataset.draftKind;
    const options = {
      label: input.dataset.draftLabel || "数值",
      minimum: Number(input.dataset.draftMinimum ?? 0),
      integer: input.dataset.draftInteger === "true",
      positive: input.dataset.draftPositive === "true"
    };
    if (input.dataset.draftMaximum !== undefined) options.maximum = Number(input.dataset.draftMaximum);

    let job = null;
    if (kind === "employment") {
      job = buildView().labor.rows.find(row => row.key === input.dataset.draftTarget);
      if (!job) {
        setDraftError(key, "这个岗位已不可用，请重新打开镇民面板后再试。", input);
        return false;
      }
      options.maximum = job.maxAssignable;
    }
    const parsed = parseNumericDraft(rawValue, options);
    if (!parsed.ok) {
      setDraftError(key, parsed.reason, input);
      return false;
    }

    let result;
    let successMessage;
    if (kind === "employment") {
      result = simulation.setEmployment(state, input.dataset.draftTarget, parsed.value);
      successMessage = `已安排${number(result.assigned)}名${options.label.replace(/人数$/, "")}。`;
      renderedMapSignature = "";
      latestMapModel = null;
    } else if (kind === "project-workers") {
      result = simulation.setProjectWorkers(state, input.dataset.draftTarget, parsed.value);
      successMessage = `已将工程投入建筑工调整为${number(result.assigned)}人。`;
      renderedMapSignature = "";
      latestMapModel = null;
    } else if (kind === "wage") {
      result = simulation.setWageRate(state, input.dataset.draftTarget, parsed.value);
      successMessage = `日薪已设为${number(parsed.value, 2)}小麦等值。`;
    } else if (kind === "company-wage") {
      result = simulation.configureCompanyWage(state, input.dataset.draftTarget, parsed.value);
      successMessage = `公司日薪已设为${number(parsed.value, 2)}小麦等值。`;
    } else if (kind === "bread-price") {
      result = simulation.setBreadPrice(state, parsed.value);
      successMessage = `面包售价已设为${number(parsed.value, 3)}小麦等值/斤面包。`;
    } else if (kind === "unemployment-rate") {
      result = simulation.setUnemploymentPolicy(state, { dailyPerWorkerJin: parsed.value });
      successMessage = `失业金已设为每人每日${number(parsed.value, 2)}小麦等值。`;
    } else if (kind === "villa-price") {
      result = simulation.setVillaPolicy(state, { priceWheatJin: parsed.value });
      successMessage = `别墅定价已设为${number(parsed.value, 2)}小麦等值。`;
    } else if (kind === "villa-tax-rate") {
      result = simulation.setVillaPolicy(state, { taxRatePercent: parsed.value });
      successMessage = `别墅房产税率已设为${number(parsed.value, 2)}%。`;
    } else if (kind === "bank-deposit-rate") {
      result = simulation.setBankPolicy(state, { depositRateAnnualPercent: parsed.value });
      successMessage = `银行存款年利率已设为${number(parsed.value, 2)}%。`;
    } else if (kind === "bank-loan-rate") {
      result = simulation.setBankPolicy(state, { loanRateAnnualPercent: parsed.value });
      successMessage = `银行贷款年利率已设为${number(parsed.value, 2)}%。`;
    } else if (kind === "bank-reserve") {
      result = simulation.setBankPolicy(state, { reserveRequirementPercent: parsed.value });
      successMessage = `银行准备金率已设为${number(parsed.value, 2)}%。`;
    } else if (kind === "wage-control-civil") {
      result = simulation.setWageControl(state, { civil: parsed.value });
      successMessage = `公务员类工资系数已设为${number(parsed.value, 2)}。`;
    } else if (kind === "wage-control-industry") {
      result = simulation.setWageControl(state, { industry: parsed.value });
      successMessage = `镇营产业类工资系数已设为${number(parsed.value, 2)}。`;
    } else if (kind === "social-daily") {
      result = simulation.setSocialSecurityPolicy(state, { dailyPerWorkerJin: parsed.value });
      successMessage = `社保每日缴费已设为每劳动力${number(parsed.value, 2)}斤。`;
    } else if (kind === "social-pension") {
      result = simulation.setSocialSecurityPolicy(state, { pensionPerElderJin: parsed.value });
      successMessage = `养老金已设为每老人每日${number(parsed.value, 2)}斤。`;
    } else if (kind === "social-inject") {
      // 注资走按钮提交，此处仅做数值校验占位。
      result = { ok: true };
      successMessage = `注资金额已填写${number(parsed.value, 2)}斤，请点击注资按钮确认。`;
    } else if (kind === "bond-issue-total" || kind === "bond-issue-years" || kind === "bond-issue-rate") {
      // 国债发行走按钮提交，此处仅做数值校验占位。
      result = { ok: true };
      successMessage = "国债参数已填写，请点击发行按钮确认。";
    } else if (kind === "outside-trade-qty") {
      // 外贸数量走卖出/买入按钮提交，此处仅做数值校验占位。
      result = { ok: true };
      successMessage = `数量已填写${number(parsed.value, 2)}，请点击卖出或买入按钮确认。`;
    } else if (kind === "trade-tariff-rate") {
      result = simulation.setTradeTariffRate(state, parsed.value);
      successMessage = `出口关税税率已设为${number(parsed.value, 2)}%。`;
    } else if (kind === "agriculture-tax") {
      result = simulation.setAgricultureTax(state, parsed.value);
      successMessage = `农业税已设为${number(parsed.value, 2)}%。`;
    } else if (kind === "private-tax-rate") {
      result = simulation.setPrivateProductionTax(state, input.dataset.draftTarget, parsed.value);
      successMessage = `民营生产税已设为${number(parsed.value, 2)}%。`;
    } else if (kind === "operating-right-price") {
      result = simulation.setOperatingRightPrice(state, input.dataset.draftTarget, parsed.value);
      successMessage = `该级经营权售价已设为${number(parsed.value, 2)}小麦等值。`;
    } else if (kind === "employment-exchange") {
      result = simulation.setEmploymentExchangeQuota(state, parsed.value);
      successMessage = `在岗居民每日换券额度已设为${number(parsed.value, 2)}斤。`;
    } else if (kind === "voucher-target") {
      result = simulation.setVoucherPaymentTarget(state, parsed.value);
      successMessage = `目标粮券支付比例已设为${number(parsed.value, 2)}%。`;
    } else if (kind === "shop-rent") {
      result = simulation.setShopRent(state, parsed.value);
      successMessage = `营业店铺日租已设为${number(parsed.value, 2)}小麦等值。`;
    } else if (kind === "shop-profit-tax") {
      result = simulation.setShopProfitTax(state, parsed.value);
      successMessage = `商业利润税已设为${number(parsed.value, 2)}%。`;
    } else if (kind === "wholesale-price") {
      result = simulation.configureWholesalePrice(state, input.dataset.draftTarget, parsed.value);
      successMessage = `批发价已设为${number(parsed.value, 3)}小麦等值。`;
    } else if (kind === "wholesale-allocation") {
      result = simulation.configureWholesaleTownAllocation(state, input.dataset.draftTarget, parsed.value);
      successMessage = `镇库每日调拨已设为${number(parsed.value, 2)}。`;
    } else if (kind === "output-target") {
      result = simulation.setOutputTarget(state, input.dataset.draftTarget, parsed.value);
      successMessage = parsed.value > 0 ? `目标日产量已设为${number(parsed.value, 2)}。` : "已取消目标日产量，按人手满产。";
    } else if (kind === "service-price") {
      result = simulation.configureServicePrice(state, input.dataset.draftTarget, parsed.value);
      successMessage = `服务价格已设为${number(parsed.value, 3)}小麦等值。`;
    } else {
      setDraftError(key, "无法识别这项设置，请重新打开面板后再试。", input);
      return false;
    }
    if (!result?.ok) {
      setDraftError(key, result?.reason || "设置未能提交，请检查输入。", input);
      return false;
    }

    numericDrafts.delete(key);
    changed(true);
    render(true);
    showToast(successMessage);
    return true;
  }

  function inputHandler(event) {
    const target = event.target;
    if (!target.matches("[data-draft-key]")) return;
    const key = target.dataset.draftKey;
    numericDrafts.set(key, { value: target.value, error: "" });
    target.removeAttribute("aria-invalid");
    for (const message of root.querySelectorAll("[data-draft-error]")) {
      if (message.dataset.draftError !== key) continue;
      message.textContent = "";
      message.hidden = true;
    }
  }

  function renderPanel(view, force = false) {
    const active = Boolean(navigation.state.activePanel || startupError || !state);
    const choosingBuildPlot = isChoosingBuildPlot(navigation.state);
    root.classList.toggle("build-site-picking", choosingBuildPlot);
    const surface = $("#panelSurface");
    surface.hidden = !active;
    root.classList.toggle("panel-open", active);
    if (!active) return;
    const panelName = navigation.state.activePanel;
    const titles = {
      build: "建设", residents: "镇民与就业", business: "经营与粮账",
      policy: "政策", settings: "设置", site: "地方详情"
    };
    $("#panelKicker").textContent = titles[panelName] || "镇务";
    const panel = $("#panel");
    if (!force && shouldDeferNumericPanelRender(panel, document.activeElement)) return;
    const previousPanelName = panel.dataset.renderedPanel || "";
    const preserveUiState = previousPanelName === panelName;
    const openDetails = preserveUiState
      ? new Set(Array.from(panel.querySelectorAll("details[data-detail-key][open]")).map(detail => detail.dataset.detailKey))
      : new Set();
    const previousScrollTop = preserveUiState ? panel.scrollTop : 0;
    panel.innerHTML = panelMarkup(view);
    panel.dataset.renderedPanel = panelName || "";
    // 地方详情：用地名做面板标题，正文里不再重复一行大标题。
    const siteTitle = panelName === "site" ? panel.querySelector(":scope > h2") : null;
    if (siteTitle) {
      $("#panelKicker").textContent = siteTitle.textContent;
      siteTitle.hidden = true;
    }
    if (openDetails.size) {
      for (const detail of panel.querySelectorAll("details[data-detail-key]")) {
        if (openDetails.has(detail.dataset.detailKey)) detail.open = true;
      }
    }
    if (preserveUiState && panelName !== "build") panel.scrollTop = previousScrollTop;
    if (panelName === "build") {
      const previewPlotId = navigation.state.previewPlotId;
      if (previewPlotId && previewPlotId !== lastBuildPreviewPlotId) panel.scrollTop = 0;
      lastBuildPreviewPlotId = previewPlotId;
    } else {
      lastBuildPreviewPlotId = null;
    }
  }

  function render(forcePanel = false) {
    root.classList.toggle("no-active-save", !state);
    if (!state) {
      latestView = null;
      renderPanel(null, forcePanel);
      return;
    }
    const view = buildView();
    latestView = view;
    renderHeader(view);
    const signature = mapSignature(view, navigation.state);
    if (signature !== renderedMapSignature) {
      $("#mapWorld").innerHTML = renderMap(view, navigation.state);
      latestMapModel = createMapModel(view, navigation.state);
      renderedMapSignature = signature;
    } else if (!latestMapModel) {
      latestMapModel = createMapModel(view, navigation.state);
    }
    drawVillageMapCanvas($("#mapTerrainCanvas"), view, navigation.state, animationTime, latestMapModel);
    updateMapMotion($("#mapWorld"), view);
    renderEvents(view);
    root.querySelectorAll(".bottom-nav .tab").forEach(button => {
      const selectedPanel = navigation.state.activePanel === "site"
        ? navigation.state.returnPanel : navigation.state.activePanel;
      button.classList.toggle("active", button.dataset.panel === selectedPanel);
      button.setAttribute("aria-current", button.dataset.panel === selectedPanel ? "page" : "false");
    });
    renderPanel(view, forcePanel);
  }

  function adoptSave(entry) {
    state = entry.state;
    resetAutosaveClock();
    dashboardViews.clear();
    activeId = entry.id;
    saveSession += 1;
    stateRevision = 0;
    autosave.clearFailure();
    transientMode = false;
    persistenceIssue = null;
    numericDrafts.clear();
    upgradePreviewId = null; demolitionPreviewId = null; rightSalePreviewId = null;
    currencyPreview = null; listingPreview = null; stockListingPreview = null; sharePreviewCompanyId = null; buybackPreview = null; companyLevelPreview = null; reformFinishConfirm = false;
    lastBuildPreviewPlotId = null;
    startupError = null;
    saveWarning = entry.recovered ? "此局从自动备份读取；请保存以修复当前存档。" : null;
    pendingAction = null;
    managerOpen = false;
    clock.pause();
    clock.speed = 1;
    dirty = false;
    navigation.resetView();
    mapCamera.reset();
    animationTime = 0;
    renderedMapSignature = "";
    latestMapModel = null;
    renderedEventsSignature = "";
    latestEventKey = eventKey(state.events?.[0]);
    saveNotice = entry.savedAt
      ? `最近保存：${new Date(entry.savedAt).toLocaleString("zh-CN", { hour12: false })} · 成功`
      : "尚未保存";
    render(true);
  }

  async function applyImported(jsonText) {
    try {
      if (!saves) throw persistenceIssue || new Error("本机存储不可用");
      await saves.importFile(jsonText);
      startupError = null;
      saveWarning = null;
      managerOpen = true;
      navigation.openPanel("settings");
      render(true);
      showToast("已导入为独立存档，可从列表读取。", 3500);
    } catch (error) {
      showToast("导入失败，当前进度未更改：" + error.message, 5000);
    }
  }

  function startTemporaryGame() {
    state = createInitialState({ content: simulation.content });
    resetAutosaveClock();
    dashboardViews.clear();
    activeId = null;
    saveSession += 1;
    stateRevision = 0;
    autosave.clearFailure();
    transientMode = true;
    startupError = null;
    saveWarning = "临时游玩不会写入本机存储；刷新或关闭页面后进度不会保留。可随时导出当前进度。";
    saveNotice = "临时游玩：尚未持久保存";
    pendingAction = null;
    managerOpen = false;
    clock.pause();
    clock.speed = 1;
    dirty = true;
    navigation.resetView();
    mapCamera.reset();
    renderedMapSignature = "";
    latestMapModel = null;
    renderedEventsSignature = "";
    latestEventKey = eventKey(state.events?.[0]);
    render(true);
  }

  async function retryPersistentStorage() {
    persistenceBusy = true;
    try {
      if (!storage) { try { storage = window.localStorage; } catch {} }
      if (!saves) saves = await createIndexedSaveManager({ indexedDB: window.indexedDB, legacyStorage: storage, content: simulation.content });
      const probe = await saves.probePersistentStorage();
      if (!probe?.ok) throw new Error("IndexedDB 写入探测未通过");
      const listed = saves.list();
      persistenceIssue = null;
      startupError = null;
      saveWarning = listed.warning || (probe.localStorage?.ok === false ? "IndexedDB 持久保存可用；遗留 localStorage 仍不可写，可在存档管理中导出并按需清理旧数据。" : null);
      return true;
    } catch (error) {
      persistenceIssue = error?.code ? error : classifyPersistenceError(error, "IndexedDB 写入探测");
      startupError = state ? null : persistenceIssue;
      console.error("[麦乡存档] 重试持久存储失败", error, error?.cause || "");
      return false;
    } finally {
      persistenceBusy = false;
    }
  }

  function exportCurrentState() {
    if (!state) return false;
    const blob = new Blob([exportState(state)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `maixiang-current-year${state.year}-day${state.day}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  }

  async function clickHandler(event) {
    const target = event.target;
    const clickedButton = closest(target, "button");
    if (clickedButton && clickedButton.id !== "soundToggle" && !clickedButton.disabled && !clickedButton.matches("[data-start-building]")) {
      sound.playClick();
    }
    const commitButton = closest(target, "[data-draft-commit]");
    if (commitButton) {
      const input = commitButton.closest(".number-editor")?.querySelector("[data-draft-key]");
      commitNumericDraft(commitButton.dataset.draftCommit, input);
      return;
    }
    if (closest(target, "#soundToggle")) {
      const muted = sound.toggleMute();
      if (!muted) sound.playClick();
      render();
      showToast(muted ? "音效已静音。" : "音效已开启。");
      return;
    }
    const autosaveButton = closest(target, "[data-autosave-months]");
    if (autosaveButton && state) {
      const result = simulation.setAutosaveMonths(state, autosaveButton.dataset.autosaveMonths);
      if (result.ok) {
        dirty = true;
        resetAutosaveClock();
        render();
        const label = { 1: "每月", 3: "每3月", 6: "每半年" }[result.value] || result.value;
        showToast(`自动存档已设为${label}。`);
      } else {
        showToast(result.reason || "设置失败。");
      }
      return;
    }
    if (mapCamera.consumeSuppressedClick() && closest(target, "#mapStage")) {
      event.preventDefault();
      return;
    }
    if (!clickedButton && closest(target, "[data-site], [data-plot]")) sound.playClick();
    const zoom = closest(target, "[data-map-zoom]");
    if (zoom) {
      mapCamera.zoomBy(Number(zoom.dataset.mapZoom));
      return;
    }
    if (closest(target, "[data-map-reset]")) {
      mapCamera.reset();
      return;
    }
    const speed = closest(target, "[data-speed]");
    if (speed && state) {
      clock.setSpeed(Number(speed.dataset.speed));
      render();
      return;
    }
    if (closest(target, "#pauseBtn")) {
      clock.pause();
      void saveIfDirty();
      render();
      return;
    }
    if (closest(target, "#settingsBtn")) {
      managerOpen = false;
      pendingAction = null;
      navigation.openPanel("settings");
      render();
      return;
    }
    if (closest(target, "[data-open-save-manager]")) {
      managerOpen = true;
      render(true);
      return;
    }
    if (closest(target, "[data-close-save-manager]")) {
      managerOpen = false;
      pendingAction = null;
      render(true);
      return;
    }
    if (closest(target, "[data-cancel-save-action]")) {
      pendingAction = null;
      render(true);
      return;
    }
    if (closest(target, "[data-start-temporary]")) {
      startTemporaryGame();
      showToast("已进入临时游玩；刷新后进度不会保留。", 4200);
      return;
    }
    if (closest(target, "[data-retry-storage]")) {
      if (!await retryPersistentStorage()) { render(true); showToast(persistenceIssue?.message || "本机存储仍不可用。", 5000); return; }
      if (!state) {
        try {
          const loaded = saves.initialize();
          state = loaded.state; activeId = loaded.activeId; saveWarning = loaded.warning;
          resetAutosaveClock();
          if (state && activeId) {
            const entry = saves.read(activeId);
            adoptSave(entry);
            showToast("本机存储已恢复，存档已读取。");
            return;
          }
        } catch (error) {
          persistenceIssue = error; startupError = error;
          console.error("[麦乡存档] 恢复后初始化失败", error, error?.cause || "");
          render(true); showToast(error.message, 5000); return;
        }
      }
      render(true); showToast("本机存储已恢复。", 3200);
      return;
    }
    if (closest(target, "[data-persist-temporary]") && state && transientMode) {
      if (!await retryPersistentStorage()) { render(true); showToast(persistenceIssue?.message || "本机存储仍不可用。", 5000); return; }
      try {
        const entry = await saves.saveAs(state, `临时进度 ${saves.list().slots.length + 1}`);
        adoptSave(entry);
        showToast("临时进度已保存为本机存档。", 3600);
      } catch (error) {
        persistenceIssue = error;
        console.error("[麦乡存档] 临时进度持久化失败", error, error?.cause || "");
        render(true); showToast(error.message, 5000);
      }
      return;
    }
    if (closest(target, "[data-export-current]")) {
      if (exportCurrentState()) showToast("当前进度已导出。", 3200);
      return;
    }
    const exportLegacy = closest(target, "[data-export-legacy]");
    if (exportLegacy && saves) {
      try {
        const raw = saves.exportLegacy(exportLegacy.dataset.exportLegacy);
        const blob = new Blob([raw], { type: "application/json;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `maixiang-legacy-${Date.now()}.json`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        showToast("遗留数据已导出。", 3200);
      } catch (error) { showToast("导出遗留数据失败：" + error.message, 5000); }
      return;
    }
    const cleanLegacy = closest(target, "[data-clean-legacy]");
    if (cleanLegacy && saves) {
      const artifact = saves.legacyArtifacts().find(row => row.key === cleanLegacy.dataset.cleanLegacy);
      if (!artifact) return;
      pendingAction = { kind: "legacy-clean", key: artifact.key, title: `清理「${artifact.label}」？`,
        message: "只删除这一项 localStorage 原数据。IndexedDB 已校验归档仍会保留；不会自动清理其他进度。" };
      render(true);
      return;
    }
    if (closest(target, "[data-new-game]")) {
      pendingAction = { kind: "new", title: "开始新游戏？", message: transientMode
        ? "当前为临时游玩，不会自动持久保存；如需保留请先导出。新局将尝试建立独立本机存档。"
        : state ? "当前进度将先保存，新局使用独立存档。" : "将创建独立本机存档并进入新局。" };
      render(true);
      return;
    }
    const loadSlot = closest(target, "[data-load-slot]");
    if (loadSlot && saves) {
      const entry = saves.list().slots.find(slot => slot.id === loadSlot.dataset.loadSlot);
      if (!entry || entry.damaged) return;
      pendingAction = { kind: "load", id: entry.id, title: `读取「${entry.name}」？`, message: "当前进度将先保存；读取后时光保持暂停。" };
      render(true);
      return;
    }
    const deleteSlot = closest(target, "[data-delete-slot]");
    if (deleteSlot && saves) {
      const entry = saves.list().slots.find(slot => slot.id === deleteSlot.dataset.deleteSlot);
      if (!entry) return;
      pendingAction = { kind: "delete", id: entry.id, title: `删除「${entry.name}」？`, message: "删除后无法在游戏中恢复。" };
      render(true);
      return;
    }
    if (closest(target, "[data-confirm-save-action]") && pendingAction) {
      const action = pendingAction;
      const pausesForOperation = action.kind === "new" || action.kind === "load" || (action.kind === "delete" && action.id === activeId);
      const wasPaused = clock.paused;
      if (pausesForOperation) clock.pause();
      autosave.suspend();
      try {
        await autosave.waitForIdle();
        if (action.kind !== "delete" && state && !transientMode && !await autosave.flushSuspended({ force: true })) {
          if (!wasPaused && pausesForOperation) clock.resume();
          showToast("当前进度保存失败，未切换存档。", 5000);
          return;
        }
        if (action.kind === "new") {
          if (!saves && !await retryPersistentStorage()) throw persistenceIssue || new Error("本机存储不可用");
          const entry = await saves.createNew(`新游戏 ${saves.list().slots.length + 1}`);
          adoptSave(entry);
          showToast("新游戏已开始，时光保持暂停。");
        } else if (action.kind === "load") {
          adoptSave(await saves.activate(action.id));
          showToast("存档已读取，时光保持暂停。");
        } else if (action.kind === "legacy-clean") {
          const result = await saves.removeLegacy(action.key);
          pendingAction = null;
          render(true);
          showToast(result.removed ? "遗留 localStorage 数据已清理；IndexedDB 归档仍保留。" : "该项 localStorage 已不存在。", 3800);
        } else if (action.kind === "delete") {
          const result = await saves.remove(action.id);
          pendingAction = null;
          if (result.current) {
            state = null;
            dashboardViews.clear();
            latestView = null;
            activeId = null;
            saveSession += 1;
            stateRevision = 0;
            autosave.clearFailure();
            dirty = false;
            clock.pause();
            numericDrafts.clear();
            upgradePreviewId = null; demolitionPreviewId = null; rightSalePreviewId = null;
            currencyPreview = null; listingPreview = null; stockListingPreview = null; sharePreviewCompanyId = null; buybackPreview = null; companyLevelPreview = null; reformFinishConfirm = false;
            navigation.resetView();
            navigation.openPanel("settings");
            managerOpen = true;
            renderedMapSignature = "";
            latestMapModel = null;
            renderedEventsSignature = "";
          }
          render(true);
          showToast(result.current ? "已删除当前存档，请选择存档或开始新游戏。" : "存档已删除。");
        }
      } catch (error) {
        if (!wasPaused && pausesForOperation && state) clock.resume();
        persistenceIssue = error?.code ? error : persistenceIssue;
        if (error?.code) console.error("[麦乡存档] 存档操作失败", error, error?.cause || "");
        pendingAction = null;
        managerOpen = true;
        navigation.openPanel("settings");
        render(true);
        showToast("操作失败：" + error.message, 5000);
      } finally {
        autosave.resume();
      }
      return;
    }
    if (closest(target, "[data-save-current]")) {
      if (transientMode) {
        showToast("当前为临时游玩；请选择“保存到本机”或“导出当前进度”。", 4200);
      } else if (await saveIfDirty(true)) { render(true); showToast("当前进度已保存。"); }
      return;
    }
    if (closest(target, "[data-save-as]") && state && saves && !transientMode) {
      const name = $("#saveAsName")?.value;
      if (!name?.trim()) { showToast("请输入新存档名称。"); return; }
      const wasPaused = clock.paused;
      clock.pause();
      autosave.suspend();
      try {
        await autosave.waitForIdle();
        if (!await autosave.flushSuspended({ force: true })) {
          if (!wasPaused) clock.resume();
          showToast("当前进度保存失败，未创建新存档。", 5000);
          return;
        }
        adoptSave(await saves.saveAs(state, name));
        showToast("已另存为独立存档。");
      } catch (error) {
        if (!wasPaused && state) clock.resume();
        showToast("另存失败：" + error.message, 5000);
      } finally {
        autosave.resume();
      }
      return;
    }
    const renameSlot = closest(target, "[data-rename-slot]");
    if (renameSlot) {
      const name = Array.from(root.querySelectorAll("[data-rename-input]"))
        .find(input => input.dataset.renameInput === renameSlot.dataset.renameSlot)?.value;
      autosave.suspend();
      try {
        await autosave.waitForIdle();
        await saves.rename(renameSlot.dataset.renameSlot, name);
        render(true);
        showToast("存档已重命名。");
      } catch (error) { showToast("重命名失败：" + error.message, 5000); }
      finally { autosave.resume(); }
      return;
    }
    const exportSlot = closest(target, "[data-export-slot]");
    if (exportSlot && saves) {
      try {
        const entry = saves.read(exportSlot.dataset.exportSlot);
        const blob = new Blob([exportState(entry.state)], { type: "application/json;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `maixiang-save-year${entry.state.year}-day${entry.state.day}.json`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        showToast("存档文件已导出。");
      } catch (error) { showToast("导出失败：" + error.message, 5000); }
      return;
    }
    const resource = closest(target, "[data-resource]");
    if (resource) {
      navigation.openPanel(resource.dataset.resource);
      render();
      return;
    }
    const navButton = closest(target, ".bottom-nav [data-panel]");
    if (navButton) {
      navigation.openPanel(navButton.dataset.panel, true);
      render();
      return;
    }
    if (closest(target, "#panelClose")) {
      if (!state) return;
      navigation.closePanel();
      render();
      return;
    }
    if (closest(target, "[data-back]")) {
      navigation.backFromSite();
      upgradePreviewId = null;
      demolitionPreviewId = null;
      render();
      return;
    }
    const goPanel = closest(target, "[data-go]");
    if (goPanel) {
      navigation.openPanel(goPanel.dataset.go);
      render();
      return;
    }
    const openBuilding = closest(target, "[data-open-building]");
    if (openBuilding) {
      navigation.openSite(`building:${openBuilding.dataset.openBuilding}`);
      renderedMapSignature = "";
      latestMapModel = null;
      render();
      return;
    }
    if (closest(target, "#eventToggle")) {
      navigation.state.eventsExpanded = !navigation.state.eventsExpanded;
      navigation.state.eventsDismissed = false;
      renderedEventsSignature = "";
      render();
      return;
    }
    if (closest(target, "#eventClose")) {
      navigation.dismissEvents();
      renderedEventsSignature = "";
      render();
      return;
    }
    if (closest(target, "[data-import-save]")) {
      const input = $("#saveImportFile");
      if (input) {
        input.value = "";
        input.click();
      }
      return;
    }
    const projectAdjust = closest(target, "[data-project-step]");
    if (projectAdjust && state) {
      const projectId = projectAdjust.dataset.projectStep;
      const draftKey = `project-workers:${projectId}`;
      if (numericDrafts.has(draftKey)) {
        setDraftError(draftKey, "人数草稿尚未确认；请先点“确认”，再使用加减按钮。", numericInputFor(draftKey));
        return;
      }
      const view = buildView();
      const project = (view.projects || []).find(row => row.instanceId === projectId);
      if (!project) return;
      const result = simulation.setProjectWorkers(state, projectId, project.workers + Number(projectAdjust.dataset.step));
      if (!result.ok) showToast(result.reason);
      changed(true);
      renderedMapSignature = "";
      latestMapModel = null;
      render();
      return;
    }
    const adjust = closest(target, "[data-job][data-step]");
    if (adjust && state) {
      const draftKey = `workers:${adjust.dataset.job}`;
      if (numericDrafts.has(draftKey)) {
        setDraftError(draftKey, "人数草稿尚未确认；请先点“确认”，再使用加减按钮。", numericInputFor(draftKey));
        return;
      }
      const view = buildView();
      const row = view.labor.rows.find(item => item.key === adjust.dataset.job);
      if (!row) return;
      const base = row.roleId === "farmers" ? (row.targetCount ?? row.count) : row.count;
      const result = simulation.setEmployment(state, row.key, base + Number(adjust.dataset.step));
      if (!result.ok) showToast(result.reason);
      changed(true);
      renderedMapSignature = "";
      latestMapModel = null;
      render();
      return;
    }
    if (closest(target, "[data-reclaim-submit]") && state) {
      const view = buildView();
      const reclaim = view.reclaim;
      if (!reclaim) return;
      const acres = readStagedNumber("reclaim-acres", {
        label: "本次开荒亩数", minimum: 1, maximum: reclaim.remaining, integer: true, positive: true
      });
      if (acres === null) return;
      const workers = readStagedNumber("reclaim-workers", {
        label: "投入开荒人数", minimum: 1, maximum: 100000, integer: true, positive: true
      });
      if (workers === null) return;
      const result = simulation.reclaimFarmland(state, acres, workers);
      if (!result.ok) { showToast(result.reason); return; }
      numericDrafts.clear();
      changed(true);
      renderedMapSignature = "";
      latestMapModel = null;
      render(true);
      showToast(`已开荒${number(result.acres)}亩，投入${number(result.workers)}人、${number(result.workDays)}工日；镇库支付${number(result.paidVoucher, 2)}${moneyUnit(view)}工资。`, 4200);
      return;
    }
    if (closest(target, "[data-reform-start]") && state) {
      const result = simulation.startCurrencyReform(state);
      if (!result.ok) { showToast(result.reason); return; }
      reformFinishConfirm = false;
      changed(true);
      render(true);
      showToast("货币改革已启动，进入过渡期；目标粮券比例初始为0%。", 4200);
      return;
    }
    if (closest(target, "[data-bank-open]") && state) {
      const reform = buildView().monetaryReform;
      navigation.openSite(reform.bankBuildingId ? `building:${reform.bankBuildingId}` : "bank-compat");
      render(true);
      return;
    }
    if (closest(target, "[data-reform-finish-preview]") && state) {
      reformFinishConfirm = true;
      render(true);
      return;
    }
    if (closest(target, "[data-reform-finish-cancel]")) {
      reformFinishConfirm = false;
      render(true);
      return;
    }
    if (closest(target, "[data-reform-finish-confirm]") && state) {
      const result = simulation.finishCurrencyReform(state);
      if (!result.ok) { showToast(result.reason); reformFinishConfirm = false; render(true); return; }
      reformFinishConfirm = false;
      changed(true);
      render(true);
      showToast("过渡期已结束，新产生的货币交易固定使用粮券。", 4200);
      return;
    }
    if (closest(target, "#manualAid") && state) {
      const result = simulation.sendRelief(state, simulation.content.rules.manualReliefAmountJin);
      changed(true);
      render();
      showToast(result.movedQeqUnits > 0
        ? `已向居民账拨出 ${number(result.movedQeqUnits / simulation.content.precision.qeqUnitsPerJin)}斤口粮。`
        : "镇库已无可拨口粮。");
      return;
    }
    const currencyPreviewButton = closest(target, "[data-currency-preview]");
    if (currencyPreviewButton && state) {
      const amount = readStagedNumber("currency-amount", { label: "粮券数量", positive: true });
      if (amount === null) return;
      const view = buildView();
      if (currencyPreviewButton.dataset.currencyPreview === "redeem" && amount > view.currency.townVoucher + 1e-9) {
        showToast("镇库粮券余额不足，不能注销这么多粮券。"); return;
      }
      const type = currencyPreviewButton.dataset.currencyPreview;
      currencyPreview = {
        type, amount,
        afterTownVoucher: view.currency.townVoucher + (type === "issue" ? amount : -amount),
        afterIssued: view.currency.issuedVoucher + (type === "issue" ? amount : -amount)
      };
      render(true);
      return;
    }
    if (closest(target, "[data-currency-preview-cancel]")) {
      currencyPreview = null; render(true); return;
    }
    const currencyConfirm = closest(target, "[data-currency-confirm]");
    if (currencyConfirm && state && currencyPreview) {
      const result = currencyConfirm.dataset.currencyConfirm === "issue"
        ? simulation.issueGrainVouchers(state, "town", currencyPreview.amount)
        : simulation.redeemGrainVouchers(state, "town", currencyPreview.amount);
      if (!result.ok) { showToast(result.reason); render(true); return; }
      if (currencyConfirm.dataset.currencyConfirm === "issue") state.currency.guidancePending = false;
      const action = currencyConfirm.dataset.currencyConfirm === "issue" ? "印制发行" : "注销";
      currencyPreview = null; numericDrafts.delete("currency-amount"); changed(true); render(true);
      showToast(`已${action}${number(result.voucherUnits / simulation.content.precision.currencyUnitsPerVoucher, 2)}粮券。`);
      return;
    }
    const intermediatePrice = closest(target, "[data-intermediate-price]");
    if (intermediatePrice && state) {
      const itemId = intermediatePrice.dataset.intermediatePrice;
      const price = readStagedNumber(`intermediate:${itemId}`, { label: "中间品价格", positive: true });
      if (price === null) return;
      const result = simulation.configureIntermediatePrice(state, itemId, price);
      if (!result.ok) { showToast(result.reason); return; }
      numericDrafts.delete(`intermediate:${itemId}`); changed(true); render(true);
      showToast(`${{ flour: "面粉", bread: "面包", wood: "木材" }[itemId] || itemId}价格已设为${number(result.value, 3)}小麦等值/${itemId === "wood" ? "单位" : "斤"}。`);
      return;
    }
    const companyPreviewButton = closest(target, "[data-company-preview]");
    if (companyPreviewButton && state) {
      const buildingId = companyPreviewButton.dataset.companyPreview;
      const building = buildView().buildings.find(row => row.id === buildingId);
      if (!building) return;
      const levels = readStagedNumber(`company-form:${buildingId}:levels`, { label: "划入公司等级", integer: true, minimum: 1, maximum: building.ownership.townLevels });
      const capital = readStagedNumber(`company-form:${buildingId}:capital`, { label: "初始经营资金（小麦等值）", minimum: 0 });
      const material = readStagedNumber(`company-form:${buildingId}:material`, { label: "初始原料数量", minimum: 0 });
      const name = (root.querySelector(`[data-company-name="${CSS.escape(buildingId)}"]`)?.value || `${building.name}公司`).trim().slice(0, 30);
      if (levels === null || capital === null || material === null || !name) return;
      listingPreview = { buildingId, name, levels, capital, material };
      render(true); return;
    }
    if (closest(target, "[data-company-preview-cancel]")) { listingPreview = null; render(true); return; }
    const companyCreate = closest(target, "[data-company-create]");
    if (companyCreate && state && listingPreview?.buildingId === companyCreate.dataset.companyCreate) {
      const result = simulation.createCompany(state, listingPreview.buildingId, {
        name: listingPreview.name, levels: listingPreview.levels,
        operatingCapitalVoucher: listingPreview.capital, initialMaterialQuantity: listingPreview.material
      });
      if (!result.ok) { showToast(result.reason); render(true); return; }
      const id = listingPreview.buildingId;
      for (const suffix of ["levels", "capital", "material"]) numericDrafts.delete(`company-form:${id}:${suffix}`);
      listingPreview = null; changed(true); renderedMapSignature = ""; render(true);
      showToast(`公司已成立，${number(result.levels)}级产能由公司独立经营；尚未上市。`);
      return;
    }
    const stockListPreviewButton = closest(target, "[data-stock-list-preview]");
    if (stockListPreviewButton && state) {
      const companyId = stockListPreviewButton.dataset.stockListPreview;
      const company = buildView().companies.find(row => row.id === companyId);
      if (!company) return;
      const totalShares = readStagedNumber(`stock-list:${companyId}:total`, { label: "总股本", integer: true, minimum: 1 });
      const price = readStagedNumber(`stock-list:${companyId}:price`, { label: "每股价格", positive: true });
      const offeredShares = readStagedNumber(`stock-list:${companyId}:offered`, { label: "本次出售股数", integer: true, minimum: 0 });
      const ticker = (root.querySelector(`[data-stock-ticker="${CSS.escape(companyId)}"]`)?.value || "").trim();
      if (totalShares === null || price === null || offeredShares === null) return;
      let reason = null;
      if (!/^\d{3}$/.test(ticker)) reason = "股票代码必须是三位数字";
      else if (totalShares % company.listedLevels !== 0) reason = `总股本须能被${company.listedLevels}级整除`;
      else if (offeredShares > totalShares) reason = "本次出售股数不能超过总股本";
      stockListingPreview = { companyId, ticker, totalShares, price, offeredShares, totalValue: totalShares * price, plannedProceeds: offeredShares * price, townPercentAfter: totalShares ? (totalShares - offeredShares) / totalShares * 100 : 0, reason };
      render(true); return;
    }
    if (closest(target, "[data-stock-list-cancel]")) { stockListingPreview = null; render(true); return; }
    const stockListConfirm = closest(target, "[data-stock-list-confirm]");
    if (stockListConfirm && state && stockListingPreview?.companyId === stockListConfirm.dataset.stockListConfirm) {
      const p = stockListingPreview;
      const result = simulation.listCompanyShares(state, p.companyId, { ticker: p.ticker, totalShares: p.totalShares, priceVoucherPerShare: p.price, offeredShares: p.offeredShares });
      if (!result.ok) { showToast(result.reason + (result.nearby?.length ? `；可选${result.nearby.join("、")}股` : "")); render(true); return; }
      for (const suffix of ["total", "price", "offered"]) numericDrafts.delete(`stock-list:${p.companyId}:${suffix}`);
      stockListingPreview = null; changed(true); render(true); showToast(`${p.ticker} 已挂牌；股份仍由镇库持有，居民认购后才实际成交。`); return;
    }
    const sharePreviewButton = closest(target, "[data-share-preview]");
    if (sharePreviewButton && state) {
      const companyId = sharePreviewButton.dataset.sharePreview;
      const viewCompany = buildView().companies.find(row => row.id === companyId);
      if (!viewCompany) return;
      const shares = readStagedNumber(`share:${companyId}:count`, { label: "出售股数", integer: true, minimum: 0, maximum: viewCompany.townShares });
      const price = readStagedNumber(`share:${companyId}:price`, { label: "每股售价", positive: true });
      if (shares === null || price === null) return;
      const result = simulation.configureShareOffer(state, companyId, shares, price);
      if (!result.ok) { showToast(result.reason); return; }
      sharePreviewCompanyId = companyId; changed(true); render(true); return;
    }
    if (closest(target, "[data-share-cancel]")) { sharePreviewCompanyId = null; render(true); return; }
    const shareConfirm = closest(target, "[data-share-confirm]");
    if (shareConfirm && state) {
      const companyId = shareConfirm.dataset.shareConfirm;
      const result = simulation.subscribeShares(state, companyId);
      if (!result.ok) { showToast(result.reason); render(true); return; }
      sharePreviewCompanyId = null; changed(true); render(true);
      showToast(`居民认购${number(result.subscribedShares)}股，实际成交收入${number(result.proceedsVoucherUnits / simulation.content.precision.currencyUnitsPerVoucher, 2)}粮券归镇库。`);
      return;
    }
    const companyCapital = closest(target, "[data-company-capital]");
    if (companyCapital && state) {
      const companyId = companyCapital.dataset.companyCapital;
      const amount = readStagedNumber(`company:${companyId}:capital`, { label: "追加经营资金（小麦等值）", positive: true });
      if (amount === null) return;
      const result = simulation.addCompanyCapital(state, companyId, amount);
      if (!result.ok) { showToast(result.reason); return; }
      numericDrafts.delete(`company:${companyId}:capital`); changed(true); render(true);
      showToast(`已向公司注资${number(amount, 2)}小麦等值。`); return;
    }
    const companyWage = closest(target, "[data-company-wage]");
    if (companyWage && state) {
      const companyId = companyWage.dataset.companyWage;
      const value = readStagedNumber(`company:${companyId}:wage`, { label: "公司日薪", minimum: 0 });
      if (value === null) return;
      const result = simulation.configureCompanyWage(state, companyId, value);
      if (!result.ok) { showToast(result.reason); return; }
      numericDrafts.delete(`company:${companyId}:wage`); changed(true); render(true); return;
    }
    const companyTarget = closest(target, "[data-company-target]");
    if (companyTarget && state) {
      const companyId = companyTarget.dataset.companyTarget;
      const company = buildView().companies.find(row => row.id === companyId);
      if (!company) return;
      const value = readStagedNumber(`company:${companyId}:target`, { label: "公司目标用工", integer: true, minimum: 0, maximum: company.capacity });
      if (value === null) return;
      const result = simulation.configureCompanyTargetWorkers(state, companyId, value);
      if (!result.ok) { showToast(result.reason); return; }
      numericDrafts.delete(`company:${companyId}:target`); changed(true); render(true); return;
    }
    const companyPrice = closest(target, "[data-company-price]");
    if (companyPrice && state) {
      const companyId = companyPrice.dataset.companyPrice, itemId = companyPrice.dataset.itemId;
      const value = readStagedNumber(`company:${companyId}:price:${itemId}`, { label: "公司售价", positive: true });
      if (value === null) return;
      const result = simulation.configureCompanySalePrice(state, companyId, itemId, value);
      if (!result.ok) { showToast(result.reason); return; }
      numericDrafts.delete(`company:${companyId}:price:${itemId}`); changed(true); render(true); return;
    }
    const levelPreviewButton = closest(target, "[data-company-level-preview]");
    if (levelPreviewButton && state) {
      const companyId = levelPreviewButton.dataset.companyLevelPreview;
      const direction = levelPreviewButton.dataset.direction;
      const preview = simulation.previewCompanyLevelChange(state, companyId, direction);
      companyLevelPreview = { companyId, direction, preview };
      render(true); return;
    }
    if (closest(target, "[data-company-level-cancel]")) { companyLevelPreview = null; render(true); return; }
    const levelConfirm = closest(target, "[data-company-level-confirm]");
    if (levelConfirm && state && companyLevelPreview?.companyId === levelConfirm.dataset.companyLevelConfirm) {
      const { companyId, direction, preview: shown } = companyLevelPreview;
      const current = simulation.previewCompanyLevelChange(state, companyId, direction);
      const signature = row => JSON.stringify([row?.available, row?.reason || null, row?.levelsBefore, row?.levelsAfter, row?.issuedShares || 0, row?.cancelledShares || 0, row?.totalSharesBefore || 0, row?.totalSharesAfter || 0, row?.townSharesBefore || 0, row?.townSharesAfter || 0, Math.round((row?.townPercentBefore || 0) * 1e6), Math.round((row?.townPercentAfter || 0) * 1e6)]);
      if (signature(current) !== signature(shown)) {
        companyLevelPreview = { companyId, direction, preview: current };
        render(true); showToast("等级与股权条件已变化，预览已更新，请再次确认。"); return;
      }
      const result = direction === "remove"
        ? simulation.removeCompanyOperatingLevel(state, companyId)
        : simulation.addCompanyOperatingLevel(state, companyId);
      if (!result.ok) { companyLevelPreview = { companyId, direction, preview: simulation.previewCompanyLevelChange(state, companyId, direction) }; showToast(result.reason); render(true); return; }
      companyLevelPreview = null; changed(true); render(true);
      showToast(direction === "remove"
        ? (result.cancelledShares ? `已划回1级并注销镇库${number(result.cancelledShares)}股。` : "已划回1级。")
        : (result.issuedShares ? `已划入1级并向镇库增发${number(result.issuedShares)}股。` : "已划入1级镇营产能。"));
      return;
    }
    const liquidate = closest(target, "[data-company-liquidate]");
    if (liquidate && state) {
      if (!window.confirm("确认全部划回公司等级并清算？居民股份或工资债务未清时会被拒绝。")) return;
      const result = simulation.liquidateCompany(state, liquidate.dataset.companyLiquidate);
      if (!result.ok) { showToast(result.reason); return; }
      changed(true); render(true); showToast("公司已完成清算并将全部等级划回镇营。"); return;
    }
    const buybackPreviewButton = closest(target, "[data-company-buyback-preview]");
    if (buybackPreviewButton && state) {
      const companyId = buybackPreviewButton.dataset.companyBuybackPreview;
      const shares = readStagedNumber(`buyback:${companyId}:count`, { label: "回购股数", integer: true, minimum: 1 });
      const price = readStagedNumber(`buyback:${companyId}:price`, { label: "回购价", positive: true });
      if (shares === null || price === null) return;
      const preview = simulation.previewTownBuyback(state, companyId, { shares, priceVoucherPerShare: price });
      buybackPreview = { companyId, shares, price, preview };
      render(true); return;
    }
    if (closest(target, "[data-company-buyback-cancel]")) { buybackPreview = null; render(true); return; }
    const buybackConfirm = closest(target, "[data-company-buyback-confirm]");
    if (buybackConfirm && state && buybackPreview?.companyId === buybackConfirm.dataset.companyBuybackConfirm) {
      const { companyId, shares, price, preview: shown } = buybackPreview;
      const current = simulation.previewTownBuyback(state, companyId, { shares, priceVoucherPerShare: price });
      const signature = row => JSON.stringify([row?.available, row?.reason || null, row?.requestedShares || 0, row?.willingShares || 0, row?.affordableShares || 0, row?.executableShares || 0, row?.costVoucherUnits || 0, row?.priceVoucherUnits || 0, row?.reference?.referencePerShareVoucherUnits || 0]);
      if (signature(current) !== signature(shown)) {
        buybackPreview = { companyId, shares, price, preview: current };
        render(true); showToast("回购条件已变化，成交数量或成本已更新，请再次确认。"); return;
      }
      const result = simulation.buybackCompanyShares(state, companyId, { shares, priceVoucherPerShare: price });
      if (!result.ok) { buybackPreview = { companyId, shares, price, preview: simulation.previewTownBuyback(state, companyId, { shares, priceVoucherPerShare: price }) }; showToast(result.reason); render(true); return; }
      buybackPreview = null; changed(true); render(true); showToast(`镇库已回购${number(result.boughtShares)}股，实际支付${number(result.paidVoucherUnits / simulation.content.precision.currencyUnitsPerVoucher, 2)}粮券。`); return;
    }

    const shopOpen = closest(target, "[data-shop-open]");
    if (shopOpen && state) {
      const result = simulation.openResidentShop(state, shopOpen.dataset.shopBuilding, shopOpen.dataset.shopOpen);
      if (!result.ok) { showToast(result.reason); return; }
      changed(true); renderedMapSignature = ""; render(true);
      showToast(`店铺已开业，家庭投入${number(result.startupVoucher, 2)}小麦等值。`);
      return;
    }
    const shopMerchant = closest(target, "[data-shop-merchant][data-step]");
    if (shopMerchant && state) {
      const shop = buildView().shops.find(row => row.id === shopMerchant.dataset.shopMerchant);
      if (!shop) return;
      const result = simulation.configureShopMerchants(state, shop.id, shop.merchants + Number(shopMerchant.dataset.step));
      if (!result.ok) { showToast(result.reason); return; }
      changed(true); render(true);
      return;
    }
    const shopClerk = closest(target, "[data-shop-clerk][data-step]");
    if (shopClerk && state) {
      const shop = buildView().shops.find(row => row.id === shopClerk.dataset.shopClerk);
      if (!shop) return;
      const result = simulation.configureShopClerks(state, shop.id, shop.clerks + Number(shopClerk.dataset.step));
      if (!result.ok) { showToast(result.reason); return; }
      changed(true); render(true);
      return;
    }
    const shopClose = closest(target, "[data-shop-close]");
    if (shopClose && state) {
      const result = simulation.closeResidentShop(state, shopClose.dataset.shopClose);
      if (!result.ok) { showToast(result.reason); return; }
      changed(true); renderedMapSignature = ""; render(true);
      showToast(result.liquidationPending ? "店铺已停业，岗位已释放，剩余债务进入清算。" : "店铺已停业并完成清算。");
      return;
    }
    const shopFund = closest(target, "[data-shop-fund]");
    if (shopFund && state) {
      const result = simulation.fundResidentShopLiquidation(state, shopFund.dataset.shopFund);
      if (!result.ok) { showToast(result.reason); return; }
      changed(true); renderedMapSignature = ""; render(true);
      showToast(result.liquidationPending ? "业主已补资，仍有债务待清偿。" : "债务已清偿，剩余资产已返还业主。");
      return;
    }
    const choose = closest(target, ".choose-build[data-build]");
    if (choose && state) {
      if (navigation.state.buildType === choose.dataset.build) {
        navigation.cancelBuild();
        simulation.clearPublicProcurementIntent(state, "wood");
        invalidateStateView();
      } else {
        navigation.chooseBuild(choose.dataset.build);
        simulation.setPublicProcurementIntent(state, { kind: "build", typeId: choose.dataset.build });
        invalidateStateView();
      }
      renderedMapSignature = "";
      latestMapModel = null;
      render();
      return;
    }
    if (closest(target, "[data-cancel-build]")) {
      navigation.reselectBuildPlot();
      renderedMapSignature = "";
      latestMapModel = null;
      render();
      return;
    }
    if (closest(target, "[data-start-building]") && state) {
      const { buildType, previewPlotId } = navigation.state;
      if (!buildType || !previewPlotId) return;
      const result = simulation.buildAt(state, buildType, previewPlotId);
      if (!result.ok) {
        showToast(result.reason);
        render(true);
        return;
      }
      const name = simulation.content.buildings[buildType]?.name || buildType;
      navigation.finishBuild();
      changed(true);
      renderedMapSignature = "";
      latestMapModel = null;
      sound.playBuild();
      render();
      showToast(`${name}开工，已安排${number(result.assignedBuilders)}名建筑工。`);
      return;
    }
    if (closest(target, "[data-upgrade-preview]") && state) {
      upgradePreviewId = target.dataset.upgradePreview;
      demolitionPreviewId = null;
      simulation.setPublicProcurementIntent(state, { kind: "upgrade", buildingId: upgradePreviewId });
      invalidateStateView();
      render();
      return;
    }
    if (closest(target, "[data-upgrade-cancel]")) {
      upgradePreviewId = null;
      if (state) { simulation.clearPublicProcurementIntent(state, "wood"); invalidateStateView(); }
      render();
      return;
    }
    if (closest(target, "[data-upgrade-start]") && state) {
      const buildingId = target.dataset.upgradeStart;
      const result = simulation.upgradeBuilding(state, buildingId);
      if (!result.ok) { showToast(result.reason); return; }
      upgradePreviewId = null;
      changed(true);
      renderedMapSignature = "";
      latestMapModel = null;
      sound.playBuild();
      render();
      showToast("升级已开工；新增岗位完工后开放。");
      return;
    }
    if (closest(target, "[data-demolish-preview]") && state) {
      demolitionPreviewId = target.dataset.demolishPreview;
      upgradePreviewId = null;
      render();
      return;
    }
    if (closest(target, "[data-demolish-cancel]")) {
      demolitionPreviewId = null;
      render();
      return;
    }
    if (closest(target, "[data-demolish-confirm]") && state) {
      const buildingId = target.dataset.demolishConfirm;
      const result = simulation.demolishBuilding(state, buildingId);
      if (!result.ok) { showToast(result.reason); return; }
      demolitionPreviewId = null;
      navigation.state.selectedSite = "field";
      changed(true);
      renderedMapSignature = "";
      latestMapModel = null;
      render();
      showToast(`已拆除${result.preview.name}，返还${result.preview.refund.length}类材料。`);
      return;
    }
    if (closest(target, "[data-right-preview]") && state) {
      rightSalePreviewId = target.dataset.rightPreview;
      render();
      return;
    }
    if (closest(target, "[data-right-cancel]")) {
      rightSalePreviewId = null;
      render();
      return;
    }
    if (closest(target, "[data-right-confirm]") && state) {
      const buildingId = target.dataset.rightConfirm;
      const result = simulation.sellOperatingLevel(state, buildingId);
      if (!result.ok) { showToast(result.reason || result.preview?.reason || "经营权未成交"); render(); return; }
      rightSalePreviewId = null;
      changed(true);
      render();
      showToast(`居民共同购入一级经营权；${result.transferredWorkers}名原镇营工人转入民营岗位。`);
      return;
    }
    const plot = closest(target, "[data-plot]");
    if (plot && state && navigation.state.buildType) {
      navigation.choosePlot(plot.dataset.plot);
      renderedMapSignature = "";
      latestMapModel = null;
      render();
      return;
    }
    const site = closest(target, "[data-site]");
    if (site && state) {
      if (navigation.state.activePanel === "build" && navigation.state.buildType && site.dataset.site === "field") return;
      navigation.openSite(site.dataset.site);
      renderedMapSignature = "";
      latestMapModel = null;
      render();
    }
    const socialTrade = closest(target, "[data-social-repay], [data-social-buy], [data-social-sell]");
    if (socialTrade && state) {
      const companyId = socialTrade.dataset.socialBuy || socialTrade.dataset.socialSell || null;
      const key = companyId ? `social-shares:${companyId}` : "social-repay";
      const input = numericInputFor(key);
      const rawValue = numericDrafts.has(key) ? numericDrafts.get(key).value : input?.value;
      const parsed = parseNumericDraft(rawValue, { label: companyId ? "股数" : "还款金额", minimum: 0, maximum: 1000000000, positive: true, integer: Boolean(companyId) });
      if (!parsed.ok) { setDraftError(key, parsed.reason, input); return; }
      const result = socialTrade.dataset.socialRepay !== undefined ? simulation.repaySocialSecurityDebt(state, parsed.value)
        : socialTrade.dataset.socialBuy ? simulation.socialBuyShares(state, companyId, parsed.value)
        : simulation.socialSellShares(state, companyId, parsed.value);
      if (!result?.ok) { setDraftError(key, result?.reason || "操作失败", input); return; }
      numericDrafts.delete(key);
      changed(true);
      render(true);
      showToast(socialTrade.dataset.socialRepay !== undefined ? `社保基金已还款${number(result.repaidJin, 1)}斤。`
        : socialTrade.dataset.socialBuy ? `社保基金买入${number(result.shares)}股。` : `社保基金卖出${number(result.shares)}股。`);
      return;
    }
    if (target.matches("[data-social-inject]") && state) {
      const input = numericInputFor("social-inject");
      const rawValue = numericDrafts.has("social-inject") ? numericDrafts.get("social-inject").value : input?.value;
      const parsed = parseNumericDraft(rawValue, { label: "注资金额", minimum: 0, maximum: 1000000000 });
      if (!parsed.ok) {
        setDraftError("social-inject", parsed.reason, input);
        return;
      }
      const result = simulation.injectSocialSecurity(state, parsed.value);
      if (!result?.ok) {
        setDraftError("social-inject", result?.reason || "注资失败", input);
        return;
      }
      numericDrafts.delete("social-inject");
      changed(true);
      render(true);
      showToast(`已向社保基金注资${number(result.injectedJin, 1)}斤小麦等值。`);
      return;
    }
    if (target.matches("[data-bond-issue]") && state) {
      const readDraft = (key, label, minimum, maximum) => {
        const input = numericInputFor(key);
        const rawValue = numericDrafts.has(key) ? numericDrafts.get(key).value : input?.value;
        return { parsed: parseNumericDraft(rawValue, { label, minimum, maximum }), input, key };
      };
      const total = readDraft("bond-issue-total", "发行总额", 1, 1000000000);
      if (!total.parsed.ok) { setDraftError(total.key, total.parsed.reason, total.input); return; }
      const years = readDraft("bond-issue-years", "期限", 1, 10);
      if (!years.parsed.ok) { setDraftError(years.key, years.parsed.reason, years.input); return; }
      const rate = readDraft("bond-issue-rate", "起拍票面年利率", 0, 20);
      if (!rate.parsed.ok) { setDraftError(rate.key, rate.parsed.reason, rate.input); return; }
      const result = simulation.issueGovernmentBond(state, {
        totalVoucher: total.parsed.value,
        termYears: years.parsed.value,
        startRateAnnualPercent: rate.parsed.value
      });
      if (!result?.ok) {
        setDraftError(rate.key, result?.reason || "发行失败", rate.input);
        return;
      }
      for (const key of ["bond-issue-total", "bond-issue-years", "bond-issue-rate"]) numericDrafts.delete(key);
      changed(true);
      render(true);
      showToast(`国债${result.issue.id}已发行，进入${7}天认购期。`);
      return;
    }
    // 用户 0.1.11：批发市场单次调运——收储入镇库 / 镇库投放，用来平抑库存。
    const wholesaleMoveButton = closest(target, "[data-wholesale-stockpile],[data-wholesale-release]");
    if (wholesaleMoveButton && state) {
      const isStockpile = wholesaleMoveButton.hasAttribute("data-wholesale-stockpile");
      const itemId = isStockpile ? wholesaleMoveButton.dataset.wholesaleStockpile : wholesaleMoveButton.dataset.wholesaleRelease;
      const key = `wholesale-move:${itemId}`;
      const input = numericInputFor(key);
      const rawValue = numericDrafts.has(key) ? numericDrafts.get(key).value : input?.value;
      const parsed = parseNumericDraft(rawValue, { label: "单次调运量", minimum: 0, maximum: 1000000000, positive: true });
      if (!parsed.ok) {
        setDraftError(key, parsed.reason, input);
        return;
      }
      const result = isStockpile
        ? simulation.stockpileWholesale(state, itemId, parsed.value)
        : simulation.releaseWholesale(state, itemId, parsed.value);
      if (!result?.ok) {
        setDraftError(key, result?.reason || "调运失败", input);
        return;
      }
      numericDrafts.delete(key);
      changed(true);
      render(true);
      const itemUnit = itemId === "wood" ? "单位" : "斤";
      showToast(`${isStockpile ? "已从批发市场收储" : "已向批发市场投放"}${number(result.movedJin, 2)}${itemUnit}。`);
      return;
    }
    // 0.2.3 流通改革：把目标利润率一键应用到所有综合商店。
    const marginAllButton = closest(target, "[data-shop-margin-all]");
    if (marginAllButton && state) {
      const shopId = marginAllButton.dataset.shopMarginAll;
      const key = `shop-margin:${shopId}`;
      const input = numericInputFor(key);
      const rawValue = numericDrafts.has(key) ? numericDrafts.get(key).value : input?.value;
      const parsed = parseNumericDraft(rawValue, { label: "目标利润率", minimum: 0, maximum: 100 });
      if (!parsed.ok) { setDraftError(key, parsed.reason, input); return; }
      const result = simulation.configureAllShopsTargetMargin(state, parsed.value);
      if (!result?.ok) { setDraftError(key, result?.reason || "设置失败", input); return; }
      numericDrafts.delete(key);
      changed(true);
      render(true);
      showToast(`已将${number(result.shops)}家综合商店的目标利润率设为${number(result.targetMarginPercent, 1)}%。`);
      return;
    }
    const buildCategoryTab = closest(target, "[data-build-category]");
    if (buildCategoryTab) {
      setBuildCategory(buildCategoryTab.dataset.buildCategory);
      render(true);
      return;
    }
    const outsideTradeButton = closest(target, "[data-outside-sell],[data-outside-buy]");
    if (outsideTradeButton && state) {
      const itemId = outsideTradeButton.dataset.outsideSell || outsideTradeButton.dataset.outsideBuy;
      const direction = outsideTradeButton.dataset.outsideSell ? "sell" : "buy";
      const key = `outside-qty:${itemId}`;
      const input = numericInputFor(key);
      const rawValue = numericDrafts.has(key) ? numericDrafts.get(key).value : input?.value;
      const parsed = parseNumericDraft(rawValue, { label: "交易数量", minimum: 0, maximum: 100000 });
      if (!parsed.ok) {
        setDraftError(key, parsed.reason, input);
        return;
      }
      const result = simulation.tradeWithOutsideTown(state, direction, itemId, parsed.value);
      if (!result?.ok) {
        setDraftError(key, result?.reason || "交易失败", input);
        return;
      }
      numericDrafts.delete(key);
      changed(true);
      render(true);
      const itemName = { wheat: "小麦", flour: "面粉", bread: "面包", salt: "食盐", wood: "木材" }[itemId] || itemId;
      showToast(direction === "sell"
        ? `已向民镇卖出${number(result.quantityJin, 1)}${itemId === "wood" ? "单位" : "斤"}${itemName}，得小麦${number(result.valueJin, 1)}斤（含关税${number(result.tariffJin, 1)}斤）。`
        : `已从民镇买入${number(result.quantityJin, 1)}斤${itemName}，支付小麦${number(result.valueJin, 1)}斤。`);
      return;
    }
    const wheatLoanButton = closest(target, "[data-wheat-loan-issue]");
    if (wheatLoanButton && state) {
      const principalKey = "wheat-loan-principal";
      const rateKey = "wheat-loan-rate";
      const principalInput = numericInputFor(principalKey);
      const rateInput = numericInputFor(rateKey);
      const principalRaw = numericDrafts.has(principalKey) ? numericDrafts.get(principalKey).value : principalInput?.value;
      const rateRaw = numericDrafts.has(rateKey) ? numericDrafts.get(rateKey).value : rateInput?.value;
      const principalParsed = parseNumericDraft(principalRaw, { label: "放贷斤数", minimum: 0, maximum: 1000000 });
      if (!principalParsed.ok) {
        setDraftError(principalKey, principalParsed.reason, principalInput);
        return;
      }
      const rateParsed = parseNumericDraft(rateRaw, { label: "年利率", minimum: 0, maximum: 50 });
      if (!rateParsed.ok) {
        setDraftError(rateKey, rateParsed.reason, rateInput);
        return;
      }
      const result = simulation.issueWheatLoan(state, principalParsed.value, rateParsed.value);
      if (!result?.ok) {
        setDraftError(principalKey, result?.reason || "放贷失败", principalInput);
        return;
      }
      numericDrafts.delete(principalKey);
      numericDrafts.delete(rateKey);
      changed(true);
      render(true);
      showToast(`已向民镇发放小麦贷款${number(result.loan.principalJin)}斤，年利率${number(result.loan.annualRatePercent, 1)}%。`);
      return;
    }
    // 长期贸易协定（民镇）：签约与解约。
    const agreementSignButton = closest(target, "[data-agreement-sign]");
    if (agreementSignButton && state) {
      const itemKey = "trade-agreement-item";
      const annualKey = "trade-agreement-annual";
      const yearsKey = "trade-agreement-years";
      const itemSelect = document.querySelector(`[data-draft-key="${itemKey}"]`);
      const annualInput = numericInputFor(annualKey);
      const yearsInput = numericInputFor(yearsKey);
      const annualRaw = numericDrafts.has(annualKey) ? numericDrafts.get(annualKey).value : annualInput?.value;
      const yearsRaw = numericDrafts.has(yearsKey) ? numericDrafts.get(yearsKey).value : yearsInput?.value;
      const annualParsed = parseNumericDraft(annualRaw, { label: "年供货量", minimum: 0, maximum: 5000000 });
      if (!annualParsed.ok) {
        setDraftError(annualKey, annualParsed.reason, annualInput);
        return;
      }
      const yearsParsed = parseNumericDraft(yearsRaw, { label: "年限", minimum: 1, maximum: 5, integer: true });
      if (!yearsParsed.ok) {
        setDraftError(yearsKey, yearsParsed.reason, yearsInput);
        return;
      }
      const itemId = itemSelect?.value || "salt";
      const result = simulation.signTradeAgreement(state, { itemId, annualJin: annualParsed.value, years: yearsParsed.value });
      if (!result?.ok) {
        setDraftError(annualKey, result?.reason || "签约失败", annualInput);
        return;
      }
      numericDrafts.delete(annualKey);
      numericDrafts.delete(yearsKey);
      changed(true);
      render(true);
      showToast(`已签署长期协定：年供${number(result.agreement.annualJin)}，锁定单价${number(result.agreement.pricePerUnit, 2)}，为期${result.agreement.yearsTotal}年。`);
      return;
    }
    const agreementTerminateButton = closest(target, "[data-agreement-terminate]");
    if (agreementTerminateButton && state) {
      const result = simulation.terminateTradeAgreement(state, agreementTerminateButton.dataset.agreementTerminate);
      if (!result?.ok) {
        showToast(result?.reason || "解约失败");
        return;
      }
      changed(true);
      render(true);
      showToast(`已解除长期协定，赔付小麦${number(result.paidJin, 1)}斤。`);
      return;
    }
  }

  function changeHandler(event) {
    const target = event.target;
    if (target.matches("[data-draft-key]") && shouldCommitNumericDraftOnChange(target.dataset.draftKind)) {
      commitNumericDraft(target.dataset.draftKey, target);
      return;
    }
    if (target.matches("[data-reform-target-range]") && state) {
      const result = simulation.setVoucherPaymentTarget(state, Number(target.value));
      if (!result.ok) { showToast(result.reason); render(true); return; }
      numericDrafts.delete("voucher-target");
      changed(true);
      render(true);
      return;
    }
    if (target.matches("#residentExchangeEnabled") && state) {
      const result = simulation.setResidentExchangeEnabled(state, target.checked);
      if (!result.ok) { showToast(result.reason); render(true); return; }
      changed(true);
      render(true);
      showToast(target.checked ? "居民粮食换券已开放。" : "居民粮食换券已关闭；已有粮券仍可兑回小麦。");
      return;
    }
    if (target.matches("#autoRelief") && state) {
      simulation.toggleAutomaticRelief(state, target.checked);
      changed(true);
      render();
      showToast(target.checked ? "自动救济已开启。" : "自动救济已关闭。");
      return;
    }
    if (target.matches("#benefitEnabled") && state) {
      const result = simulation.setUnemploymentPolicy(state, {
        enabled: target.checked
      });
      if (!result.ok) showToast(result.reason);
      changed(true);
      render();
      return;
    }
    if (target.matches("#socialSecurityEnabled") && state) {
      const result = simulation.setSocialSecurityPolicy(state, {
        enabled: target.checked
      });
      if (!result.ok) showToast(result.reason);
      changed(true);
      render();
      showToast(target.checked ? "社保基金已开启。" : "社保基金已关闭。");
      return;
    }
    if (target.matches("#saveImportFile") && target.files?.[0]) {
      target.files[0].text().then(applyImported).catch(error => {
        showToast("无法读取导入文件：" + error.message, 5000);
      });
    }
  }

  function keyHandler(event) {
    const draftInput = closest(event.target, "[data-draft-key]");
    if (draftInput && event.key === "Enter") {
      event.preventDefault();
      commitNumericDraft(draftInput.dataset.draftKey, draftInput);
      return;
    }
    if (draftInput && event.key === "Escape") {
      event.preventDefault();
      numericDrafts.delete(draftInput.dataset.draftKey);
      render(true);
      const replacement = numericInputFor(draftInput.dataset.draftKey);
      replacement?.focus({ preventScroll: true });
      return;
    }
    if ((event.key === "Enter" || event.key === " ") && closest(event.target, '[role="button"][data-site], [role="button"][data-plot]')) {
      event.preventDefault();
      event.target.closest('[role="button"][data-site], [role="button"][data-plot]').click();
    }
  }

  root.addEventListener("click", clickHandler);
  root.addEventListener("input", inputHandler);
  root.addEventListener("change", changeHandler);
  root.addEventListener("keydown", keyHandler);
  const pageHideHandler = () => { void saveIfDirty(); };
  const visibilityHandler = () => {
    previousFrame = performance.now();
    if (document.hidden && animationFrame) {
      cancelAnimationFrame(animationFrame);
      animationFrame = 0;
    } else if (!document.hidden && !animationFrame) {
      animationFrame = requestAnimationFrame(frame);
    }
  };
  window.addEventListener("pagehide", pageHideHandler);
  const saveTimer = setInterval(() => {
    if (!state || transientMode || !saves) return;
    const months = state.policy?.autosaveMonths ?? 1;
    if (absoluteGameDay() - lastAutosaveAbsDay >= months * 30) {
      lastAutosaveAbsDay = absoluteGameDay();
      void saveIfDirty();
    }
  }, 2000);
  document.addEventListener("visibilitychange", visibilityHandler);

  function frame(now) {
    animationFrame = 0;
    if (document.hidden) return;
    const elapsed = Math.min(.5, Math.max(0, (now - previousFrame) / 1000));
    previousFrame = now;
    try {
      mapCamera.step();
      if (state) {
        if (!clock.paused) animationTime += elapsed;
        // 防御：单日结算异常时暂停并提示，避免静默卡死（之前异常会直接掐断 rAF 循环）
        let advanced = 0;
        const frameStart = performance.now();
        try {
          advanced = clock.advanceFrame(elapsed, () => {
            simulation.advanceDay(state);
            dirty = true;
            stateRevision += 1;
            invalidateStateView();
            if (state.shortageQeq > 0) {
              clock.pause();
              showToast("口粮出现短缺，时光已暂停。请检查居民粮账并拨粮救济。", 4200);
            }
            // 单帧内多日结算超时保护：超过 800ms 自动暂停，下帧继续
            if (performance.now() - frameStart > 800 && !clock.paused) {
              clock.pause();
              showToast("单日结算较慢，已自动暂停，可手动继续。", 3000);
            }
          });
        } catch (err) {
          clock.pause();
          console.error("[麦乡] 日结算异常已暂停", err);
          showToast("结算出现异常已暂停：" + (err && err.message || "未知错误"), 5000);
        }
        if (advanced > 0) render();
        const view = latestView;
        if (view && !clock.paused && now - lastCanvasFrame >= 90) {
          drawVillageMapCanvas($("#mapTerrainCanvas"), view, navigation.state, animationTime, latestMapModel);
          lastCanvasFrame = now;
        }
      }
    } catch (err) {
      // 外层兜底：相机/渲染任一环节抛异常也不掐断 rAF，主循环继续，下次直接报出真凶
      clock.pause();
      console.error("[麦乡] 帧异常已暂停", err);
      showToast("运行出现异常已暂停：" + (err && err.message || "未知错误"), 5000);
    }
    animationFrame = requestAnimationFrame(frame);
  }

  async function bootstrapPersistence() {
    persistenceBusy = true;
    render(true);
    try {
      saves = await createIndexedSaveManager({ indexedDB: window.indexedDB, legacyStorage: storage, content: simulation.content });
      const probe = await saves.probePersistentStorage();
      if (!probe?.ok) throw new Error("IndexedDB 写入探测未通过");
      const loaded = saves.initialize();
      state = loaded.state;
      resetAutosaveClock();
      dashboardViews.clear();
      activeId = loaded.activeId;
      saveSession += 1;
      stateRevision = 0;
      autosave.clearFailure();
      saveWarning = loaded.warning || (probe.localStorage?.ok === false ? "IndexedDB 持久保存可用；遗留 localStorage 仍不可写，可按需导出并清理旧数据。" : null);
      const current = loaded.slots.find(slot => slot.current);
      saveNotice = current?.savedAt ? `最近保存：${new Date(current.savedAt).toLocaleString("zh-CN", { hour12: false })} · 成功` : "尚未保存";
      startupError = null;
      persistenceIssue = null;
      if (state) { managerOpen = false; navigation.resetView(); }
      else { managerOpen = true; navigation.openPanel("settings"); }
    } catch (error) {
      persistenceIssue = error?.code ? error : classifyPersistenceError(error, "初始化 IndexedDB");
      startupError = persistenceIssue;
      console.error("[麦乡存档] IndexedDB 启动失败", error, error?.cause || "");
      managerOpen = true;
      navigation.openPanel("settings");
    } finally {
      persistenceBusy = false;
      render(true);
    }
  }

  render();
  void bootstrapPersistence();
  animationFrame = requestAnimationFrame(frame);
  return {
    save: () => saveIfDirty(true),
    getSaveKey: () => SAVE_DB_NAME,
    destroy() {
      clearInterval(saveTimer);
      toast.destroy();
      if (animationFrame) cancelAnimationFrame(animationFrame);
      mapCamera.destroy();
      sound.destroy();
      root.removeEventListener("click", clickHandler);
      root.removeEventListener("input", inputHandler);
      root.removeEventListener("change", changeHandler);
      root.removeEventListener("keydown", keyHandler);
      window.removeEventListener("pagehide", pageHideHandler);
      document.removeEventListener("visibilitychange", visibilityHandler);
    }
  };
}
