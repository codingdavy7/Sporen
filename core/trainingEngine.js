export const DAYS = ["Ma", "Di", "Wo", "Do", "Vr", "Za", "Zo"];

const DIFFICULTY_RANK = { easy: 1, medium: 2, hard: 3 };

export function createPlannerState(plan, preferences = {}) {
  const weeksById = {};
  const sessionsById = {};

  for (const week of plan.weeks || []) {
    const weekId = `w${week.weekNumber}`;
    const sessionIds = [];

    week.sessions.forEach((session, index) => {
      const id = `${weekId}-s${index + 1}`;
      sessionIds.push(id);

      sessionsById[id] = {
        id,
        weekId,
        code: `S${index + 1}`,
        title: session.title,
        difficulty: inferDifficulty(index),
        type: index === 2 ? "recovery" : "track",
        durationMin: 15,
        track: {
          lengthM: estimateLength(session.track),
          turns: estimateTurns(session.track),
          shape: inferShape(session.track),
          surface: inferSurface(session.track),
          treatPattern: session.snacks,
          endReward: "jackpot",
        },
        adaptive: {
          easier: {
            lengthM: Math.max(5, estimateLength(session.track) - 4),
            turns: Math.max(0, estimateTurns(session.track) - 1),
            note: "korter spoor",
          },
          shorter: {
            durationMin: 8,
            lengthM: 5,
            turns: 0,
            note: "mini-sessie",
          },
        },
        status: "planned",
        isLightVersion: false,
      };
    });

    weeksById[weekId] = {
      id: weekId,
      number: week.weekNumber,
      title: week.theme,
      goal: week.sessions[0]?.goal || "",
      settings: {
        surface: "gras",
        trackAgingMin: 0,
        trackAgingMax: 10,
      },
      sessions: sessionIds,
      calendar: defaultCalendarForWeek(sessionIds),
      backlog: [],
      notes: "",
    };
  }

  const program = {
    id: "teckel-spoor-8w",
    title: "Teckel Spoortraining - 8 weken",
    currentWeek: 1,
    progress: {
      weeksCompleted: [],
      sessionsCompleted: [],
    },
    dogProfile: {
      name: preferences.dogName || "",
      ageMonths: null,
      level: "beginner",
      rewardType: "food",
      stressSensitive: true,
    },
  };

  return {
    program,
    weeksById,
    sessionsById,
    logs: [],
    ui: {
      selectedWeekId: "w1",
      moveDialogOpen: false,
      pendingMove: null,
      moveMode: false,
    },
  };
}

export function validateWeek(week, sessionMap) {
  const warnings = [];

  const isHardDay = (day) => {
    return week.calendar[day].some((sessionId) => {
      const s = sessionMap[sessionId];
      return s && DIFFICULTY_RANK[s.difficulty] >= 2;
    });
  };

  for (let i = 0; i < DAYS.length - 1; i += 1) {
    if (isHardDay(DAYS[i]) && isHardDay(DAYS[i + 1])) {
      warnings.push({
        type: "recovery",
        message: `${DAYS[i]} en ${DAYS[i + 1]} zijn allebei medium/moeilijk.`,
      });
    }
  }

  for (const day of DAYS) {
    if (week.calendar[day].length > 1) {
      warnings.push({
        type: "overload",
        message: `${day} heeft ${week.calendar[day].length} sessies gepland.`,
      });
    }
  }

  const restDays = DAYS.filter((day) => week.calendar[day].length === 0).length;
  if (restDays < 2) {
    warnings.push({
      type: "rest",
      message: "Weinig rustdagen over. Let op focus en frustratie.",
    });
  }

  return warnings;
}

