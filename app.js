const STORAGE_KEY = "teckel_sporen_v1";
const STORAGE_VERSION = "1.0";
const TOTAL_WEEKS = 8;
const SESSIONS_PER_WEEK = 3;
const STAR_GOAL = 8;
const TRAININGS_PER_STAR = 3;
const SESSION_LABELS = ["A", "B", "C"];

const state = {
  plan: null,
  selectedTrainingId: null,
  data: {
    version: STORAGE_VERSION,
    sessions: [],
    completedTrainings: [],
    preferences: {
      dogName: "",
      startDate: todayISO(),
      profilePhoto: "",
    },
  },
};

const page = document.body.dataset.page || "";

init();

async function init() {
  loadStorage();
  await loadPlanSafe();

  if (page === "profile") initProfilePage();
  if (page === "dashboard") initDashboardPage();
  if (page === "trainingen") initTrainingenPage();
}

async function loadPlanSafe() {
  try {
    const response = await fetch("./data/plan.json");
    if (!response.ok) throw new Error("Kon plan niet laden");
    const parsed = await response.json();
    if (!Array.isArray(parsed.weeks)) throw new Error("Ongeldig plan-formaat");
    state.plan = parsed;
  } catch (error) {
    console.error(error);
    const container = document.querySelector("main");
    if (!container) return;
    const warning = document.createElement("p");
    warning.className = "muted";
    warning.textContent =
      window.location.protocol === "file:"
        ? "Kon trainingsdata niet laden. Open via lokale server: python3 -m http.server"
        : "Kon trainingsdata niet laden.";
    container.prepend(warning);
  }
}

function loadStorage() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return;

  try {
    const parsed = JSON.parse(raw);
    if (parsed.version !== STORAGE_VERSION) return;

    const preferences = parsed.preferences && typeof parsed.preferences === "object" ? parsed.preferences : {};
    state.data = {
      version: STORAGE_VERSION,
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
      completedTrainings: Array.isArray(parsed.completedTrainings)
        ? parsed.completedTrainings.filter(isValidTrainingId)
        : [],
      preferences: {
        dogName: typeof preferences.dogName === "string" ? preferences.dogName : "",
        startDate: isIsoDate(preferences.startDate) ? preferences.startDate : todayISO(),
        profilePhoto: typeof preferences.profilePhoto === "string" ? preferences.profilePhoto : "",
      },
    };
  } catch (error) {
    console.warn("Kon storage niet lezen", error);
  }
}

function saveStorage() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.data));
}

function initProfilePage() {
  const form = document.getElementById("profile-form");
  const dogName = document.getElementById("dog-name");
  const startDate = document.getElementById("start-date");
  const photoInput = document.getElementById("photo-input");
  const photoPreview = document.getElementById("photo-preview");
  const photoRemove = document.getElementById("photo-remove");
  const msg = document.getElementById("profile-msg");

  dogName.value = state.data.preferences.dogName;
  startDate.value = state.data.preferences.startDate;
  renderPhoto(photoPreview, state.data.preferences.profilePhoto);

  photoInput.addEventListener("change", async () => {
    const file = photoInput.files && photoInput.files[0];
    if (!file) return;
    const dataUrl = await readFileAsDataUrl(file);
    state.data.preferences.profilePhoto = dataUrl;
    renderPhoto(photoPreview, dataUrl);
    msg.textContent = "Foto klaar. Klik op Profiel opslaan.";
  });

  photoRemove.addEventListener("click", () => {
    state.data.preferences.profilePhoto = "";
    photoInput.value = "";
    renderPhoto(photoPreview, "");
    msg.textContent = "Foto verwijderd. Klik op Profiel opslaan.";
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const nextName = dogName.value.trim();
    const nextDate = startDate.value;

    if (!nextName) {
      msg.textContent = "Vul een hondennaam in.";
      return;
    }
    if (!isIsoDate(nextDate)) {
      msg.textContent = "Kies een geldige startdatum.";
      return;
    }

    state.data.preferences.dogName = nextName;
    state.data.preferences.startDate = nextDate;
    saveStorage();
    msg.textContent = "Profiel opgeslagen.";
  });
}

