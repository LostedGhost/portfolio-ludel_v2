/* ===== PORTFOLIO LUDEL — SERVER.JS =====
   Serveur Node.js natif (sans framework externe)
   Port 3000 — API REST + fichiers statiques
   ======================================= */

const http = require('http');
const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');
const url  = require('url');

require('dotenv').config();

const PORT       = process.env.PORT || 3000;
const ADMIN_HASH = '52daf8440265da2c033ecee8b725fc172f774acdd053ebf710954119576da0a5'; // Lucio@2026
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME     = 'portfolio';
const DATA_FILE  = path.join(__dirname, 'data.json');
const MESSAGES_FILE = path.join(__dirname, 'messages.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOADS_DIR = path.join(PUBLIC_DIR, 'uploads');
const MAX_UPLOAD  = 5 * 1024 * 1024; // 5 MB

// ── Assurer l'existence du dossier uploads ──────────────────────────────────
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
// Assurer l'existence du fichier messages.json
if (!fs.existsSync(MESSAGES_FILE)) fs.writeFileSync(MESSAGES_FILE, JSON.stringify([]), 'utf8');

// ── Database Layer (MongoDB with JSON fallback) ─────────────────────────────
let dbClient = null;
let db = null;

async function connectDB() {
  if (!MONGODB_URI) {
    console.warn("[DB] MONGODB_URI non défini. Utilisation du mode fichier JSON uniquement.");
    return false;
  }
  try {
    const { MongoClient } = require('mongodb');
    dbClient = new MongoClient(MONGODB_URI);
    await dbClient.connect();
    db = dbClient.db(DB_NAME);
    console.log(`[DB] Connecté à MongoDB Atlas (${DB_NAME})`);
    await migrateIfNeeded();
    return true;
  } catch (e) {
    console.error("[DB] Erreur connexion MongoDB:", e.message);
    return false;
  }
}

async function migrateIfNeeded() {
  const settingsCount = await db.collection('settings').countDocuments();
  if (settingsCount === 0 && fs.existsSync(DATA_FILE)) {
    console.log("[DB] Migration data.json -> MongoDB...");
    const localData = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    await db.collection('settings').insertOne({ _id: 'global', ...localData });
  }
  const messagesCount = await db.collection('messages').countDocuments();
  if (messagesCount === 0 && fs.existsSync(MESSAGES_FILE)) {
    console.log("[DB] Migration messages.json -> MongoDB...");
    const localMsgs = JSON.parse(fs.readFileSync(MESSAGES_FILE, 'utf8'));
    if (localMsgs.length > 0) await db.collection('messages').insertMany(localMsgs);
  }
}

async function getPortfolioData() {
  if (db) {
    const doc = await db.collection('settings').findOne({ _id: 'global' });
    if (doc) { const { _id, ...rest } = doc; return rest; }
  }
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

async function updatePortfolioData(data) {
  if (db) {
    await db.collection('settings').updateOne({ _id: 'global' }, { $set: data }, { upsert: true });
  }
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
}

async function getMessagesFromDB() {
  if (db) return await db.collection('messages').find().sort({ date: -1 }).toArray();
  return JSON.parse(fs.readFileSync(MESSAGES_FILE, 'utf8'));
}

async function addMessageToDB(msg) {
  if (db) await db.collection('messages').insertOne(msg);
  else {
    const msgs = JSON.parse(fs.readFileSync(MESSAGES_FILE, 'utf8'));
    msgs.unshift(msg);
    fs.writeFileSync(MESSAGES_FILE, JSON.stringify(msgs, null, 2), 'utf8');
  }
}

async function markMessageReadInDB(id, lu) {
  if (db) {
    // MongoDB stored IDs might be numbers or strings depending on migration
    // We try both or match by string conversion
    const res = await db.collection('messages').updateOne(
      { $or: [{ id: id }, { id: Number(id) }, { id: String(id) }] },
      { $set: { lu: lu } }
    );
    return res.matchedCount > 0;
  }
  const msgs = JSON.parse(fs.readFileSync(MESSAGES_FILE, 'utf8'));
  const idx = msgs.findIndex(m => String(m.id).trim() === String(id).trim());
  if (idx !== -1) {
    msgs[idx].lu = lu;
    fs.writeFileSync(MESSAGES_FILE, JSON.stringify(msgs, null, 2), 'utf8');
    return true;
  }
  return false;
}

function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Token');
}

function json(res, statusCode, obj) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function errorResponse(res, code, msg) {
  json(res, code, { error: msg });
}

// ── Vérification du token admin ─────────────────────────────────────────────
async function checkAdminToken(req, res) {
  const token = req.headers['x-admin-token'];
  if (!token) { errorResponse(res, 401, 'Token manquant'); return false; }
  const data = await getPortfolioData();
  const validHash = data.auth?.passwordHash || ADMIN_HASH;
  if (token !== validHash && token !== ADMIN_HASH) {
    errorResponse(res, 401, 'Token invalide');
    return false;
  }
  return true;
}

// ── Lire le body JSON ───────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ── Parser multipart/form-data ──────────────────────────────────────────────
function parseMultipart(buffer, boundary) {
  const boundaryBuf = Buffer.from('--' + boundary);
  const parts = [];
  let start = 0;

  while (true) {
    const idx = buffer.indexOf(boundaryBuf, start);
    if (idx === -1) break;
    const partStart = idx + boundaryBuf.length;
    const next = buffer.indexOf(boundaryBuf, partStart);
    if (next === -1) break;

    // chaque part commence par \r\n, finit par \r\n
    const partBuf = buffer.slice(partStart + 2, next - 2);
    // séparer headers et corps
    const headerEnd = partBuf.indexOf('\r\n\r\n');
    if (headerEnd === -1) { start = next; continue; }

    const headerStr = partBuf.slice(0, headerEnd).toString('utf8');
    const body = partBuf.slice(headerEnd + 4);

    const nameMatch = headerStr.match(/name="([^"]+)"/);
    const filenameMatch = headerStr.match(/filename="([^"]+)"/);
    const contentTypeMatch = headerStr.match(/Content-Type:\s*(.+)/i);

    parts.push({
      name: nameMatch ? nameMatch[1] : null,
      filename: filenameMatch ? filenameMatch[1] : null,
      contentType: contentTypeMatch ? contentTypeMatch[1].trim() : 'application/octet-stream',
      data: body
    });

    start = next;
  }
  return parts;
}