export function moveSession(planner, sessionId, fromDay, toDay, strategy = "append", options = {}) {
  const week = planner.weeksById[planner.sessionsById[sessionId]?.weekId];
  if (!week || !week.calendar[fromDay] || !week.calendar[toDay]) return { ok: false, message: "Ongeldige verplaatsing" };

  removeSessionFromWeek(week, sessionId);

  if (strategy === "swap" && week.calendar[toDay].length > 0) {
    const swapped = week.calendar[toDay].shift();
    week.calendar[fromDay].push(swapped);
  }
  week.calendar[toDay].push(sessionId);

  if (options.lightVersion) planner.sessionsById[sessionId].isLightVersion = true;
  planner.sessionsById[sessionId].status = "moved";

  return { ok: true, warnings: validateWeek(week, planner.sessionsById) };
}

export function markSessionMissed(planner, sessionId, day) {
  const week = planner.weeksById[planner.sessionsById[sessionId]?.weekId];
  if (!week) return { ok: false };

  removeSessionFromWeek(week, sessionId, day);
  if (!week.backlog.includes(sessionId)) week.backlog.push(sessionId);
  planner.sessionsById[sessionId].status = "missed";

  return { ok: true, warnings: validateWeek(week, planner.sessionsById) };
}

export function replanFromBacklog(planner, sessionId, toDay, options = {}) {
  const week = planner.weeksById[planner.sessionsById[sessionId]?.weekId];
  if (!week || !week.calendar[toDay]) return { ok: false };

  week.backlog = week.backlog.filter((id) => id !== sessionId);
  week.calendar[toDay].push(sessionId);
  if (options.lightVersion) planner.sessionsById[sessionId].isLightVersion = true;
  planner.sessionsById[sessionId].status = "moved";

  return { ok: true, warnings: validateWeek(week, planner.sessionsById) };
}

export function autoReshuffleWeek(planner, weekId) {
  const week = planner.weeksById[weekId];
  if (!week) return { ok: false, moved: [] };

  const ordered = [...week.sessions];
  const before = snapshotCalendar(week.calendar);

  for (const day of DAYS) week.calendar[day] = [];

  const dayOrder = ["Di", "Do", "Za", "Ma", "Wo", "Vr", "Zo"];
  for (const sessionId of ordered) {
    const chosenDay = findBestDay(week, sessionId, dayOrder, planner.sessionsById);
    week.calendar[chosenDay].push(sessionId);
  }

  const moved = diffCalendars(before, week.calendar);
  return { ok: true, moved, warnings: validateWeek(week, planner.sessionsById) };
}

export function resetWeek(planner, weekId) {
  const week = planner.weeksById[weekId];
  if (!week) return { ok: false };

  week.calendar = defaultCalendarForWeek(week.sessions);
  week.backlog = [];
  week.notes = "";
  week.sessions.forEach((sessionId) => {
    planner.sessionsById[sessionId].status = "planned";
    planner.sessionsById[sessionId].isLightVersion = false;
  });

  return { ok: true, warnings: validateWeek(week, planner.sessionsById) };
}

export function completeSession(planner, sessionId, payload) {
  const session = planner.sessionsById[sessionId];
  if (!session) return { ok: false };

  session.status = "done";
  if (!planner.program.progress.sessionsCompleted.includes(sessionId)) {
    planner.program.progress.sessionsCompleted.push(sessionId);
  }

  const weekNumber = Number(session.weekId.replace("w", ""));
  const weekSessions = planner.weeksById[session.weekId].sessions;
  const allDone = weekSessions.every((id) => planner.program.progress.sessionsCompleted.includes(id));
  if (allDone && !planner.program.progress.weeksCompleted.includes(weekNumber)) {
    planner.program.progress.weeksCompleted.push(weekNumber);
  }

  const logEntry = {
    id: `log-${payload.date}-${sessionId}`,
    date: payload.date,
    weekId: session.weekId,
    sessionId,
    surface: payload.surface || session.track.surface,
    weather: payload.weather || "onbekend",
    successScore: Number(payload.successScore || 0),
    focus: payload.focus || "middel",
    notes: payload.notes || "",
    photoDataUrl: payload.photoDataUrl || "",
    observations: {
      noseDown: Boolean(payload.noseDown),
      calmPace: Boolean(payload.calmPace),
      foundTurn: payload.foundTurn === null ? null : Boolean(payload.foundTurn),
      distracted: Boolean(payload.distracted),
    },
  };

  planner.logs.push(logEntry);
  return { ok: true, logEntry };
}

