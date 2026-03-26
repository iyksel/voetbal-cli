const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const Database = require('better-sqlite3');
const chrono = require('chrono-node');

// Initialize database
const db = new Database('voetbal.db');
db.pragma('foreign_keys = ON');

// ==================== CONFIGURATIE ====================
const CONFIG = {
  playerLimit: 10,
  dayMessageHour: 9,
  reminderHoursBefore: 2,
  schedulerTickMs: 60000, // Check elke minuut
  schedulerBatch: 25,
  // BELANGRIJK: Zet hier je WhatsApp groep ID
  // Je kan dit zien in de console als je een bericht stuurt in de groep
  WHATSAPP_GROUP_ID: null // Bijv: '1234567890-1234567890@g.us'
};

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

client.on('qr', qr => {
    qrcode.generate(qr, { small: true });
    console.log('Scan de QR code met WhatsApp');
});

client.on('ready', () => {
    console.log('✅ BOT READY - WhatsApp verbonden!');
    console.log('🔔 Scheduler gestart - automatische herinneringen actief!');

    // Start scheduler voor automatische berichten
    startScheduler();
});

client.on('message', async msg => {
    console.log("GROUP ID:", msg.from);
    console.log("TEXT:", msg.body);

    // Auto-detect groep ID als nog niet ingesteld
    if (!CONFIG.WHATSAPP_GROUP_ID && msg.from.endsWith('@g.us')) {
        CONFIG.WHATSAPP_GROUP_ID = msg.from;
        console.log(`✅ WhatsApp groep ID opgeslagen: ${CONFIG.WHATSAPP_GROUP_ID}`);
    }

    // Alleen groepsberichten
    if (!msg.from.endsWith('@g.us')) return;

    const text = msg.body.trim();
    const userName = msg._data.notifyName || 'Onbekend';
    const whatsappId = msg.author || msg.from; // msg.author voor groepen, msg.from voor privé

    // Alleen commands
    if (!text.startsWith('/')) return;

    const [cmdRaw, ...args] = text.split(' ');
    const cmd = cmdRaw.toLowerCase();

    let response = null;

    try {
        if (cmd === '/status') response = cmdStatus();
        else if (cmd === '/ja') response = cmdSignup(whatsappId, 'ja', args);
        else if (cmd === '/kan') response = cmdSignup(whatsappId, 'kan', args);
        else if (cmd === '/nee') response = cmdNee(whatsappId, args);
        else if (cmd === '/wachtlijst') response = cmdWachtlijst();
        else if (cmd === '/teams') response = cmdTeams();
        else if (cmd === '/witwon') response = cmdWin(whatsappId, 'wit');
        else if (cmd === '/zwartwon') response = cmdWin(whatsappId, 'zwart');
        else if (cmd === '/mvp') response = cmdMvp(whatsappId, args);
        else if (cmd === '/mvps') response = cmdMvps();
        else if (cmd === '/lijst') response = cmdLijst();
        else if (cmd === '/wedstrijden') response = cmdWedstrijden();
        else if (cmd === '/positie') response = cmdPositie(whatsappId, args);
        else if (cmd === '/play') response = cmdPlay(whatsappId, args);
        else if (cmd === '/help') response = cmdHelp();
        else if (cmd === '/whoami') response = cmdWhoAmI(whatsappId);
    } catch (err) {
        response = `❌ ${err.message}`;
    }

    if (response) {
        msg.reply(response);
    }
});

client.initialize();

// ==================== UTILITY FUNCTIONS ====================

function nowMs() { return Date.now(); }

