const STORAGE_KEY = "teckel_sporen_v1";
const STORAGE_VERSION = "1.0";
const TOTAL_WEEKS = 8;
const DAYS_PER_WEEK = 7;
const TOTAL_DAYS = TOTAL_WEEKS * DAYS_PER_WEEK;

const state = {
  plan: null,
  data: {
    version: STORAGE_VERSION,
    sessions: [],
    preferences: {
      dogName: "",
      startDate: todayISO(),
    },
  },
};

const elements = {
  programContainer: document.getElementById("program-container"),
  currentTarget: document.getElementById("current-target"),
  completion: document.getElementById("completion"),
  recentSessions: document.getElementById("recent-sessions"),
  progressBody: document.getElementById("progress-body"),
  sessionForm: document.getElementById("session-form"),
  settingsForm: document.getElementById("settings-form"),
  formError: document.getElementById("form-error"),
  resetButton: document.getElementById("reset-button"),
  dogName: document.getElementById("dogName"),
  startDate: document.getElementById("startDate"),
  date: document.getElementById("date"),
  week: document.getElementById("week"),
  day: document.getElementById("day"),
  exerciseId: document.getElementById("exerciseId"),
};

init();

async function init() {
  loadStorage();
  bindEvents();
  seedFormDefaults();
  try {
    await loadPlan();
  } catch (error) {
    console.error(error);
    elements.programContainer.innerHTML = "<p>Kon trainingsplan niet laden.</p>";
  }
  renderAll();
}

async function loadPlan() {
  const response = await fetch("./data/plan.json");
  if (!response.ok) {
    throw new Error("Kon trainingsplan niet laden.");
  }
  state.plan = await response.json();
}

function loadStorage() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return;

  try {
    const parsed = JSON.parse(raw);
    if (parsed.version !== STORAGE_VERSION) {
      console.warn("Storage-versie komt niet overeen. Terug naar veilige default.");
      return;
    }
    if (!Array.isArray(parsed.sessions) || typeof parsed.preferences !== "object") {
      console.warn("Storage-structuur ongeldig. Terug naar veilige default.");
      return;
    }
    state.data = parsed;
  } catch (error) {
    console.warn("Storage kon niet worden gelezen. Terug naar veilige default.", error);
  }
}

function saveStorage() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.data));
}

function bindEvents() {
  elements.sessionForm.addEventListener("submit", onSubmitSession);
  elements.settingsForm.addEventListener("submit", onSaveSettings);
  elements.resetButton.addEventListener("click", onResetData);
  elements.week.addEventListener("input", syncExerciseId);
  elements.day.addEventListener("input", syncExerciseId);
}

function seedFormDefaults() {
  const target = computeCurrentTarget();
  elements.week.value = String(target.week);
  elements.day.value = String(target.day);
  elements.date.value = todayISO();
  syncExerciseId();
}

function onSubmitSession(event) {
  event.preventDefault();
  elements.formError.textContent = "";

  const form = new FormData(elements.sessionForm);
  const session = {
    id: `${Date.now()}-${Math.floor(Math.random() * 10000)}`,
    date: String(form.get("date") || ""),
    week: Number(form.get("week")),
    day: Number(form.get("day")),
    exerciseId: String(form.get("exerciseId") || ""),
    trackLengthM: Number(form.get("trackLengthM")),
    surface: String(form.get("surface") || ""),
    distractions: Number(form.get("distractions")),
    focus: Number(form.get("focus")),
    success: Number(form.get("success")),
    notes: String(form.get("notes") || "").trim(),
  };

  const error = validateSession(session);
  if (error) {
    elements.formError.textContent = error;
    return;
  }

  state.data.sessions.push(session);
  saveStorage();
  renderAll();

  elements.notes.value = "";
  elements.trackLengthM.value = "";
  elements.distractions.value = "";
  elements.focus.value = "";
  elements.success.value = "";
}

function onSaveSettings(event) {
  event.preventDefault();
  const form = new FormData(elements.settingsForm);
  const dogName = String(form.get("dogName") || "").trim();
  const startDate = String(form.get("startDate") || "").trim();

  if (startDate && !isIsoDate(startDate)) {
    alert("Gebruik een geldige startdatum.");
    return;
  }

  state.data.preferences.dogName = dogName;
  state.data.preferences.startDate = startDate || todayISO();
  saveStorage();
  renderDashboard();
}

function onResetData() {
  const confirmed = window.confirm("Weet je zeker dat je alle lokale data wilt verwijderen?");
  if (!confirmed) return;

  localStorage.removeItem(STORAGE_KEY);
  state.data = {
    version: STORAGE_VERSION,
    sessions: [],
    preferences: {
      dogName: "",
      startDate: todayISO(),
    },
  };
  elements.settingsForm.reset();
  seedFormDefaults();
  renderAll();
}

