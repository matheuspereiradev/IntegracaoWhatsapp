import 'dotenv/config';

import { Client, LocalAuth, MessageMedia } from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';
import fs from 'fs';
import path from 'path';
import express, { Request, Response } from 'express';
import cors from 'cors';
import multer from 'multer';
import { ObjectId, Db } from 'mongodb';

// Tipagem do seu módulo db.js (ver db.d.ts)
import { connect, getDb } from './db';

// =========================
// CONFIGURAÇÕES
// =========================
const PORT: number = Number(process.env.PORT) || 3000;

// =========================
const CHAT_STATUS = {
  NOVO: 'novo',
  EM_ANDAMENTO: 'em_andamento',
  FINALIZADO: 'finalizado',
} as const;

type ChatStatus = typeof CHAT_STATUS[keyof typeof CHAT_STATUS];

type SavedMedia = {
  savedPath: string;
  mimetype: string | null;
  filename: string | null;
} | null;

type SavedMessageDoc = {
  _id?: ObjectId;
  waMessageId: string | null;
  chatRefId: ObjectId;
  direction: 'inbound' | 'outbound';
  chatId: string;
  isGroup: boolean;
  chatName: string | null;
  from: string | null;
  to: string | null;
  authorDisplay: string;
  type: string;
  body: string | null;
  caption: string | null;
  media: SavedMedia;
  timestamp: Date;
  receivedAt?: string;
  sentAt?: string;
};

type ChatDoc = {
  _id?: ObjectId;
  waChatId: string;
  isGroup: boolean;
  title: string | null;
  participants: string[];
  status: ChatStatus;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: Date;
};