function initDashboardPage() {
  const dogGreeting = document.getElementById("dog-greeting");
  const upcoming = document.getElementById("upcoming-session");
  const unlockStatus = document.getElementById("unlock-status");
  const stars = document.getElementById("stars");
  const progressFill = document.getElementById("progress-fill");
  const starMeta = document.getElementById("star-meta");
  const completedMeta = document.getElementById("completed-meta");

  const dogName = state.data.preferences.dogName || "je hond";
  dogGreeting.textContent = `Welkom, ${dogName}`;

  const completedCount = getCompletedCount();
  const starsEarned = Math.min(STAR_GOAL, Math.floor(completedCount / TRAININGS_PER_STAR));
  const unlockedWeeks = getUnlockedWeeks(completedCount);
  const nextTraining = getNextUpcomingTraining();

  if (nextTraining) {
    upcoming.textContent = `Volgende sessie: Week ${nextTraining.week} - Training ${SESSION_LABELS[nextTraining.session - 1]} (${nextTraining.title})`;
  } else {
    upcoming.textContent = "Volgende sessie: alle trainingen voltooid.";
  }

  unlockStatus.textContent = `Unlocked: week 1 t/m ${unlockedWeeks}. Voltooi 3 trainingen voor een extra week.`;

  stars.innerHTML = Array.from({ length: STAR_GOAL }, (_, index) => {
    const filled = index < starsEarned ? "filled" : "";
    return `<span class=\"star ${filled}\">★</span>`;
  }).join("");

  const percent = Math.min(100, (starsEarned / STAR_GOAL) * 100);
  progressFill.style.width = `${percent}%`;
  starMeta.textContent = `${starsEarned}/${STAR_GOAL} sterren verdiend`;
  completedMeta.textContent = `${completedCount} trainingen voltooid`;
}

function initTrainingenPage() {
  const weeksList = document.getElementById("weeks-list");
  const detail = document.getElementById("training-detail");

  if (!state.plan || !Array.isArray(state.plan.weeks)) {
    weeksList.innerHTML = "<p class=\"muted\">Trainingsdata niet beschikbaar.</p>";
    return;
  }

  weeksList.addEventListener("click", (event) => {
    const sessionButton = event.target.closest("button[data-training-id]");
    if (sessionButton) {
      state.selectedTrainingId = sessionButton.dataset.trainingId;
      renderTrainingenPage();
      return;
    }

    const toggleButton = event.target.closest("button[data-toggle-id]");
    if (toggleButton) {
      const id = toggleButton.dataset.toggleId;
      toggleTrainingCompletion(id);
      renderTrainingenPage();
    }
  });

  detail.addEventListener("click", (event) => {
    const toggleButton = event.target.closest("button[data-toggle-id]");
    if (!toggleButton) return;
    toggleTrainingCompletion(toggleButton.dataset.toggleId);
    renderTrainingenPage();
  });

  renderTrainingenPage();
}

function renderTrainingenPage() {
  const weeksList = document.getElementById("weeks-list");
  const detail = document.getElementById("training-detail");
  const completed = getCompletedSet();
  const unlockedWeeks = getUnlockedWeeks(completed.size);

  const weekCards = state.plan.weeks
    .map((week) => {
      const unlocked = week.weekNumber <= unlockedWeeks;
      if (!unlocked) return "";

      const sessionButtons = week.sessions
        .map((session, idx) => {
          const sessionNumber = idx + 1;
          const id = toTrainingId(week.weekNumber, sessionNumber);
          const isDone = completed.has(id);
          const isActive = state.selectedTrainingId === id;
          const activeClass = isActive ? "active" : "";
          const doneClass = isDone ? "done" : "";
          const stateLabel = isDone ? "Gedaan" : "Open";

          return `
            <button type=\"button\" class=\"session-btn ${activeClass} ${doneClass}\" data-training-id=\"${id}\">
              Training ${SESSION_LABELS[idx]}: ${escapeHtml(session.title)}
              <span class=\"session-state\">${stateLabel}</span>
            </button>
          `;
        })
        .join("");

      return `
        <article class=\"week-card\">
          <h3 class=\"week-title\">Week ${week.weekNumber} - ${escapeHtml(week.theme)}</h3>
          <div class=\"session-list\">${sessionButtons}</div>
        </article>
      `;
    })
    .join("");

  weeksList.innerHTML = weekCards;

  if (!state.selectedTrainingId || !completedTrainingExists(state.selectedTrainingId, unlockedWeeks)) {
    state.selectedTrainingId = firstUnlockedTrainingId(unlockedWeeks);
  }

  detail.innerHTML = buildTrainingDetailHtml(state.selectedTrainingId, completed);
}

