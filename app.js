import {
  DAYS,
  applyTrainingDays,
  completeSession,
  createPlannerState,
  moveSession,
  replanFromBacklog,
  setCurrentWeek,
} from "./core/trainingEngine.js";

const STORAGE_KEY = "teckel_sporen_v1";
const STORAGE_VERSION = "1.0";
const TRAININGS_PER_STAR = 3;
const RICH_TEXT_CACHE_LIMIT = 250;
const richTextCache = new Map();
const state = {
  page: document.body.dataset.page || "",
  plan: null,
  planner: null,
  preferences: {
    dogName: "",
    pawrent: "",
    startDate: todayISO(),
    trainingDays: ["Di", "Do", "Za"],
    profilePhoto: "",
  },
};

init();

async function init() {
  const saved = loadStorage();
  state.preferences = saved.preferences;
  initGlobalNav();

  await loadPlanSafe();
  if (!state.plan) return;

  state.planner = isValidPlanner(saved.planner) ? saved.planner : createPlannerState(state.plan, state.preferences);
  migrateLegacyIfNeeded(saved);
  syncPlannerWithPlan();

  if (state.page === "profile") initProfilePage();
  if (state.page === "dashboard") initDashboardPage();
  if (state.page === "trainingen") initTrainingenPage();
  if (state.page === "session") initSessionPage();
  if (state.page === "logboek") initLogboekPage();
}

async function loadPlanSafe() {
  try {
    const response = await fetch("./data/plan.json");
    if (!response.ok) throw new Error("Kon plan niet laden");
    const parsed = await response.json();
    if (!Array.isArray(parsed.weeks)) throw new Error("Plan-formaat ongeldig");
    state.plan = parsed;
  } catch (error) {
    console.error(error);
    const main = document.querySelector("main");
    if (main) {
      const warning = document.createElement("p");
      warning.className = "muted";
      warning.textContent =
        window.location.protocol === "file:"
          ? "Kon plan niet laden. Gebruik lokale server: python3 -m http.server"
          : "Kon plan niet laden.";
      main.prepend(warning);
    }
  }
}

function loadStorage() {
  const fallback = { preferences: { dogName: "", pawrent: "", startDate: todayISO(), trainingDays: ["Di", "Do", "Za"], profilePhoto: "" }, planner: null, legacy: null };
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return fallback;

  try {
    const parsed = JSON.parse(raw);
    const preferences = parsed.preferences && typeof parsed.preferences === "object" ? parsed.preferences : {};

    return {
      preferences: {
        dogName: typeof preferences.dogName === "string" ? preferences.dogName : "",
        pawrent: typeof preferences.pawrent === "string" ? preferences.pawrent : "",
        startDate: isIsoDate(preferences.startDate) ? preferences.startDate : todayISO(),
        trainingDays: normalizeTrainingDays(preferences.trainingDays),
        profilePhoto: typeof preferences.profilePhoto === "string" ? preferences.profilePhoto : "",
      },
      planner: parsed.planner && typeof parsed.planner === "object" ? parsed.planner : null,
      legacy: parsed,
    };
  } catch (error) {
    console.warn("Storage parse fout", error);
    return fallback;
  }
}

function isValidPlanner(value) {
  return Boolean(value && value.program && value.weeksById && value.sessionsById && Array.isArray(value.logs) && value.ui);
}

function migrateLegacyIfNeeded(saved) {
  const legacy = saved.legacy;
  if (!legacy || !state.planner) return;

  if (Array.isArray(legacy.completedTrainings)) {
    for (const id of legacy.completedTrainings) {
      const mapped = legacyTrainingIdToNew(id);
      if (mapped && !state.planner.program.progress.sessionsCompleted.includes(mapped)) {
        state.planner.program.progress.sessionsCompleted.push(mapped);
      }
    }
  }

  if (Array.isArray(legacy.sessions)) {
    for (const entry of legacy.sessions) {
      if (!Number.isInteger(entry.week) || !Number.isInteger(entry.day)) continue;
      const mapped = `w${entry.week}-s${entry.day}`;
      if (!state.planner.program.progress.sessionsCompleted.includes(mapped)) {
        state.planner.program.progress.sessionsCompleted.push(mapped);
      }
    }
  }

  syncCompletedWeekProgress();
  persist();
}

function syncPlannerWithPlan() {
  if (plannerNeedsRebuild()) {
    state.planner = rebuildPlannerPreservingProgress();
  }

  const byWeek = new Map((state.plan.weeks || []).map((week) => [week.weekNumber, week]));
  for (const [sessionId, session] of Object.entries(state.planner.sessionsById)) {
    const m = sessionId.match(/^w(\d+)-s(\d+)$/i);
    if (!m) continue;
    const weekNumber = Number(m[1]);
    const sessionNumber = Number(m[2]);
    const planWeek = byWeek.get(weekNumber);
    const planSession = planWeek?.sessions?.[sessionNumber - 1];
    if (!planSession) continue;

    session.title = planSession.title;
    session.trainingCode = deriveTrainingCode(weekNumber, planSession.title, sessionNumber - 1);
    session.details = {
      intro: planSession.intro || "",
      goal: planSession.goal || "",
      spoor: planSession.spoor || "",
      benodigdheden: Array.isArray(planSession.benodigdheden) ? planSession.benodigdheden : [],
      extraTip: planSession.extraTip || "",
      valkuil: planSession.valkuil || "",
    };
    session.track = session.track || {};
    session.track.lengthM = estimateLengthFromText(planSession.spoor);
    session.track.turns = estimateTurnsFromText(planSession.spoor);
    session.track.shape = inferShapeFromText(planSession.spoor);
    session.track.surface = inferSurfaceFromText(planSession.spoor);
    session.track.treatPattern = planSession.spoor || "";
    delete session.adaptive;
  }

  const days = normalizeTrainingDays(state.preferences.trainingDays);
  for (const week of Object.values(state.planner.weeksById)) {
    week.settings = week.settings || {};
    week.settings.trainingDays = days;
    const planWeek = byWeek.get(week.number);
    if (planWeek) week.title = planWeek.theme;
  }
  if (!Array.isArray(state.preferences.trainingDays) || state.preferences.trainingDays.length !== 3) {
    state.preferences.trainingDays = days;
  }
  persist();
}

