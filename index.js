// index.js
// Requisitos: Node 18+
// Dependências: whatsapp-web.js, qrcode-terminal, express, cors, mongodb, dotenv
// Execução: node index.js

require('dotenv').config();

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const express = require('express');
const cors = require('cors');
const { ObjectId } = require('mongodb');

const { connect, getDb } = require('./db');

// =========================
// CONFIGURAÇÕES
// =========================
const AUTO_OPEN_MEDIA = true; // false se não quiser abrir arquivos automaticamente
const PORT = process.env.PORT || 3000;

// =========================
const CHAT_STATUS = {
  NOVO: 'novo',
  EM_ANDAMENTO: 'em_andamento',
  FINALIZADO: 'finalizado',
};

// =========================
// HELPERS GERAIS
// =========================
function ensureDirSync(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function sanitizeName(name) {
  return String(name || '')
    .replaceAll(/[^a-zA-Z0-9]/g, '')
    .trim();
}

function extFromMime(mime) {
  const map = {
    // Imagens
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif',
    // Vídeo
    'video/mp4': '.mp4',
    'video/3gpp': '.3gp',
    'video/quicktime': '.mov',
    'video/x-matroska': '.mkv',
    // Áudio
    'audio/ogg': '.ogg',
    'audio/opus': '.ogg',
    'audio/mpeg': '.mp3',
    'audio/mp4': '.m4a',
    'audio/aac': '.aac',
    'audio/wav': '.wav',
    // Documentos
    'application/pdf': '.pdf',
    'application/msword': '.doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
    'application/vnd.ms-excel': '.xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
    'text/csv': '.csv',
    'application/vnd.ms-powerpoint': '.ppt',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
    'text/plain': '.txt',
    'application/zip': '.zip',
    'application/x-7z-compressed': '.7z',
    'application/x-rar-compressed': '.rar',
    'application/json': '.json',
  };
  return map[mime] || '';
}

async function saveMediaMessage(msg, chat, whoLabel = 'desconhecido') {
  const media = await msg.downloadMedia();
  if (!media) {
    console.log('[MÍDIA] Não foi possível baixar o conteúdo.');
    return null;
  }

  const date = new Date();
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');

  const baseDir = path.join(
    __dirname,
    'downloads',
    `${yyyy}-${mm}-${dd}`,
    sanitizeName(chat.isGroup ? chat.name : whoLabel)
  );
  ensureDirSync(baseDir);

  const guessedExt = extFromMime(media.mimetype);
  const filenameExt = media.filename ? path.extname(media.filename) : '';
  const ext = guessedExt || filenameExt || '';

  const baseName =
    sanitizeName(media.filename) ||
    `${msg.id.id.slice(-8)}${ext || ''}` ||
    `arquivo_${Date.now()}${ext || ''}`;

  const filePath = path.join(baseDir, baseName.endsWith(ext) ? baseName : baseName + ext);

  const buffer = Buffer.from(media.data, 'base64');
  fs.writeFileSync(filePath, buffer);
  console.log(`[MÍDIA] Salvo em: ${filePath}`);

  return filePath;
}

function nowIso() {
  return new Date().toISOString();
}

function toChatId(inputPhone) {
  if (!inputPhone) return null;
  const digits = String(inputPhone).replace(/[^\d]/g, '');
  if (digits.length < 10) return null;
  return `${digits}@c.us`;
}

function labelForType(type) {
  const map = {
    chat: 'texto',
    image: 'imagem',
    video: 'vídeo',
    audio: 'áudio',
    ptt: 'áudio (PTT)',
    document: 'documento',
    sticker: 'sticker',
    location: 'localização',
    contact: 'contato',
    contacts_array: 'lista de contatos',
    reaction: 'reação',
    unknown: 'desconhecido',
  };
  return map[type] || type || 'desconhecido';
}

async function saveMessage(doc) {
  try {
    const db = getDb();
    await db.collection('messages').insertOne(doc);
  } catch (err) {
    console.error('[DB] Falha ao salvar mensagem:', err?.message || err);
  }
}

function parseBool(v, def = false) {
  if (v == null) return def;
  if (typeof v === 'boolean') return v;
  const s = String(v).toLowerCase();
  return ['1', 'true', 'yes', 'y', 'on'].includes(s);
}

// =========================
// REGRAS DE CHAT (MongoDB)
// =========================
async function getOpenChatByWaChatId(waChatId) {
  const db = getDb();
  return db.collection('chats').findOne({
    waChatId,
    status: { $ne: CHAT_STATUS.FINALIZADO },
  });
}

async function createChatFromMessage({
  waChatId,
  isGroup,
  title,
  participants = [],
  initialStatus,
  firstTs,
}) {
  const db = getDb();
  const doc = {
    waChatId,
    isGroup: !!isGroup,
    title: title || null,
    participants,
    status: initialStatus || CHAT_STATUS.NOVO,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    lastMessageAt: firstTs || new Date(),
  };
  const res = await db.collection('chats').insertOne(doc);
  return { ...doc, _id: res.insertedId };
}

async function updateChatStatus(chatId, newStatus) {
  const db = getDb();
  await db.collection('chats').updateOne(
    { _id: new ObjectId(String(chatId)) },
    { $set: { status: newStatus, updatedAt: nowIso() } }
  );
}

async function touchChat(chatId, ts) {
  const db = getDb();
  await db.collection('chats').updateOne(
    { _id: new ObjectId(String(chatId)) },
    { $set: { lastMessageAt: ts, updatedAt: nowIso() } }
  );
}

async function ensureChat({ msg, chat, contact, direction, ts }) {
  const waChatId = direction === 'inbound' ? msg.from : msg.to;
  const isGroup = chat.isGroup;

  const title = isGroup
    ? chat.name
    : (contact?.pushname || contact?.name || contact?.number || null);

  const participants = [];
  if (isGroup) {
    if (msg.author) participants.push(msg.author);
  } else {
    participants.push(waChatId);
  }

  let chatDoc = await getOpenChatByWaChatId(waChatId);
  if (!chatDoc) {
    const initialStatus =
      direction === 'inbound' ? CHAT_STATUS.NOVO : CHAT_STATUS.EM_ANDAMENTO;

    chatDoc = await createChatFromMessage({
      waChatId,
      isGroup,
      title,
      participants,
      initialStatus,
      firstTs: ts,
    });
  } else {
    await touchChat(chatDoc._id, ts);
  }

  return chatDoc;
}

async function getChatById(id) {
  const db = getDb();
  return db.collection('chats').findOne({ _id: new ObjectId(String(id)) });
}

async function ensureChatByWaChatId(waChatId, { title = null, isGroup = false, ts = new Date() } = {}) {
  let chatDoc = await getOpenChatByWaChatId(waChatId);
  if (!chatDoc) {
    chatDoc = await createChatFromMessage({
      waChatId,
      isGroup,
      title,
      participants: isGroup ? [] : [waChatId],
      initialStatus: CHAT_STATUS.EM_ANDAMENTO,
      firstTs: ts,
    });
  } else {
    await touchChat(chatDoc._id, ts);
    if (chatDoc.status === CHAT_STATUS.NOVO) {
      await updateChatStatus(chatDoc._id, CHAT_STATUS.EM_ANDAMENTO);
      chatDoc.status = CHAT_STATUS.EM_ANDAMENTO;
    }
  }
  return chatDoc;
}

// =========================
// CLIENT WHATSAPP
// =========================
const client = new Client({
  authStrategy: new LocalAuth({ clientId: 'wa-cli' }),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    // Se faltar Chrome/Chromium: npm i puppeteer OU informe executablePath aqui.
  },
});