function buildTrainingDetailHtml(trainingId, completedSet) {
  const training = getTrainingById(trainingId);
  if (!training) return "Selecteer een training links.";

  const done = completedSet.has(trainingId);
  const toggleLabel = done ? "Markeer als niet gedaan" : "Markeer als gedaan";

  return `
    <h3>Week ${training.week} - Training ${SESSION_LABELS[training.session - 1]}</h3>
    <p><strong>Titel:</strong> ${escapeHtml(training.title)}</p>
    <p><strong>Doel:</strong> ${escapeHtml(training.goal)}</p>
    <p><strong>Spoor:</strong> ${escapeHtml(training.track)}</p>
    <p><strong>Snoepjes:</strong> ${escapeHtml(training.snacks)}</p>
    <p><strong>Leeftijd spoor:</strong> ${escapeHtml(training.trackAge)}</p>
    <p><strong>Benodigdheden:</strong> ${escapeHtml(training.materials.join(", "))}</p>
    <button type=\"button\" class=\"button\" data-toggle-id=\"${trainingId}\">${toggleLabel}</button>
  `;
}

function toggleTrainingCompletion(trainingId) {
  const set = new Set(state.data.completedTrainings.filter(isValidTrainingId));
  if (set.has(trainingId)) {
    set.delete(trainingId);
  } else {
    set.add(trainingId);
  }
  state.data.completedTrainings = [...set].sort();
  saveStorage();
}

function getCompletedSet() {
  const fromManual = new Set(state.data.completedTrainings.filter(isValidTrainingId));
  const fromSessions = state.data.sessions
    .filter((session) => Number.isInteger(session.week) && Number.isInteger(session.day))
    .map((session) => toTrainingId(session.week, session.day))
    .filter(isValidTrainingId);

  fromSessions.forEach((id) => fromManual.add(id));
  return fromManual;
}

function getCompletedCount() {
  return getCompletedSet().size;
}

function getUnlockedWeeks(completedCount) {
  const unlocked = 2 + Math.floor(completedCount / TRAININGS_PER_STAR);
  return clamp(unlocked, 2, TOTAL_WEEKS);
}

function getNextUpcomingTraining() {
  if (!state.plan || !Array.isArray(state.plan.weeks)) return null;

  const completed = getCompletedSet();
  const unlockedWeeks = getUnlockedWeeks(completed.size);

  for (let week = 1; week <= unlockedWeeks; week += 1) {
    for (let session = 1; session <= SESSIONS_PER_WEEK; session += 1) {
      const id = toTrainingId(week, session);
      if (completed.has(id)) continue;

      const weekData = state.plan.weeks.find((item) => item.weekNumber === week);
      const sessionData = weekData && weekData.sessions[session - 1];
      if (!sessionData) continue;

      return {
        week,
        session,
        title: sessionData.title,
      };
    }
  }

  return null;
}

function completedTrainingExists(trainingId, unlockedWeeks) {
  const training = getTrainingById(trainingId);
  return Boolean(training && training.week <= unlockedWeeks);
}

function firstUnlockedTrainingId(unlockedWeeks) {
  for (let week = 1; week <= unlockedWeeks; week += 1) {
    for (let session = 1; session <= SESSIONS_PER_WEEK; session += 1) {
      if (getTrainingById(toTrainingId(week, session))) {
        return toTrainingId(week, session);
      }
    }
  }
  return null;
}

function getTrainingById(trainingId) {
  if (!isValidTrainingId(trainingId) || !state.plan) return null;

  const [weekRaw, sessionRaw] = trainingId.split("-");
  const week = Number(weekRaw);
  const session = Number(sessionRaw);

  const weekData = state.plan.weeks.find((item) => item.weekNumber === week);
  if (!weekData || !Array.isArray(weekData.sessions)) return null;

  const sessionData = weekData.sessions[session - 1];
  if (!sessionData) return null;

  return {
    week,
    session,
    title: sessionData.title,
    goal: sessionData.goal,
    track: sessionData.track,
    snacks: sessionData.snacks,
    trackAge: sessionData.trackAge,
    materials: Array.isArray(sessionData.materials) ? sessionData.materials : [],
  };
}

function isValidTrainingId(value) {
  if (typeof value !== "string" || !/^\d+-\d+$/.test(value)) return false;
  const [weekRaw, sessionRaw] = value.split("-");
  const week = Number(weekRaw);
  const session = Number(sessionRaw);
  return week >= 1 && week <= TOTAL_WEEKS && session >= 1 && session <= SESSIONS_PER_WEEK;
}

function toTrainingId(week, session) {
  return `${week}-${session}`;
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
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Kon foto niet lezen"));
    reader.readAsDataURL(file);
  });
}

function isIsoDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
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
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