function normalizeName(name) {
  let s = String(name || '').trim().toLowerCase();
  s = s.replace(/^['"\s]+|['"\s]+$/g, '');
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

function ensurePlayerByName(name, isGuest = 0) {
  const norm = normalizeName(name);
  let p = db.prepare(`SELECT * FROM players WHERE name_normalized = ?`).get(norm);
  if (p) return p;

  const display = titleCaseWords(norm);
  const info = db.prepare(`
    INSERT INTO players (display_name, name_normalized, is_guest, created_at)
    VALUES (?, ?, ?, ?)
  `).run(display, norm, isGuest, nowMs());

  return { id: info.lastInsertRowid, display_name: display, name_normalized: norm, wins: 0, games: 0 };
}

/**
 * Haal speler op via WhatsApp ID, of link een nieuwe speler
 * @param {string} whatsappId - WhatsApp ID (msg.author voor groepen)
 * @param {string|null} name - Optionele naam voor eerste keer linken
 * @returns {{ player: object, isNewLink: boolean }}
 */
function getOrLinkPlayer(whatsappId, name = null) {
  // Check of WhatsApp ID al gelinkt is
  let player = db.prepare(`SELECT * FROM players WHERE whatsapp_id = ?`).get(whatsappId);

  if (player) {
    return { player, isNewLink: false };
  }

  // Niet gelinkt - naam is verplicht voor eerste keer
  if (!name || name.trim() === '') {
    throw new Error('Eerste keer? Gebruik: /ja <jouw naam>\nDaarna kan je gewoon /ja typen!');
  }

  // Zoek of maak speler op basis van naam
  player = ensurePlayerByName(name);

  // Check of deze speler al een ander WhatsApp ID heeft
  if (player.whatsapp_id && player.whatsapp_id !== whatsappId) {
    throw new Error(`${player.display_name} is al gelinkt aan een ander WhatsApp account.`);
  }

  // Link WhatsApp ID aan deze speler
  db.prepare(`UPDATE players SET whatsapp_id = ? WHERE id = ?`).run(whatsappId, player.id);

  return { player, isNewLink: true };
}

function getActiveMatch() {
    return db.prepare(`
        SELECT * FROM matches
        WHERE status IN ('open', 'full')
        ORDER BY starts_at ASC
        LIMIT 1
    `).get();
}

function countYes(matchId) {
  return db.prepare(`
    SELECT COUNT(*) as c FROM match_players
    WHERE match_id = ? AND signup_state = 'ja' AND is_waitlist = 0
  `).get(matchId).c;
}

function countTotal(matchId) {
  return db.prepare(`
    SELECT COUNT(*) as c FROM match_players
    WHERE match_id = ? AND is_waitlist = 0
  `).get(matchId).c;
}

function wilsonScore(p) {
  const n = p.games;
  const wins = p.wins;
  if (n === 0) return 0;

  const z = 1.96;
  const pHat = wins / n;
  const denominator = 1 + (z * z) / n;
  const center = pHat + (z * z) / (2 * n);
  const margin = z * Math.sqrt((pHat * (1 - pHat) / n) + (z * z / (4 * n * n)));

  return (center - margin) / denominator;
}

// ==================== COMMAND HANDLERS ====================

function cmdHelp() {
    return `🤖 Voetbal Bot Commands:

📋 Match Info:
/status - Toon match + wie ingeschreven is
/wachtlijst - Toon wachtlijst
/teams - Genereer teams (bij 10x /ja)
/wedstrijden - Laatste 20 wedstrijden
/lijst - Alle spelers + winrate

✅ Inschrijven:
/ja - Schrijf jezelf in (via je nummer)
/ja <naam> - Schrijf speler <naam> in
/kan - Misschien (jezelf)
/kan <naam> - Misschien (speler <naam>)
/nee - Schrijf jezelf uit
/nee <naam> - Schrijf speler <naam> uit

🎮 Match Acties:
/play <dag> <uur> - Nieuwe match aanmaken
/witwon of /zwartwon - Resultaat ingeven
/mvp <naam> - Stem voor MVP
/mvps - MVP leaderboard

⚙️ Profiel:
/positie <positie> - Stel je positie in (keeper/verdediger/middenveld/aanvaller)
/whoami - Test je WhatsApp link
/help - Dit bericht

📱 **Nummer Herkenning:**
Je nummer wordt automatisch herkend als je gelinkt bent.
Andere spelers kan je altijd inschrijven met hun naam.`;
}

function cmdStatus() {
    const m = getActiveMatch();
    if (!m) return '❌ Geen actieve match.';

    const rows = db.prepare(`
      SELECT p.display_name, mp.signup_state, mp.joined_at, p.position
      FROM match_players mp
      JOIN players p ON p.id = mp.player_id
      WHERE mp.match_id = ? AND mp.is_waitlist = 0
      ORDER BY mp.joined_at ASC
    `).all(m.id);

    const yes = rows.filter(r => r.signup_state === 'ja');
    const kan = rows.filter(r => r.signup_state === 'kan');

    const posLabel = (pos) => {
      if (!pos) return '';
      if (pos === 'keeper') return ' [K]';
      if (pos === 'verdediger') return ' [V]';
      if (pos === 'middenveld') return ' [M]';
      if (pos === 'aanvaller') return ' [A]';
      return '';
    };

    const lines = [
      `📅 *Match ${m.match_date} om ${m.starts_at}*`,
      `📊 Status: *${yes.length}/${m.player_limit}*`,
      '',
      `✅ *JA (${yes.length}):*`
    ];

    if (yes.length > 0) {
      yes.forEach((s, i) => {
        lines.push(`${i + 1}. ${s.display_name}${posLabel(s.position)}`);
      });
    } else {
      lines.push('  (niemand)');
    }

    lines.push('');
    lines.push(`⚠️ *KAN (${kan.length}):*`);

    if (kan.length > 0) {
      kan.forEach((s, i) => {
        lines.push(`${i + 1}. ${s.display_name}${posLabel(s.position)}`);
      });
    } else {
      lines.push('  (niemand)');
    }

    return lines.join('\n');
}

function cmdSignup(whatsappId, state, args) {
    const m = getActiveMatch();
    if (!m) throw new Error('Geen actieve match.');

    let player;

    if (args.length > 0) {
        // Naam meegegeven - zoek in database
        const name = args.join(' ');
        player = db.prepare(`SELECT * FROM players WHERE name_normalized = ?`).get(normalizeName(name));

        if (!player) {
            throw new Error(`Speler "${name}" niet gevonden in database.`);
        }
    } else {
        // Geen naam - zoek via WhatsApp ID
        player = db.prepare(`SELECT * FROM players WHERE whatsapp_id = ?`).get(whatsappId);

        if (!player) {
            throw new Error('Je WhatsApp nummer is nog niet gelinkt aan een speler.\n\nGebruik: /ja <jouw naam>');
        }
    }

    const existing = db.prepare(`
      SELECT * FROM match_players WHERE match_id = ? AND player_id = ?
    `).get(m.id, player.id);

    const yesCount = countYes(m.id);

    if (existing) {
      if (existing.signup_state === state && existing.is_waitlist === 0) {
        return `✅ ${player.display_name} staat al als "${state}".`;
      }

      // Update
      if (state === 'ja' && yesCount >= m.player_limit && existing.is_waitlist === 0) {
        // Verplaats naar wachtlijst
        const waitPos = getNextWaitlistPosition(m.id);
        db.prepare(`
          UPDATE match_players
          SET signup_state = ?, is_waitlist = 1, waitlist_position = ?
          WHERE match_id = ? AND player_id = ?
        `).run(state, waitPos, m.id, player.id);
        return `⏳ ${player.display_name} op wachtlijst (#${waitPos}). Match vol (${yesCount}/${m.player_limit}).`;
      }

      db.prepare(`
        UPDATE match_players
        SET signup_state = ?, is_waitlist = 0, waitlist_position = NULL
        WHERE match_id = ? AND player_id = ?
      `).run(state, m.id, player.id);

      const newCount = countYes(m.id);
      return `✅ ${player.display_name} → *${state}* (${newCount}/${m.player_limit})`;
    }

    // New signup
    if (state === 'ja' && yesCount >= m.player_limit) {
      const waitPos = getNextWaitlistPosition(m.id);
      db.prepare(`
        INSERT INTO match_players (match_id, player_id, signup_state, joined_at, is_waitlist, waitlist_position)
        VALUES (?, ?, ?, ?, 1, ?)
      `).run(m.id, player.id, state, nowMs(), waitPos);
      return `⏳ ${player.display_name} op wachtlijst (#${waitPos}). Match vol (${yesCount}/${m.player_limit}).`;
    }

    db.prepare(`
      INSERT INTO match_players (match_id, player_id, signup_state, joined_at, is_waitlist)
      VALUES (?, ?, ?, ?, 0)
    `).run(m.id, player.id, state, nowMs());

    const newCount = countYes(m.id);
    return `✅ ${player.display_name} → *${state}* (${newCount}/${m.player_limit})`;
}

function getNextWaitlistPosition(matchId) {
  const max = db.prepare(`
    SELECT MAX(waitlist_position) as mx FROM match_players WHERE match_id = ? AND is_waitlist = 1
  `).get(matchId).mx;
  return (max || 0) + 1;
}

function cmdNee(whatsappId, args) {
    const m = getActiveMatch();
    if (!m) throw new Error('Geen actieve match.');

    let player;

    if (args.length > 0) {
        // Naam meegegeven - zoek in database
        const name = args.join(' ');
        player = db.prepare(`SELECT * FROM players WHERE name_normalized = ?`).get(normalizeName(name));

        if (!player) {
            throw new Error(`Speler "${name}" niet gevonden in database.`);
        }
    } else {
        // Geen naam - zoek via WhatsApp ID
        player = db.prepare(`SELECT * FROM players WHERE whatsapp_id = ?`).get(whatsappId);

        if (!player) {
            throw new Error('Je WhatsApp nummer is nog niet gelinkt aan een speler.\n\nGebruik: /nee <naam>');
        }
    }

    const existing = db.prepare(`
      SELECT * FROM match_players WHERE match_id = ? AND player_id = ?
    `).get(m.id, player.id);

    if (!existing) {
      return `ℹ️ ${player.display_name} stond niet ingeschreven.`;
    }

    const wasOnWaitlist = existing.is_waitlist === 1;

    db.prepare(`DELETE FROM match_players WHERE match_id = ? AND player_id = ?`)
      .run(m.id, player.id);

    let result = `❌ ${player.display_name} uitgeschreven.`;

    // Promoveer eerste van wachtlijst
    if (!wasOnWaitlist) {
      const firstWaitlist = db.prepare(`
        SELECT mp.player_id, p.display_name
        FROM match_players mp
        JOIN players p ON p.id = mp.player_id
        WHERE mp.match_id = ? AND mp.is_waitlist = 1
        ORDER BY mp.waitlist_position ASC
        LIMIT 1
      `).get(m.id);

      if (firstWaitlist) {
        db.prepare(`
          UPDATE match_players
          SET is_waitlist = 0, waitlist_position = NULL, signup_state = 'ja'
          WHERE match_id = ? AND player_id = ?
        `).run(m.id, firstWaitlist.player_id);

        result += `\n✅ ${firstWaitlist.display_name} gepromoveerd van wachtlijst!`;
      }
    }

    const newCount = countYes(m.id);
    return `${result}\n📊 Nieuwe stand: ${newCount}/${m.player_limit}`;
}

function cmdWachtlijst() {
    const m = getActiveMatch();
    if (!m) throw new Error('Geen actieve match.');

    const rows = db.prepare(`
      SELECT p.display_name, mp.waitlist_position
      FROM match_players mp
      JOIN players p ON p.id = mp.player_id
      WHERE mp.match_id = ? AND mp.is_waitlist = 1
      ORDER BY mp.waitlist_position ASC
    `).all(m.id);

    if (rows.length === 0) {
      return 'ℹ️ Wachtlijst is leeg.';
    }

    const lines = ['⏳ *Wachtlijst:*'];
    rows.forEach(r => {
      lines.push(`${r.waitlist_position}. ${r.display_name}`);
    });

    return lines.join('\n');
}

function cmdTeams() {
    const m = getActiveMatch();
    if (!m) throw new Error('Geen actieve match.');

    const yes = countYes(m.id);
    const total = countTotal(m.id);

    if (yes !== m.player_limit || total !== m.player_limit) {
      throw new Error(`Teams kan pas als er ${m.player_limit}x /ja is. Nu: ${yes}x ja.`);
    }

    // Generate teams
    const rows = db.prepare(`
      SELECT p.id as player_id, p.display_name, p.wins, p.games, p.position
      FROM match_players mp
      JOIN players p ON p.id = mp.player_id
      WHERE mp.match_id = ? AND mp.signup_state = 'ja' AND mp.is_waitlist = 0
      ORDER BY mp.joined_at ASC
    `).all(m.id);

    if (rows.length !== 10) {
      throw new Error(`Verwacht 10 spelers, maar kreeg ${rows.length}.`);
    }

    const { teamWit, teamZwart } = generateBalancedTeams(rows);

    // Save teams
    db.prepare(`UPDATE match_players SET team = NULL WHERE match_id = ?`).run(m.id);
    const upd = db.prepare(`UPDATE match_players SET team = ? WHERE match_id = ? AND player_id = ?`);
    for (const p of teamWit) upd.run('wit', m.id, p.player_id);
    for (const p of teamZwart) upd.run('zwart', m.id, p.player_id);

    return formatTeams(m.id);
}

function formatTeams(matchId) {
    const wit = db.prepare(`
      SELECT p.display_name, p.wins, p.games, p.position
      FROM match_players mp
      JOIN players p ON p.id = mp.player_id
      WHERE mp.match_id = ? AND mp.team = 'wit'
    `).all(matchId);

    const zwart = db.prepare(`
      SELECT p.display_name, p.wins, p.games, p.position
      FROM match_players mp
      JOIN players p ON p.id = mp.player_id
      WHERE mp.match_id = ? AND mp.team = 'zwart'
    `).all(matchId);

    const formatTeam = (team, name) => {
      const rates = team.map(p => wilsonScore(p));
      const avg = rates.reduce((s, r) => s + r, 0) / rates.length;
      const variance = rates.reduce((s, r) => s + Math.pow(r - avg, 2), 0) / rates.length;
      const stdDev = Math.sqrt(variance);

      const posLabel = (pos) => {
        if (!pos) return '?';
        if (pos === 'keeper') return 'K';
        if (pos === 'verdediger') return 'V';
        if (pos === 'middenveld') return 'M';
        if (pos === 'aanvaller') return 'A';
        return '?';
      };

      const posOrder = { 'keeper': 1, 'verdediger': 2, 'middenveld': 3, 'aanvaller': 4 };
      const sorted = team.slice().sort((a, b) => {
        const orderA = posOrder[a.position] || 99;
        const orderB = posOrder[b.position] || 99;
        return orderA - orderB;
      });

      const lines = [`*${name}*`, `Wilson: ${(avg * 100).toFixed(1)}% (σ=${(stdDev * 100).toFixed(1)}%)`, ''];
      sorted.forEach(p => {
        const w = wilsonScore(p);
        lines.push(`- ${p.display_name} [${posLabel(p.position)}] (W:${(w * 100).toFixed(0)}% | ${p.wins}W/${p.games}G)`);
      });

      return lines.join('\n');
    };

    return formatTeam(wit, '⬜ Team Wit') + '\n\n' + formatTeam(zwart, '⬛ Team Zwart');
}

function generateBalancedTeams(players10) {
  const players = players10.map(p => ({ ...p, rate: wilsonScore(p) }));

  const totalWilson = players.reduce((s, p) => s + p.rate, 0);
  const totalDefense = calcDefensiveStrength(players);
  const totalOffense = calcOffensiveStrength(players);
  const totalKeepers = countKeepers(players);

  const combs = combinations(players, 5);
  let best = null;
  let bestScore = Infinity;

  for (const teamA of combs) {
    const teamB = players.filter(p => !teamA.some(a => a.player_id === p.player_id));

    const wilsonA = teamA.reduce((s, p) => s + p.rate, 0);
    const wilsonDiff = Math.abs(wilsonA - (totalWilson / 2));

    const stdDevA = calcWilsonStdDev(teamA);
    const stdDevB = calcWilsonStdDev(teamB);
    const stdDevDiff = Math.abs(stdDevA - stdDevB);

    const defenseA = calcDefensiveStrength(teamA);
    const defenseDiff = Math.abs(defenseA - (totalDefense / 2));

    const offenseA = calcOffensiveStrength(teamA);
    const offenseDiff = Math.abs(offenseA - (totalOffense / 2));

    const keepersA = countKeepers(teamA);
    const keepersB = countKeepers(teamB);
    let keeperPenalty = 0;

    if (totalKeepers === 2) {
      keeperPenalty = (keepersA !== 1) ? 15 : 0;
    } else if (totalKeepers > 2) {
      keeperPenalty = Math.abs(keepersA - keepersB) * 5;
    }

    const score =
      defenseDiff * 100.0 +
      offenseDiff * 100.0 +
      keeperPenalty * 80.0 +
      wilsonDiff * 60.0 +
      stdDevDiff * 30.0;

    if (score < bestScore) {
      bestScore = score;
      best = { teamA, teamB };
    }
  }

  return { teamWit: best.teamA, teamZwart: best.teamB };
}

function combinations(arr, k) {
  const result = [];
  const n = arr.length;

  function backtrack(start, comb) {
    if (comb.length === k) {
      result.push([...comb]);
      return;
    }
    for (let i = start; i < n; i++) {
      comb.push(arr[i]);
      backtrack(i + 1, comb);
      comb.pop();
    }
  }

  backtrack(0, []);
  return result;
}

function calcDefensiveStrength(team) {
  let strength = 0;
  for (const p of team) {
    if (p.position === 'keeper') strength += 1.0;
    else if (p.position === 'verdediger') strength += 1.0;
    else if (p.position === 'middenveld') strength += 0.5;
  }
  return strength;
}

function calcOffensiveStrength(team) {
  let strength = 0;
  for (const p of team) {
    if (p.position === 'aanvaller') strength += 1.0;
    else if (p.position === 'middenveld') strength += 0.5;
  }
  return strength;
}

function countKeepers(team) {
  return team.filter(p => p.position === 'keeper').length;
}

function calcWilsonStdDev(team) {
  const rates = team.map(p => p.rate);
  const mean = rates.reduce((s, r) => s + r, 0) / rates.length;
  const variance = rates.reduce((s, r) => s + Math.pow(r - mean, 2), 0) / rates.length;
  return Math.sqrt(variance);
}

function cmdWin(whatsappId, team) {
    const m = getActiveMatch();
    if (!m) throw new Error('Geen actieve match.');

    const player = db.prepare(`SELECT * FROM players WHERE whatsapp_id = ?`).get(whatsappId);
    if (!player) {
        throw new Error('Je WhatsApp nummer is nog niet gelinkt aan een speler.');
    }

    const wasinMatch = db.prepare(`
      SELECT * FROM match_players WHERE match_id = ? AND player_id = ? AND is_waitlist = 0
    `).get(m.id, player.id);

    if (!wasinMatch) {
      throw new Error('Je kan alleen resultaat ingeven als je zelf in de match zat.');
    }

    const wit = db.prepare(`
      SELECT player_id FROM match_players WHERE match_id = ? AND team = 'wit'
    `).all(m.id);

    const zwart = db.prepare(`
      SELECT player_id FROM match_players WHERE match_id = ? AND team = 'zwart'
    `).all(m.id);

    if (wit.length === 0 || zwart.length === 0) {
      throw new Error('Teams zijn nog niet gegenereerd. Gebruik eerst /teams.');
    }

    const winners = team === 'wit' ? wit : zwart;
    const losers = team === 'wit' ? zwart : wit;

    const tx = db.transaction(() => {
      for (const w of winners) {
        db.prepare(`UPDATE players SET games = games + 1, wins = wins + 1 WHERE id = ?`).run(w.player_id);
      }
      for (const l of losers) {
        db.prepare(`UPDATE players SET games = games + 1 WHERE id = ?`).run(l.player_id);
      }
      db.prepare(`UPDATE matches SET status = 'closed' WHERE id = ?`).run(m.id);
    });
    tx();

    return `🏆 *Team ${team.charAt(0).toUpperCase() + team.slice(1)} heeft gewonnen!*\n\nStem nu voor MVP: /mvp <naam>`;
}

function cmdMvp(whatsappId, args) {
    const m = db.prepare(`
      SELECT * FROM matches WHERE status = 'closed' ORDER BY starts_at DESC LIMIT 1
    `).get();

    if (!m) throw new Error('Geen gesloten match gevonden. Voer eerst resultaat in met /witwon of /zwartwon.');

    const player = db.prepare(`SELECT * FROM players WHERE whatsapp_id = ?`).get(whatsappId);
    if (!player) {
        throw new Error('Je WhatsApp nummer is nog niet gelinkt aan een speler.');
    }

    const wasinMatch = db.prepare(`
      SELECT * FROM match_players WHERE match_id = ? AND player_id = ? AND is_waitlist = 0
    `).get(m.id, player.id);

    if (!wasinMatch) {
      throw new Error('Je kan alleen stemmen voor MVP als je zelf in de match zat.');
    }

    const alreadyVoted = db.prepare(`
      SELECT * FROM mvp_votes WHERE match_id = ? AND voter_player_id = ?
    `).get(m.id, player.id);

    if (alreadyVoted) {
      throw new Error('Je hebt al gestemd voor MVP in deze match.');
    }

    const name = args.join(' ').trim();
    if (!name) throw new Error('Gebruik: /mvp <naam>');

    const votedPlayer = db.prepare(`SELECT * FROM players WHERE name_normalized = ?`).get(normalizeName(name));
    if (!votedPlayer) throw new Error(`Speler "${name}" niet gevonden.`);

    const votedWasInMatch = db.prepare(`
      SELECT * FROM match_players WHERE match_id = ? AND player_id = ? AND is_waitlist = 0
    `).get(m.id, votedPlayer.id);

    if (!votedWasInMatch) {
      throw new Error(`${votedPlayer.display_name} zat niet in deze match.`);
    }

    db.prepare(`
      INSERT INTO mvp_votes (match_id, voter_player_id, voted_player_id, voted_at)
      VALUES (?, ?, ?, ?)
    `).run(m.id, player.id, votedPlayer.id, nowMs());

    const votes = db.prepare(`
      SELECT p.display_name, COUNT(*) as count
      FROM mvp_votes v
      JOIN players p ON p.id = v.voted_player_id
      WHERE v.match_id = ?
      GROUP BY v.voted_player_id
      ORDER BY count DESC
    `).all(m.id);

    let result = `✅ Stem geregistreerd: je stemde voor *${votedPlayer.display_name}* als MVP!`;

    if (votes.length > 0) {
      result += '\n\n*Huidige stemmen:*\n';
      votes.forEach(v => {
        result += `${v.display_name}: ${v.count} stem${v.count > 1 ? 'men' : ''}\n`;
      });
    }

    return result;
}

function cmdMvps() {
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
      return 'ℹ️ Nog geen MVP stemmen. Stem na een match met /mvp <naam>.';
    }

    const mvpCounts = {};
    for (const r of mvpPerMatch) {
      if (!mvpCounts[r.display_name]) mvpCounts[r.display_name] = 0;
      mvpCounts[r.display_name]++;
    }

    const sorted = Object.entries(mvpCounts).sort((a, b) => b[1] - a[1]);
    const lines = ['🏆 *MVP Leaderboard:*', ''];
    sorted.slice(0, 10).forEach(([name, count], i) => {
      lines.push(`${i + 1}. ${name} — ${count} MVP${count > 1 ? 's' : ''}`);
    });

    return lines.join('\n');
}

function cmdLijst() {
    const rows = db.prepare(`
      SELECT display_name, position, wins, games
      FROM players
      WHERE games > 0
      ORDER BY games DESC, wins DESC
      LIMIT 30
    `).all();

    if (rows.length === 0) {
      return 'ℹ️ Nog geen spelers met wedstrijden.';
    }

    const posLabel = (pos) => {
      if (!pos) return '';
      if (pos === 'keeper') return ' [K]';
      if (pos === 'verdediger') return ' [V]';
      if (pos === 'middenveld') return ' [M]';
      if (pos === 'aanvaller') return ' [A]';
      return '';
    };

    const lines = ['📊 *Spelers Ranking:*', ''];
    rows.forEach((r, i) => {
      const wilson = wilsonScore(r);
      const pct = r.games > 0 ? ((r.wins / r.games) * 100).toFixed(0) : '0';
      lines.push(`${i + 1}. ${r.display_name}${posLabel(r.position)} — ${pct}% (${r.wins}W/${r.games}G)`);
    });

    return lines.join('\n');
}

function cmdWedstrijden() {
    const rows = db.prepare(`
      SELECT id, match_date, starts_at, status
      FROM matches
      ORDER BY starts_at DESC
      LIMIT 20
    `).all();

    if (rows.length === 0) {
      return 'ℹ️ Nog geen wedstrijden.';
    }

    const lines = ['📅 *Laatste Wedstrijden:*', ''];
    rows.forEach(r => {
      const status = r.status === 'closed' ? '✅' : r.status === 'cancelled' ? '❌' : '⏳';
      lines.push(`${status} ${r.match_date} ${r.starts_at}`);
    });

    return lines.join('\n');
}

function cmdPositie(whatsappId, args) {
    const validPositions = ['keeper', 'verdediger', 'middenveld', 'aanvaller'];
    const pos = args[0]?.toLowerCase();

    if (!pos || !validPositions.includes(pos)) {
      throw new Error('Gebruik: /positie <keeper|verdediger|middenveld|aanvaller>');
    }

    const player = db.prepare(`SELECT * FROM players WHERE whatsapp_id = ?`).get(whatsappId);
    if (!player) {
        throw new Error('Je WhatsApp nummer is nog niet gelinkt aan een speler.');
    }

    db.prepare(`UPDATE players SET position = ? WHERE id = ?`).run(pos, player.id);

    return `✅ ${player.display_name} positie → *${pos}*`;
}

function cmdPlay(whatsappId, args) {
    // Verificatie dat gebruiker gelinkt is (optioneel - alleen voor admin check)
    // const { player } = getOrLinkPlayer(whatsappId);

    const text = args.join(' ').trim();
    if (!text) throw new Error('Gebruik: /play <dag> <uur>. Bijv: /play morgen 20:00');

    const parsed = chrono.parse(text, new Date(), { forwardDate: true });
    if (parsed.length === 0) throw new Error(`Kon datum/tijd niet herkennen: "${text}"`);

    const dt = parsed[0].start.date();
    const date = dt.toISOString().slice(0, 10);
    const time = dt.toTimeString().slice(0, 5);

    // Check duplicate
    const existing = db.prepare(`
      SELECT * FROM matches
      WHERE match_date = ? AND starts_at = ? AND status IN ('open', 'full')
    `).get(date, time);

    if (existing) {
      throw new Error(`Match op ${date} ${time} bestaat al.`);
    }

    const info = db.prepare(`
      INSERT INTO matches (match_date, starts_at, status, player_limit, created_at)
      VALUES (?, ?, 'open', 10, ?)
    `).run(date, time, nowMs());

    // Schedule automatische herinneringen
    createActionsForMatch(info.lastInsertRowid);

    return `✅ Match aangemaakt: *${date}* om *${time}*\n\nSchrijf in met /ja!`;
}

// ==================== SCHEDULER (Automatische herinneringen) ====================

function createActionsForMatch(matchId) {
  cancelAllActions(matchId);

  const m = db.prepare(`SELECT * FROM matches WHERE id = ?`).get(matchId);
  if (!m) return;
  if (m.status === 'cancelled' || m.status === 'closed') return;

  const startsAt = new Date(`${m.match_date}T${m.starts_at}:00`);

  // Day message (bijv. om 9:00 op de dag zelf)
  const dayMsgAt = new Date(startsAt);
  dayMsgAt.setHours(CONFIG.dayMessageHour, 0, 0, 0);

  // Reminder (bijv. 2 uur voor start)
  const reminderAt = new Date(startsAt.getTime() - CONFIG.reminderHoursBefore * 60 * 60 * 1000);

  const ins = db.prepare(`
    INSERT INTO scheduled_actions (match_id, action_type, run_at, executed_at, cancelled_at, created_at)
    VALUES (?, ?, ?, NULL, NULL, ?)
  `);

  const createdAt = nowMs();
  ins.run(matchId, 'day_message', dayMsgAt.toISOString(), createdAt);
  ins.run(matchId, 'reminder', reminderAt.toISOString(), createdAt);
  ins.run(matchId, 'start_check', startsAt.toISOString(), createdAt);

  console.log(`✅ Herinneringen gepland voor match ${matchId}`);
}

function cancelAllActions(matchId) {
  db.prepare(`
    UPDATE scheduled_actions
    SET cancelled_at = ?
    WHERE match_id = ? AND executed_at IS NULL AND cancelled_at IS NULL
  `).run(nowMs(), matchId);
}

function countMaybe(matchId) {
  return db.prepare(`
    SELECT COUNT(*) as c FROM match_players
    WHERE match_id = ? AND signup_state = 'kan' AND is_waitlist = 0
  `).get(matchId).c;
}

function startScheduler() {
  console.log('⏰ Scheduler gestart - checkt elke minuut...');

  setInterval(() => {
    try {
      executeDueActionsOnce();
    } catch (err) {
      console.error('❌ Scheduler error:', err);
    }
  }, CONFIG.schedulerTickMs);
}

async function executeDueActionsOnce() {
  if (!CONFIG.WHATSAPP_GROUP_ID) {
    // Geen groep ID ingesteld, wacht tot eerste bericht
    return;
  }

  const due = db.prepare(`
    SELECT * FROM scheduled_actions
    WHERE executed_at IS NULL AND cancelled_at IS NULL
      AND datetime(run_at) <= datetime(?)
    ORDER BY datetime(run_at) ASC
    LIMIT ?
  `).all(new Date().toISOString(), CONFIG.schedulerBatch);

  if (due.length > 0) {
    console.log(`⏰ ${due.length} scheduled action(s) to execute...`);
  }

  for (const a of due) {
    const claimed = db.prepare(`
      UPDATE scheduled_actions
      SET executed_at = ?
      WHERE id = ? AND executed_at IS NULL AND cancelled_at IS NULL
    `).run(nowMs(), a.id);

    if (claimed.changes !== 1) continue;

    const m = db.prepare(`SELECT * FROM matches WHERE id = ?`).get(a.match_id);
    if (!m) continue;
    if (m.status === 'cancelled' || m.status === 'closed') continue;

    let message = null;

    if (a.action_type === 'day_message') {
      message = `📅 *Vandaag ${m.starts_at}*\n\n/ja om te bevestigen\n/kan als je misschien kan`;
      console.log(`📅 DAY MESSAGE voor match ${m.id}`);
    }

    if (a.action_type === 'reminder') {
      const yes = countYes(m.id);
      const maybe = countMaybe(m.id);
      const needSure = Math.max(0, CONFIG.playerLimit - yes);
      message = `⏰ *Reminder: Nog ${CONFIG.reminderHoursBefore} uur!*\n\n✅ Zeker: ${yes}/${CONFIG.playerLimit}\n⚠️ Misschien: ${maybe}\n\n📌 Nog ${needSure} ${needSure === 1 ? 'persoon' : 'personen'} zeker nodig!`;
      console.log(`⏰ REMINDER voor match ${m.id}`);
    }

    if (a.action_type === 'start_check') {
      const yes = countYes(m.id);
      const total = countTotal(m.id);

      if (yes < CONFIG.playerLimit) {
        db.prepare(`UPDATE matches SET status = 'cancelled' WHERE id = ?`).run(m.id);
        db.prepare(`UPDATE match_players SET team = NULL WHERE match_id = ?`).run(m.id);
        cancelAllActions(m.id);
        message = `❌ *Match gecanceld*\n\nNiet genoeg spelers (${yes}/${CONFIG.playerLimit} zeker)`;
        console.log(`❌ CANCELLED match ${m.id}`);
      } else {
        message = `⚽ *Tijd om te spelen!*\n\n${yes}/${CONFIG.playerLimit} spelers klaar!\n\nGebruik /teams voor teams`;
        console.log(`⚽ START CHECK match ${m.id}`);
      }
    }

    // Stuur bericht naar WhatsApp groep
    if (message) {
      try {
        await client.sendMessage(CONFIG.WHATSAPP_GROUP_ID, message);
        console.log(`✅ Bericht verzonden naar WhatsApp`);
      } catch (err) {
        console.error(`❌ Kan bericht niet versturen:`, err);
      }
    }
  }
}

function cmdWhoAmI(whatsappId) {
    const player = db.prepare(`SELECT * FROM players WHERE whatsapp_id = ?`).get(whatsappId);

    if (!player) {
        return `❌ Je WhatsApp is nog niet gelinkt.\n\nGebruik: /ja <jouw naam> om te linken\nOf vraag een admin om je handmatig te linken.`;
    }

    const posLabel = player.position ? ` [${player.position}]` : '';
    const wilson = player.games > 0 ? `${(wilsonScore(player) * 100).toFixed(1)}%` : 'Geen games';

    return `✅ Je bent gelinkt als: *${player.display_name}*${posLabel}\n\nStats: ${wilson} - ${player.wins}W/${player.games}G\nWhatsApp ID: ${whatsappId}`;
}

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n👋 Bot stoppen...');
    db.close();
    process.exit(0);
});