client.on('qr', (qr) => {
  console.log('\n[QR CODE] Escaneie com o WhatsApp (Menu > Aparelhos conectados):\n');
  qrcode.generate(qr, { small: true });
});

client.on('authenticated', () => console.log('[AUTH] Autenticado!'));
client.on('auth_failure', (m) => console.error('[AUTH ERROR]', m));
client.on('ready', () => {
  console.log('[READY] WhatsApp pronto. Você pode enviar mensagens pelo terminal:');
  console.log('Formato: +55DDDNÚMERO >> "sua mensagem"');
  console.log('Ex.: +5588999999999 >> "Olá, deu certo!"\n');
});

// =========================
// MENSAGENS RECEBIDAS
// =========================
client.on('message', async (msg) => {
  try {
    const chat = await msg.getChat();
    const contact = await msg.getContact();

    if(msg.type==="notification_template")
      return

    const who =
      contact?.pushname ||
      contact?.name ||
      contact?.number ||
      msg.author ||
      msg.from;

    const isGroup = chat.isGroup;
    const chatName = isGroup ? chat.name : null;
    const type = msg.type || 'unknown';
    const typeLabel = labelForType(type);
    const ts = typeof msg.timestamp === 'number'
      ? new Date(msg.timestamp * 1000)
      : new Date();

    // garante/associa chat (INBOUND)
    const chatDoc = await ensureChat({
      msg,
      chat,
      contact,
      direction: 'inbound',
      ts,
    });

    if (type === 'chat') {
      console.log(`\n[Msg recebida] De: ${who}${isGroup ? ` (grupo: ${chatName})` : ''}`);
      console.log(`Conteúdo: ${msg.body}`);

      await saveMessage({
        waMessageId: msg.id?._serialized || msg.id?.id || null,
        chatRefId: chatDoc._id,
        direction: 'inbound',
        chatId: msg.from,
        isGroup,
        chatName,
        from: msg.author || msg.from,
        to: msg.to || null,
        authorDisplay: who,
        type: 'chat',
        body: msg.body,
        caption: null,
        media: null,
        timestamp: ts,
        receivedAt: nowIso(),
      });
      return;
    }

    console.log(`\n[Arquivo recebido] De: ${who}${isGroup ? ` (grupo: ${chatName})` : ''}`);
    console.log(`Tipo: ${typeLabel}${msg.caption ? ` | Legenda: ${msg.caption}` : ''}`);

    let savedPath = null;
    if (['image', 'audio', 'ptt', 'video', 'document'].includes(type)) {
      savedPath = await saveMediaMessage(msg, chat, msg.from);
    }

    await saveMessage({
      waMessageId: msg.id?._serialized || msg.id?.id || null,
      chatRefId: chatDoc._id,
      direction: 'inbound',
      chatId: msg.from,
      isGroup,
      chatName,
      from: msg.author || msg.from,
      to: msg.to || null,
      authorDisplay: who,
      type,
      body: null,
      caption: msg.caption || null,
      media: savedPath
        ? {
            savedPath,
            mimetype: msg._data?.mimetype || null,
            filename: msg._data?.filename || null,
          }
        : null,
      timestamp: ts,
      receivedAt: nowIso(),
    });
  } catch (err) {
    console.error('[ERRO message handler]', err);
  }
});