function plannerNeedsRebuild() {
  for (const week of state.plan.weeks || []) {
    const weekId = `w${week.weekNumber}`;
    const plannerWeek = state.planner.weeksById[weekId];
    if (!plannerWeek) return true;
    if ((plannerWeek.sessions || []).length !== (week.sessions || []).length) return true;
  }
  return false;
}

function rebuildPlannerPreservingProgress() {
  const oldPlanner = state.planner;
  const rebuilt = createPlannerState(state.plan, state.preferences);
  const oldToNew = new Map();

  for (const week of state.plan.weeks || []) {
    const weekId = `w${week.weekNumber}`;
    const oldWeek = oldPlanner.weeksById[weekId];
    const newWeek = rebuilt.weeksById[weekId];
    if (!oldWeek || !newWeek) continue;

    const newIdsByKey = new Map();
    for (const newSessionId of newWeek.sessions || []) {
      const key = sessionIdentityKey(rebuilt.sessionsById[newSessionId]);
      if (!newIdsByKey.has(key)) newIdsByKey.set(key, []);
      newIdsByKey.get(key).push(newSessionId);
    }

    for (const oldSessionId of oldWeek.sessions || []) {
      const oldSession = oldPlanner.sessionsById[oldSessionId];
      if (!oldSession) continue;
      const key = sessionIdentityKey(oldSession);
      const candidates = newIdsByKey.get(key) || [];
      const newMatch = candidates.shift();
      if (newMatch) oldToNew.set(oldSessionId, newMatch);
    }
  }

  const completed = [];
  for (const oldId of oldPlanner.program.progress.sessionsCompleted || []) {
    const mapped = oldToNew.get(oldId);
    if (mapped && !completed.includes(mapped)) completed.push(mapped);
  }
  rebuilt.program.progress.sessionsCompleted = completed;

  rebuilt.logs = (oldPlanner.logs || [])
    .map((log) => {
      const mappedSessionId = oldToNew.get(log.sessionId);
      if (!mappedSessionId) return null;
      const mappedSession = rebuilt.sessionsById[mappedSessionId];
      if (!mappedSession) return null;
      return {
        ...log,
        sessionId: mappedSessionId,
        weekId: mappedSession.weekId,
      };
    })
    .filter(Boolean);

  rebuilt.program.dogProfile.name = state.preferences.dogName || "";
  syncCompletedWeekProgressOn(rebuilt);
  return rebuilt;
}

function persist() {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: STORAGE_VERSION,
        preferences: state.preferences,
        planner: state.planner,
      })
    );
    return { ok: true };
  } catch (error) {
    console.error("Opslaan mislukt", error);
    return { ok: false, message: "Opslaan mislukt. Kies een kleinere foto en probeer opnieuw." };
  }
}

function initProfilePage() {
  const form = document.getElementById("profile-form");
  const nameInput = document.getElementById("dog-name");
  const pawrentInput = document.getElementById("pawrent-name");
  const startInput = document.getElementById("start-date");
  const trainingDayInputs = Array.from(document.querySelectorAll('input[name="training-days"]'));
  const photoInput = document.getElementById("photo-input");
  const photoPreview = document.getElementById("photo-preview");
  const photoRemove = document.getElementById("photo-remove");
  const msg = document.getElementById("profile-msg");
  const backLink = document.getElementById("profile-back-link");

  const qs = new URLSearchParams(window.location.search);
  const ret = qs.get("return");
  if (ret === "trainingen") backLink.href = "./trainingen.html";
  if (ret === "logboek") backLink.href = "./logboek.html";
  if (ret === "dashboard") backLink.href = "./dashboard.html";

  nameInput.value = state.preferences.dogName;
  pawrentInput.value = state.preferences.pawrent || "";
  startInput.value = state.preferences.startDate;
  const selectedDays = normalizeTrainingDays(state.preferences.trainingDays);
  trainingDayInputs.forEach((input) => {
    input.checked = selectedDays.includes(input.value);
  });
  renderPhoto(photoPreview, state.preferences.profilePhoto);

  photoInput.addEventListener("change", async () => {
    const file = photoInput.files && photoInput.files[0];
    if (!file) return;
    try {
      state.preferences.profilePhoto = await readFileAsDataUrl(file);
      renderPhoto(photoPreview, state.preferences.profilePhoto);
      msg.textContent = "Foto gekozen.";
    } catch (_err) {
      msg.textContent = "Foto kon niet verwerkt worden.";
    }
  });

  photoRemove.addEventListener("click", () => {
    state.preferences.profilePhoto = "";
    photoInput.value = "";
    renderPhoto(photoPreview, "");
    msg.textContent = "Foto verwijderd.";
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const name = nameInput.value.trim();
    const pawrent = pawrentInput.value.trim();
    let startDate = startInput.value;
    const chosenDays = trainingDayInputs.filter((input) => input.checked).map((input) => input.value);
    const trainingDays = chosenDays.length === 0 ? ["Di", "Do", "Za"] : chosenDays;

    if (!name) return (msg.textContent = "Vul een teckelnaam in.");
    if (!isIsoDate(startDate)) startDate = todayISO();
    if (trainingDays.length !== 3) return (msg.textContent = "Selecteer exact 3 trainingsdagen.");

    state.preferences.dogName = name;
    state.preferences.pawrent = pawrent;
    state.preferences.startDate = startDate;
    state.preferences.trainingDays = trainingDays;
    state.planner.program.dogProfile.name = name;
    applyTrainingDays(state.planner, trainingDays);
    const saved = persist();
    if (!saved.ok) {
      msg.textContent = saved.message;
      return;
    }
    msg.textContent = "Profiel opgeslagen. Doorsturen...";
    window.location.replace(withRefresh("./dashboard.html"));
  });

  backLink.addEventListener("click", (event) => {
    if (window.history.length > 1) {
      event.preventDefault();
      window.history.back();
    }
  });
}

