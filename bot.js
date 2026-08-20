require('dotenv').config();
const { Client, GatewayIntentBits, Partials } = require('discord.js');
const { WebSocketServer } = require('ws');
const http = require('http');

// ─────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const OVERLAY_CHANNEL_NAME = process.env.OVERLAY_CHANNEL_NAME || 'overlay-media-jdr';
const WS_PASSWORD = process.env.WS_PASSWORD;
const PORT = process.env.PORT || 3000;

if (!DISCORD_TOKEN || !WS_PASSWORD) {
  console.error('❌ DISCORD_TOKEN et WS_PASSWORD sont requis dans .env');
  process.exit(1);
}

// ─────────────────────────────────────────────
// DÉTECTION DU TYPE DE FICHIER → COUCHE (LAYER)
// ─────────────────────────────────────────────
const VISUAL_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'mp4', 'webm', 'mov'];
const AUDIO_EXTENSIONS = ['mp3', 'wav', 'ogg', 'flac', 'm4a'];

function getFileExtension(filename) {
  return filename.split('.').pop().toLowerCase();
}

function detectLayer(filename) {
  const ext = getFileExtension(filename);
  if (VISUAL_EXTENSIONS.includes(ext)) return 'visual';
  if (AUDIO_EXTENSIONS.includes(ext)) return 'audio';
  return null; // type non supporté, on ignore
}

function isImage(filename) {
  const ext = getFileExtension(filename);
  return ['png', 'jpg', 'jpeg', 'webp'].includes(ext);
}

function isVideo(filename) {
  const ext = getFileExtension(filename);
  return ['mp4', 'webm', 'mov'].includes(ext);
}

// ─────────────────────────────────────────────
// RÉGLAGES VISUELS (taille, position, durée, fade)
// ─────────────────────────────────────────────
const SIZE_PRESETS = {
  petit: 250,
  moyen: 500,
  grand: 850,
  enorme: 1300,
};

const visualSettings = {
  sizePx: SIZE_PRESETS.moyen,
  posX: null, // null = centré
  posY: null,
  durationMs: 8000,
  fadeMs: 2000,
  persistent: false, // si true, l'image reste affichée indéfiniment (pas d'auto-clear)
};

// ─────────────────────────────────────────────
// FILE D'ATTENTE AUDIO
// ─────────────────────────────────────────────
const audioQueue = []; // { url, filename, author }
let audioVolume = 100; // 0-100
let audioLoop = false; // si true, la piste en cours (et les suivantes) tournent en boucle
let currentlyPlaying = false;

function enqueueAudio(track) {
  audioQueue.push(track);
  if (!currentlyPlaying) {
    playNextInQueue();
  }
}

function playNextInQueue() {
  const next = audioQueue.shift();
  if (!next) {
    currentlyPlaying = false;
    return;
  }
  currentlyPlaying = true;
  broadcast({
    type: 'media',
    layer: 'audio',
    kind: 'audio',
    url: next.url,
    filename: next.filename,
    author: next.author,
    volume: audioVolume / 100,
    loop: audioLoop,
    timestamp: Date.now(),
  });
  console.log(`📤 Média envoyé → couche "audio": ${next.filename} (file d'attente: ${audioQueue.length} restante(s))`);
}

// ─────────────────────────────────────────────
// SERVEUR HTTP + WEBSOCKET
// ─────────────────────────────────────────────
// Une réponse HTTP basique est nécessaire pour que le vérificateur de santé
// de Render détecte correctement le port comme actif (sinon il ne voit
// que le WebSocket et peut considérer le service comme "non sain").
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('JDR Overlay bot en ligne.');
});
const wss = new WebSocketServer({ server });

// clients authentifiés (apps Electron connectées)
const clients = new Set();

