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
  created_at INTEGER NOT NULL
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
           p.display_name, p.wins, p.games
    FROM match_players mp
    JOIN players p ON p.id = mp.player_id
    WHERE mp.match_id = ?
    ORDER BY mp.joined_at ASC
  `).all(matchId);
}

function countTotal(matchId) {
  return db.prepare(`SELECT COUNT(*) AS c FROM match_players WHERE match_id = ?`).get(matchId).c;
}

function countYes(matchId) {
  return db.prepare(`
    SELECT COUNT(*) AS c FROM match_players
    WHERE match_id = ? AND signup_state = 'ja'
  `).get(matchId).c;
}

function countMaybe(matchId) {
  return db.prepare(`
    SELECT COUNT(*) AS c FROM match_players
    WHERE match_id = ? AND signup_state = 'kan'
  `).get(matchId).c;
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

function generateBalancedTeams(players10) {
  const players = players10.map(p => ({ ...p, rate: wilsonScore(p) }));
  const total = players.reduce((s, p) => s + p.rate, 0);
  const target = total / 2;

  const combs = combinations(players, 5);
  let best = null;
  let bestDiff = Infinity;

  for (const teamA of combs) {
    const sumA = teamA.reduce((s, p) => s + p.rate, 0);
    const diff = Math.abs(target - sumA);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = teamA;
    }
  }

  const aIds = new Set(best.map(p => p.player_id));
  const teamWit = best;
  const teamZwart = players.filter(p => !aIds.has(p.player_id));
  return { teamWit, teamZwart, diff: bestDiff };
}

function isReadyForTeams(matchId) {
  const m = getMatch(matchId);
  if (!m) return false;

  const yes = countYes(matchId);
  const total = countTotal(matchId);

  // jouw regel: /kan telt niet; je moet 10x /ja hebben + totaal moet ook exact 10 zijn
  return (yes === m.player_limit) && (total === m.player_limit);
}

function ensureTeamsUpToDate(matchId, { autoPost = false } = {}) {
  const m = getMatch(matchId);
  if (!m) return { ok: false, reason: 'no_match' };
  if (!isReadyForTeams(matchId)) return { ok: false, reason: 'not_ready' };

  const rows = listSignups(matchId);
  const rosterHash = computeRosterHash(rows);

  if (m.roster_hash && m.roster_hash === rosterHash && m.teams_generated_at) {
    if (autoPost) postTeams(matchId, { header: 'Teams (ongewijzigd)' });
    return { ok: true, recomputed: false };
  }

  const { teamWit, teamZwart, diff } = generateBalancedTeams(rows);

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

  const avgW = wit.reduce((s, p) => s + wilsonScore(p), 0) / 5;
  const avgZ = zwart.reduce((s, p) => s + wilsonScore(p), 0) / 5;

  const linesW = wit.map(p => `- ${p.display_name} (${(pureWinrate(p) * 100).toFixed(0)}% | wilson ${(wilsonScore(p) * 100).toFixed(0)}% | ${p.wins}/${p.games})`);
  const linesZ = zwart.map(p => `- ${p.display_name} (${(pureWinrate(p) * 100).toFixed(0)}% | wilson ${(wilsonScore(p) * 100).toFixed(0)}% | ${p.wins}/${p.games})`);

  enqueue('teams',
    [
      `${header}`,
      `⬜ Team Wit (avg wilson ${(avgW * 100).toFixed(1)}%)`,
      ...linesW,
      ``,
      `⬛ Team Zwart (avg wilson ${(avgZ * 100).toFixed(1)}%)`,
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
    db.prepare(`UPDATE match_players SET signup_state = ? WHERE match_id = ? AND player_id = ?`)
      .run(state, matchId, playerId);
  } else {
    const total = countTotal(matchId);
    if (total >= m.player_limit) return { action: 'full' };

    db.prepare(`
      INSERT INTO match_players (match_id, player_id, signup_state, joined_at, team)
      VALUES (?, ?, ?, ?, NULL)
    `).run(matchId, playerId, state, nowMs());
  }

  const newStatus = updateMatchStatus(matchId);

  // teams zijn alleen geldig als 10x /ja; dus bij elke wijziging die ready-status breekt: clear
  if (!isReadyForTeams(matchId)) clearTeams(matchId);

  return { action: existing ? 'updated' : 'inserted', status: newStatus };
});

const txNee = db.transaction((matchId, playerId) => {
  const m = getMatch(matchId);
  if (!m) throw new Error('Match bestaat niet.');
  if (m.status === 'cancelled' || m.status === 'closed') throw new Error(`Match is ${m.status}.`);

  const existing = db.prepare(`SELECT * FROM match_players WHERE match_id = ? AND player_id = ?`).get(matchId, playerId);
  if (!existing) return { removed: false };

  db.prepare(`DELETE FROM match_players WHERE match_id = ? AND player_id = ?`).run(matchId, playerId);

  const newStatus = updateMatchStatus(matchId);
  clearTeams(matchId); // roster veranderde sowieso
  return { removed: true, status: newStatus };
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
    '/as <naam>                 -> zet huidige gebruiker',
    '/play <tekst>              -> maakt match (bv: /play zondag 14u30, /play maandag 21:00, /play 21h30)',
    '/status                    -> toon actieve match + lijst + nog zeker nodig',
    '/ja [naam]                 -> inschrijven zeker',
    '/kan [naam]                -> misschien (telt niet mee voor starten)',
    '/nee [naam]                -> uitschrijven',
    '/teams                     -> toon teams (alleen bij 10x /ja)',
    '/witwon | /zwartwon        -> resultaat (first wins, pas na starttijd)',
    '/lijst                     -> alle spelers (pure winrate)',
    '/wedstrijden               -> overzicht laatste 20 wedstrijden',
    '/edit <uur>                -> uur aanpassen',
    '/cancel                    -> match cancelen',
    '/exit                      -> stoppen',
  ].join('\n'));
}

function cmdAs(args) {
  const name = args.join(' ').trim();
  if (!name) throw new Error('Gebruik: /as <naam>');
  const p = ensurePlayerByName(name, 0);
  ctx.currentPlayerId = p.id;
  ctx.currentPlayerName = p.display_name;
  enqueue('info', `OK. Current user = ${p.display_name} (id=${p.id}).`);
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

  const rows = listSignups(m.id);
  const list = rows.map((r, idx) => {
    const tag = r.signup_state === 'kan' ? '(misschien)' : '(zeker)';
    return `${idx + 1}. ${r.display_name} ${tag}`;
  });

  enqueue('info',
    [
      `Match id=${m.id} | ${fmtDateTime(m.starts_at)} | status=${m.status}`,
      `Totaal op lijst: ${total}/${m.player_limit} | Zeker: ${yes}/${m.player_limit} | Misschien: ${maybe}`,
      `Nog zeker nodig: ${needSure}`,
      (list.length ? list.join('\n') : '(nog niemand ingeschreven)'),
      (total === m.player_limit && yes < m.player_limit) ? '⚠️ Lijst is vol maar niet genoeg zeker: iemand moet /ja of iemand moet /nee.' : ''
    ].filter(Boolean).join('\n'),
    m.id
  );
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
  if (res.action === 'full') {
    enqueue('error', `De lijst is al vol (${m.player_limit}). ${player.display_name} is te laat en staat niet op de lijst.`, m.id);
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

  enqueue('info', `Uitgeschreven: ${player.display_name}. Totaal ${total}/${m.player_limit}. Zeker ${yes}/${m.player_limit}. Misschien ${maybe}. Nog zeker nodig: ${needSure}.`, m.id);
}

function cmdTeams() {
  const m = getActiveMatch();
  if (!m) throw new Error('Geen actieve match.');
  if (!isReadyForTeams(m.id)) throw new Error('Teams kan pas als er 10x /ja is.');

  const r = ensureTeamsUpToDate(m.id, { autoPost: false });
  postTeams(m.id, { header: r.recomputed ? 'Teams (nieuw)' : 'Teams (ongewijzigd)' });
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
    SELECT display_name, wins, games
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
    return `${i + 1}. ${p.display_name} — ${(pure * 100).toFixed(1)}% (${p.wins}/${p.games})`;
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

    else if (cmd === '/play') cmdPlay(args);

    else if (cmd === '/status') cmdStatus();
    else if (cmd === '/ja') cmdSignup('ja', args);
    else if (cmd === '/kan') cmdSignup('kan', args);
    else if (cmd === '/nee') cmdNee(args);

    else if (cmd === '/teams') cmdTeams();
    else if (cmd === '/witwon') cmdWin('wit');
    else if (cmd === '/zwartwon') cmdWin('zwart');

    else if (cmd === '/lijst') cmdLijst();
    else if (cmd === '/wedstrijden') cmdWedstrijden();
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