// ── Servir les fichiers statiques ────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.pdf':  'application/pdf',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.ttf':  'font/ttf'
};

function serveStatic(req, res, urlPath) {
  let filePath = path.join(PUBLIC_DIR, urlPath === '/' ? 'index.html' : urlPath);
  // Sécurité : ne pas sortir du dossier public
  if (!filePath.startsWith(PUBLIC_DIR)) {
    errorResponse(res, 403, 'Accès refusé');
    return;
  }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': stat.size,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600'
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

// ── Routeur API ──────────────────────────────────────────────────────────────
async function handleAPI(req, res, urlPath) {
  console.log(`[API] ${req.method} ${urlPath}`);
  /* ---- GET /api/data ---- */
  if (urlPath === '/api/data' && req.method === 'GET') {
    const data = await getPortfolioData();
    json(res, 200, data);
    return;
  }

  /* ---- POST /api/data ---- */
  if (urlPath === '/api/data' && req.method === 'POST') {
    if (!await checkAdminToken(req, res)) return;
    try {
      const buf = await readBody(req);
      const newData = JSON.parse(buf.toString('utf8'));
      // Conserver le passwordHash (ne pas l'écraser accidentellement sauf section auth)
      if (!newData.auth || !newData.auth.passwordHash) {
        const current = await getPortfolioData();
        if (!newData.auth) newData.auth = {};
        newData.auth.passwordHash = "52daf8440265da2c033ecee8b725fc172f774acdd053ebf710954119576da0a5";
      }
      await updatePortfolioData(newData);
      json(res, 200, { success: true });
    } catch (e) {
      errorResponse(res, 400, 'JSON invalide : ' + e.message);
    }
    return;
  }

  /* ---- POST /api/login ---- */
  if (urlPath === '/api/login' && req.method === 'POST') {
    try {
      const buf = await readBody(req);
      const { password } = JSON.parse(buf.toString('utf8'));
      const hash = sha256(password || '');
      const data = await getPortfolioData();
      const validHash = data.auth?.passwordHash || ADMIN_HASH;
      if (hash === validHash || hash === ADMIN_HASH) {
        json(res, 200, { success: true, token: hash });
      } else {
        json(res, 200, { success: false });
      }
    } catch (e) {
      errorResponse(res, 400, 'Requête invalide');
    }
    return;
  }

  /* ---- POST /api/change-password ---- */
  if (urlPath === '/api/change-password' && req.method === 'POST') {
    if (!await checkAdminToken(req, res)) return;
    try {
      const buf = await readBody(req);
      const { oldPassword, newPassword } = JSON.parse(buf.toString('utf8'));
      const data = await getPortfolioData();
      if (sha256(oldPassword || '') !== data.auth.passwordHash) {
        json(res, 200, { success: false, message: 'Ancien mot de passe incorrect' });
        return;
      }
      if (!newPassword || newPassword.length < 8) {
        json(res, 200, { success: false, message: 'Le nouveau mot de passe doit contenir au moins 8 caractères' });
        return;
      }
      data.auth.passwordHash = sha256(newPassword);
      await updatePortfolioData(data);
      json(res, 200, { success: true });
    } catch (e) {
      errorResponse(res, 400, 'Requête invalide');
    }
    return;
  }

  /* ---- POST /api/upload ---- */
  if (urlPath === '/api/upload' && req.method === 'POST') {
    if (!await checkAdminToken(req, res)) return;

    // Vérifier taille
    const contentLength = parseInt(req.headers['content-length'] || '0', 10);
    if (contentLength > MAX_UPLOAD) {
      errorResponse(res, 413, 'Fichier trop volumineux (max 5 MB)');
      return;
    }

    const contentType = req.headers['content-type'] || '';
    const boundaryMatch = contentType.match(/boundary=(.+)/);
    if (!boundaryMatch) {
      errorResponse(res, 400, 'Content-Type multipart manquant ou boundary absent');
      return;
    }
    const boundary = boundaryMatch[1].trim();

    try {
      const buf = await readBody(req);
      if (buf.length > MAX_UPLOAD) {
        errorResponse(res, 413, 'Fichier trop volumineux (max 5 MB)');
        return;
      }

      const parts = parseMultipart(buf, boundary);
      const filePart = parts.find(p => p.filename);
      const oldPathPart = parts.find(p => p.name === 'oldPath');

      if (!filePart) {
        errorResponse(res, 400, 'Aucun fichier trouvé dans la requête');
        return;
      }

      // Suppression de l'ancien fichier si spécifié
      if (oldPathPart && oldPathPart.data) {
        const oldRelPath = oldPathPart.data.toString('utf8').trim();
        if (oldRelPath.startsWith('/uploads/')) {
            const oldFileName = path.basename(oldRelPath);
            const fullOldPath = path.join(UPLOADS_DIR, oldFileName);
            if (fs.existsSync(fullOldPath)) {
                try { fs.unlinkSync(fullOldPath); } catch(e){ console.error("Erreur suppression ancien fichier:", e); }
            }
        }
      }

      // Nettoyer le nom de fichier
      const safeOrigName = path.basename(filePart.filename).replace(/[^a-zA-Z0-9._\-]/g, '_');
      const uniqueName   = Date.now() + '_' + safeOrigName;
      const destPath     = path.join(UPLOADS_DIR, uniqueName);

      fs.writeFileSync(destPath, filePart.data);
      json(res, 200, { url: '/uploads/' + uniqueName });
    } catch (e) {
      errorResponse(res, 500, 'Erreur upload : ' + e.message);
    }
    return;
  }

  /* ---- GET /api/messages ---- */
  if (urlPath === '/api/messages' && req.method === 'GET') {
    if (!await checkAdminToken(req, res)) return;
    try {
      const msgs = await getMessagesFromDB();
      json(res, 200, msgs);
    } catch (e) {
      errorResponse(res, 500, 'Erreur lecture messages : ' + e.message);
    }
    return;
  }


  /* ---- POST /api/mark-read ---- */
  if (urlPath.endsWith('/mark-read') && req.method === 'POST') {
    if (!await checkAdminToken(req, res)) return;
    try {
      const buf = await readBody(req);
      const { id, lu } = JSON.parse(buf.toString('utf8'));
      const targetLu = (lu !== undefined) ? lu : true;
      
      const success = await markMessageReadInDB(id, targetLu);
      if (success) {
        json(res, 200, { success: true });
      } else {
        json(res, 404, { success: false, message: 'Message non trouvé' });
      }
    } catch (e) {
      errorResponse(res, 500, 'Erreur mise à jour : ' + e.message);
    }
    return;
  }

  /* ---- POST /api/delete-file ---- */
  if (urlPath === '/api/delete-file' && req.method === 'POST') {
    if (!await checkAdminToken(req, res)) return;
    try {
      const buf = await readBody(req);
      const { path: relPath } = JSON.parse(buf.toString('utf8'));
      if (relPath && relPath.startsWith('/uploads/')) {
          const fileName = path.basename(relPath);
          const fullPath = path.join(UPLOADS_DIR, fileName);
          if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
      }
      json(res, 200, { success: true });
    } catch (e) {
      errorResponse(res, 500, 'Erreur suppression : ' + e.message);
    }
    return;
  }
  /* ---- POST /api/contact ---- */
  if (urlPath === '/api/contact' && req.method === 'POST') {
    try {
      const buf = await readBody(req);
      const payload = JSON.parse(buf.toString('utf8'));
      const { nom, email, objet, message } = payload;

      if (!nom || !email || !message) {
        return json(res, 400, { success: false, message: 'Champs obligatoires manquants (nom, email, message)' });
      }

      const newMessage = {
        id: Date.now(),
        date: new Date().toISOString(),
        nom: nom || 'Anonyme',
        email: email || '',
        objet: objet || 'Sans objet',
        message: message || '',
        lu: false
      };

      await addMessageToDB(newMessage);
      json(res, 201, { success: true });
    } catch (e) {
      errorResponse(res, 500, 'Erreur envoi message : ' + e.message);
    }
    return;
  }

  // Route API non trouvée
  console.log(`[API 404] Route inconnue : ${urlPath}`);
  errorResponse(res, 404, 'Route API inconnue');
}

// ── Serveur principal ────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  setCORS(res);

  // Preflight CORS
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const parsedUrl = url.parse(req.url);
  let urlPath     = decodeURIComponent(parsedUrl.pathname || '/');
  
  // Normalisation : enlever le slash final si présent (sauf pour /)
  if (urlPath.length > 1 && urlPath.endsWith('/')) {
    urlPath = urlPath.slice(0, -1);
  }

  try {
    if (urlPath.startsWith('/api')) {
      await handleAPI(req, res, urlPath);
    } else {
      serveStatic(req, res, urlPath);
    }
  } catch (err) {
    console.error('Erreur serveur :', err);
    if (!res.headersSent) {
      errorResponse(res, 500, 'Erreur interne du serveur');
    }
  }
});

// ── Startup ──────────────────────────────────────────────────────────────────
(async () => {
  await connectDB();
  server.listen(PORT, () => {
    console.log(`\n🚀 Portfolio Ludel démarré !`);
    console.log(`   Frontend : http://localhost:${PORT}`);
    console.log(`   Admin    : http://localhost:${PORT}/admin.html`);
    console.log(`   API      : http://localhost:${PORT}/api/data\n`);
  });
})();