wss.on('connection', (ws) => {
  let authenticated = false;
  ws.isAlive = true;

  // Le navigateur (Electron) répond automatiquement aux pings par un pong,
  // sans code particulier à écrire côté client.
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (raw) => {
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }

    // Authentification obligatoire au premier message
    if (!authenticated) {
      if (data.type === 'auth' && data.password === WS_PASSWORD) {
        authenticated = true;
        clients.add(ws);
        ws.send(JSON.stringify({ type: 'auth_ok' }));
        // On envoie les réglages actuels dès la connexion,
        // pour que l'overlay soit à jour même après une reconnexion
        ws.send(JSON.stringify({ type: 'settings', layer: 'visual', settings: visualSettings }));
        console.log('✅ Client Electron authentifié');
      } else {
        ws.send(JSON.stringify({ type: 'auth_error' }));
        ws.close();
      }
      return;
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    console.log('🔌 Client déconnecté');
  });
});

// Heartbeat : envoie un VRAI message JSON toutes les 10s à chaque client
// connecté (plutôt qu'un simple ping bas niveau). Certains hébergeurs ne
// comptent que les vraies données comme "trafic actif" pour décider de
// couper ou non une connexion inactive — un ping protocolaire seul ne
// suffisait apparemment pas avec Render.
const HEARTBEAT_INTERVAL = 10000;

setInterval(() => {
  const message = JSON.stringify({ type: 'heartbeat', timestamp: Date.now() });
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) {
      ws.send(message);
    }
  }
}, HEARTBEAT_INTERVAL);