function validateSession(session) {
  if (!isIsoDate(session.date)) return "Datum is verplicht en moet geldig zijn.";
  if (session.week < 1 || session.week > TOTAL_WEEKS) return "Week moet tussen 1 en 8 liggen.";
  if (session.day < 1 || session.day > DAYS_PER_WEEK) return "Dag moet tussen 1 en 7 liggen.";
  if (!session.exerciseId) return "Exercise ID ontbreekt.";
  if (!Number.isFinite(session.trackLengthM) || session.trackLengthM < 1) return "Spoorlengte moet minimaal 1 meter zijn.";
  if (!["gras", "bos", "zand", "mix"].includes(session.surface)) return "Ondergrond is ongeldig.";
  if (!isRating(session.distractions) || !isRating(session.focus) || !isRating(session.success)) {
    return "Ratings moeten tussen 1 en 5 liggen.";
  }
  return "";
}

function isRating(value) {
  return Number.isInteger(value) && value >= 1 && value <= 5;
}

function isIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
}

function syncExerciseId() {
  const week = clamp(Number(elements.week.value || 1), 1, TOTAL_WEEKS);
  const day = clamp(Number(elements.day.value || 1), 1, DAYS_PER_WEEK);
  elements.exerciseId.value = `w${week}d${day}`;
}

function renderAll() {
  renderDashboard();
  renderProgram();
  renderProgress();
  hydrateSettings();
}

function renderDashboard() {
  const target = computeCurrentTarget();
  elements.currentTarget.textContent = `Week ${target.week}, Dag ${target.day}`;
  elements.completion.textContent = `${completionPercent()}%`;

  const recent = [...state.data.sessions]
    .sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id))
    .slice(0, 3);

  if (recent.length === 0) {
    elements.recentSessions.innerHTML = "<li>Nog geen sessies gelogd.</li>";
    return;
  }

  elements.recentSessions.innerHTML = recent
    .map(
      (session) =>
        `<li class="session-item"><strong>${session.date}</strong> · Week ${session.week}, Dag ${session.day}<br /><small>${session.surface}, ${session.trackLengthM}m, focus ${session.focus}/5, succes ${session.success}/5</small></li>`
    )
    .join("");
}

function completionPercent() {
  const uniqueDone = new Set(state.data.sessions.map((s) => `${s.week}-${s.day}`)).size;
  return Math.round((uniqueDone / TOTAL_DAYS) * 100);
}

function computeCurrentTarget() {
  const startRaw = state.data.preferences.startDate || todayISO();
  const start = new Date(`${startRaw}T00:00:00`);
  const now = new Date();
  const diffMs = now.getTime() - start.getTime();
  const diffDays = Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24)));
  const progressIndex = clamp(diffDays, 0, TOTAL_DAYS - 1);
  const week = Math.floor(progressIndex / DAYS_PER_WEEK) + 1;
  const day = (progressIndex % DAYS_PER_WEEK) + 1;
  return { week, day };
}

function renderProgram() {
  if (!state.plan || !Array.isArray(state.plan.weeks)) {
    elements.programContainer.innerHTML = "<p>Kon programma niet laden.</p>";
    return;
  }

  elements.programContainer.innerHTML = state.plan.weeks
    .map((week) => {
      const days = week.days
        .map(
          (day) => `
          <article class="day-card">
            <h4>Dag ${day.dayNumber}: ${escapeHtml(day.title)}</h4>
            <p><strong>Setup:</strong> ${escapeHtml(day.setup)}</p>
            <ul>${day.steps.map((step) => `<li>${escapeHtml(step)}</li>`).join("")}</ul>
            <p><strong>Succescriterium:</strong> ${escapeHtml(day.successCriteria)}</p>
          </article>
        `
        )
        .join("");

      return `
        <details class="week" ${week.weekNumber === 1 ? "open" : ""}>
          <summary>Week ${week.weekNumber} · ${escapeHtml(week.goal)}</summary>
          ${days}
        </details>
      `;
    })
    .join("");
}

function renderProgress() {
  const rows = [];

  for (let week = 1; week <= TOTAL_WEEKS; week += 1) {
    const sessions = state.data.sessions.filter((s) => s.week === week);
    const count = sessions.length;
    const focusAvg = count > 0 ? average(sessions.map((s) => s.focus)).toFixed(1) : "-";
    const successAvg = count > 0 ? average(sessions.map((s) => s.success)).toFixed(1) : "-";

    rows.push(`
      <tr>
        <td>Week ${week}</td>
        <td>${count}</td>
        <td class="${focusAvg !== "-" && Number(focusAvg) >= 4 ? "good" : ""}">${focusAvg}</td>
        <td class="${successAvg !== "-" && Number(successAvg) >= 4 ? "good" : ""}">${successAvg}</td>
      </tr>
    `);
  }

  elements.progressBody.innerHTML = rows.join("");
}

function hydrateSettings() {
  elements.dogName.value = state.data.preferences.dogName || "";
  elements.startDate.value = state.data.preferences.startDate || todayISO();
}

function average(values) {
  const total = values.reduce((acc, value) => acc + value, 0);
  return total / values.length;
}

function todayISO() {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