// =========================
// HELPERS GERAIS
// =========================
function ensureDirSync(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function sanitizeName(name: string): string {
  return String(name || '')
    .replaceAll(/[^a-zA-Z0-9]/g, '')
    .trim();
}

function extFromMime(mime: string | undefined): string {
  const map: Record<string, string> = {
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
  return mime ? (map[mime] || '') : '';
}

async function saveMediaMessage(msg: any, chat: any, whoLabel: string = 'desconhecido'): Promise<string | null> {
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

function nowIso(): string {
  return new Date().toISOString();
}

function toChatId(inputPhone?: string | null): string | null {
  if (!inputPhone) return null;
  const digits = String(inputPhone).replace(/[^\d]/g, '');
  if (digits.length < 10) return null;
  return `${digits}@c.us`;
}

function labelForType(type?: string): string {
  const map: Record<string, string> = {
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
  return (type && map[type]) || type || 'desconhecido';
}

async function saveMessage(doc: SavedMessageDoc): Promise<void> {
  try {
    const db: Db = getDb();
    await db.collection('messages').insertOne(doc);
  } catch (err: any) {
    console.error('[DB] Falha ao salvar mensagem:', err?.message || err);
  }
}

function parseBool(v: unknown, def: boolean = false): boolean {
  if (v == null) return def;
  if (typeof v === 'boolean') return v;
  const s = String(v).toLowerCase();
  return ['1', 'true', 'yes', 'y', 'on'].includes(s);
}

// =========================
async function getOpenChatByWaChatId(waChatId: string): Promise<ChatDoc | null> {
  const db: Db = getDb();
  return db.collection<ChatDoc>('chats').findOne({
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
}: {
  waChatId: string;
  isGroup: boolean;
  title: string | null;
  participants?: string[];
  initialStatus?: ChatStatus;
  firstTs?: Date;
}): Promise<ChatDoc> {
  const db: Db = getDb();
  const doc: ChatDoc = {
    waChatId,
    isGroup: !!isGroup,
    title: title || null,
    participants,
    status: initialStatus || CHAT_STATUS.NOVO,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    lastMessageAt: firstTs || new Date(),
  };
  const res = await db.collection<ChatDoc>('chats').insertOne(doc);
  return { ...doc, _id: res.insertedId };
}

async function updateChatStatus(chatId: ObjectId | string, newStatus: ChatStatus): Promise<void> {
  const db: Db = getDb();
  await db.collection('chats').updateOne(
    { _id: new ObjectId(String(chatId)) },
    { $set: { status: newStatus, updatedAt: nowIso() } }
  );
}

async function touchChat(chatId: ObjectId | string, ts: Date): Promise<void> {
  const db: Db = getDb();
  await db.collection('chats').updateOne(
    { _id: new ObjectId(String(chatId)) },
    { $set: { lastMessageAt: ts, updatedAt: nowIso() } }
  );
}

async function ensureChat({
  msg,
  chat,
  contact,
  direction,
  ts,
}: {
  msg: any;
  chat: any;
  contact: any;
  direction: 'inbound' | 'outbound';
  ts: Date;
}): Promise<ChatDoc> {
  const waChatId: string = direction === 'inbound' ? msg.from : msg.to;
  const isGroup: boolean = chat.isGroup;

  const title: string | null = isGroup
    ? chat.name
    : (contact?.pushname || contact?.name || contact?.number || null);

  const participants: string[] = [];
  if (isGroup) {
    if (msg.author) participants.push(msg.author);
  } else {
    participants.push(waChatId);
  }

  let chatDoc = await getOpenChatByWaChatId(waChatId);
  if (!chatDoc) {
    const initialStatus: ChatStatus =
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
    await touchChat(chatDoc._id!, ts);
  }

  return chatDoc;
}

async function getChatById(id: ObjectId | string): Promise<ChatDoc | null> {
  const db: Db = getDb();
  return db.collection<ChatDoc>('chats').findOne({ _id: new ObjectId(String(id)) });
}

async function ensureChatByWaChatId(
  waChatId: string,
  { title = null, isGroup = false, ts = new Date() }: { title?: string | null; isGroup?: boolean; ts?: Date } = {}
): Promise<ChatDoc> {
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
    await touchChat(chatDoc._id!, ts);
    if (chatDoc.status === CHAT_STATUS.NOVO) {
      await updateChatStatus(chatDoc._id!, CHAT_STATUS.EM_ANDAMENTO);
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

client.on('qr', (qr: string) => {
  console.log('\n[QR CODE] Escaneie com o WhatsApp (Menu > Aparelhos conectados):\n');
  qrcode.generate(qr, { small: true });
});

client.on('authenticated', () => console.log('[AUTH] Autenticado!'));
client.on('auth_failure', (m: any) => console.error('[AUTH ERROR]', m));
client.on('ready', () => {
  console.log('[READY] WhatsApp pronto. Você pode enviar mensagens pelo terminal:');
  console.log('Formato: +55DDDNÚMERO >> "sua mensagem"');
  console.log('Ex.: +5588999999999 >> "Olá, deu certo!"\n');
});

// =========================
// MENSAGENS RECEBIDAS
// =========================
client.on('message', async (msg: any) => {
  try {
    const chat = await msg.getChat();
    const contact = await msg.getContact();

    if (msg.type === 'notification_template') return;

    const who: string =
      contact?.pushname ||
      contact?.name ||
      contact?.number ||
      msg.author ||
      msg.from;

    const isGroup: boolean = chat.isGroup;
    const chatName: string | null = isGroup ? chat.name : null;
    const type: string = msg.type || 'unknown';
    const typeLabel = labelForType(type);
    const ts: Date = typeof msg.timestamp === 'number'
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
        chatRefId: chatDoc._id!,
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

    let savedPath: string | null = null;
    if (['image', 'audio', 'ptt', 'video', 'document'].includes(type)) {
      savedPath = await saveMediaMessage(msg, chat, msg.from);
    }

    await saveMessage({
      waMessageId: msg.id?._serialized || msg.id?.id || null,
      chatRefId: chatDoc._id!,
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
client.on('message_create', async (msg: any) => {
  try {
    if (!msg.fromMe) return;

    const chat = await msg.getChat();
    const isGroup: boolean = chat.isGroup;
    const chatName: string | null = isGroup ? chat.name : null;

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

    const type: string = msg.type || 'unknown';
    const typeLabel = labelForType(type);
    const ts: Date = typeof msg.timestamp === 'number'
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
      await updateChatStatus(chatDoc._id!, CHAT_STATUS.EM_ANDAMENTO);
      chatDoc.status = CHAT_STATUS.EM_ANDAMENTO;
    }

    if (type === 'chat') {
      console.log(`mensagem enviada para ${destinoNome} >> ${msg.body}`);

      await saveMessage({
        waMessageId: msg.id?._serialized || msg.id?.id || null,
        chatRefId: chatDoc._id!,
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

    let savedPath: string | null = null;
    if (['image', 'audio', 'ptt', 'video', 'document'].includes(type)) {
      try {
        savedPath = await saveMediaMessage(msg, chat, msg.from);
      } catch (e: any) {
        console.warn('[MÍDIA OUTBOUND] Não foi possível baixar/abrir a mídia enviada:', e?.message || e);
      }
    }

    await saveMessage({
      waMessageId: msg.id?._serialized || msg.id?.id || null,
      chatRefId: chatDoc._id!,
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
process.stdin.on('data', async (chunk: string) => {
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
    } catch (err: any) {
      console.error('[ERRO ao enviar]', err?.message || err);
    }
  }
});

// =========================
// API HTTP
// =========================
function startHttpServer(): void {
  const app = express();
  app.use(cors());
  app.use(express.json());

  // --- Upload em memória para enviar mídias ---
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024 } // 50 MB
  });

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ ok: true, status: 'up' });
  });

  // LISTAR CHATS (filtro de status/q)
  app.get('/chats', async (req: Request, res: Response) => {
    try {
      const db: Db = getDb();
      const limit = Math.min(Number(req.query.limit) || 50, 200);

      const rawStatus = String(req.query.status || '').trim();
      const statusList = rawStatus
        ? rawStatus.split(',').map(s => s.trim()).filter(Boolean)
        : null;

      const q = String(req.query.q || '').trim();

      const filter: any = {};
      if (statusList && statusList.length) {
        filter.status = { $in: statusList };
      }
      if (q) {
        filter.title = { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
      }

      const docs = await db.collection<ChatDoc>('chats')
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

  // LISTAR ABERTOS
  app.get('/chats/open', async (req: Request, res: Response) => {
    try {
      const db: Db = getDb();
      const limit = Math.min(Number(req.query.limit) || 50, 200);

      const docs = await db.collection<ChatDoc>('chats')
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

  // LISTAR MENSAGENS DO CHAT
  app.get('/chats/:id/messages', async (req: Request, res: Response) => {
    try {
      const db: Db = getDb();
      const { id } = req.params;
      if (!ObjectId.isValid(id)) {
        return res.status(400).json({ ok: false, error: 'invalid_chat_id' });
        }
      const chatRefId = new ObjectId(String(id));

      const limit = Math.min(Number(req.query.limit) || 50, 200);
      const beforeId = req.query.beforeId && ObjectId.isValid(String(req.query.beforeId))
        ? new ObjectId(String(req.query.beforeId))
        : null;

      const sinceRaw = req.query.since ? new Date(String(req.query.since)) : null;
      const untilRaw = req.query.until ? new Date(String(req.query.until)) : null;

      const direction = String(req.query.direction || '').trim();
      const type = String(req.query.type || '').trim();
      const mediaOnly = parseBool(req.query.mediaOnly, false);

      const filter: any = { chatRefId };

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

      const items = await db.collection<SavedMessageDoc>('messages')
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

  // FINALIZAR CHAT
  app.post('/chats/:id/finish', async (req: Request, res: Response) => {
    try {
      const id = req.params.id;
      const chat = await getChatById(id);
      if (!chat) return res.status(404).json({ ok: false, error: 'chat_not_found' });

      await updateChatStatus(chat._id!, CHAT_STATUS.FINALIZADO);
      res.json({ ok: true, data: { _id: chat._id, status: CHAT_STATUS.FINALIZADO } });
    } catch (err) {
      console.error('[HTTP] /chats/:id/finish', err);
      res.status(500).json({ ok: false, error: 'failed_finish_chat' });
    }
  });

  // ENVIAR TEXTO
  app.post('/messages/send', async (req: Request, res: Response) => {
    try {
      const { chatId, phoneNumber, message } = req.body || {};
      if (!message || (!chatId && !phoneNumber)) {
        return res.status(400).json({
          ok: false,
          error: 'invalid_payload',
          hint: 'Envie { chatId, message } ou { phoneNumber, message }'
        });
      }

      let waChatId: string | null;
      let chatDoc: ChatDoc | null;

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

      await client.sendMessage(waChatId!, message);

      res.json({
        ok: true,
        data: {
          chatId: String((chatDoc as ChatDoc)._id),
          waChatId,
          status: (chatDoc as ChatDoc).status,
          messagePreview: message.slice(0, 200),
        },
      });
    } catch (err) {
      console.error('[HTTP] /messages/send', err);
      res.status(500).json({ ok: false, error: 'failed_send_message' });
    }
  });

  // ============== ENVIAR MÍDIA (upload) ==============
  app.post('/messages/send-media', upload.single('file'), async (req: Request, res: Response) => {
    try {
      const { chatId, phoneNumber, caption, forceDocument, voice } = (req.body || {}) as Record<string, any>;
      const file = (req as any).file as Express.Multer.File | undefined;

      if (!file) {
        return res.status(400).json({ ok: false, error: 'file_required' });
      }
      if (!chatId && !phoneNumber) {
        return res.status(400).json({ ok: false, error: 'chat_or_phone_required' });
      }

      let waChatId: string | null;
      let chatDoc: ChatDoc | null;

      if (chatId) {
        chatDoc = await getChatById(chatId);
        if (!chatDoc) return res.status(404).json({ ok: false, error: 'chat_not_found' });
        if (chatDoc.status === CHAT_STATUS.FINALIZADO) {
          return res.status(409).json({ ok: false, error: 'chat_finalizado' });
        }
        waChatId = chatDoc.waChatId;
      } else {
        waChatId = toChatId(phoneNumber);
        if (!waChatId) return res.status(400).json({ ok: false, error: 'invalid_phone_number' });
        chatDoc = await ensureChatByWaChatId(waChatId, {
          isGroup: waChatId.endsWith('@g.us'),
          ts: new Date(),
        });
      }

      const b64 = file.buffer.toString('base64');
      const media = new MessageMedia(file.mimetype, b64, file.originalname);

      const options: any = {};
      if (caption) options.caption = caption;
      if (parseBool(forceDocument, false)) options.sendMediaAsDocument = true;
      if (parseBool(voice, false) && file.mimetype?.startsWith('audio/')) options.sendAudioAsVoice = true;

      await client.sendMessage(waChatId!, media, options);

      res.json({
        ok: true,
        data: {
          chatId: String((chatDoc as ChatDoc)._id),
          waChatId,
          status: (chatDoc as ChatDoc).status,
          filename: file.originalname,
          mimetype: file.mimetype,
          size: file.size,
          caption: caption || null,
          asDocument: !!options.sendMediaAsDocument,
          asVoice: !!options.sendAudioAsVoice,
        },
      });
    } catch (err) {
      console.error('[HTTP] /messages/send-media', err);
      res.status(500).json({ ok: false, error: 'failed_send_media' });
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