function broadcast(payload) {
  const message = JSON.stringify(payload);
  for (const client of clients) {
    if (client.readyState === client.OPEN) {
      client.send(message);
    }
  }
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Serveur WebSocket en écoute sur le port ${PORT}`);
});

// ─────────────────────────────────────────────
// BOT DISCORD
// ─────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Message, Partials.Channel],
});

client.once('ready', () => {
  console.log(`🤖 Bot connecté en tant que ${client.user.tag}`);
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (message.channel.name !== OVERLAY_CHANNEL_NAME) return;

  // ── Commandes texte ──
  const content = message.content.trim();
  const [cmd, ...args] = content.split(/\s+/);

  if (cmd === '!clear') {
    broadcast({ type: 'clear', layer: 'visual' });
    return;
  }

  // ── Réglages IMAGE ──
  if (cmd === '!taille') {
    const preset = SIZE_PRESETS[args[0]?.toLowerCase()];
    if (!preset) {
      message.reply(`Taille invalide. Choix possibles : ${Object.keys(SIZE_PRESETS).join(', ')}`);
      return;
    }
    visualSettings.sizePx = preset;
    broadcast({ type: 'settings', layer: 'visual', settings: visualSettings });
    return;
  }

  if (cmd === '!pos') {
    if (args[0]?.toLowerCase() === 'centre') {
      visualSettings.posX = null;
      visualSettings.posY = null;
    } else {
      const x = parseInt(args[0], 10);
      const y = parseInt(args[1], 10);
      if (Number.isNaN(x) || Number.isNaN(y)) {
        message.reply('Usage : `!pos X Y` (en pixels) ou `!pos centre`');
        return;
      }
      visualSettings.posX = x;
      visualSettings.posY = y;
    }
    broadcast({ type: 'settings', layer: 'visual', settings: visualSettings });
    return;
  }

  if (cmd === '!duree') {
    const seconds = parseFloat(args[0]);
    if (Number.isNaN(seconds) || seconds <= 0) {
      message.reply('Usage : `!duree N` (en secondes)');
      return;
    }
    visualSettings.durationMs = seconds * 1000;
    broadcast({ type: 'settings', layer: 'visual', settings: visualSettings });
    return;
  }

  if (cmd === '!fade') {
    const seconds = parseFloat(args[0]);
    if (Number.isNaN(seconds) || seconds < 0) {
      message.reply('Usage : `!fade N` (en secondes, ex: 1.5)');
      return;
    }
    visualSettings.fadeMs = seconds * 1000;
    broadcast({ type: 'settings', layer: 'visual', settings: visualSettings });
    return;
  }

  if (cmd === '!fixe') {
    visualSettings.persistent = true;
    broadcast({ type: 'settings', layer: 'visual', settings: visualSettings });
    message.reply('🖼️ Les prochaines images resteront affichées jusqu\'à `!clear`.');
    return;
  }

  if (cmd === '!normal') {
    visualSettings.persistent = false;
    broadcast({ type: 'settings', layer: 'visual', settings: visualSettings });
    message.reply(`🖼️ Retour au mode normal (disparition après ${visualSettings.durationMs / 1000}s).`);
    return;
  }

  // ── Réglages AUDIO ──
  if (cmd === '!volume') {
    const vol = parseInt(args[0], 10);
    if (Number.isNaN(vol) || vol < 0 || vol > 100) {
      message.reply('Usage : `!volume N` (entre 0 et 100)');
      return;
    }
    audioVolume = vol;
    broadcast({ type: 'volume', layer: 'audio', volume: audioVolume / 100 });
    return;
  }

  if (cmd === '!loop') {
    audioLoop = true;
    broadcast({ type: 'set_loop', layer: 'audio', loop: true });
    message.reply('🔁 La musique en cours (et les suivantes) tournera en boucle.');
    return;
  }

  if (cmd === '!noloop') {
    audioLoop = false;
    broadcast({ type: 'set_loop', layer: 'audio', loop: false });
    message.reply('▶️ Boucle désactivée.');
    return;
  }

  if (cmd === '!clearmusique' || cmd === '!stopmusique') {
    audioQueue.length = 0; // on vide aussi la file d'attente
    currentlyPlaying = false;
    broadcast({ type: 'clear', layer: 'audio' });
    return;
  }

  if (cmd === '!pause') {
    broadcast({ type: 'pause', layer: 'audio' });
    return;
  }

  if (cmd === '!resume') {
    broadcast({ type: 'resume', layer: 'audio' });
    return;
  }

  if (cmd === '!suivant' || cmd === '!skip') {
    // Fait un fade-out de la piste en cours puis passe à la suivante dans la file
    broadcast({ type: 'fadeout_next', layer: 'audio' });
    // On laisse un court délai pour laisser le fade-out se jouer côté overlay
    // avant d'envoyer la piste suivante (le crossfade côté overlay gère la transition)
    playNextInQueue();
    return;
  }

  // ── Pièces jointes (images / vidéos / audio) ──
  if (message.attachments.size === 0) return;

  for (const attachment of message.attachments.values()) {
    const layer = detectLayer(attachment.name);
    if (!layer) continue; // type non supporté

    let url = attachment.url;

    // Optimisation qualité pour les images (CDN Discord)
    if (isImage(attachment.name)) {
      url += (url.includes('?') ? '&' : '?') + 'width=1600&quality=lossless';
    }

    const author = {
      username: message.author.username,
      avatar: message.author.displayAvatarURL({ extension: 'png', size: 128 }),
    };

    if (layer === 'audio') {
      // L'audio passe par la file d'attente plutôt que d'être diffusé immédiatement
      enqueueAudio({ url, filename: attachment.name, author });
      continue;
    }

    broadcast({
      type: 'media',
      layer,
      kind: isImage(attachment.name) ? 'image' : 'video',
      url,
      filename: attachment.name,
      author,
      timestamp: Date.now(),
    });

    console.log(`📤 Média envoyé → couche "${layer}": ${attachment.name}`);
  }
});

client.on('error', (err) => {
  console.error('❌ Erreur du client Discord:', err);
});

client.on('shardError', (err) => {
  console.error('❌ Erreur de shard Discord:', err);
});

// Si la connexion n'a toujours pas abouti après 20s, c'est le signe
// d'un blocage réseau silencieux (ex: IP partagée bloquée côté Discord)
// plutôt qu'une vraie erreur — utile pour distinguer les deux cas.
setTimeout(() => {
  if (!client.isReady()) {
    console.error('❌ Toujours pas connecté à Discord après 20s — probable blocage réseau (IP partagée Render bloquée par Discord ?)');
  }
}, 20000);

client.login(DISCORD_TOKEN).catch((err) => {
  console.error('❌ Échec de connexion à Discord:', err.message);
});