// =========================
// MENSAGENS ENVIADAS
// =========================
client.on('message_create', async (msg) => {
  try {
    if (!msg.fromMe) return;

    const chat = await msg.getChat();
    const isGroup = chat.isGroup;
    const chatName = isGroup ? chat.name : null;

    let destinoNome = '';
    if (isGroup) {
      destinoNome = chat.name;
    } else {
      const contato = await chat.getContact();
      destinoNome =
        contato?.pushname ||
        contato?.name ||
        contato?.number ||
        msg.to;
    }

    const type = msg.type || 'unknown';
    const typeLabel = labelForType(type);
    const ts = typeof msg.timestamp === 'number'
      ? new Date(msg.timestamp * 1000)
      : new Date();

    // garante/associa chat (OUTBOUND)
    const chatDoc = await ensureChat({
      msg,
      chat,
      contact: null,
      direction: 'outbound',
      ts,
    });

    // se estava NOVO e eu enviei msg, vira EM_ANDAMENTO
    if (chatDoc.status === CHAT_STATUS.NOVO) {
      await updateChatStatus(chatDoc._id, CHAT_STATUS.EM_ANDAMENTO);
      chatDoc.status = CHAT_STATUS.EM_ANDAMENTO;
    }

    if (type === 'chat') {
      console.log(`mensagem enviada para ${destinoNome} >> ${msg.body}`);

      await saveMessage({
        waMessageId: msg.id?._serialized || msg.id?.id || null,
        chatRefId: chatDoc._id,
        direction: 'outbound',
        chatId: msg.to,
        isGroup,
        chatName,
        from: msg.from,
        to: msg.to,
        authorDisplay: 'me',
        type: 'chat',
        body: msg.body,
        caption: null,
        media: null,
        timestamp: ts,
        sentAt: nowIso(),
      });
      return;
    }

    const legenda = msg.caption ? ` >> ${msg.caption}` : '';
    console.log(`${typeLabel} enviada para ${destinoNome}${legenda}`);

    let savedPath = null;
    if (['image', 'audio', 'ptt', 'video', 'document'].includes(type)) {
      try {
        savedPath = await saveMediaMessage(msg, chat, msg.from);
      } catch (e) {
        console.warn('[MÍDIA OUTBOUND] Não foi possível baixar/abrir a mídia enviada:', e?.message || e);
      }
    }

    await saveMessage({
      waMessageId: msg.id?._serialized || msg.id?.id || null,
      chatRefId: chatDoc._id,
      direction: 'outbound',
      chatId: msg.to,
      isGroup,
      chatName,
      from: msg.from,
      to: msg.to,
      authorDisplay: 'me',
      type,
      body: null,
      caption: msg.caption || null,
      media: savedPath
        ? {
            savedPath,
            mimetype: msg._data?.mimetype || null,
            filename: msg._data?.filename || null,
          }
        : null,
      timestamp: ts,
      sentAt: nowIso(),
    });
  } catch (err) {
    console.error('[ERRO message_create]', err);
  }
});

