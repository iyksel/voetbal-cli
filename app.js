'use strict';

// Best practice: start ook via CLI met TZ=Europe/Brussels node app.js [web:75]
process.env.TZ = 'Europe/Brussels';

const Database = require('better-sqlite3');
const chrono = require('chrono-node');
const readline = require('readline');

const db = new Database('voetbal.db');
db.pragma('foreign_keys = ON');

const CONFIG = {
  playerLimit: 10,
  dayMessageHour: 9,
  reminderHoursBefore: 2,
  schedulerTickMs: 2000,
  schedulerBatch: 25,
};

// -------------------- DB SCHEMA --------------------
db.exec(`
CREATE TABLE IF NOT EXISTS players (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  display_name TEXT NOT NULL,
  name_normalized TEXT NOT NULL UNIQUE,
  is_guest INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  games INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  position TEXT CHECK(position IN ('keeper', 'verdediger', 'middenveld', 'aanvaller')),
  mvp_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_date TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open', -- open, full, cancelled, closed
  player_limit INTEGER NOT NULL DEFAULT 10,
  created_at INTEGER NOT NULL,
  roster_hash TEXT,
  teams_generated_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_matches_status ON matches(status);
CREATE INDEX IF NOT EXISTS idx_matches_date ON matches(match_date);

CREATE TABLE IF NOT EXISTS match_players (
  match_id INTEGER NOT NULL,
  player_id INTEGER NOT NULL,
  signup_state TEXT NOT NULL,          -- 'ja' of 'kan'
  joined_at INTEGER NOT NULL,
  team TEXT,                           -- NULL tot teams gemaakt; daarna 'wit' of 'zwart'
  is_waitlist INTEGER NOT NULL DEFAULT 0,  -- 1 = op wachtlijst
  waitlist_position INTEGER,           -- positie op wachtlijst (1, 2, 3, ...)
  PRIMARY KEY (match_id, player_id),
  FOREIGN KEY(match_id) REFERENCES matches(id) ON DELETE CASCADE,
  FOREIGN KEY(player_id) REFERENCES players(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS match_results (
  match_id INTEGER PRIMARY KEY,
  winner_team TEXT NOT NULL,           -- 'wit' of 'zwart'
  score TEXT,                          -- bijv. '1-0', '0-2'
  decided_at INTEGER NOT NULL,
  decided_by_player_id INTEGER,
  FOREIGN KEY(match_id) REFERENCES matches(id) ON DELETE CASCADE,
  FOREIGN KEY(decided_by_player_id) REFERENCES players(id)
);

CREATE TABLE IF NOT EXISTS scheduled_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id INTEGER NOT NULL,
  action_type TEXT NOT NULL,           -- 'day_message' | 'reminder' | 'start_check'
  run_at TEXT NOT NULL,                -- ISO
  executed_at INTEGER,
  cancelled_at INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(match_id) REFERENCES matches(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_actions_due
ON scheduled_actions(executed_at, cancelled_at, run_at);

CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  match_id INTEGER,
  type TEXT NOT NULL,
  text TEXT NOT NULL,
  FOREIGN KEY(match_id) REFERENCES matches(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS mvp_votes (
  match_id INTEGER NOT NULL,
  voter_player_id INTEGER NOT NULL,
  voted_player_id INTEGER NOT NULL,
  voted_at INTEGER NOT NULL,
  PRIMARY KEY (match_id, voter_player_id),
  FOREIGN KEY(match_id) REFERENCES matches(id) ON DELETE CASCADE,
  FOREIGN KEY(voter_player_id) REFERENCES players(id) ON DELETE CASCADE,
  FOREIGN KEY(voted_player_id) REFERENCES players(id) ON DELETE CASCADE
);
`);

// -------------------- CLI CONTEXT --------------------
const ctx = {
  currentPlayerId: null,
  currentPlayerName: null,
};

// -------------------- HELPERS --------------------
function nowMs() { return Date.now(); }