function initDashboardPage() {
  const greeting = document.getElementById("dog-greeting");
  const upcoming = document.getElementById("upcoming-session");
  const nextDate = document.getElementById("next-session-date");
  const nextInfo = document.getElementById("next-session-info");
  const cta = document.getElementById("start-now-link");
  const boneTrack = document.getElementById("bone-track");
  const boneMeta = document.getElementById("bone-meta");
  const dashboardPhoto = document.getElementById("dashboard-photo");
  const dashboardDogName = document.getElementById("dashboard-dog-name");
  const pawrentName = document.getElementById("dashboard-pawrent-name");

  const dogName = state.preferences.dogName || "Teckel";
  greeting.textContent = `Welkom ${dogName}`;
  dashboardDogName.textContent = dogName;
  pawrentName.textContent = state.preferences.pawrent || "-";
  renderPhoto(dashboardPhoto, state.preferences.profilePhoto);

  const completedCount = completedSessionCount();
  const unlockedWeeks = getUnlockedWeeks(completedCount);
  const next = getNextOpenSession(unlockedWeeks);

  if (next) {
    const nextLabel = String(next.trainingCode || "") === "0" ? "Introductie" : `Training ${next.trainingCode || `S${next.sessionNumber}`}`;
    upcoming.textContent = `Volgende sessie: Week ${next.week} - ${nextLabel}`;
    nextDate.textContent = `Gepland op ${formatDateReadable(next.dateIso)}`;
    nextInfo.textContent = `${next.title} · ${next.lengthM}m · ${next.turns} bocht(en) · ${next.surface}`;
    cta.href = `./session.html?week=w${next.week}&session=${next.id}&return=dashboard`;
  } else {
    upcoming.textContent = "Volgende sessie: alle sessies in unlocked weken voltooid.";
    nextDate.textContent = "-";
    nextInfo.textContent = "Geen open sessies in unlocked weken.";
    cta.href = "./trainingen.html";
  }

  const totalSessions = Object.keys(state.planner.sessionsById).length;
  const completed = new Set(state.planner.program.progress.sessionsCompleted);
  boneTrack.innerHTML = Object.keys(state.planner.sessionsById)
    .sort(sortSessionIds)
    .map((sessionId) => `<span class="bone ${completed.has(sessionId) ? "filled" : ""}" title="${sessionId}">🦴</span>`)
    .join("");
  boneMeta.textContent = `${completedCount}/${totalSessions} trainingen afgewerkt · unlocked weken t/m ${unlockedWeeks}`;
}