// =========================
// ENVIO PELO TERMINAL
// =========================
process.stdin.setEncoding('utf8');
process.stdin.on('data', async (chunk) => {
  const lines = chunk.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    if (/^(exit|quit)$/i.test(line)) {
      console.log('Saindo...');
      try { await client.destroy(); } catch {}
      process.exit(0);
    }

    // +5588999999999 >> "mensagem"
    const pattern = /^\s*([+]?[\d\s\-\(\)]+)\s*>>\s*(?:"([^"]+)"|(.+))\s*$/;
    const m = line.match(pattern);
    if (!m) {
      console.log('Formato inválido. Use: +55DDDNÚMERO >> "mensagem"  (ou digite exit para sair)');
      continue;
    }

    const phoneRaw = m[1]?.trim();
    const message = (m[2] ?? m[3] ?? '').trim();
    const waChatId = toChatId(phoneRaw);
    if (!waChatId) {
      console.log('Número inválido.');
      continue;
    }

    try {
      await client.sendMessage(waChatId, message);
      console.log(`[ENVIADO] Para ${waChatId}: ${message}`);
    } catch (err) {
      console.error('[ERRO ao enviar]', err?.message || err);
    }
  }
});

// =========================
function startHttpServer() {
  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get('/health', (req, res) => {
    res.json({ ok: true, status: 'up' });
  });

  // --------- NOVA ROTA: LISTAR CHATS COM FILTRO DE STATUS ---------
  // GET /chats?status=novo,em_andamento&q=texto&limit=50
  app.get('/chats', async (req, res) => {
    try {
      const db = getDb();
      const limit = Math.min(Number(req.query.limit) || 50, 200);

      const rawStatus = (req.query.status || '').trim();
      const statusList = rawStatus
        ? rawStatus.split(',').map(s => s.trim()).filter(Boolean)
        : null;

      const q = (req.query.q || '').trim();

      const filter = {};
      if (statusList && statusList.length) {
        filter.status = { $in: statusList };
      }
      if (q) {
        filter.title = { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
      }

      const docs = await db.collection('chats')
        .find(filter)
        .sort({ lastMessageAt: -1 })
        .limit(limit)
        .toArray();

      res.json({ ok: true, data: docs, filter });
    } catch (err) {
      console.error('[HTTP] /chats', err);
      res.status(500).json({ ok: false, error: 'failed_list_chats' });
    }
  });

  // --------- ROTA EXISTENTE: LISTAR ABERTOS ---------
  app.get('/chats/open', async (req, res) => {
    try {
      const db = getDb();
      const limit = Math.min(Number(req.query.limit) || 50, 200);

      const docs = await db.collection('chats')
        .find({ status: { $ne: CHAT_STATUS.FINALIZADO } })
        .sort({ lastMessageAt: -1 })
        .limit(limit)
        .toArray();

      res.json({ ok: true, data: docs });
    } catch (err) {
      console.error('[HTTP] /chats/open', err);
      res.status(500).json({ ok: false, error: 'failed_list_open_chats' });
    }
  });

  // --------- NOVA ROTA: LISTAR MENSAGENS DE UM CHAT ---------
  // GET /chats/:id/messages?limit=50&beforeId=...&since=ISO&until=ISO&direction=inbound&type=image&mediaOnly=true
  app.get('/chats/:id/messages', async (req, res) => {
    try {
      const db = getDb();
      const { id } = req.params;
      if (!ObjectId.isValid(id)) {
        return res.status(400).json({ ok: false, error: 'invalid_chat_id' });
      }
      const chatRefId = new ObjectId(String(id));

      const limit = Math.min(Number(req.query.limit) || 50, 200);
      const beforeId = req.query.beforeId && ObjectId.isValid(req.query.beforeId)
        ? new ObjectId(String(req.query.beforeId))
        : null;

      const sinceRaw = req.query.since ? new Date(req.query.since) : null;
      const untilRaw = req.query.until ? new Date(req.query.until) : null;

      const direction = (req.query.direction || '').trim();
      const type = (req.query.type || '').trim();
      const mediaOnly = parseBool(req.query.mediaOnly, false);

      const filter = { chatRefId };

      if (beforeId) filter._id = { $lt: beforeId };

      if (sinceRaw || untilRaw) {
        filter.timestamp = {};
        if (sinceRaw && !isNaN(sinceRaw.getTime())) filter.timestamp.$gte = sinceRaw;
        if (untilRaw && !isNaN(untilRaw.getTime())) filter.timestamp.$lte = untilRaw;
        if (!Object.keys(filter.timestamp).length) delete filter.timestamp;
      }

      if (direction === 'inbound' || direction === 'outbound') filter.direction = direction;
      if (type) filter.type = type;
      if (mediaOnly) filter.media = { $ne: null };

      const items = await db.collection('messages')
        .find(filter)
        .sort({ _id: -1 })
        .limit(limit)
        .toArray();

      const nextCursor = items.length ? String(items[items.length - 1]._id) : null;

      res.json({
        ok: true,
        data: items,
        pageInfo: { limit, nextCursor },
        filter,
      });
    } catch (err) {
      console.error('[HTTP] /chats/:id/messages', err);
      res.status(500).json({ ok: false, error: 'failed_list_messages' });
    }
  });

  // --------- FINALIZAR CHAT ---------
  app.post('/chats/:id/finish', async (req, res) => {
    try {
      const id = req.params.id;
      const chat = await getChatById(id);
      if (!chat) return res.status(404).json({ ok: false, error: 'chat_not_found' });

      await updateChatStatus(chat._id, CHAT_STATUS.FINALIZADO);
      res.json({ ok: true, data: { _id: chat._id, status: CHAT_STATUS.FINALIZADO } });
    } catch (err) {
      console.error('[HTTP] /chats/:id/finish', err);
      res.status(500).json({ ok: false, error: 'failed_finish_chat' });
    }
  });

  // --------- ENVIAR MENSAGEM ---------
  // body: { chatId?: string, phoneNumber?: string, message: string }
  app.post('/messages/send', async (req, res) => {
    try {
      const { chatId, phoneNumber, message } = req.body || {};
      if (!message || (!chatId && !phoneNumber)) {
        return res.status(400).json({
          ok: false,
          error: 'invalid_payload',
          hint: 'Envie { chatId, message } ou { phoneNumber, message }'
        });
      }

      let waChatId;
      let chatDoc;

      if (chatId) {
        chatDoc = await getChatById(chatId);
        if (!chatDoc) return res.status(404).json({ ok: false, error: 'chat_not_found' });
        if (chatDoc.status === CHAT_STATUS.FINALIZADO) {
          return res.status(409).json({ ok: false, error: 'chat_finalizado' });
        }
        waChatId = chatDoc.waChatId;
      } else {
        waChatId = toChatId(phoneNumber);
        if (!waChatId) {
          return res.status(400).json({ ok: false, error: 'invalid_phone_number' });
        }
        chatDoc = await ensureChatByWaChatId(waChatId, {
          title: null,
          isGroup: waChatId.endsWith('@g.us'),
          ts: new Date(),
        });
      }

      await client.sendMessage(waChatId, message);

      res.json({
        ok: true,
        data: {
          chatId: String(chatDoc._id),
          waChatId,
          status: chatDoc.status,
          messagePreview: message.slice(0, 200),
        },
      });
    } catch (err) {
      console.error('[HTTP] /messages/send', err);
      res.status(500).json({ ok: false, error: 'failed_send_message' });
    }
  });

  app.listen(PORT, () => {
    console.log(`[HTTP] API escutando em http://localhost:${PORT}`);
  });
}

// =========================
// BOOTSTRAP
// =========================
(async () => {
  try {
    await connect(); // MongoDB
    client.initialize(); // WhatsApp
    startHttpServer(); // HTTP API
  } catch (err) {
    console.error('[BOOT] Erro ao iniciar aplicação:', err);
    process.exit(1);
  }
})();
