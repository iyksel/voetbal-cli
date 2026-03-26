const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const Database = require('better-sqlite3');

// Initialize database
const db = new Database('voetbal.db');
db.pragma('foreign_keys = ON');

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
});

client.on('message', async msg => {
    // Alleen groepsberichten
    if (!msg.from.endsWith('@g.us')) return;

    const text = msg.body.trim();
    const name = msg._data.notifyName || 'Onbekend';

    // Alleen commands
    if (!text.startsWith('/')) return;

    let response = null;

    try {
        if (text === '/status') {
            response = handleStatus();
        } else if (text === '/ja') {
            response = handleJoin(name);
        } else if (text.startsWith('/play')) {
            response = handlePlay(text);
        } else if (text === '/help') {
            response = handleHelp();
        }
    } catch (err) {
        response = `❌ Error: ${err.message}`;
    }

    if (response) {
        msg.reply(response);
    }
});

client.initialize();

// ==================== HANDLERS ====================

function getActiveMatch() {
    return db.prepare(`
        SELECT * FROM matches
        WHERE status IN ('open', 'full')
        ORDER BY starts_at ASC
        LIMIT 1
    `).get();
}

function handleStatus() {
    const match = getActiveMatch();
    if (!match) return '❌ Geen actieve match.';

    const signups = db.prepare(`
        SELECT p.display_name, mp.signup_state
        FROM match_players mp
        JOIN players p ON p.id = mp.player_id
        WHERE mp.match_id = ? AND mp.is_waitlist = 0
        ORDER BY mp.joined_at ASC
    `).all(match.id);

    const yes = signups.filter(s => s.signup_state === 'ja');
    const kan = signups.filter(s => s.signup_state === 'kan');

    const lines = [
        `📅 Match: ${match.match_date} om ${match.starts_at}`,
        `📊 Status: ${yes.length}/${match.player_limit}`,
        '',
        `✅ JA (${yes.length}):`,
        yes.map(s => `- ${s.display_name}`).join('\n') || '  (niemand)',
        '',
        `⚠️ KAN (${kan.length}):`,
        kan.map(s => `- ${s.display_name}`).join('\n') || '  (niemand)'
    ];

    return lines.join('\n');
}

function handleJoin(name) {
    const match = getActiveMatch();
    if (!match) return '❌ Geen actieve match.';

    // Normalize name
    const norm = String(name || '').trim().toLowerCase();

    // Find or create player
    let player = db.prepare(`SELECT * FROM players WHERE name_normalized = ?`).get(norm);

    if (!player) {
        const display = name.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
        const info = db.prepare(`
            INSERT INTO players (display_name, name_normalized, is_guest, created_at)
            VALUES (?, ?, 0, ?)
        `).run(display, norm, Date.now());
        player = { id: info.lastInsertRowid, display_name: display };
    }

    // Check if already signed up
    const existing = db.prepare(`
        SELECT * FROM match_players
        WHERE match_id = ? AND player_id = ?
    `).get(match.id, player.id);

    if (existing && existing.signup_state === 'ja' && existing.is_waitlist === 0) {
        return '✅ Je staat al ingeschreven!';
    }

    // Count current signups
    const yesCount = db.prepare(`
        SELECT COUNT(*) as count FROM match_players
        WHERE match_id = ? AND signup_state = 'ja' AND is_waitlist = 0
    `).get(match.id).count;

    if (yesCount >= match.player_limit) {
        return `❌ Match vol! (${yesCount}/${match.player_limit})`;
    }

    // Sign up
    if (existing) {
        db.prepare(`
            UPDATE match_players
            SET signup_state = 'ja', is_waitlist = 0, waitlist_position = NULL
            WHERE match_id = ? AND player_id = ?
        `).run(match.id, player.id);
    } else {
        db.prepare(`
            INSERT INTO match_players (match_id, player_id, signup_state, joined_at, is_waitlist)
            VALUES (?, ?, 'ja', ?, 0)
        `).run(match.id, player.id, Date.now());
    }

    const newCount = yesCount + 1;
    return `✅ ${player.display_name} staat ingeschreven! (${newCount}/${match.player_limit})`;
}

function handlePlay(text) {
    return '⚠️ /play commando is alleen beschikbaar via de CLI (app.js).\nGebruik: node app.js';
}

function handleHelp() {
    return `🤖 Voetbal Bot Commands:

/status - Zie wie ingeschreven is
/ja - Schrijf jezelf in voor de match
/help - Toon dit bericht

Voor meer commands gebruik de CLI:
node app.js`;
}

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n👋 Bot stoppen...');
    db.close();
    process.exit(0);
});