function normalizeName(name) {
  let s = String(name || '').trim().toLowerCase();
  // verwijder omringende quotes en extra whitespace
  s = s.replace(/^['"\s]+|['"\s]+$/g, '');
  // collapse meerdere spaties naar één
  s = s.replace(/\s+/g, ' ');
  return s;
}

function titleCaseWords(norm) {
  return norm
    .split(' ')
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function isoDateOnlyLocal(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  const y = x.getFullYear();
  const m = String(x.getMonth() + 1).padStart(2, '0');
  const day = String(x.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function fmtDateTime(d) {
  const x = new Date(d);
  return x.toLocaleString('nl-BE', {
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function fmtTime(d) {
  const x = new Date(d);
  return x.toLocaleTimeString('nl-BE', { hour: '2-digit', minute: '2-digit' });
}

function enqueue(type, text, matchId = null) {
  db.prepare(`INSERT INTO outbox (created_at, match_id, type, text) VALUES (?, ?, ?, ?)`)
    .run(nowMs(), matchId, type, text);
  console.log(text);
}

function requireUser() {
  if (!ctx.currentPlayerId) throw new Error(`Zet eerst je user met /as <naam>.`);
}

function getActiveMatch() {
  return db.prepare(`
    SELECT * FROM matches
    WHERE status IN ('open','full')
    ORDER BY datetime(starts_at) ASC
    LIMIT 1
  `).get();
}

function getMatch(matchId) {
  return db.prepare(`SELECT * FROM matches WHERE id = ?`).get(matchId);
}

function listSignups(matchId) {
  return db.prepare(`
    SELECT mp.player_id, mp.signup_state, mp.joined_at, mp.team,
           mp.is_waitlist, mp.waitlist_position,
           p.display_name, p.wins, p.games, p.position
    FROM match_players mp
    JOIN players p ON p.id = mp.player_id
    WHERE mp.match_id = ? AND mp.is_waitlist = 0
    ORDER BY mp.joined_at ASC
  `).all(matchId);
}

function listWaitlist(matchId) {
  return db.prepare(`
    SELECT mp.player_id, mp.signup_state, mp.joined_at, mp.waitlist_position,
           p.display_name, p.wins, p.games, p.position
    FROM match_players mp
    JOIN players p ON p.id = mp.player_id
    WHERE mp.match_id = ? AND mp.is_waitlist = 1
    ORDER BY mp.waitlist_position ASC
  `).all(matchId);
}

function countTotal(matchId) {
  return db.prepare(`SELECT COUNT(*) AS c FROM match_players WHERE match_id = ? AND is_waitlist = 0`).get(matchId).c;
}

function countYes(matchId) {
  return db.prepare(`
    SELECT COUNT(*) AS c FROM match_players
    WHERE match_id = ? AND signup_state = 'ja' AND is_waitlist = 0
  `).get(matchId).c;
}

function countMaybe(matchId) {
  return db.prepare(`
    SELECT COUNT(*) AS c FROM match_players
    WHERE match_id = ? AND signup_state = 'kan' AND is_waitlist = 0
  `).get(matchId).c;
}

function countWaitlist(matchId) {
  return db.prepare(`SELECT COUNT(*) AS c FROM match_players WHERE match_id = ? AND is_waitlist = 1`).get(matchId).c;
}

function getNextWaitlistPosition(matchId) {
  const row = db.prepare(`SELECT MAX(waitlist_position) AS max FROM match_players WHERE match_id = ? AND is_waitlist = 1`).get(matchId);
  return (row.max || 0) + 1;
}

// status=open/full is “lijst vol” (ja+kan), niet “ready”
function updateMatchStatus(matchId) {
  const m = getMatch(matchId);
  if (!m) return null;
  if (m.status === 'cancelled' || m.status === 'closed') return m.status;

  const total = countTotal(matchId);
  const newStatus = (total >= m.player_limit) ? 'full' : 'open';
  db.prepare(`UPDATE matches SET status = ? WHERE id = ?`).run(newStatus, matchId);
  return newStatus;
}

function clearTeams(matchId) {
  db.prepare(`UPDATE match_players SET team = NULL WHERE match_id = ?`).run(matchId);
  db.prepare(`UPDATE matches SET roster_hash = NULL, teams_generated_at = NULL WHERE id = ?`).run(matchId);
}

function computeRosterHash(rows) {
  const ids = rows.slice().map(r => r.player_id).sort((a, b) => a - b);
  return ids.join('|');
}

function ensurePlayerByName(inputName, isGuest = 0) {
  const norm = normalizeName(inputName);
  if (!norm) throw new Error('Lege naam.');

  const display = titleCaseWords(norm);

  const existing = db.prepare(`SELECT * FROM players WHERE name_normalized = ?`).get(norm);
  if (existing) {
    // upgrade display_name indien het vroeger in lowercase opgeslagen werd
    if (existing.display_name !== display) {
      db.prepare(`UPDATE players SET display_name = ? WHERE id = ?`).run(display, existing.id);
      return db.prepare(`SELECT * FROM players WHERE id = ?`).get(existing.id);
    }
    return existing;
  }

  const info = db.prepare(`
    INSERT INTO players (display_name, name_normalized, is_guest, created_at)
    VALUES (?, ?, ?, ?)
  `).run(display, norm, isGuest ? 1 : 0, nowMs());

  return db.prepare(`SELECT * FROM players WHERE id = ?`).get(info.lastInsertRowid);
}

// -------------------- ROBUUSTE DATUM/TIJD PARSING --------------------
function normalizeDateText(raw) {
  let s = String(raw || '').trim().toLowerCase();
  s = s.replace(/\s+/g, ' ');

  // h -> u (21h, 21h30)
  s = s.replace(/(\d)\s*h(\d?)/g, '$1u$2');

  // 21u => 21:00
  s = s.replace(/\b(\d{1,2})\s*u\b/g, (_, hh) => `${hh}:00`);

  // 21u30 => 21:30
  s = s.replace(/\b(\d{1,2})\s*u\s*(\d{1,2})\b/g, (_, hh, mm) => `${hh}:${String(mm).padStart(2, '0')}`);

  // 21.30 => 21:30
  s = s.replace(/\b(\d{1,2})\.(\d{2})\b/g, '$1:$2');

  // 21:0 => 21:00
  s = s.replace(/\b(\d{1,2}):(\d)\b/g, (_, hh, m1) => `${hh}:${m1}0`);

  return s;
}

function containsWeekdayOrRelative(normalized) {
  return /\b(maandag|dinsdag|woensdag|donderdag|vrijdag|zaterdag|zondag|vandaag|morgen|overmorgen)\b/i.test(normalized);
}

function parseDateTimeNlRobust(rawText) {
  const normalized = normalizeDateText(rawText);
  const d = chrono.nl.parseDate(normalized, new Date(), { forwardDate: true }); // forwardDate: future assumption [web:10]
  if (!d) return null;

  // Safety: als chrono toch een tijd in het verleden geeft (bv. "vandaag 10:00" om 14:00),
  // schuiven we forward naar de eerstvolgende logische future datum.
  if (d <= new Date() && containsWeekdayOrRelative(normalized)) {
    const dd = new Date(d);
    // voor "vandaag/morgen/overmorgen" -> schuif per dag; voor weekdagen -> per 7 dagen
    const isRelative = /\b(vandaag|morgen|overmorgen)\b/i.test(normalized);
    const stepDays = isRelative ? 1 : 7;

    while (dd <= new Date()) dd.setDate(dd.getDate() + stepDays);
    return { date: dd, normalized };
  }

  return { date: d, normalized };
}

// -------------------- WINRATE (pure + Wilson Score for teams) --------------------
function pureWinrate(p) {
  if (!p.games) return 0;
  return p.wins / p.games;
}

/**
 * Wilson Score Lower Bound (95% confidence).
 * Geeft een conservatieve schatting van de winrate:
 *  - Weinig games → score dichter bij 50% (onzeker)
 *  - Veel games   → score nadert echte winrate
 *  - 0 games      → 0.25 (conservatieve startwaarde)
 */
function wilsonScore(p) {
  if (!p.games) return 0.25;
  const n = p.games;
  const phat = p.wins / n;
  const z = 1.96; // 95% confidence
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = phat + z2 / (2 * n);
  const margin = z * Math.sqrt((phat * (1 - phat)) / n + z2 / (4 * n * n));
  return (centre - margin) / denom;
}

// -------------------- TEAMS --------------------
function combinations(arr, k) {
  const ret = [];
  const n = arr.length;
  function rec(start, comb) {
    if (comb.length === k) { ret.push(comb.slice()); return; }
    for (let i = start; i < n; i++) {
      comb.push(arr[i]);
      rec(i + 1, comb);
      comb.pop();
    }
  }
  rec(0, []);
  return ret;
}

/**
 * Bereken defensive strength van een team.
 * Keeper: 100% defense, Verdediger: 100%, Middenveld: 50%, Aanvaller: 0%
 */
function calcDefensiveStrength(team) {
  let strength = 0;
  for (const p of team) {
    if (p.position === 'keeper') strength += 1.0;
    else if (p.position === 'verdediger') strength += 1.0;
    else if (p.position === 'middenveld') strength += 0.5;
    // aanvaller en onbekend: 0
  }
  return strength;
}

/**
 * Bereken offensive strength van een team.
 * Aanvaller: 100%, Middenveld: 50%, Verdediger: 0%, Keeper: 0%
 */
function calcOffensiveStrength(team) {
  let strength = 0;
  for (const p of team) {
    if (p.position === 'aanvaller') strength += 1.0;
    else if (p.position === 'middenveld') strength += 0.5;
    // verdediger, keeper en onbekend: 0
  }
  return strength;
}

/**
 * Tel aantal keepers in team
 */
function countKeepers(team) {
  return team.filter(p => p.position === 'keeper').length;
}

/**
 * Bereken standaarddeviatie van Wilson scores binnen een team.
 * Lagere stddev = meer balanced team (geen superstars + zwakke spelers)
 */
function calcWilsonStdDev(team) {
  const rates = team.map(p => p.rate);
  const mean = rates.reduce((s, r) => s + r, 0) / rates.length;
  const variance = rates.reduce((s, r) => s + Math.pow(r - mean, 2), 0) / rates.length;
  return Math.sqrt(variance);
}

/**
 * Bereken variance van Wilson scores binnen een team.
 * Gebruikt variance (stddev²) voor exponentiële penalty op hoge spreiding.
 */
function calcWilsonVariance(team) {
  const rates = team.map(p => p.rate);
  const mean = rates.reduce((s, r) => s + r, 0) / rates.length;
  const variance = rates.reduce((s, r) => s + Math.pow(r - mean, 2), 0) / rates.length;
  return variance;
}

/**
 * Verbeterd team balancing algoritme:
 * Balanceert op 4 dimensies:
 * 1. Wilson score (skill level) - GEMIDDELDE
 * 2. Wilson spreiding (standaarddeviatie) - INTERN BALANCED
 * 3. Defensive strength (met middenveld als 50%)
 * 4. Offensive strength (met middenveld als 50%)
 *
 * Keeper mis-match krijgt extra zware penalty.
 */
function generateBalancedTeams(players10) {
  const players = players10.map(p => ({ ...p, rate: wilsonScore(p) }));

  // Bereken totalen voor alle spelers
  const totalWilson = players.reduce((s, p) => s + p.rate, 0);
  const totalDefense = calcDefensiveStrength(players);
  const totalOffense = calcOffensiveStrength(players);
  const totalKeepers = countKeepers(players);

  const combs = combinations(players, 5);
  let best = null;
  let bestScore = Infinity;

  for (const teamA of combs) {
    const teamB = players.filter(p => !teamA.some(a => a.player_id === p.player_id));

    // 1. Wilson score balans (target: 50% elk)
    const wilsonA = teamA.reduce((s, p) => s + p.rate, 0);
    const wilsonDiff = Math.abs(wilsonA - (totalWilson / 2));

    // 2. Wilson spreiding: σ moet GELIJK zijn tussen beide teams
    const stdDevA = calcWilsonStdDev(teamA);
    const stdDevB = calcWilsonStdDev(teamB);
    // Verschil in σ tussen teams = moet minimaal zijn
    const stdDevDiff = Math.abs(stdDevA - stdDevB);

    // 3. Defensive strength balans
    const defenseA = calcDefensiveStrength(teamA);
    const defenseDiff = Math.abs(defenseA - (totalDefense / 2));

    // 4. Offensive strength balans
    const offenseA = calcOffensiveStrength(teamA);
    const offenseDiff = Math.abs(offenseA - (totalOffense / 2));

    // Keeper balans (probeer gelijk te verdelen)
    const keepersA = countKeepers(teamA);
    const keepersB = countKeepers(teamB);
    let keeperPenalty = 0;

    if (totalKeepers === 2) {
      // Ideaal: 1-1 verdeling
      keeperPenalty = (keepersA !== 1) ? 15 : 0;
    } else if (totalKeepers === 1) {
      // Acceptabel: 1-0 verdeling (geen penalty)
      keeperPenalty = 0;
    } else if (totalKeepers > 2) {
      // Probeer zo gelijk mogelijk te verdelen
      keeperPenalty = Math.abs(keepersA - keepersB) * 5;
    }

    // Totale score (lagere = beter)
    // PRIORITEIT: 1) Posities, 2) Wilson totaal, 3) σ verschil
    const score =
      defenseDiff * 100.0 +      // #1 Positie balans: HOOGSTE prioriteit
      offenseDiff * 100.0 +      // #1 Positie balans: HOOGSTE prioriteit
      keeperPenalty * 80.0 +     // #1 Keeper balans: zeer belangrijk
      wilsonDiff * 60.0 +        // #2 Wilson totaal gelijk: belangrijk
      stdDevDiff * 30.0;         // #3 σ verschil: laagste prioriteit

    if (score < bestScore) {
      bestScore = score;
      best = {
        teamA,
        teamB,
        wilsonDiff,
        stdDevDiff,
        stdDevA,
        stdDevB,
        defenseDiff,
        offenseDiff,
        keepersA,
        keepersB
      };
    }
  }

  return {
    teamWit: best.teamA,
    teamZwart: best.teamB,
    diff: best.wilsonDiff,
    stdDevDiff: best.stdDevDiff,
    defenseDiff: best.defenseDiff,
    offenseDiff: best.offenseDiff
  };
}

function isReadyForTeams(matchId) {
  const m = getMatch(matchId);
  if (!m) return false;

  const yes = countYes(matchId);
  const total = countTotal(matchId);

  // jouw regel: /kan telt niet; je moet 10x /ja hebben + totaal moet ook exact 10 zijn
  return (yes === m.player_limit) && (total === m.player_limit);
}

function ensureTeamsUpToDate(matchId, { autoPost = false, force = false } = {}) {
  const m = getMatch(matchId);
  if (!m) return { ok: false, reason: 'no_match' };
  if (!isReadyForTeams(matchId)) return { ok: false, reason: 'not_ready' };

  const rows = listSignups(matchId);
  const rosterHash = computeRosterHash(rows);

  // Skip cache check als force=true (herbereken altijd)
  if (!force && m.roster_hash && m.roster_hash === rosterHash && m.teams_generated_at) {
    if (autoPost) postTeams(matchId, { header: 'Teams (ongewijzigd)' });
    return { ok: true, recomputed: false };
  }

  const { teamWit, teamZwart, diff, stdDevDiff, defenseDiff, offenseDiff } = generateBalancedTeams(rows);

  const tx = db.transaction(() => {
    db.prepare(`UPDATE match_players SET team = NULL WHERE match_id = ?`).run(matchId);

    const upd = db.prepare(`UPDATE match_players SET team = ? WHERE match_id = ? AND player_id = ?`);
    for (const p of teamWit) upd.run('wit', matchId, p.player_id);
    for (const p of teamZwart) upd.run('zwart', matchId, p.player_id);

    db.prepare(`UPDATE matches SET roster_hash = ?, teams_generated_at = ? WHERE id = ?`)
      .run(rosterHash, nowMs(), matchId);
  });
  tx();

  if (autoPost) postTeams(matchId, { header: `Teams (nieuw) diff=${diff.toFixed(4)}` });
  return { ok: true, recomputed: true };
}

function postTeams(matchId, { header = 'Teams' } = {}) {
  const rows = listSignups(matchId);
  const wit = rows.filter(r => r.team === 'wit');
  const zwart = rows.filter(r => r.team === 'zwart');

  if (wit.length !== 5 || zwart.length !== 5) {
    enqueue('error', `Kan teams niet tonen: niet correct opgeslagen (wit=${wit.length}, zwart=${zwart.length}).`, matchId);
    return;
  }

  // Voeg Wilson rate toe aan spelers
  const witWithRate = wit.map(p => ({ ...p, rate: wilsonScore(p) }));
  const zwartWithRate = zwart.map(p => ({ ...p, rate: wilsonScore(p) }));

  // Bereken stats per team
  const avgW = witWithRate.reduce((s, p) => s + p.rate, 0) / 5;
  const avgZ = zwartWithRate.reduce((s, p) => s + p.rate, 0) / 5;
  const stdDevW = calcWilsonStdDev(witWithRate);
  const stdDevZ = calcWilsonStdDev(zwartWithRate);
  const defW = calcDefensiveStrength(wit);
  const defZ = calcDefensiveStrength(zwart);
  const offW = calcOffensiveStrength(wit);
  const offZ = calcOffensiveStrength(zwart);

  // Korte positie labels
  const posLabel = (pos) => {
    if (pos === 'keeper') return 'K';
    if (pos === 'verdediger') return 'V';
    if (pos === 'middenveld') return 'M';
    if (pos === 'aanvaller') return 'A';
    return '?';
  };

  // Sorteer functie: K -> V -> M -> A -> onbekend
  const posOrder = { 'keeper': 1, 'verdediger': 2, 'middenveld': 3, 'aanvaller': 4 };
  const sortByPosition = (a, b) => {
    const orderA = posOrder[a.position] || 99;
    const orderB = posOrder[b.position] || 99;
    return orderA - orderB;
  };

  // Sorteer beide teams
  const witSorted = wit.slice().sort(sortByPosition);
  const zwartSorted = zwart.slice().sort(sortByPosition);

  const linesW = witSorted.map(p => {
    const pos = p.position ? `[${posLabel(p.position)}]` : '[?]';
    const wilson = (wilsonScore(p) * 100).toFixed(0);
    return `- ${p.display_name} ${pos} (W:${wilson}% | ${p.wins}W/${p.games}G)`;
  });
  const linesZ = zwartSorted.map(p => {
    const pos = p.position ? `[${posLabel(p.position)}]` : '[?]';
    const wilson = (wilsonScore(p) * 100).toFixed(0);
    return `- ${p.display_name} ${pos} (W:${wilson}% | ${p.wins}W/${p.games}G)`;
  });

  enqueue('teams',
    [
      `${header}`,
      ``,
      `⬜ Team Wit`,
      `   Wilson: ${(avgW * 100).toFixed(1)}% (σ=${(stdDevW * 100).toFixed(1)}%) | DEF: ${defW.toFixed(1)} | OFF: ${offW.toFixed(1)}`,
      ...linesW,
      ``,
      `⬛ Team Zwart`,
      `   Wilson: ${(avgZ * 100).toFixed(1)}% (σ=${(stdDevZ * 100).toFixed(1)}%) | DEF: ${defZ.toFixed(1)} | OFF: ${offZ.toFixed(1)}`,
      ...linesZ,
    ].join('\n'),
    matchId
  );
}

// -------------------- SCHEDULER (DB-driven) --------------------
function cancelAllActions(matchId) {
  db.prepare(`
    UPDATE scheduled_actions
    SET cancelled_at = ?
    WHERE match_id = ? AND executed_at IS NULL AND cancelled_at IS NULL
  `).run(nowMs(), matchId);
}

function createActionsForMatch(matchId) {
  cancelAllActions(matchId);

  const m = getMatch(matchId);
  if (!m) return;
  if (m.status === 'cancelled' || m.status === 'closed') return;

  const startsAt = new Date(m.starts_at);

  const dayMsgAt = new Date(startsAt);
  dayMsgAt.setHours(CONFIG.dayMessageHour, 0, 0, 0);

  const reminderAt = new Date(startsAt.getTime() - CONFIG.reminderHoursBefore * 60 * 60 * 1000);

  const ins = db.prepare(`
    INSERT INTO scheduled_actions (match_id, action_type, run_at, executed_at, cancelled_at, created_at)
    VALUES (?, ?, ?, NULL, NULL, ?)
  `);

  const createdAt = nowMs();
  ins.run(matchId, 'day_message', dayMsgAt.toISOString(), createdAt);
  ins.run(matchId, 'reminder', reminderAt.toISOString(), createdAt);
  ins.run(matchId, 'start_check', startsAt.toISOString(), createdAt);
}

function executeDueActionsOnce() {
  const due = db.prepare(`
    SELECT * FROM scheduled_actions
    WHERE executed_at IS NULL AND cancelled_at IS NULL
      AND datetime(run_at) <= datetime(?)
    ORDER BY datetime(run_at) ASC
    LIMIT ?
  `).all(new Date().toISOString(), CONFIG.schedulerBatch);

  for (const a of due) {
    const claimed = db.prepare(`
      UPDATE scheduled_actions
      SET executed_at = ?
      WHERE id = ? AND executed_at IS NULL AND cancelled_at IS NULL
    `).run(nowMs(), a.id);

    if (claimed.changes !== 1) continue;

    const m = getMatch(a.match_id);
    if (!m) continue;
    if (m.status === 'cancelled' || m.status === 'closed') continue;

    if (a.action_type === 'day_message') {
      enqueue('info', `Vandaag ${fmtTime(m.starts_at)} — /ja om te bevestigen, /kan als je misschien kan.`, m.id);
    }

    if (a.action_type === 'reminder') {
      const yes = countYes(m.id);
      const maybe = countMaybe(m.id);
      const needSure = Math.max(0, m.player_limit - yes);
      enqueue('reminder', `Reminder: nog ${CONFIG.reminderHoursBefore} uur — zeker: ${yes}/${m.player_limit}, misschien: ${maybe}. Nog ${needSure} zeker nodig.`, m.id);
    }

    if (a.action_type === 'start_check') {
      const yes = countYes(m.id);
      const total = countTotal(m.id);

      if (yes < m.player_limit) {
        db.prepare(`UPDATE matches SET status = 'cancelled' WHERE id = ?`).run(m.id);
        clearTeams(m.id);
        cancelAllActions(m.id);
        enqueue('cancel', `Gecanceld: startmoment bereikt maar niet genoeg zeker (ja=${yes}/${m.player_limit}, totaal=${total}/${m.player_limit}).`, m.id);
      } else {
        ensureTeamsUpToDate(m.id, { autoPost: false });
        enqueue('start', `Tijd om te spelen! (zeker ${yes}/${m.player_limit})`, m.id);
      }
    }
  }
}

setInterval(executeDueActionsOnce, CONFIG.schedulerTickMs);

// -------------------- TRANSACTIONS --------------------
const txSignup = db.transaction((matchId, playerId, state) => {
  const m = getMatch(matchId);
  if (!m) throw new Error('Match bestaat niet.');
  if (m.status === 'cancelled' || m.status === 'closed') throw new Error(`Match is ${m.status}.`);

  const existing = db.prepare(`SELECT * FROM match_players WHERE match_id = ? AND player_id = ?`).get(matchId, playerId);

  if (existing) {
    // Als al op wachtlijst → update state maar blijf op wachtlijst
    db.prepare(`UPDATE match_players SET signup_state = ? WHERE match_id = ? AND player_id = ?`)
      .run(state, matchId, playerId);
    return { action: 'updated', status: m.status, isWaitlist: existing.is_waitlist === 1 };
  } else {
    const total = countTotal(matchId);
    if (total >= m.player_limit) {
      // Lijst is vol → ga naar wachtlijst
      const waitPos = getNextWaitlistPosition(matchId);
      db.prepare(`
        INSERT INTO match_players (match_id, player_id, signup_state, joined_at, team, is_waitlist, waitlist_position)
        VALUES (?, ?, ?, ?, NULL, 1, ?)
      `).run(matchId, playerId, state, nowMs(), waitPos);
      return { action: 'waitlist', status: m.status, waitlistPosition: waitPos };
    }

    db.prepare(`
      INSERT INTO match_players (match_id, player_id, signup_state, joined_at, team, is_waitlist, waitlist_position)
      VALUES (?, ?, ?, ?, NULL, 0, NULL)
    `).run(matchId, playerId, state, nowMs());
  }

  const newStatus = updateMatchStatus(matchId);

  // teams zijn alleen geldig als 10x /ja; dus bij elke wijziging die ready-status breekt: clear
  if (!isReadyForTeams(matchId)) clearTeams(matchId);

  return { action: 'inserted', status: newStatus, isWaitlist: false };
});

const txNee = db.transaction((matchId, playerId) => {
  const m = getMatch(matchId);
  if (!m) throw new Error('Match bestaat niet.');
  if (m.status === 'cancelled' || m.status === 'closed') throw new Error(`Match is ${m.status}.`);

  const existing = db.prepare(`SELECT * FROM match_players WHERE match_id = ? AND player_id = ?`).get(matchId, playerId);
  if (!existing) return { removed: false, promoted: null };

  const wasOnWaitlist = existing.is_waitlist === 1;

  db.prepare(`DELETE FROM match_players WHERE match_id = ? AND player_id = ?`).run(matchId, playerId);

  let promoted = null;

  // Als de speler NIET op wachtlijst stond, schuif eerste van wachtlijst door
  if (!wasOnWaitlist) {
    const firstWaitlist = db.prepare(`
      SELECT mp.*, p.display_name
      FROM match_players mp
      JOIN players p ON p.id = mp.player_id
      WHERE mp.match_id = ? AND mp.is_waitlist = 1
      ORDER BY mp.waitlist_position ASC
      LIMIT 1
    `).get(matchId);

    if (firstWaitlist) {
      // Promoveer naar actieve lijst
      db.prepare(`
        UPDATE match_players
        SET is_waitlist = 0, waitlist_position = NULL, joined_at = ?
        WHERE match_id = ? AND player_id = ?
      `).run(nowMs(), matchId, firstWaitlist.player_id);

      // Hernummer wachtlijst posities
      const remainingWaitlist = db.prepare(`
        SELECT player_id FROM match_players
        WHERE match_id = ? AND is_waitlist = 1
        ORDER BY waitlist_position ASC
      `).all(matchId);

      const updPos = db.prepare(`UPDATE match_players SET waitlist_position = ? WHERE match_id = ? AND player_id = ?`);
      remainingWaitlist.forEach((r, idx) => updPos.run(idx + 1, matchId, r.player_id));

      promoted = { playerId: firstWaitlist.player_id, displayName: firstWaitlist.display_name };
    }
  } else {
    // Was op wachtlijst → hernummer wachtlijst
    const remainingWaitlist = db.prepare(`
      SELECT player_id FROM match_players
      WHERE match_id = ? AND is_waitlist = 1
      ORDER BY waitlist_position ASC
    `).all(matchId);

    const updPos = db.prepare(`UPDATE match_players SET waitlist_position = ? WHERE match_id = ? AND player_id = ?`);
    remainingWaitlist.forEach((r, idx) => updPos.run(idx + 1, matchId, r.player_id));
  }

  const newStatus = updateMatchStatus(matchId);
  clearTeams(matchId); // roster veranderde sowieso

  return { removed: true, status: newStatus, promoted, wasOnWaitlist };
});

const txSetResult = db.transaction((matchId, winnerTeam, decidedByPlayerId) => {
  const m = getMatch(matchId);
  if (!m) throw new Error('Match bestaat niet.');
  if (m.status === 'cancelled') throw new Error('Match is gecanceld.');
  if (m.status === 'closed') throw new Error('Match is al gesloten.');

  const startsAt = new Date(m.starts_at);
  if (new Date() < startsAt) throw new Error('Uitslag mag pas ingegeven worden na het starttijdstip.');

  const existingRes = db.prepare(`SELECT * FROM match_results WHERE match_id = ?`).get(matchId);
  if (existingRes) return { inserted: false };

  if (!isReadyForTeams(matchId)) throw new Error('Kan geen resultaat zetten: niet 10x /ja.');

  const rows = listSignups(matchId);
  if (rows.some(r => !r.team)) throw new Error('Kan geen resultaat zetten: teams zijn niet opgeslagen (doe /teams als we 10x /ja zijn).');

  db.prepare(`
    INSERT INTO match_results (match_id, winner_team, decided_at, decided_by_player_id)
    VALUES (?, ?, ?, ?)
  `).run(matchId, winnerTeam, nowMs(), decidedByPlayerId || null);

  const winners = rows.filter(r => r.team === winnerTeam).map(r => r.player_id);
  const all = rows.map(r => r.player_id);

  const updGames = db.prepare(`UPDATE players SET games = games + 1 WHERE id = ?`);
  const updWins = db.prepare(`UPDATE players SET wins = wins + 1 WHERE id = ?`);

  for (const pid of all) updGames.run(pid);
  for (const pid of winners) updWins.run(pid);

  db.prepare(`UPDATE matches SET status = 'closed' WHERE id = ?`).run(matchId);
  cancelAllActions(matchId);

  return { inserted: true };
});

// -------------------- COMMANDS --------------------
function cmdHelp() {
  enqueue('info', [
    `Timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`,
    '',
    'Commands:',
    '/as <naam> [positie]       -> zet huidige gebruiker',
    '/addspeler <naam> <pos>    -> voeg speler toe (pos: K/V/M/A)',
    '/positie <positie>         -> stel je positie in',
    '/play <tekst>              -> maak match (bv: /play zondag 14u30)',
    '/status                    -> toon match + lijst + wachtlijst',
    '/ja [naam]                 -> inschrijven zeker',
    '/kan [naam]                -> misschien (telt niet voor start)',
    '/nee [naam]                -> uitschrijven',
    '/wachtlijst                -> toon wachtlijst',
    '/teams                     -> toon teams (alleen bij 10x /ja)',
    '/witwon | /zwartwon        -> resultaat ingeven',
    '/mvp <naam>                -> stem voor MVP (na match)',
    '/mvps                      -> MVP leaderboard',
    '/lijst                     -> alle spelers + winrate',
    '/wedstrijden               -> laatste 20 wedstrijden',
    '/edit <uur>                -> uur aanpassen',
    '/cancel                    -> match cancelen',
    '/exit                      -> stoppen',
  ].join('\n'));
}

function cmdAs(args) {
  const fullText = args.join(' ').trim();
  if (!fullText) throw new Error('Gebruik: /as <naam> [keeper|verdediger|middenveld|aanvaller]');

  // Splits naam en optionele positie
  const validPositions = ['keeper', 'verdediger', 'middenveld', 'aanvaller'];
  let position = null;
  let name = fullText;

  // Check of laatste woord een positie is
  const parts = fullText.split(/\s+/);
  const lastPart = parts[parts.length - 1].toLowerCase();
  if (validPositions.includes(lastPart)) {
    position = lastPart;
    name = parts.slice(0, -1).join(' ');
  }

  const p = ensurePlayerByName(name, 0);

  // Update positie als meegegeven
  if (position) {
    db.prepare(`UPDATE players SET position = ? WHERE id = ?`).run(position, p.id);
  }

  ctx.currentPlayerId = p.id;
  ctx.currentPlayerName = p.display_name;

  const posInfo = position ? ` [${position}]` : '';
  enqueue('info', `OK. Current user = ${p.display_name}${posInfo} (id=${p.id}).`);
}

function cmdPlay(args) {
  requireUser();

  if (getActiveMatch()) {
    throw new Error('Er is al een actieve match (open/full). Eerst /cancel of zet resultaat met /witwon of /zwartwon.');
  }

  const raw = args.join(' ').trim();
  if (!raw) throw new Error('Gebruik: /play <dag/uur>');

  const parsed = parseDateTimeNlRobust(raw);
  if (!parsed) throw new Error('Kon datum/tijd niet parsen.');

  const startsAt = parsed.date;
  const matchDate = isoDateOnlyLocal(startsAt);

  const info = db.prepare(`
    INSERT INTO matches (match_date, starts_at, status, player_limit, created_at, roster_hash, teams_generated_at)
    VALUES (?, ?, 'open', ?, ?, NULL, NULL)
  `).run(matchDate, startsAt.toISOString(), CONFIG.playerLimit, nowMs());

  const matchId = info.lastInsertRowid;

  createActionsForMatch(matchId);

  enqueue(
    'info',
    `Match aangemaakt (id=${matchId}) op ${fmtDateTime(startsAt)}. (input="${parsed.normalized}") Inschrijven met /ja of /kan.`,
    matchId
  );
}

function cmdStatus() {
  const m = getActiveMatch();
  if (!m) return enqueue('info', 'Geen actieve match.');

  const total = countTotal(m.id);
  const yes = countYes(m.id);
  const maybe = countMaybe(m.id);
  const needSure = Math.max(0, m.player_limit - yes);
  const waitlistCount = countWaitlist(m.id);

  // Korte positie labels
  const posLabel = (pos) => {
    if (pos === 'keeper') return 'K';
    if (pos === 'verdediger') return 'V';
    if (pos === 'middenveld') return 'M';
    if (pos === 'aanvaller') return 'A';
    return '?';
  };

  const rows = listSignups(m.id);
  const list = rows.map((r, idx) => {
    const tag = r.signup_state === 'kan' ? '(misschien)' : '(zeker)';
    const pos = r.position ? ` [${posLabel(r.position)}]` : '';
    return `${idx + 1}. ${r.display_name}${pos} ${tag}`;
  });

  // Wachtlijst
  const waitlist = listWaitlist(m.id);
  const waitlistLines = waitlist.map((r) => {
    const pos = r.position ? ` [${posLabel(r.position)}]` : '';
    return `   ${r.waitlist_position}. ${r.display_name}${pos}`;
  });

  const output = [
    `Match id=${m.id} | ${fmtDateTime(m.starts_at)} | status=${m.status}`,
    `Totaal op lijst: ${total}/${m.player_limit} | Zeker: ${yes}/${m.player_limit} | Misschien: ${maybe}`,
    `Nog zeker nodig: ${needSure}`,
    '',
    (list.length ? list.join('\n') : '(nog niemand ingeschreven)'),
  ];

  if (waitlistCount > 0) {
    output.push('');
    output.push(`🕐 Wachtlijst (${waitlistCount}):`);
    output.push(...waitlistLines);
  }

  if (total === m.player_limit && yes < m.player_limit) {
    output.push('');
    output.push('⚠️ Lijst is vol maar niet genoeg zeker: iemand moet /ja of iemand moet /nee.');
  }

  enqueue('info', output.filter(line => line !== undefined).join('\n'), m.id);
}

function cmdSignup(state, args) {
  requireUser();
  const m = getActiveMatch();
  if (!m) throw new Error('Geen actieve match.');

  const name = args.join(' ').trim();
  const player = name
    ? ensurePlayerByName(name, 1)
    : db.prepare(`SELECT * FROM players WHERE id = ?`).get(ctx.currentPlayerId);

  const res = txSignup(m.id, player.id, state);

  if (res.action === 'waitlist') {
    enqueue('info', `🕐 ${player.display_name} staat op de WACHTLIJST (positie #${res.waitlistPosition}). Als iemand afzegt schuif je automatisch door.`, m.id);
    return;
  }

  if (res.isWaitlist) {
    enqueue('info', `OK: ${player.display_name} (op wachtlijst) => ${state}.`, m.id);
    return;
  }

  const total = countTotal(m.id);
  const yes = countYes(m.id);
  const maybe = countMaybe(m.id);
  const needSure = Math.max(0, m.player_limit - yes);

  enqueue('info', `OK: ${player.display_name} => ${state}. Totaal ${total}/${m.player_limit}. Zeker ${yes}/${m.player_limit}. Misschien ${maybe}. Nog zeker nodig: ${needSure}.`, m.id);

  if (isReadyForTeams(m.id)) ensureTeamsUpToDate(m.id, { autoPost: true });
}

function cmdNee(args) {
  requireUser();
  const m = getActiveMatch();
  if (!m) throw new Error('Geen actieve match.');

  const name = args.join(' ').trim();
  const player = name
    ? ensurePlayerByName(name, 1)
    : db.prepare(`SELECT * FROM players WHERE id = ?`).get(ctx.currentPlayerId);

  const res = txNee(m.id, player.id);
  if (!res.removed) {
    enqueue('error', `${player.display_name} stond niet op de lijst.`, m.id);
    return;
  }

  const total = countTotal(m.id);
  const yes = countYes(m.id);
  const maybe = countMaybe(m.id);
  const needSure = Math.max(0, m.player_limit - yes);

  let msg = res.wasOnWaitlist
    ? `Uitgeschreven van wachtlijst: ${player.display_name}.`
    : `Uitgeschreven: ${player.display_name}. Totaal ${total}/${m.player_limit}. Zeker ${yes}/${m.player_limit}. Misschien ${maybe}. Nog zeker nodig: ${needSure}.`;

  if (res.promoted) {
    msg += `\n🎉 ${res.promoted.displayName} is doorgeschoven van de wachtlijst naar de match!`;
  }

  enqueue('info', msg, m.id);
}

function cmdTeams() {
  const m = getActiveMatch();
  if (!m) throw new Error('Geen actieve match.');
  if (!isReadyForTeams(m.id)) throw new Error('Teams kan pas als er 10x /ja is.');

  // Force=true om altijd opnieuw te berekenen (nuttig na algoritme wijzigingen)
  const r = ensureTeamsUpToDate(m.id, { autoPost: false, force: true });
  postTeams(m.id, { header: r.recomputed ? 'Teams (nieuw)' : 'Teams' });
}

function cmdWin(team) {
  requireUser();
  const m = getActiveMatch();
  if (!m) throw new Error('Geen actieve match.');

  const res = txSetResult(m.id, team, ctx.currentPlayerId);
  if (!res.inserted) {
    enqueue('error', `Uitslag bestaat al voor match ${m.id} (eerste telt).`, m.id);
    return;
  }
  enqueue('info', `Resultaat opgeslagen: ${team} won. Stats geüpdatet. Match is gesloten.`, m.id);
}

function cmdLijst() {
  const rows = db.prepare(`
    SELECT display_name, wins, games, position
    FROM players
  `).all();

  if (rows.length === 0) return enqueue('info', 'Nog geen spelers in DB.');

  // Sorteer op pure winrate, dan wins (meer = beter), dan games (minder = beter)
  rows.sort((a, b) => {
    const aHasGames = a.games > 0 ? 1 : 0;
    const bHasGames = b.games > 0 ? 1 : 0;
    if (aHasGames !== bHasGames) return bHasGames - aHasGames; // spelers met games eerst
    const aWr = a.games ? a.wins / a.games : 0;
    const bWr = b.games ? b.wins / b.games : 0;
    if (aWr !== bWr) return bWr - aWr;        // hogere winrate eerst
    if (a.wins !== b.wins) return b.wins - a.wins; // 6/6 boven 1/1
    return a.games - b.games;                  // 0/1 boven 0/6
  });

  const lines = rows.map((p, i) => {
    const pure = (p.games === 0) ? 0 : (p.wins / p.games);
    const pos = p.position ? ` [${p.position}]` : '';
    return `${i + 1}. ${p.display_name}${pos} — ${(pure * 100).toFixed(1)}% (${p.wins}/${p.games})`;
  });

  enqueue('info', `Ranglijst:\n${lines.join('\n')}`);
}

function cmdWedstrijden() {
  const matches = db.prepare(`
    SELECT m.id, m.match_date, m.starts_at, m.status, mr.winner_team, mr.score
    FROM matches m
    LEFT JOIN match_results mr ON mr.match_id = m.id
    WHERE m.status = 'closed'
    ORDER BY datetime(m.starts_at) DESC
    LIMIT 20
  `).all();

  if (matches.length === 0) return enqueue('info', 'Nog geen gespeelde wedstrijden.');

  const lines = [];
  for (const m of matches) {
    const players = db.prepare(`
      SELECT mp.team, p.display_name
      FROM match_players mp
      JOIN players p ON p.id = mp.player_id
      WHERE mp.match_id = ?
      ORDER BY mp.team, mp.joined_at
    `).all(m.id);

    const wit = players.filter(p => p.team === 'wit').map(p => p.display_name);
    const zwart = players.filter(p => p.team === 'zwart').map(p => p.display_name);

    const winIcon = m.winner_team === 'wit' ? '⬜' : (m.winner_team === 'zwart' ? '⬛' : '');
    const date = new Date(m.starts_at);
    const dateStr = `${date.getDate()}/${String(date.getMonth() + 1).padStart(2, '0')}`;
    const scoreStr = m.score ? ` (${m.score})` : '';
    
    lines.push(`${dateStr} — ${wit.join(', ')} ${scoreStr} ${zwart.join(', ')}`);
  }

  enqueue('info', `Laatste 20 wedstrijden:\n${lines.join('\n')}`);
}

function cmdWachtlijst() {
  const m = getActiveMatch();
  if (!m) return enqueue('info', 'Geen actieve match.');

  const waitlist = listWaitlist(m.id);
  if (waitlist.length === 0) {
    enqueue('info', 'Geen spelers op de wachtlijst.', m.id);
    return;
  }

  const posLabel = (pos) => {
    if (pos === 'keeper') return 'K';
    if (pos === 'verdediger') return 'V';
    if (pos === 'middenveld') return 'M';
    if (pos === 'aanvaller') return 'A';
    return '?';
  };

  const lines = waitlist.map((r) => {
    const pos = r.position ? ` [${posLabel(r.position)}]` : '';
    return `${r.waitlist_position}. ${r.display_name}${pos}`;
  });

  enqueue('info', `🕐 Wachtlijst (${waitlist.length}):\n${lines.join('\n')}`, m.id);
}

function getLastClosedMatch() {
  return db.prepare(`
    SELECT * FROM matches
    WHERE status = 'closed'
    ORDER BY datetime(starts_at) DESC
    LIMIT 1
  `).get();
}

function cmdMvp(args) {
  requireUser();

  // Zoek laatste gesloten match
  const m = getLastClosedMatch();
  if (!m) throw new Error('Geen afgeronde wedstrijden om voor te stemmen.');

  // Controleer of huidige user in de match zat
  const wasinMatch = db.prepare(`
    SELECT * FROM match_players WHERE match_id = ? AND player_id = ? AND is_waitlist = 0
  `).get(m.id, ctx.currentPlayerId);

  if (!wasinMatch) {
    throw new Error('Je kan alleen stemmen voor MVP als je zelf in de match zat.');
  }

  // Controleer of al gestemd
  const alreadyVoted = db.prepare(`
    SELECT * FROM mvp_votes WHERE match_id = ? AND voter_player_id = ?
  `).get(m.id, ctx.currentPlayerId);

  if (alreadyVoted) {
    throw new Error('Je hebt al gestemd voor MVP in deze match.');
  }

  const name = args.join(' ').trim();
  if (!name) throw new Error('Gebruik: /mvp <naam>');

  // Zoek de speler en controleer of die in de match zat
  const votedPlayer = db.prepare(`SELECT * FROM players WHERE name_normalized = ?`).get(normalizeName(name));
  if (!votedPlayer) throw new Error(`Speler "${name}" niet gevonden.`);

  const votedWasInMatch = db.prepare(`
    SELECT * FROM match_players WHERE match_id = ? AND player_id = ? AND is_waitlist = 0
  `).get(m.id, votedPlayer.id);

  if (!votedWasInMatch) {
    throw new Error(`${votedPlayer.display_name} zat niet in deze match.`);
  }

  // Registreer stem
  db.prepare(`
    INSERT INTO mvp_votes (match_id, voter_player_id, voted_player_id, voted_at)
    VALUES (?, ?, ?, ?)
  `).run(m.id, ctx.currentPlayerId, votedPlayer.id, nowMs());

  // Update mvp_count (we tellen later pas wie echt "won")
  enqueue('info', `Stem geregistreerd: je stemde voor ${votedPlayer.display_name} als MVP!`, m.id);

  // Toon huidige stemmen
  const votes = db.prepare(`
    SELECT p.display_name, COUNT(*) as count
    FROM mvp_votes v
    JOIN players p ON p.id = v.voted_player_id
    WHERE v.match_id = ?
    GROUP BY v.voted_player_id
    ORDER BY count DESC
  `).all(m.id);

  if (votes.length > 0) {
    const voteLines = votes.map(v => `${v.display_name}: ${v.count} stem${v.count > 1 ? 'men' : ''}`);
    enqueue('info', `Huidige stemmen:\n${voteLines.join('\n')}`, m.id);
  }
}

function cmdMvps() {
  const rows = db.prepare(`
    SELECT p.display_name, p.position, p.mvp_count, p.games
    FROM players p
    WHERE p.mvp_count > 0
    ORDER BY p.mvp_count DESC
    LIMIT 20
  `).all();

  if (rows.length === 0) {
    // Bereken MVP per match op basis van stemmen
    const mvpPerMatch = db.prepare(`
      SELECT v.match_id, v.voted_player_id, p.display_name, COUNT(*) as votes
      FROM mvp_votes v
      JOIN players p ON p.id = v.voted_player_id
      GROUP BY v.match_id, v.voted_player_id
      HAVING votes = (
        SELECT MAX(vote_count) FROM (
          SELECT COUNT(*) as vote_count FROM mvp_votes WHERE match_id = v.match_id GROUP BY voted_player_id
        )
      )
    `).all();

    if (mvpPerMatch.length === 0) {
      return enqueue('info', 'Nog geen MVP stemmen. Stem na een match met /mvp <naam>.');
    }

    // Tel MVPs per speler
    const mvpCounts = {};
    for (const r of mvpPerMatch) {
      if (!mvpCounts[r.display_name]) mvpCounts[r.display_name] = 0;
      mvpCounts[r.display_name]++;
    }

    const sorted = Object.entries(mvpCounts).sort((a, b) => b[1] - a[1]);
    const lines = sorted.map(([name, count], i) => `${i + 1}. ${name} — ${count} MVP${count > 1 ? 's' : ''}`);

    enqueue('info', `🏆 MVP Leaderboard:\n${lines.join('\n')}`);
    return;
  }

  const posLabel = (pos) => {
    if (pos === 'keeper') return 'K';
    if (pos === 'verdediger') return 'V';
    if (pos === 'middenveld') return 'M';
    if (pos === 'aanvaller') return 'A';
    return '?';
  };

  const lines = rows.map((p, i) => {
    const pos = p.position ? ` [${posLabel(p.position)}]` : '';
    const pct = p.games > 0 ? ((p.mvp_count / p.games) * 100).toFixed(0) : 0;
    return `${i + 1}. ${p.display_name}${pos} — ${p.mvp_count} MVP${p.mvp_count > 1 ? 's' : ''} (${pct}% van matches)`;
  });

  enqueue('info', `🏆 MVP Leaderboard:\n${lines.join('\n')}`);
}

function cmdAddSpeler(args) {
  const fullText = args.join(' ').trim();
  if (!fullText) throw new Error('Gebruik: /addspeler <naam> <positie> (positie: K, V, M, A)');

  // Parse naam en positie
  const parts = fullText.split(/\s+/);
  const posInput = parts[parts.length - 1].toUpperCase();

  const posMap = {
    'K': 'keeper',
    'V': 'verdediger',
    'M': 'middenveld',
    'A': 'aanvaller',
    'KEEPER': 'keeper',
    'VERDEDIGER': 'verdediger',
    'MIDDENVELD': 'middenveld',
    'AANVALLER': 'aanvaller'
  };

  const position = posMap[posInput];
  if (!position) {
    throw new Error('Ongeldige positie. Gebruik: K (keeper), V (verdediger), M (middenveld), A (aanvaller)');
  }

  const name = parts.slice(0, -1).join(' ');
  if (!name) throw new Error('Geef een naam op. Gebruik: /addspeler <naam> <positie>');

  const p = ensurePlayerByName(name, 0);
  db.prepare(`UPDATE players SET position = ? WHERE id = ?`).run(position, p.id);

  enqueue('info', `Speler toegevoegd: ${p.display_name} [${posInput}]`);
}

function cmdPositie(args) {
  requireUser();

  const pos = args.join(' ').trim().toLowerCase();
  const validPositions = ['keeper', 'verdediger', 'middenveld', 'aanvaller'];

  if (!pos) {
    throw new Error('Gebruik: /positie <keeper|verdediger|middenveld|aanvaller>');
  }

  if (!validPositions.includes(pos)) {
    throw new Error(`Ongeldige positie. Kies uit: ${validPositions.join(', ')}`);
  }

  db.prepare(`UPDATE players SET position = ? WHERE id = ?`).run(pos, ctx.currentPlayerId);
  enqueue('info', `Positie ingesteld: ${pos} voor ${ctx.currentPlayerName}.`);
}

function parseTimeOnlyRobust(str) {
  let s = String(str || '').trim().toLowerCase();
  s = s.replace(/\s+/g, '');
  s = s.replace(/h/g, 'u');

  let m = s.match(/^(\d{1,2})u$/);
  if (m) return { h: Number(m[1]), min: 0 };

  m = s.match(/^(\d{1,2})u(\d{1,2})$/);
  if (m) return { h: Number(m[1]), min: Number(String(m[2]).padStart(2, '0')) };

  m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (m) return { h: Number(m[1]), min: Number(m[2]) };

  m = s.match(/^(\d{1,2})\.(\d{2})$/);
  if (m) return { h: Number(m[1]), min: Number(m[2]) };

  return null;
}

function cmdEdit(args) {
  const m = getActiveMatch();
  if (!m) throw new Error('Geen actieve match.');

  const t = parseTimeOnlyRobust(args.join(' '));
  if (!t) throw new Error('Gebruik: /edit 22u of /edit 20:30 of /edit 21h30 of /edit 20u30');

  const startsAt = new Date(m.starts_at);
  startsAt.setHours(t.h, t.min, 0, 0);

  db.prepare(`UPDATE matches SET starts_at = ? WHERE id = ?`).run(startsAt.toISOString(), m.id);
  createActionsForMatch(m.id);

  enqueue('info', `Match ${m.id} uur aangepast: ${fmtDateTime(startsAt)}.`, m.id);
}

function cmdCancel() {
  const m = getActiveMatch();
  if (!m) throw new Error('Geen actieve match.');

  db.prepare(`UPDATE matches SET status = 'cancelled' WHERE id = ?`).run(m.id);
  clearTeams(m.id);
  cancelAllActions(m.id);

  enqueue('cancel', `Match ${m.id} is gecanceld.`, m.id);
}

// -------------------- CLI LOOP --------------------
enqueue('info', `CLI gestart. Timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}. Gebruik /help.`);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });

rl.on('line', (line) => {
  const input = String(line || '').trim();
  if (!input) return;
  if (!input.startsWith('/')) return;

  const [cmdRaw, ...args] = input.split(' ');
  const cmd = cmdRaw.toLowerCase();

  try {
    if (cmd === '/help') cmdHelp();
    else if (cmd === '/exit') { rl.close(); process.exit(0); }
    else if (cmd === '/as') cmdAs(args);
    else if (cmd === '/addspeler') cmdAddSpeler(args);

    else if (cmd === '/play') cmdPlay(args);

    else if (cmd === '/status') cmdStatus();
    else if (cmd === '/ja') cmdSignup('ja', args);
    else if (cmd === '/kan') cmdSignup('kan', args);
    else if (cmd === '/nee') cmdNee(args);
    else if (cmd === '/wachtlijst') cmdWachtlijst();

    else if (cmd === '/teams') cmdTeams();
    else if (cmd === '/witwon') cmdWin('wit');
    else if (cmd === '/zwartwon') cmdWin('zwart');

    else if (cmd === '/mvp') cmdMvp(args);
    else if (cmd === '/mvps') cmdMvps();

    else if (cmd === '/lijst') cmdLijst();
    else if (cmd === '/wedstrijden') cmdWedstrijden();
    else if (cmd === '/positie') cmdPositie(args);
    else if (cmd === '/edit') cmdEdit(args);
    else if (cmd === '/cancel') cmdCancel();

    else enqueue('error', `Onbekend commando: ${cmd}. Gebruik /help.`);
  } catch (e) {
    enqueue('error', `❌ ${e.message}`);
  }
});

process.on('SIGINT', () => {
  console.log('\nStoppen...');
  rl.close();
  process.exit(0);
});
