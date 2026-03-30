const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const Database = require('better-sqlite3');
const chrono = require('chrono-node');

// Initialize database
const db = new Database('voetbal.db');
db.pragma('foreign_keys = ON');

// ==================== DATABASE MIGRATIONS ====================
// Add skill_modifier column if it doesn't exist
try {
  db.prepare(`ALTER TABLE players ADD COLUMN skill_modifier REAL DEFAULT 0`).run();
  console.log('✅ skill_modifier kolom toegevoegd aan players tabel');
} catch (e) {
  // Column already exists, ignore
}

// Set initial skill modifiers for known players
// BOOST: Gokdeniz, Seymen, Ardenis, Mikail (+0.08 = +8%)
// NERF: Mo-emre, Ahmet, Emre-b, Mehmet, Enver, Isaac (-0.08 = -8%)
const SKILL_MODIFIERS = {
  boost: ['gokdeniz', 'seymen', 'ardenis', 'mikail'],
  nerf: ['mo-emre', 'ahmet', 'emre-b', 'mehmet', 'enver', 'isaac']
};

const updateModifier = db.prepare(`UPDATE players SET skill_modifier = ? WHERE name_normalized = ?`);
SKILL_MODIFIERS.boost.forEach(name => updateModifier.run(0.08, name));
SKILL_MODIFIERS.nerf.forEach(name => updateModifier.run(-0.08, name));

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
    console.log("=== DEBUG MESSAGE ===");
    console.log("GROUP ID:", msg.from);
    console.log("TEXT:", msg.body);
    console.log("AUTHOR:", msg.author);
    console.log("NOTIFY NAME:", msg._data.notifyName);
    console.log("FROM:", msg.from);
    console.log("=====================");

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

    console.log(`📱 WhatsApp ID gebruikt: ${whatsappId}`);

    // Alleen commands
    if (!text.startsWith('/')) return;

    const [cmdRaw, ...args] = text.split(' ');
    const cmd = cmdRaw.toLowerCase();

    console.log(`🎯 Command parsing:`);
    console.log(`   Raw text: "${text}"`);
    console.log(`   Command: "${cmd}"`);
    console.log(`   Args: [${args.map(a => `"${a}"`).join(', ')}]`);

    let response = null;

    try {
        if (cmd === '/status') response = cmdStatus();
        else if (cmd === '/ja') response = cmdSignup(whatsappId, 'ja', args);
        else if (cmd === '/kan') response = cmdSignup(whatsappId, 'kan', args);
        else if (cmd === '/nee') response = cmdNee(whatsappId, args);
        else if (cmd === '/wachtlijst') response = cmdWachtlijst();
        else if (cmd === '/teams') response = cmdTeams();
        else if (cmd === '/witwon') response = cmdWin('wit', args);
        else if (cmd === '/zwartwon') response = cmdWin('zwart', args);
        else if (cmd === '/mvp') response = cmdMvp(whatsappId, args);
        else if (cmd === '/mvps') response = cmdMvps();
        else if (cmd === '/lijst') response = cmdLijst();
        else if (cmd === '/wedstrijden') response = cmdWedstrijden();
        else if (cmd === '/positie') response = cmdPositie(whatsappId, args);
        else if (cmd === '/play') response = cmdPlay(whatsappId, args);
        else if (cmd === '/addspeler') response = cmdAddSpeler(args);
        else if (cmd === '/edit') response = cmdEdit(args);
        else if (cmd === '/cancel') response = cmdCancel();
        else if (cmd === '/help') response = cmdHelp();
        else if (cmd === '/whoami') response = cmdWhoAmI(whatsappId);
        else if (cmd === '/debug') response = cmdDebug(whatsappId);
        else if (cmd === '/modifier') response = cmdModifier(args);
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

function normalizeName(name) {
  let s = String(name || '').trim().toLowerCase();
  s = s.replace(/^['"\s]+|['"\s]+$/g, '');
  s = s.replace(/\s+/g, ' ');
  return s;
}

// -------------------- DATUM FORMATTING --------------------
const WEEKDAYS_NL = ['Zondag', 'Maandag', 'Dinsdag', 'Woensdag', 'Donderdag', 'Vrijdag', 'Zaterdag'];

/**
 * Format een datum als "Maandag 22/04"
 * @param {string} isoDate - ISO datum string (YYYY-MM-DD)
 * @returns {string} - Geformatteerde datum
 */
function formatDateNl(isoDate) {
  const d = new Date(isoDate + 'T12:00:00'); // Middag om timezone issues te vermijden
  const weekday = WEEKDAYS_NL[d.getDay()];
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  return `${weekday} ${day}/${month}`;
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
/**
 * Pure Wilson Score Lower Bound (zonder modifier)
 */
function wilsonScoreRaw(p) {
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

/**
 * Wilson Score met skill_modifier toegepast
 * - skill_modifier van +0.08 = 8% boost
 * - skill_modifier van -0.08 = 8% nerf
 * Geclipt tussen 0.05 en 0.95 om extreme waarden te voorkomen
 */
function wilsonScore(p) {
  const raw = wilsonScoreRaw(p);
  const modifier = p.skill_modifier || 0;
  return Math.max(0.05, Math.min(0.95, raw + modifier));
}

// ==================== COMMAND HANDLERS ====================

function cmdHelp() {
    return `🤖 Voetbal Bot Commands:

📋 Match Info:
/status - Toon match + wie ingeschreven is
/wachtlijst - Toon wachtlijst
/teams - Genereer teams (bij 10 spelers)
/wedstrijden - Laatste 20 wedstrijden
/lijst - Alle spelers + winrate

✅ Inschrijven:
/ja - Schrijf jezelf in
/ja <naam> - Schrijf speler in (linkt je nummer)
/kan - Misschien (telt mee voor 10!)
/nee - Schrijf jezelf uit
/nee <naam> - Schrijf speler uit

🎮 Match Acties:
/play <dag> <uur> - Nieuwe match (bijv: /play vrijdag 22u)
/edit <tijd> - Wijzig tijd (bijv: /edit 20u30)
/cancel - Annuleer match
/witwon [score] - Wit won (bijv: /witwon 4-0)
/zwartwon [score] - Zwart won (bijv: /zwartwon 2-1)
/mvp <naam> - Stem voor MVP
/mvps - MVP leaderboard

⚙️ Spelers:
/addspeler <naam> <positie> - Voeg toe (K/V/M/A)
/positie <pos> - Stel je positie in
/modifier <naam> <+/-waarde> - Pas skill modifier aan
/whoami - Test je link
/debug - Debug linking info
/help - Dit bericht`;
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
    const total = yes.length + kan.length;

    const posLabel = (pos) => {
      if (!pos) return '';
      if (pos === 'keeper') return ' [K]';
      if (pos === 'verdediger') return ' [V]';
      if (pos === 'middenveld') return ' [M]';
      if (pos === 'aanvaller') return ' [A]';
      return '';
    };

    const lines = [
      `📅 *Match ${formatDateNl(m.match_date)} om ${m.starts_at}*`,
      `📊 Totaal: ${total}/${m.player_limit}`,
      ''
    ];

    // Toon hint als match vol is maar niet 10x ja
    if (total >= m.player_limit && yes.length < m.player_limit) {
      lines.push(`⚠️ *Nog ${m.player_limit - yes.length} spelers nodig!*`);
      lines.push('');
    }

    if (yes.length > 0) {
      yes.forEach((s, i) => {
        lines.push(`${i + 1}. ${s.display_name}`);
      });
    } else {
      lines.push('  (niemand)');
    }

    lines.push('');


    if (kan.length > 0) {
      lines.push(`⚠️ *KAN (${kan.length}):*`);
      kan.forEach((s, i) => {
        lines.push(`${i + 1}. ${s.display_name}`);
      });
    }

    return lines.join('\n');
}

function cmdSignup(whatsappId, state, args) {
    console.log(`🔗 SIGNUP DEBUG:`);
    console.log(`   WhatsApp ID: ${whatsappId}`);
    console.log(`   State: ${state}`);
    console.log(`   Args: [${args.map(a => `"${a}"`).join(', ')}]`);

    const m = getActiveMatch();
    if (!m) throw new Error('Geen actieve match.');

    let player;
    let linkMessage = '';

    if (args.length > 0) {
        // Naam meegegeven - zoek of maak aan
        const name = args.join(' ');
        console.log(`   → Naam van args: "${name}"`);

        // Check eerst of dit whatsapp_id al gelinkt is
        const existingLink = db.prepare(`SELECT * FROM players WHERE whatsapp_id = ?`).get(whatsappId);
        console.log(`   → Bestaande link:`, existingLink ? `${existingLink.display_name} (${existingLink.id})` : 'Geen');

        player = ensurePlayerByName(name, 1);
        console.log(`   → Speler gevonden/aangemaakt: ${player.display_name} (ID: ${player.id})`);

        // Link alleen als dit whatsapp nummer nog niet gelinkt is
        if (!existingLink) {
            // Check of deze speler al een ander whatsapp_id heeft
            const currentPlayer = db.prepare(`SELECT * FROM players WHERE id = ?`).get(player.id);
            console.log(`   → Huidige speler whatsapp_id:`, currentPlayer.whatsapp_id || 'Geen');

            if (!currentPlayer.whatsapp_id) {
                console.log(`   → LINKING: ${player.display_name} ↔ ${whatsappId}`);
                db.prepare(`UPDATE players SET whatsapp_id = ? WHERE id = ?`).run(whatsappId, player.id);
                linkMessage = `\n🔗 ${player.display_name} is nu gelinkt aan je WhatsApp!`;
                console.log(`   → Link SUCCESS!`);
            } else {
                console.log(`   → Speler heeft al ander WhatsApp ID: ${currentPlayer.whatsapp_id}`);
            }
        } else {
            console.log(`   → WhatsApp ID al in gebruik door: ${existingLink.display_name}`);
        }
    } else {
        console.log(`   → Geen naam - zoeken via WhatsApp ID`);
        // Geen naam - zoek via WhatsApp ID
        player = db.prepare(`SELECT * FROM players WHERE whatsapp_id = ?`).get(whatsappId);

        if (!player) {
            throw new Error('Je WhatsApp nummer is nog niet gelinkt.\n\nGebruik: /ja <jouw naam>');
        }
        console.log(`   → Gevonden via WhatsApp ID: ${player.display_name}`);
    }

    const existing = db.prepare(`
      SELECT * FROM match_players WHERE match_id = ? AND player_id = ?
    `).get(m.id, player.id);

    // Tel totaal (ja + kan) voor de limiet check
    const totalCount = countTotal(m.id);

    if (existing) {
      if (existing.signup_state === state && existing.is_waitlist === 0) {
        return `✅ ${player.display_name} staat al als "${state}".` + linkMessage + '\n\n' + cmdStatus();
      }

      // Wijzig van ja→kan of kan→ja maar check limiet
      if (totalCount >= m.player_limit && existing.is_waitlist === 1) {
        // Was op wachtlijst, blijft op wachtlijst
        db.prepare(`
          UPDATE match_players SET signup_state = ? WHERE match_id = ? AND player_id = ?
        `).run(state, m.id, player.id);
        return `⏳ ${player.display_name} → *${state}* (wachtlijst)` + linkMessage + '\n\n' + cmdStatus();
      }

      db.prepare(`
        UPDATE match_players
        SET signup_state = ?, is_waitlist = 0, waitlist_position = NULL
        WHERE match_id = ? AND player_id = ?
      `).run(state, m.id, player.id);

      return buildSignupResult(m, player, state, linkMessage);
    }

    // Nieuwe signup - check of match vol is (ja + kan >= limit)
    if (totalCount >= m.player_limit) {
      const waitPos = getNextWaitlistPosition(m.id);
      db.prepare(`
        INSERT INTO match_players (match_id, player_id, signup_state, joined_at, is_waitlist, waitlist_position)
        VALUES (?, ?, ?, ?, 1, ?)
      `).run(m.id, player.id, state, nowMs(), waitPos);
      return `⏳ ${player.display_name} op wachtlijst (#${waitPos}). Match vol!${linkMessage}\n\n` + cmdStatus();
    }

    db.prepare(`
      INSERT INTO match_players (match_id, player_id, signup_state, joined_at, is_waitlist)
      VALUES (?, ?, ?, ?, 0)
    `).run(m.id, player.id, state, nowMs());

    return buildSignupResult(m, player, state, linkMessage);
}

function buildSignupResult(match, player, state, linkMessage) {
    const total = countTotal(match.id);
    let result = `✅ ${player.display_name} → *${state}*${linkMessage}\n\n`;

    const yesCount = countYes(match.id);

    // Teams alleen als er 10x /ja is
    if (yesCount === match.player_limit) {
        result += '🎉 *We zijn met 10 zekere spelers! Teams worden gemaakt...*\n\n';
        result += generateAndSaveTeams(match.id);
    } else if (total === match.player_limit) {
        // Match vol, maar niet iedereen is zeker
        const kanCount = total - yesCount;
        result += `📋 *Match vol!* (${yesCount}x ja, ${kanCount}x kan)\n`;
        result += `⚠️ Nog ${kanCount} ${kanCount === 1 ? 'persoon' : 'personen'} moet /ja zeggen voor teams.\n\n`;
        result += cmdStatus();
    } else {
        result += cmdStatus();
    }

    return result;
}

function generateAndSaveTeams(matchId) {
    const rows = db.prepare(`
      SELECT p.id as player_id, p.display_name, p.wins, p.games, p.position
      FROM match_players mp
      JOIN players p ON p.id = mp.player_id
      WHERE mp.match_id = ? AND mp.signup_state = 'ja' AND mp.is_waitlist = 0
      ORDER BY mp.joined_at ASC
    `).all(matchId);

    if (rows.length !== 10) {
        return `❌ Kan geen teams maken: ${rows.length} spelers (10 nodig).`;
    }

    const { teamWit, teamZwart } = generateBalancedTeams(rows);

    // Save teams
    db.prepare(`UPDATE match_players SET team = NULL WHERE match_id = ?`).run(matchId);
    const upd = db.prepare(`UPDATE match_players SET team = ? WHERE match_id = ? AND player_id = ?`);
    for (const p of teamWit) upd.run('wit', matchId, p.player_id);
    for (const p of teamZwart) upd.run('zwart', matchId, p.player_id);

    return formatTeams(matchId);
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
        // Naam meegegeven - zoek of maak aan
        const name = args.join(' ');
        player = ensurePlayerByName(name, 1);
    } else {
        // Geen naam - zoek via WhatsApp ID
        player = db.prepare(`SELECT * FROM players WHERE whatsapp_id = ?`).get(whatsappId);

        if (!player) {
            throw new Error('Je WhatsApp nummer is nog niet gelinkt.\n\nGebruik: /nee <naam>');
        }
    }

    const existing = db.prepare(`
      SELECT * FROM match_players WHERE match_id = ? AND player_id = ?
    `).get(m.id, player.id);

    if (!existing) {
      return `ℹ️ ${player.display_name} stond niet ingeschreven.\n\n` + cmdStatus();
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

        result += `\n🎉 ${firstWaitlist.display_name} gepromoveerd van wachtlijst!`;
      }
    }

    return result + '\n\n' + cmdStatus();
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
    const kan = total - yes;

    if (yes !== m.player_limit) {
      if (kan > 0) {
        throw new Error(`Teams kan pas als er ${m.player_limit}x /ja is.\nNu: ${yes}x ja, ${kan}x kan.\n\n⚠️ Nog ${kan} ${kan === 1 ? 'persoon' : 'personen'} moet /ja zeggen!`);
      } else {
        throw new Error(`Teams kan pas als er ${m.player_limit}x /ja is. Nu: ${yes}x ja.`);
      }
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
        lines.push(`- ${p.display_name} (${(w * 100).toFixed(0)}% | ${p.wins}/${p.games})`);
      });

      return lines.join('\n');
    };

    return formatTeam(wit, '⬜ Team Wit') + '\n\n' + formatTeam(zwart, '⬛ Team Zwart');
}

/**
 * Tier-pairing team balancing:
 *
 * 1. Sorteer spelers op Wilson score (hoog → laag)
 * 2. Maak 5 paren: (1e,2e), (3e,4e), (5e,6e), (7e,8e), (9e,10e)
 * 3. Elk team krijgt exact 1 speler uit elke tier
 * 4. Kies de verdeling (32 opties) die posities het beste balanceert
 *
 * Dit garandeert dat beide teams vergelijkbare skill-spreiding hebben.
 */
function generateBalancedTeams(players10) {
  const players = players10.map(p => ({ ...p, rate: wilsonScore(p) }));

  // Sorteer op Wilson score (hoog → laag)
  players.sort((a, b) => b.rate - a.rate);

  // Maak 5 paren: [0,1], [2,3], [4,5], [6,7], [8,9]
  const pairs = [];
  for (let i = 0; i < 10; i += 2) {
    pairs.push([players[i], players[i + 1]]);
  }

  // Probeer alle 2^5 = 32 combinaties
  // Bit i = 0: pair[i][0] → teamA, pair[i][1] → teamB
  // Bit i = 1: pair[i][0] → teamB, pair[i][1] → teamA
  let bestTeamA = null;
  let bestTeamB = null;
  let bestScore = Infinity;

  for (let mask = 0; mask < 32; mask++) {
    const teamA = [];
    const teamB = [];

    for (let i = 0; i < 5; i++) {
      if ((mask >> i) & 1) {
        teamA.push(pairs[i][1]);
        teamB.push(pairs[i][0]);
      } else {
        teamA.push(pairs[i][0]);
        teamB.push(pairs[i][1]);
      }
    }

    // Score op positie balans
    const defA = calcDefensiveStrength(teamA);
    const defB = calcDefensiveStrength(teamB);
    const offA = calcOffensiveStrength(teamA);
    const offB = calcOffensiveStrength(teamB);

    const defDiff = Math.abs(defA - defB);
    const offDiff = Math.abs(offA - offB);

    // Keeper balans
    const keepersA = countKeepers(teamA);
    const keepersB = countKeepers(teamB);
    const totalKeepers = keepersA + keepersB;
    let keeperPenalty = 0;
    if (totalKeepers === 2) {
      keeperPenalty = (keepersA !== 1) ? 10 : 0;
    } else if (totalKeepers > 2) {
      keeperPenalty = Math.abs(keepersA - keepersB) * 5;
    }

    // Wilson diff (zou klein moeten zijn door pairing)
    const wilsonA = teamA.reduce((s, p) => s + p.rate, 0);
    const wilsonB = teamB.reduce((s, p) => s + p.rate, 0);
    const wilsonDiff = Math.abs(wilsonA - wilsonB);

    const score = defDiff * 100 + offDiff * 100 + keeperPenalty * 80 + wilsonDiff * 50;

    if (score < bestScore) {
      bestScore = score;
      bestTeamA = teamA.slice();
      bestTeamB = teamB.slice();
    }
  }

  return {
    teamWit: bestTeamA,
    teamZwart: bestTeamB
  };
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

function cmdWin(team, args) {
    const m = getActiveMatch();
    if (!m) throw new Error('Geen actieve match.');

    const wit = db.prepare(`
      SELECT player_id FROM match_players WHERE match_id = ? AND team = 'wit'
    `).all(m.id);

    const zwart = db.prepare(`
      SELECT player_id FROM match_players WHERE match_id = ? AND team = 'zwart'
    `).all(m.id);

    if (wit.length === 0 || zwart.length === 0) {
      throw new Error('Teams zijn nog niet gegenereerd. Gebruik eerst /teams.');
    }

    // Check of er al een resultaat is
    const existingRes = db.prepare(`SELECT * FROM match_results WHERE match_id = ?`).get(m.id);
    if (existingRes) {
      throw new Error('Resultaat is al ingevoerd voor deze match.');
    }

    // Parse score (bijv. "4-0" of "2-1")
    let score = null;
    if (args.length > 0) {
      const scoreArg = args.join('').trim();
      if (/^\d+-\d+$/.test(scoreArg)) {
        score = scoreArg;
      }
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

      // Sla resultaat op
      db.prepare(`
        INSERT INTO match_results (match_id, winner_team, score, decided_at)
        VALUES (?, ?, ?, ?)
      `).run(m.id, team, score, nowMs());

      db.prepare(`UPDATE matches SET status = 'closed' WHERE id = ?`).run(m.id);
    });
    tx();

    // Schedule MVP voting end (2 uur na resultaat)
    scheduleMvpEnd(m.id);

    const teamLabel = team.charAt(0).toUpperCase() + team.slice(1);
    const scoreText = score ? ` met ${score}` : '';
    return `🏆 *Team ${teamLabel} heeft gewonnen${scoreText}!*\n\n⏰ MVP stemmen open voor 2 uur (of tot 10 stemmen / 6+ voor iemand)\n\nStem nu: /mvp <naam>\n\n` + cmdLijst();
}

function scheduleMvpEnd(matchId) {
  // Cancel bestaande mvp_end actions
  db.prepare(`
    UPDATE scheduled_actions
    SET cancelled_at = ?
    WHERE match_id = ? AND action_type = 'mvp_end' AND executed_at IS NULL
  `).run(nowMs(), matchId);

  // Schedule nieuwe mvp_end action (2 uur later)
  const mvpEndAt = new Date(Date.now() + 2 * 60 * 60 * 1000);
  db.prepare(`
    INSERT INTO scheduled_actions (match_id, action_type, run_at, executed_at, cancelled_at, created_at)
    VALUES (?, 'mvp_end', ?, NULL, NULL, ?)
  `).run(matchId, mvpEndAt.toISOString(), nowMs());

  console.log(`⏰ MVP voting eindigt om ${mvpEndAt.toTimeString().slice(0, 5)}`);
}

function isMvpVotingOpen(matchId) {
  // Check of mvp_end action al is uitgevoerd
  const executed = db.prepare(`
    SELECT * FROM scheduled_actions
    WHERE match_id = ? AND action_type = 'mvp_end' AND executed_at IS NOT NULL
  `).get(matchId);

  return !executed;
}

function checkAndFinalizeMvpVoting(matchId) {
  // Tel totaal aantal votes
  const totalVotes = db.prepare(`
    SELECT COUNT(*) as c FROM mvp_votes WHERE match_id = ?
  `).get(matchId).c;

  // Check of iemand 6+ votes heeft
  const topVoter = db.prepare(`
    SELECT voted_player_id, COUNT(*) as votes
    FROM mvp_votes
    WHERE match_id = ?
    GROUP BY voted_player_id
    ORDER BY votes DESC
    LIMIT 1
  `).get(matchId);

  const hasWinner = topVoter && topVoter.votes >= 6;
  const allVoted = totalVotes >= 10;

  if (hasWinner || allVoted) {
    return finalizeMvpVoting(matchId);
  }

  return null;
}

function finalizeMvpVoting(matchId) {
  // Markeer mvp_end als uitgevoerd
  db.prepare(`
    UPDATE scheduled_actions
    SET executed_at = ?
    WHERE match_id = ? AND action_type = 'mvp_end' AND executed_at IS NULL
  `).run(nowMs(), matchId);

  // Bepaal MVP (meeste stemmen)
  const winner = db.prepare(`
    SELECT p.display_name, COUNT(*) as votes
    FROM mvp_votes v
    JOIN players p ON p.id = v.voted_player_id
    WHERE v.match_id = ?
    GROUP BY v.voted_player_id
    ORDER BY votes DESC
    LIMIT 1
  `).get(matchId);

  if (!winner) {
    return '📊 *MVP Voting gesloten*\n\nGeen stemmen ontvangen.';
  }

  const totalVotes = db.prepare(`
    SELECT COUNT(*) as c FROM mvp_votes WHERE match_id = ?
  `).get(matchId).c;

  return `🏆 *MVP Voting gesloten!*\n\n⭐ *${winner.display_name}* is de MVP met ${winner.votes}/${totalVotes} stemmen!`;
}

function cmdMvp(whatsappId, args) {
    const m = db.prepare(`
      SELECT * FROM matches WHERE status = 'closed' ORDER BY starts_at DESC LIMIT 1
    `).get();

    if (!m) throw new Error('Geen gesloten match gevonden. Voer eerst resultaat in met /witwon of /zwartwon.');

    // Check of MVP voting nog open is
    if (!isMvpVotingOpen(m.id)) {
      throw new Error('MVP voting voor deze match is al gesloten.');
    }

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

    // Check of voting moet eindigen (10 votes of 6+ voor iemand)
    const finalizeResult = checkAndFinalizeMvpVoting(m.id);
    if (finalizeResult) {
      return `✅ Je stemde voor *${votedPlayer.display_name}*!\n\n` + finalizeResult;
    }

    // Toon huidige stand
    const votes = db.prepare(`
      SELECT p.display_name, COUNT(*) as count
      FROM mvp_votes v
      JOIN players p ON p.id = v.voted_player_id
      WHERE v.match_id = ?
      GROUP BY v.voted_player_id
      ORDER BY count DESC
    `).all(m.id);

    const totalVotes = votes.reduce((sum, v) => sum + v.count, 0);
    const remaining = 10 - totalVotes;

    let result = `✅ Stem geregistreerd: je stemde voor *${votedPlayer.display_name}* als MVP!`;
    result += `\n\n📊 *Stand (${totalVotes}/10 stemmen):*\n`;
    votes.forEach(v => {
      const bar = '█'.repeat(v.count) + '░'.repeat(6 - v.count);
      result += `${v.display_name}: ${bar} ${v.count}\n`;
    });

    if (remaining > 0) {
      result += `\n⏳ Nog ${remaining} ${remaining === 1 ? 'stem' : 'stemmen'} of 6+ voor winnaar`;
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
    `).all();

    if (rows.length === 0) {
      return 'ℹ️ Nog geen spelers met wedstrijden.';
    }

    // Sorteer op % (hoog→laag), dan op wins (hoog→laag)
    rows.sort((a, b) => {
      const pctA = a.wins / a.games;
      const pctB = b.wins / b.games;
      if (pctA !== pctB) return pctB - pctA; // Hoger % eerst
      return b.wins - a.wins; // Meer wins eerst
    });

    const posLabel = (pos) => {
      if (!pos) return '';
      if (pos === 'keeper') return ' [K]';
      if (pos === 'verdediger') return ' [V]';
      if (pos === 'middenveld') return ' [M]';
      if (pos === 'aanvaller') return ' [A]';
      return '';
    };

    const lines = ['📊 *Spelers Ranking:*', ''];
    rows.slice(0, 30).forEach((r, i) => {
      const pct = ((r.wins / r.games) * 100).toFixed(0);
      lines.push(`${i + 1}. ${r.display_name} — ${pct}% (${r.wins}/${r.games})`);
    });

    return lines.join('\n');
}

function cmdWedstrijden() {
    // Alleen closed matches, laatste 5
    const matches = db.prepare(`
      SELECT m.id, m.match_date, mr.winner_team, mr.score
      FROM matches m
      LEFT JOIN match_results mr ON mr.match_id = m.id
      WHERE m.status = 'closed'
      ORDER BY m.starts_at DESC
      LIMIT 5
    `).all();

    if (matches.length === 0) {
      return 'ℹ️ Nog geen gespeelde wedstrijden.';
    }

    const lines = ['📅 *Laatste 5nWedstrijden:*', ''];

    for (const match of matches) {
      // Haal teams op
      const wit = db.prepare(`
        SELECT p.display_name
        FROM match_players mp
        JOIN players p ON p.id = mp.player_id
        WHERE mp.match_id = ? AND mp.team = 'wit'
      `).all(match.id).map(p => p.display_name.split(' ')[0]); // Alleen voornaam

      const zwart = db.prepare(`
        SELECT p.display_name
        FROM match_players mp
        JOIN players p ON p.id = mp.player_id
        WHERE mp.match_id = ? AND mp.team = 'zwart'
      `).all(match.id).map(p => p.display_name.split(' ')[0]); // Alleen voornaam

      // Format datum als dd/mm
      const d = new Date(match.match_date + 'T12:00:00');
      const day = String(d.getDate()).padStart(2, '0');
      const month = String(d.getMonth() + 1).padStart(2, '0');
      const dateStr = `${day}/${month}`;

      // Score (of '-' als geen score)
      const score = match.score || '-';

      // Bepaal winnaar indicator
      const witWon = match.winner_team === 'wit';
      const witNames = wit.join(' ,');
      const zwartNames = zwart.join(' ,');

      // Format: dd/mm | Wit 2-0 Zwart (winnaar vet)
      if (witWon) {
        lines.push(`${dateStr} | *${witNames}* ${score} ${zwartNames}`);
      } else {
        lines.push(`${dateStr} | ${witNames} ${score} *${zwartNames}*`);
      }
    }

    return lines.join('\n\n');
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
    // Check of er al een actieve match is
    if (getActiveMatch()) {
        throw new Error('Er is al een actieve match. Eerst /cancel of zet resultaat met /witwon of /zwartwon.');
    }

    const text = args.join(' ').trim();
    if (!text) throw new Error('Gebruik: /play <dag> <uur>\nBijv: /play morgen 22u of /play vrijdag 20:30');

    // Normaliseer tekst (22u → 22:00, 21h30 → 21:30, etc.)
    const normalized = normalizeDateText(text);

    const dt = chrono.nl.parseDate(normalized, new Date(), { forwardDate: true });
    if (!dt) throw new Error(`Kon datum/tijd niet herkennen: "${text}"`);

    const date = dt.toISOString().slice(0, 10);
    const time = dt.toTimeString().slice(0, 5);

    const info = db.prepare(`
      INSERT INTO matches (match_date, starts_at, status, player_limit, created_at)
      VALUES (?, ?, 'open', 10, ?)
    `).run(date, time, nowMs());

    // Schedule automatische herinneringen
    createActionsForMatch(info.lastInsertRowid);

    return `✅ Match aangemaakt: *${formatDateNl(date)}* om *${time}*\n\nSchrijf in met /ja!`;
}

function cmdAddSpeler(args) {
    const fullText = args.join(' ').trim();
    if (!fullText) throw new Error('Gebruik: /addspeler <naam> <positie>\nPositie: K, V, M, A');

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

    const posLabel = { 'keeper': 'K', 'verdediger': 'V', 'middenveld': 'M', 'aanvaller': 'A' };
    return `✅ Speler toegevoegd: ${p.display_name}`;
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

    const time = `${String(t.h).padStart(2, '0')}:${String(t.min).padStart(2, '0')}`;

    db.prepare(`UPDATE matches SET starts_at = ? WHERE id = ?`).run(time, m.id);
    createActionsForMatch(m.id);

    return `✅ Match tijd gewijzigd naar *${time}*`;
}

function clearTeams(matchId) {
    db.prepare(`UPDATE match_players SET team = NULL WHERE match_id = ?`).run(matchId);
}

function cmdCancel() {
    const m = getActiveMatch();
    if (!m) throw new Error('Geen actieve match.');

    db.prepare(`UPDATE matches SET status = 'cancelled' WHERE id = ?`).run(m.id);
    clearTeams(m.id);
    cancelAllActions(m.id);

    return `❌ Match ${formatDateNl(m.match_date)} ${m.starts_at} is gecanceld.`;
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

    let message = null;

    // MVP end kan ook voor closed matches (dat is juist de bedoeling)
    if (a.action_type === 'mvp_end') {
      if (m.status === 'closed') {
        message = finalizeMvpVoting(m.id);
        console.log(`🏆 MVP VOTING CLOSED voor match ${m.id}`);
      }
      // Stuur bericht en ga door naar volgende action
      if (message) {
        try {
          await client.sendMessage(CONFIG.WHATSAPP_GROUP_ID, message);
          console.log(`✅ MVP bericht verzonden naar WhatsApp`);
        } catch (err) {
          console.error(`❌ Kan MVP bericht niet versturen:`, err);
        }
      }
      continue;
    }

    // Andere actions: skip cancelled/closed matches
    if (m.status === 'cancelled' || m.status === 'closed') continue;

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
        return `❌ Je WhatsApp is nog niet gelinkt.\nWhatsApp ID: \`${whatsappId}\`\n\nGebruik: /ja <jouw naam> om te linken`;
    }

    const posLabel = player.position ? ` [${player.position}]` : '';
    const wilson = player.games > 0 ? `${(wilsonScore(player) * 100).toFixed(1)}%` : 'Geen games';

    return `✅ Je bent gelinkt als: *${player.display_name}*${posLabel}\n\nStats: ${wilson} - ${player.wins}W/${player.games}G\nWhatsApp ID: \`${whatsappId}\``;
}

function cmdDebug(whatsappId) {
    const allLinks = db.prepare(`
        SELECT id, display_name, whatsapp_id, position
        FROM players
        WHERE whatsapp_id IS NOT NULL
        ORDER BY display_name
    `).all();

    let result = `🔍 *Debug Info:*\n\nJe WhatsApp ID: \`${whatsappId}\`\n\n`;

    if (allLinks.length === 0) {
        result += 'Geen spelers gelinkt aan WhatsApp.';
    } else {
        result += `*Gelinkte spelers (${allLinks.length}):*\n`;
        allLinks.forEach(p => {
            const posLabel = p.position ? ` [${p.position}]` : '';
            const isYou = p.whatsapp_id === whatsappId ? ' ← *JIJ*' : '';
            result += `• ${p.display_name}${posLabel}${isYou}\n`;
            result += `  ID: \`${p.whatsapp_id}\`\n`;
        });
    }

    return result;
}

/**
 * /modifier <naam> <+/-waarde> - Pas skill modifier aan
 * Bijv: /modifier ahmet -5 (nerf met 5%)
 *       /modifier mikail +10 (boost met 10%)
 *       /modifier ahmet 0 (reset naar normaal)
 */
function cmdModifier(args) {
    if (args.length < 2) {
        // Toon huidige modifiers
        const players = db.prepare(`
            SELECT display_name, skill_modifier, wins, games
            FROM players
            WHERE skill_modifier != 0
            ORDER BY skill_modifier DESC
        `).all();

        if (players.length === 0) {
            return `⚙️ *Skill Modifiers*\n\nGeen spelers met aangepaste modifiers.\n\nGebruik: /modifier <naam> <+/-waarde>\nBijv: /modifier ahmet -5`;
        }

        let result = `⚙️ *Skill Modifiers:*\n\n`;
        players.forEach(p => {
            const sign = p.skill_modifier >= 0 ? '+' : '';
            const pct = (p.skill_modifier * 100).toFixed(0);
            result += `• ${p.display_name}: ${sign}${pct}%\n`;
        });
        result += `\nGebruik: /modifier <naam> <waarde>`;
        return result;
    }

    const value = args.pop();
    const name = args.join(' ').trim();

    if (!name) throw new Error('Gebruik: /modifier <naam> <+/-waarde>');

    // Parse modifier value (accept +5, -5, 5, etc)
    const numValue = parseFloat(value.replace(/[+%]/g, ''));
    if (isNaN(numValue) || numValue < -30 || numValue > 30) {
        throw new Error('Modifier moet tussen -30 en +30 zijn.');
    }

    const modifier = numValue / 100; // Convert to decimal

    const player = db.prepare(`SELECT * FROM players WHERE name_normalized = ?`).get(normalizeName(name));
    if (!player) throw new Error(`Speler "${name}" niet gevonden.`);

    db.prepare(`UPDATE players SET skill_modifier = ? WHERE id = ?`).run(modifier, player.id);

    const sign = modifier >= 0 ? '+' : '';
    const pct = (modifier * 100).toFixed(0);
    const rawWilson = (wilsonScoreRaw(player) * 100).toFixed(1);
    const newEffective = ((wilsonScoreRaw(player) + modifier) * 100).toFixed(1);

    return `✅ Modifier voor *${player.display_name}* aangepast naar ${sign}${pct}%\n\nWilson: ${rawWilson}% → Effectief: ${newEffective}%`;
}

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n👋 Bot stoppen...');
    db.close();
    process.exit(0);
});