export function saveWeekNotes(planner, weekId, notes) {
  const week = planner.weeksById[weekId];
  if (!week) return { ok: false };
  week.notes = notes;
  return { ok: true };
}

export function setCurrentWeek(planner, weekId) {
  const week = planner.weeksById[weekId];
  if (!week) return { ok: false };
  planner.program.currentWeek = week.number;
  planner.ui.selectedWeekId = weekId;
  return { ok: true };
}

function defaultCalendarForWeek(sessionIds) {
  const calendar = { Ma: [], Di: [], Wo: [], Do: [], Vr: [], Za: [], Zo: [] };
  if (sessionIds[0]) calendar.Di.push(sessionIds[0]);
  if (sessionIds[1]) calendar.Do.push(sessionIds[1]);
  if (sessionIds[2]) calendar.Za.push(sessionIds[2]);
  return calendar;
}

function removeSessionFromWeek(week, sessionId, dayHint = null) {
  if (dayHint && week.calendar[dayHint]) {
    week.calendar[dayHint] = week.calendar[dayHint].filter((id) => id !== sessionId);
  }
  for (const day of DAYS) {
    week.calendar[day] = week.calendar[day].filter((id) => id !== sessionId);
  }
  week.backlog = week.backlog.filter((id) => id !== sessionId);
}

function inferDifficulty(index) {
  if (index === 0) return "easy";
  if (index === 1) return "medium";
  return "hard";
}

function estimateLength(trackText = "") {
  const match = String(trackText).match(/(\d{1,3})\s*(?:-|tot|\u2013)?\s*(\d{1,3})?\s*m/i);
  if (!match) return 10;
  const a = Number(match[1]);
  const b = Number(match[2] || 0);
  return b ? Math.round((a + b) / 2) : a;
}

function estimateTurns(trackText = "") {
  const direct = String(trackText).match(/(\d+)\s*bocht/i);
  if (direct) return Number(direct[1]);
  return String(trackText).toLowerCase().includes("bocht") ? 1 : 0;
}

function inferShape(trackText = "") {
  const lower = String(trackText).toLowerCase();
  if (lower.includes("l-vorm") || lower.includes("90")) return "L";
  return "line";
}

function inferSurface(trackText = "") {
  const lower = String(trackText).toLowerCase();
  if (lower.includes("bos")) return "bos";
  if (lower.includes("zand")) return "zand";
  if (lower.includes("mix")) return "mix";
  return "gras";
}

function findBestDay(week, sessionId, dayOrder, sessionMap) {
  for (const day of dayOrder) {
    if (week.calendar[day].length > 0) continue;
    if (!createsHardSequence(week, day, sessionId, sessionMap)) return day;
  }

  for (const day of dayOrder) {
    if (!createsHardSequence(week, day, sessionId, sessionMap)) return day;
  }

  return dayOrder[0];
}

function createsHardSequence(week, day, sessionId, sessionMap) {
  const idx = DAYS.indexOf(day);
  const next = DAYS[idx + 1];
  const prev = DAYS[idx - 1];
  const hard = (id) => DIFFICULTY_RANK[sessionMap[id]?.difficulty || "easy"] >= 2;
  const sessionHard = hard(sessionId);

  if (!sessionHard) return false;

  if (prev && week.calendar[prev].some(hard)) return true;
  if (next && week.calendar[next].some(hard)) return true;
  return false;
}

function snapshotCalendar(calendar) {
  const copy = {};
  for (const day of DAYS) copy[day] = [...calendar[day]];
  return copy;
}

function diffCalendars(before, after) {
  const moved = [];
  for (const day of DAYS) {
    for (const id of after[day]) {
      const prevDay = DAYS.find((d) => before[d].includes(id));
      if (prevDay && prevDay !== day) {
        moved.push({ sessionId: id, from: prevDay, to: day });
      }
    }
  }
  return moved;
}