function initTrainingenPage() {
  const weekSelect = document.getElementById("week-select");
  const weekPrev = document.getElementById("week-prev");
  const weekCurrent = document.getElementById("week-current");
  const weekNext = document.getElementById("week-next");
  const weekTitle = document.getElementById("week-title");
  const weekNavLabel = document.getElementById("week-nav-label");
  const weekGoal = document.getElementById("week-goal");
  const calendar = document.getElementById("week-calendar");
  const monthPrev = document.getElementById("month-prev");
  const monthNext = document.getElementById("month-next");
  const monthLabel = document.getElementById("month-label");
  const monthCalendar = document.getElementById("month-calendar");
  const backlogList = document.getElementById("backlog-list");
  const msg = document.getElementById("action-msg");
  const qs = new URLSearchParams(window.location.search);
  const movedSessionId = qs.get("moved") || "";
  const weekFromQuery = qs.get("week");

  let monthCursor = null;

  const unlockedWeeks = getUnlockedWeeks(completedSessionCount());
  const nextOpen = getNextOpenSession(unlockedWeeks);
  const currentWeekNumber = nextOpen ? nextOpen.week : Math.min(unlockedWeeks, Math.max(1, state.planner.program.currentWeek || 1));
  weekSelect.innerHTML = Array.from({ length: unlockedWeeks }, (_, i) => i + 1)
    .map((n) => `<option value="w${n}">Week ${n}</option>`)
    .join("");

  const validWeekFromQuery = weekFromQuery && /^w[1-8]$/i.test(weekFromQuery) ? weekFromQuery.toLowerCase() : "";
  const selectedFromState =
    state.planner.ui.selectedWeekId && Number(state.planner.ui.selectedWeekId.replace("w", "")) <= unlockedWeeks
      ? state.planner.ui.selectedWeekId
      : "w1";
  weekSelect.value = validWeekFromQuery && Number(validWeekFromQuery.replace("w", "")) <= unlockedWeeks ? validWeekFromQuery : selectedFromState;
  setCurrentWeek(state.planner, weekSelect.value);

  const parseStartDate = () => {
    const safeStart = isIsoDate(state.preferences.startDate) ? state.preferences.startDate : todayISO();
    const [y, m, d] = safeStart.split("-").map(Number);
    return new Date(y, m - 1, d);
  };

  const getWeekBaseMonday = () => {
    const start = parseStartDate();
    const mondayOffset = (start.getDay() + 6) % 7;
    return addDays(start, -mondayOffset);
  };

  const addDays = (date, days) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
  const toIso = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  const mondayIndex = (date) => (date.getDay() + 6) % 7;

  const resolveSessionDate = (weekNumber, dayName) => {
    const start = getWeekBaseMonday();
    const offset = (weekNumber - 1) * 7 + DAYS.indexOf(dayName);
    return addDays(start, offset);
  };

  const buildScheduledEntries = () => {
    const entries = [];
    const week = Number(weekSelect.value.replace("w", ""));
    const weekId = `w${week}`;
    const weekData = state.planner.weeksById[weekId];
    if (!weekData) return entries;
    for (const dayName of DAYS) {
      for (const sessionId of weekData.calendar[dayName]) {
        const session = state.planner.sessionsById[sessionId];
        const date = resolveSessionDate(week, dayName);
        entries.push({ sessionId, weekId, weekNumber: week, code: session.code, title: session.title, iso: toIso(date) });
      }
    }
    return entries.sort((a, b) => a.iso.localeCompare(b.iso));
  };

  const renderMonthCalendar = () => {
    const entries = buildScheduledEntries();
    const entriesByIso = new Map();
    for (const entry of entries) {
      if (!entriesByIso.has(entry.iso)) entriesByIso.set(entry.iso, []);
      entriesByIso.get(entry.iso).push(entry);
    }
    const completed = new Set(state.planner.program.progress.sessionsCompleted);
    const selectedWeekNumber = Number(weekSelect.value.replace("w", ""));

    if (!monthCursor) {
      const first = resolveSessionDate(selectedWeekNumber, "Ma");
      monthCursor = new Date(first.getFullYear(), first.getMonth(), 1);
    }

    monthLabel.textContent = monthCursor.toLocaleDateString("nl-NL", { month: "long", year: "numeric" });

    const firstDay = new Date(monthCursor.getFullYear(), monthCursor.getMonth(), 1);
    const daysInMonth = new Date(monthCursor.getFullYear(), monthCursor.getMonth() + 1, 0).getDate();
    const blanks = mondayIndex(firstDay);

    const headers = DAYS.map((d) => `<div class="month-weekday">${d}</div>`).join("");
    const leading = Array.from({ length: blanks }, () => '<div class="month-day empty"></div>').join("");

    let cells = "";
    for (let day = 1; day <= daysInMonth; day += 1) {
      const iso = `${monthCursor.getFullYear()}-${String(monthCursor.getMonth() + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      const dayEntries = entriesByIso.get(iso) || [];
      const badges = dayEntries
        .map((entry) => {
          const doneClass = completed.has(entry.sessionId) ? "done" : "";
          const movedClass = entry.sessionId === movedSessionId ? "moved" : "";
          const s = state.planner.sessionsById[entry.sessionId];
          const label = `Training ${s?.trainingCode || `${entry.weekNumber}${sessionNumberFromId(entry.sessionId)}`}`;
          return `<a class="month-session ${doneClass} ${movedClass}" href="./session.html?week=${entry.weekId}&session=${entry.sessionId}&return=trainingen">${label}</a>`;
        })
        .join("");

      cells += `<div class="month-day ${dayEntries.length ? "has-training" : ""}"><p class="month-day-num">${day}</p>${badges}</div>`;
    }

    monthCalendar.innerHTML = `<div class="month-grid">${headers}${leading}${cells}</div>`;
  };

  const renderWeek = () => {
    const weekId = weekSelect.value;
    const previousSelectedWeekId = state.planner.ui.selectedWeekId;
    setCurrentWeek(state.planner, weekId);
    const week = state.planner.weeksById[weekId];

    weekTitle.textContent = `Week ${week.number}`;
    weekNavLabel.textContent = `Huidig: week ${currentWeekNumber}`;
    weekGoal.textContent = week.title;

    calendar.innerHTML = DAYS.map((day) => {
      const dayDate = resolveSessionDate(week.number, day);
      const realDay = DAYS[(dayDate.getDay() + 6) % 7];
      const sessions = week.calendar[day]
        .map((sessionId) => {
          const s = state.planner.sessionsById[sessionId];
          const done = state.planner.program.progress.sessionsCompleted.includes(sessionId);
          const movedClass = sessionId === movedSessionId ? "moved" : "";
          const levelLabel = `Training ${s.trainingCode || `${week.number}${sessionNumberFromId(sessionId)}`}`;
          return `
            <a class="session-pill ${done ? "done" : ""} ${movedClass}" href="./session.html?week=${weekId}&session=${sessionId}&return=trainingen">
              <div class="session-head"><strong>${levelLabel}</strong><span class="session-status">${done ? "Gedaan" : "Gepland"}</span></div>
              <p class="session-title">${escapeHtml(s.title)}</p>
            </a>
          `;
        })
        .join("");

      return `<section class="day-col"><h4>${realDay} ${dayDate.getDate()}</h4>${sessions || "<p class='muted'>Rust</p>"}</section>`;
    }).join("");

    backlogList.innerHTML = week.backlog.length
      ? week.backlog
          .map((id) => {
            const s = state.planner.sessionsById[id];
            return `<div class="backlog-item">${s.code} ${escapeHtml(s.title)} <button type="button" data-replan="${id}">Plan opnieuw</button></div>`;
          })
          .join("")
      : "<p class='muted'>Geen gemiste sessies.</p>";

    renderMonthCalendar();
    if (previousSelectedWeekId !== weekId) persist();
  };

  weekSelect.addEventListener("change", () => {
    monthCursor = null;
    renderWeek();
  });

  const setWeekByNumber = (weekNumber) => {
    if (weekNumber < 1 || weekNumber > unlockedWeeks) return false;
    weekSelect.value = `w${weekNumber}`;
    monthCursor = null;
    renderWeek();
    return true;
  };

  weekPrev.addEventListener("click", () => {
    const current = Number(weekSelect.value.replace("w", ""));
    setWeekByNumber(current - 1);
  });

  weekCurrent.addEventListener("click", () => {
    setWeekByNumber(currentWeekNumber);
  });

  weekNext.addEventListener("click", () => {
    const current = Number(weekSelect.value.replace("w", ""));
    if (!setWeekByNumber(current + 1)) {
      msg.textContent = "Volgende week is nog niet unlocked.";
    }
  });

  backlogList.addEventListener("click", (event) => {
    const replanButton = event.target.closest("button[data-replan]");
    if (!replanButton) return;
    const toDay = window.prompt("Plan op welke dag? (Ma/Di/Wo/Do/Vr/Za/Zo)", "Di");
    if (!toDay || !DAYS.includes(toDay)) return;
    const result = replanFromBacklog(state.planner, replanButton.dataset.replan, toDay, { lightVersion: false });
    msg.textContent = result.ok ? "Backlog-sessie opnieuw gepland." : "Opnieuw plannen mislukt.";
    renderWeek();
  });

  monthPrev.addEventListener("click", () => {
    monthCursor = new Date(monthCursor.getFullYear(), monthCursor.getMonth() - 1, 1);
    renderMonthCalendar();
  });

  monthNext.addEventListener("click", () => {
    monthCursor = new Date(monthCursor.getFullYear(), monthCursor.getMonth() + 1, 1);
    renderMonthCalendar();
  });

  renderWeek();
}

function initSessionPage() {
  const backLink = document.getElementById("session-back-link");
  const detail = document.getElementById("session-detail");
  const openDatePicker = document.getElementById("open-date-picker");
  const rescheduleDate = document.getElementById("reschedule-date");
  const applyRescheduleDate = document.getElementById("apply-reschedule-date");
  const resetSessionButton = document.getElementById("reset-session");
  const openEvalForm = document.getElementById("open-eval-form");
  const cancelEval = document.getElementById("cancel-eval");
  const logForm = document.getElementById("session-log-form");
  const logDate = document.getElementById("log-date");
  const logSurface = document.getElementById("log-surface");
  const logWeather = document.getElementById("log-weather");
  const logSuccess = document.getElementById("log-success");
  const logSuccessValue = document.getElementById("log-success-value");
  const logFocus = document.getElementById("log-focus");
  const obsNose = document.getElementById("obs-nose");
  const obsCalm = document.getElementById("obs-calm");
  const obsTurn = document.getElementById("obs-turn");
  const obsTurnWrap = document.getElementById("obs-turn-wrap");
  const obsDistracted = document.getElementById("obs-distracted");
  const logPhoto = document.getElementById("log-photo");
  const logNotes = document.getElementById("log-notes");
  const msg = document.getElementById("action-msg");

  const qs = new URLSearchParams(window.location.search);
  const weekId = qs.get("week") || state.planner.ui.selectedWeekId || "w1";
  const sessionId = qs.get("session") || "";
  const ret = qs.get("return") || "trainingen";
  const returnUrl = ret === "dashboard" ? "./dashboard.html" : ret === "logboek" ? "./logboek.html" : `./trainingen.html?week=${weekId}`;

  backLink.href = returnUrl;
  backLink.addEventListener("click", (event) => {
    if (window.history.length > 1) {
      event.preventDefault();
      window.history.back();
    }
  });

  const session = state.planner.sessionsById[sessionId];
  if (!session) {
    detail.innerHTML = "Sessie niet gevonden.";
    return;
  }

  renderSessionDetail(detail, sessionId);

  const hasTurn = Number(session.track.turns) > 0;
  obsTurnWrap.classList.toggle("hidden", !hasTurn);
  if (!hasTurn) obsTurn.checked = false;

  logDate.value = todayISO();
  logSuccess.value = "8";
  logSuccessValue.textContent = "8";
  logSuccess.addEventListener("input", () => {
    logSuccessValue.textContent = String(logSuccess.value);
  });

  openDatePicker.addEventListener("click", () => {
    rescheduleDate.value = "";
    rescheduleDate.classList.remove("hidden");
    applyRescheduleDate.classList.remove("hidden");
    rescheduleDate.showPicker?.();
  });

  applyRescheduleDate.addEventListener("click", () => {
    if (!rescheduleDate.value) {
      msg.textContent = "Kies eerst een datum.";
      return;
    }

    const location = findSessionLocation(sessionId);
    if (!location) {
      msg.textContent = "Kon huidige sessiepositie niet bepalen.";
      return;
    }

    if (location.weekId !== weekId) {
      msg.textContent = "Deze sessie hoort bij een andere week.";
      return;
    }

    const targetDay = dayNameFromDate(rescheduleDate.value);
    if (!targetDay) {
      msg.textContent = "Ongeldige datum.";
      return;
    }

    const result = moveSession(state.planner, sessionId, location.day, targetDay, "append", { lightVersion: false });
    if (!result.ok) {
      msg.textContent = "Verplaatsen mislukt.";
      return;
    }
    persist();
    const target = `./trainingen.html?week=${weekId}&moved=${encodeURIComponent(sessionId)}`;
    window.location.replace(withRefresh(target));
  });

  openEvalForm.addEventListener("click", () => {
    logForm.classList.remove("hidden");
    openEvalForm.classList.add("hidden");
  });

  cancelEval.addEventListener("click", () => {
    logForm.classList.add("hidden");
    openEvalForm.classList.remove("hidden");
    msg.textContent = "";
  });

  resetSessionButton.addEventListener("click", () => {
    if (!window.confirm("Reset deze training? Evaluatie en logentry worden verwijderd.")) return;
    state.planner.program.progress.sessionsCompleted = state.planner.program.progress.sessionsCompleted.filter((id) => id !== sessionId);
    if (state.planner.sessionsById[sessionId]) {
      state.planner.sessionsById[sessionId].status = "planned";
    }
    state.planner.logs = state.planner.logs.filter((log) => log.sessionId !== sessionId);
    syncCompletedWeekProgress();
    const saved = persist();
    if (!saved.ok) {
      msg.textContent = saved.message;
      return;
    }
    window.location.replace(withRefresh(returnUrl));
  });

  logForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    let photoDataUrl = "";
    const file = logPhoto.files && logPhoto.files[0];
    if (file) photoDataUrl = await readFileAsDataUrl(file);

    const res = completeSession(state.planner, sessionId, {
      date: logDate.value,
      surface: logSurface.value,
      weather: logWeather.value,
      successScore: clamp(Number(logSuccess.value || 0), 0, 10),
      focus: logFocus.value,
      notes: logNotes.value,
      noseDown: obsNose.checked,
      calmPace: obsCalm.checked,
      foundTurn: hasTurn ? obsTurn.checked : null,
      distracted: obsDistracted.checked,
      photoDataUrl,
    });

    msg.textContent = res.ok ? "Sessie opgeslagen en afgevinkt." : "Opslaan mislukt.";
    if (res.ok) {
      syncCompletedWeekProgress();
      persist();
      window.location.replace(withRefresh(returnUrl));
    }
  });
}

function findSessionLocation(sessionId) {
  return findSessionLocationInIndex(sessionId, buildSessionLocationIndex());
}

function dayNameFromDate(isoDate) {
  if (!isIsoDate(isoDate)) return null;
  const [y, m, d] = isoDate.split("-").map(Number);
  const parsed = new Date(y, m - 1, d);
  if (Number.isNaN(parsed.getTime())) return null;
  const idx = (parsed.getDay() + 6) % 7;
  return DAYS[idx] || null;
}

function normalizeTrainingDays(value) {
  if (!Array.isArray(value)) return ["Di", "Do", "Za"];
  const unique = value.filter((day, i) => DAYS.includes(day) && value.indexOf(day) === i);
  if (unique.length !== 3) return ["Di", "Do", "Za"];
  return unique;
}

function estimateLengthFromText(text = "") {
  const match = String(text).match(/(\d{1,3})\s*(?:-|tot|–)?\s*(\d{1,3})?\s*m/i);
  if (!match) return 10;
  const a = Number(match[1]);
  const b = Number(match[2] || 0);
  return b ? Math.round((a + b) / 2) : a;
}

function estimateTurnsFromText(text = "") {
  const direct = String(text).match(/(\d+)\s*bocht/i);
  if (direct) return Number(direct[1]);
  return String(text).toLowerCase().includes("bocht") ? 1 : 0;
}

function inferShapeFromText(text = "") {
  const lower = String(text).toLowerCase();
  if (lower.includes("l-vorm") || lower.includes("90")) return "L";
  return "line";
}

function inferSurfaceFromText(text = "") {
  const lower = String(text).toLowerCase();
  if (lower.includes("bos")) return "bos";
  if (lower.includes("zand")) return "zand";
  if (lower.includes("mix")) return "mix";
  if (lower.includes("asfalt")) return "asfalt";
  if (lower.includes("grind")) return "grind";
  return "gras";
}

function renderSessionDetail(container, sessionId) {
  if (!sessionId) {
    container.innerHTML = "Selecteer een sessie.";
    return;
  }
  const s = state.planner.sessionsById[sessionId];
  if (!s) {
    container.innerHTML = "Sessie niet gevonden.";
    return;
  }
  const week = state.planner.weeksById[s.weekId];
  const details = s.details || {};
  const benodigdheden = Array.isArray(details.benodigdheden) ? details.benodigdheden : [];
  const introRow = details.intro ? `<div class="detail-block"><strong>Intro:</strong>${formatRichText(details.intro)}</div>` : "";
  const valkuilRow = details.valkuil ? `<div class="detail-block"><strong>Valkuil:</strong>${formatRichText(details.valkuil)}</div>` : "";
  const benodigdhedenHtml = benodigdheden.length
    ? `<ul class="detail-list">${benodigdheden.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
    : "<p>-</p>";

  container.innerHTML = `
    <h3>Week ${week.number} - ${escapeHtml(week.title)}</h3>
    <p><strong>Training ${escapeHtml(s.trainingCode || `${week.number}${sessionNumberFromId(sessionId)}`)}</strong></p>
    ${introRow}
    <div class="detail-block"><strong>Doel:</strong>${formatRichText(details.goal || "-")}</div>
    <div class="detail-block"><strong>Spoor:</strong>${formatRichText(details.spoor || "-")}</div>
    <div class="detail-block"><strong>Benodigdheden:</strong>${benodigdhedenHtml}</div>
    <div class="detail-block"><strong>Extra tip:</strong>${formatRichText(details.extraTip || "-")}</div>
    ${valkuilRow}
  `;
}

function formatDateReadable(iso) {
  if (!isIsoDate(iso)) return "onbekend";
  const d = new Date(`${iso}T00:00:00`);
  return d.toLocaleDateString("nl-BE", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function sortSessionIds(a, b) {
  const ma = String(a).match(/^w(\d+)-s(\d+)$/i);
  const mb = String(b).match(/^w(\d+)-s(\d+)$/i);
  if (!ma || !mb) return String(a).localeCompare(String(b));
  const wa = Number(ma[1]);
  const wb = Number(mb[1]);
  if (wa !== wb) return wa - wb;
  return Number(ma[2]) - Number(mb[2]);
}

function deriveTrainingCode(weekNumber, title, index) {
  const parsed = parseTrainingCodeFromTitle(title);
  if (parsed) return parsed;
  return `${weekNumber}${String(index + 1)}`;
}

function formatRichText(text) {
  const raw = String(text || "");
  if (richTextCache.has(raw)) return richTextCache.get(raw);
  const normalized = raw
    .replace(/\u2022/g, "\n- ")
    .replace(/\s*->\s*/g, " -> ");
  const lines = normalized
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return "<p>-</p>";

  const chunks = [];
  let bullets = [];

  const flushBullets = () => {
    if (!bullets.length) return;
    chunks.push(`<ul class="detail-list">${bullets.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`);
    bullets = [];
  };

  for (const line of lines) {
    if (line.startsWith("- ")) {
      bullets.push(line.slice(2));
      continue;
    }
    flushBullets();
    chunks.push(`<p>${escapeHtml(line)}</p>`);
  }
  flushBullets();
  const rendered = chunks.join("");
  richTextCache.set(raw, rendered);
  if (richTextCache.size > RICH_TEXT_CACHE_LIMIT) {
    const firstKey = richTextCache.keys().next().value;
    richTextCache.delete(firstKey);
  }
  return rendered;
}

function initGlobalNav() {
  const button = document.querySelector(".menu-toggle");
  const drawer = document.querySelector(".menu-drawer");
  if (!button || !drawer) return;

  const isExpanded = () => button.getAttribute("aria-expanded") === "true";
  const close = () => {
    button.setAttribute("aria-expanded", "false");
    drawer.classList.add("hidden");
  };
  const open = () => {
    button.setAttribute("aria-expanded", "true");
    drawer.classList.remove("hidden");
  };

  button.addEventListener("click", () => {
    if (isExpanded()) close();
    else open();
  });

  document.addEventListener("click", (event) => {
    if (!drawer.contains(event.target) && !button.contains(event.target)) {
      close();
    }
  });

  drawer.addEventListener("click", (event) => {
    const howDan = event.target.closest(".menu-howdan");
    if (!howDan) return;
    event.preventDefault();
    close();
    window.alert("Work in progress: deze sectie wordt nog uitgewerkt.");
  });
}
function initLogboekPage() {
  const filterWeek = document.getElementById("filter-week");
  const filterSurface = document.getElementById("filter-surface");
  const filterSuccess = document.getElementById("filter-success");
  const apply = document.getElementById("apply-filters");
  const list = document.getElementById("log-list");
  let editingLogId = "";

  filterWeek.innerHTML += Array.from({ length: 8 }, (_, i) => `<option value="w${i + 1}">Week ${i + 1}</option>`).join("");

  const surfaces = [...new Set(state.planner.logs.map((log) => log.surface).filter(Boolean))];
  filterSurface.innerHTML += surfaces.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join("");

  const render = () => {
    const weekFilter = filterWeek.value;
    const surfaceFilter = filterSurface.value;
    const minSuccess = Number(filterSuccess.value || 0);

    const filtered = state.planner.logs.filter((log) => {
      if (weekFilter && log.weekId !== weekFilter) return false;
      if (surfaceFilter && log.surface !== surfaceFilter) return false;
      if (log.successScore < minSuccess) return false;
      return true;
    });

    list.innerHTML = filtered.length
      ? filtered
          .map((log) => {
            const isEditing = editingLogId === log.id;
            if (isEditing) {
              return `
            <article class="log-item">
              <strong>${escapeHtml(log.date)} · ${escapeHtml(log.sessionId)}</strong>
              <div class="form-grid compact-grid">
                <select data-edit-field="surface">
                  ${["gras", "zand", "bos", "asfalt", "grind"]
                    .map((v) => `<option value="${v}" ${log.surface === v ? "selected" : ""}>${v}</option>`)
                    .join("")}
                </select>
                <select data-edit-field="weather">
                  ${["droog", "nat", "wind"]
                    .map((v) => `<option value="${v}" ${log.weather === v ? "selected" : ""}>${v}</option>`)
                    .join("")}
                </select>
                <input data-edit-field="successScore" type="number" min="0" max="10" value="${Number(log.successScore || 0)}" />
                <select data-edit-field="focus">
                  ${["laag", "middel", "hoog"]
                    .map((v) => `<option value="${v}" ${log.focus === v ? "selected" : ""}>${v}</option>`)
                    .join("")}
                </select>
                <textarea data-edit-field="notes" rows="3" placeholder="Notities...">${escapeHtml(log.notes || "")}</textarea>
              </div>
              <div class="inline-actions">
                <button class="button" type="button" data-log-save="${log.id}">Opslaan</button>
                <button class="button ghost subtle" type="button" data-log-cancel="1">Cancel</button>
              </div>
            </article>
          `;
            }
            return `
            <article class="log-item">
              <strong>${escapeHtml(log.date)} · ${escapeHtml(log.sessionId)}</strong>
              <p>Ondergrond: ${escapeHtml(log.surface)} · Weer: ${escapeHtml(log.weather)}</p>
              <p>Succes: ${Number(log.successScore || 0)}/10 · Focus: ${escapeHtml(log.focus)}</p>
              ${log.photoDataUrl ? `<img src="${log.photoDataUrl}" alt="Sessie foto" class="log-photo" />` : ""}
              <p>${escapeHtml(log.notes || "-")}</p>
              <div class="inline-actions">
                <button class="button ghost" type="button" data-log-edit="${log.id}">Bewerk</button>
              </div>
            </article>
          `;
          })
          .join("")
      : "<p class='muted'>Geen logentries voor deze filter.</p>";
  };

  list.addEventListener("click", (event) => {
    const editBtn = event.target.closest("[data-log-edit]");
    if (editBtn) {
      editingLogId = editBtn.dataset.logEdit;
      render();
      return;
    }

    const cancelBtn = event.target.closest("[data-log-cancel]");
    if (cancelBtn) {
      editingLogId = "";
      render();
      return;
    }

    const saveBtn = event.target.closest("[data-log-save]");
    if (!saveBtn) return;
    const logId = saveBtn.dataset.logSave;
    const article = saveBtn.closest(".log-item");
    const log = state.planner.logs.find((entry) => entry.id === logId);
    if (!article || !log) return;

    const fieldValue = (name) => {
      const el = article.querySelector(`[data-edit-field="${name}"]`);
      return el ? el.value : "";
    };

    log.surface = fieldValue("surface") || "gras";
    log.weather = fieldValue("weather") || "droog";
    log.successScore = clamp(Number(fieldValue("successScore") || 0), 0, 10);
    log.focus = fieldValue("focus") || "middel";
    log.notes = fieldValue("notes");
    editingLogId = "";
    persist();
    render();
  });

  apply.addEventListener("click", render);
  render();
}

function completedSessionCount() {
  return new Set(state.planner.program.progress.sessionsCompleted).size;
}

function getUnlockedWeeks(completedCount) {
  return clamp(2 + Math.floor(completedCount / TRAININGS_PER_STAR), 2, 8);
}

function getNextOpenSession(unlockedWeeks) {
  const completed = new Set(state.planner.program.progress.sessionsCompleted);
  const locationIndex = buildSessionLocationIndex();
  for (let week = 1; week <= unlockedWeeks; week += 1) {
    const weekId = `w${week}`;
    const weekData = state.planner.weeksById[weekId];
    if (!weekData) continue;
    for (const sessionId of weekData.sessions) {
      if (!completed.has(sessionId)) {
        const s = state.planner.sessionsById[sessionId];
        return {
          week,
          id: sessionId,
          title: s.title,
          trainingCode: s.trainingCode || "",
          sessionNumber: sessionNumberFromId(sessionId),
          dateIso: getSessionPlannedDate(sessionId, locationIndex),
          lengthM: s.track.lengthM,
          turns: s.track.turns,
          surface: s.track.surface,
        };
      }
    }
  }
  return null;
}

function syncCompletedWeekProgress() {
  const completed = new Set(state.planner.program.progress.sessionsCompleted);
  state.planner.program.progress.weeksCompleted = Object.values(state.planner.weeksById)
    .filter((week) => week.sessions.every((id) => completed.has(id)))
    .map((week) => week.number)
    .sort((a, b) => a - b);
}

function syncCompletedWeekProgressOn(planner) {
  const completed = new Set(planner.program.progress.sessionsCompleted);
  planner.program.progress.weeksCompleted = Object.values(planner.weeksById)
    .filter((week) => week.sessions.every((id) => completed.has(id)))
    .map((week) => week.number)
    .sort((a, b) => a - b);
}

function legacyTrainingIdToNew(value) {
  if (typeof value !== "string") return null;
  const m = value.match(/^w(\d+)-s(\d+)$/i);
  if (!m) return null;
  return `w${Number(m[1])}-s${Number(m[2])}`;
}

function buildSessionLocationIndex() {
  const index = new Map();
  for (const [weekId, week] of Object.entries(state.planner.weeksById)) {
    for (const day of DAYS) {
      for (const sessionId of week.calendar[day]) {
        index.set(sessionId, { weekId, day });
      }
    }
  }
  return index;
}

function findSessionLocationInIndex(sessionId, locationIndex) {
  return locationIndex.get(sessionId) || null;
}

function renderPhoto(img, dataUrl) {
  if (!dataUrl) {
    img.src = "";
    img.classList.add("hidden");
    return;
  }
  img.src = dataUrl;
  img.classList.remove("hidden");
}

function readFileAsDataUrl(file) {
  if (!file.type || !file.type.startsWith("image/")) {
    return Promise.reject(new Error("Geen afbeelding"));
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const max = 900;
        const ratio = Math.min(max / img.width, max / img.height, 1);
        const width = Math.round(img.width * ratio);
        const height = Math.round(img.height * ratio);
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) return reject(new Error("Canvas niet beschikbaar"));
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", 0.82));
      };
      img.onerror = () => reject(new Error("Afbeelding kon niet geladen worden"));
      img.src = String(reader.result || "");
    };
    reader.onerror = () => reject(new Error("Kon bestand niet lezen"));
    reader.readAsDataURL(file);
  });
}

function todayISO() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function isIsoDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function withRefresh(url) {
  const u = new URL(url, window.location.href);
  u.searchParams.set("refresh", String(Date.now()));
  return `${u.pathname}${u.search}`;
}

function parseTrainingCodeFromTitle(title) {
  const match = String(title || "").match(/training\s*([0-9]+[A-Z]?)/i);
  if (!match || !match[1]) return "";
  return match[1].toUpperCase();
}

function sessionIdentityKey(session) {
  if (!session) return "";
  const code = String(session.trainingCode || parseTrainingCodeFromTitle(session.title || "")).trim().toUpperCase();
  if (code) return `code:${code}`;
  return `title:${String(session.title || "").trim().toLowerCase()}`;
}

function sessionNumberFromId(sessionId) {
  const m = String(sessionId).match(/-s(\d+)$/i);
  return m ? Number(m[1]) : 1;
}

function getSessionPlannedDate(sessionId, locationIndex = null) {
  const location = locationIndex ? findSessionLocationInIndex(sessionId, locationIndex) : findSessionLocation(sessionId);
  if (!location) return "";
  const weekNum = Number(String(location.weekId).replace("w", ""));
  if (!Number.isInteger(weekNum) || weekNum < 1) return "";
  const safeStart = isIsoDate(state.preferences.startDate) ? state.preferences.startDate : todayISO();
  const [y, m, d] = safeStart.split("-").map(Number);
  const start = new Date(y, (m || 1) - 1, d || 1);
  const mondayOffset = (start.getDay() + 6) % 7;
  const weekBaseMonday = new Date(start.getFullYear(), start.getMonth(), start.getDate() - mondayOffset);
  const offset = (weekNum - 1) * 7 + DAYS.indexOf(location.day);
  const date = new Date(weekBaseMonday.getFullYear(), weekBaseMonday.getMonth(), weekBaseMonday.getDate() + offset);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
