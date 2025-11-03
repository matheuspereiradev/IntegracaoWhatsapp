import 'dotenv/config';

import { Client, LocalAuth, MessageMedia } from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';
import express, { Request, Response } from 'express';
import cors from 'cors';
import multer from 'multer';
import { ObjectId, Db } from 'mongodb';

// Tipagem do seu módulo db.js (ver db.d.ts)
import { connect, getDb } from './db';
import { labelForType, mapMulterFilesToNodemailerAttachments, nowIso, parseBool, saveMediaMessage, toChatId } from './utils';
import { CHAT_STATUS, ChatDoc, ChatStatus, SavedMessageDoc } from './types';
import { ensureChat, ensureChatByWaChatId, getChatById, saveMessage, updateChatStatus } from './models';
import { createImapConfigCopy, createTransporter, saveAttachments } from './gmail';
import { ParsedMail, simpleParser } from 'mailparser';
import { SendMailOptions, Transporter } from 'nodemailer';
const Imap: any = require('node-imap');

// =========================
// GLOBAL GMAIL
// =========================

let globalImapInbox: any = null;
let transporterGlobal: Transporter | null = null;

// =========================
// CLIENT WHATSAPP
// =========================
const client = new Client({
  authStrategy: new LocalAuth({ clientId: 'wa-cli' }),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
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


//



// =========================
// MENSAGENS RECEBIDAS GMAIL
// =========================
function fetchMessageByUid(uid: string | number): Promise<ParsedMail> {
  return new Promise((resolve, reject) => {
    if (!globalImapInbox) return reject(new Error('IMAP INBOX não inicializado ainda'));
    globalImapInbox.search([['UID', uid]], (err: any, results: number[]) => {
      if (err) return reject(err);
      if (!results || !results.length) return reject(new Error('UID não encontrado'));
      const fetcher = globalImapInbox.fetch(results, { bodies: '' });
      fetcher.on('message', (msg: any) => {
        let raw = '';
        msg.on('body', (stream: NodeJS.ReadableStream) => {
          stream.on('data', (chunk: Buffer) => raw += chunk.toString('utf8'));
        });
        msg.once('end', async () => {
          try {
            const parsed = await simpleParser(raw);
            resolve(parsed);
          } catch (e) {
            reject(e);
          }
        });
      });
      fetcher.once('error', (e: any) => reject(e));
    });
  });
}

function fetchMessageByMessageId(messageId: string): Promise<ParsedMail> {
  return new Promise((resolve, reject) => {
    if (!globalImapInbox) return reject(new Error('IMAP INBOX não inicializado ainda'));
    const q = messageId.replace(/^<|>$/g, '');
    globalImapInbox.search([['HEADER', 'Message-ID', q]], (err: any, results: number[]) => {
      if (err) return reject(err);
      if (!results || !results.length) return reject(new Error('Message-ID não encontrado'));
      const fetcher = globalImapInbox.fetch(results, { bodies: '' });
      fetcher.on('message', (msg: any) => {
        let raw = '';
        msg.on('body', (stream: NodeJS.ReadableStream) => {
          stream.on('data', (chunk: Buffer) => raw += chunk.toString('utf8'));
        });
        msg.once('end', async () => {
          try {
            const parsed = await simpleParser(raw);
            resolve(parsed);
          } catch (e) {
            reject(e);
          }
        });
      });
      fetcher.once('error', (e: any) => reject(e));
    });
  });
}


async function connectImapInboxListener(onNewMail?: (args: any) => void): Promise<any> {
  const imapConfigBase = createImapConfigCopy();
  let lastSeenUid = 0;

  async function buildImap(): Promise<any> {
    const imapConfig = { ...imapConfigBase };
    const imap = new Imap(imapConfig);

    imap.once('ready', () => {
      console.log('[IMAP-INBOX] conectado. Abrindo INBOX...');
      imap.openBox('INBOX', false, (err: any, box: any) => {
        if (err) {
          console.error('[IMAP-INBOX] erro ao abrir INBOX:', err);
          return;
        }
        lastSeenUid = (box.uidnext && Number(box.uidnext) > 0) ? Number(box.uidnext) - 1 : 0;
        console.log('[IMAP-INBOX] INBOX aberta. Mensagens na caixa:', box.messages.total);
        console.log('[IMAP-INBOX] ignorando mensagens antigas. lastSeenUid inicial:', lastSeenUid);
        globalImapInbox = imap;
      });
    });

    imap.on('mail', (numNewMsgs: number) => {
      console.log(`[IMAP-INBOX] Evento 'mail' recebido. Indicação de novas mensagens: ${numNewMsgs}`);
      imap.search(['UNSEEN'], (err: any, results: number[]) => {
        if (err) {
          console.error('[IMAP-INBOX] erro na busca:', err);
          return;
        }
        if (!results || !results.length) return;

        const newUids = results
          .map(r => Number(r))
          .filter(uid => uid > lastSeenUid)
          .sort((a, b) => a - b);

        if (!newUids.length) return;

        lastSeenUid = Math.max(lastSeenUid, ...newUids);

        const fetcher = imap.fetch(newUids, { bodies: '', markSeen: true });
        fetcher.on('message', (msg: any) => {
          let raw = '';
          let attributes: any = null;
          msg.on('body', (stream: NodeJS.ReadableStream) => {
            stream.on('data', (chunk: Buffer) => raw += chunk.toString('utf8'));
          });
          msg.once('attributes', (attrs: any) => attributes = attrs);
          msg.once('end', async () => {
            try {
              const parsed: ParsedMail = await simpleParser(raw);
              const from = parsed.from?.text || (parsed.from?.value?.map((v: any) => v.address).join(', ')) || '(remetente desconhecido)';
              const subject = parsed.subject || '(sem assunto)';
              const text = parsed.text || parsed.html || '';
              const attachmentsCount = parsed.attachments ? parsed.attachments.length : 0;
              const messageId = parsed.messageId || (attributes && attributes['uid']) || 'unknown';
              const uid = attributes && attributes.uid;

              const inReplyTo = (parsed.inReplyTo as string) || (parsed.references && parsed.references.length ? parsed.references[0] : null);
              const threadLabel = inReplyTo ? `[RESPOSTA ${inReplyTo}]` : '[NOVO]';

              console.log(`--- ${threadLabel} ---`);
              console.log('UID:', uid);
              console.log('Message-ID:', messageId);
              console.log('Remetente:', from);
              console.log('Assunto:', subject);
              console.log('Corpo (texto curto):', (text && (text as string).substring(0, 1000)) || '(vazio)');
              console.log('Quantidade de anexos:', attachmentsCount);
              console.log('----------------------------');

              if (attachmentsCount > 0 && parsed.attachments) {
                try {
                  await saveAttachments(parsed.attachments, uid);
                } catch (e) {
                  console.error('[IMAP-INBOX/ANEXOS] erro ao salvar anexos:', e);
                }
              }

              if (onNewMail) onNewMail({ parsed, attributes });
            } catch (parseErr) {
              console.error('[IMAP-INBOX] erro ao parsear mensagem:', parseErr);
            }
          });
        });
        fetcher.once('error', (err: any) => console.error('[IMAP-INBOX] fetch error:', err));
      });
    });

    imap.on('error', (err: any) => console.error('[IMAP-INBOX] erro:', err));
    imap.on('end', () => {
      console.log('[IMAP-INBOX] conexão encerrada. Tentarei reconectar em 5s...');
      setTimeout(() => buildImap().catch((e) => console.error('[IMAP-INBOX] falha ao reconectar:', e)), 5000);
    });

    imap.connect();
    return imap;
  }

  return buildImap();
}


async function connectSentListener(): Promise<any> {
  const imapConfigBase = createImapConfigCopy();
  let lastSentUid = 0;

  async function buildImapSent(): Promise<any> {
    const imapConfig = { ...imapConfigBase };
    const imapSent = new Imap(imapConfig);

    imapSent.once('ready', () => {
      imapSent.getBoxes((err: any, boxes: any) => {
        if (err) {
          console.error('[IMAP-SENT] erro ao listar pastas:', err);
          return;
        }

        function flattenBoxes(obj: any, prefix = ''): { name: string; attribs: string[]; boxObj: any }[] {
          const results: { name: string; attribs: string[]; boxObj: any }[] = [];
          for (const name of Object.keys(obj)) {
            const box = obj[name];
            const delim = box.delimiter || '/';
            const fullName = prefix ? `${prefix}${delim}${name}` : name;
            results.push({ name: fullName, attribs: box.attribs || [], boxObj: box });
            if (box.children) {
              results.push(...flattenBoxes(box.children, fullName));
            }
          }
          return results;
        }

        const flat = flattenBoxes(boxes);
        let chosen = flat.find(b => (b.attribs || []).some(a => String(a).toLowerCase().includes('\\sent')));
        if (!chosen) chosen = flat.find(b => b.name.toLowerCase().includes('sent'));

        if (!chosen) {
          console.warn('[IMAP-SENT] não foi encontrada automaticamente uma pasta "Sent". Lista de pastas disponíveis:');
          for (const b of flat) {
            console.log(' -', b.name, 'attribs=', b.attribs && b.attribs.join ? b.attribs.join(',') : b.attribs);
          }
          console.error('[IMAP-SENT] escolha manualmente o nome da pasta Sent (ex.: "[Gmail]/Sent Mail") e atualize o script ou me diga para eu ajustar.');
          return;
        }

        imapSent.openBox(chosen.name, false, (errOpen: any, box: any) => {
          if (errOpen) {
            console.error(`[IMAP-SENT] erro ao abrir a pasta "${chosen.name}":`, errOpen);
            return;
          }
          lastSentUid = (box.uidnext && Number(box.uidnext) > 0) ? Number(box.uidnext) - 1 : 0;
          console.log(`[IMAP-SENT] monitorando a pasta "${chosen.name}". lastSentUid inicial: ${lastSentUid}. Mensagens na pasta: ${box.messages.total}`);
        });
      });
    });

    imapSent.on('mail', (numNewMsgs: number) => {
      console.log(`[IMAP-SENT] Evento 'mail' recebido na pasta Sent. Indicação de novas mensagens: ${numNewMsgs}`);
      imapSent.search(['ALL'], (err: any, results: number[]) => {
        if (err) {
          console.error('[IMAP-SENT] erro na busca:', err);
          return;
        }
        if (!results || !results.length) return;

        const newUids = results
          .map(r => Number(r))
          .filter(uid => uid > lastSentUid)
          .sort((a, b) => a - b);

        if (!newUids.length) return;

        lastSentUid = Math.max(lastSentUid, ...newUids);

        const fetcher = imapSent.fetch(newUids, { bodies: '', markSeen: false });
        fetcher.on('message', (msg: any) => {
          let raw = '';
          let attributes: any = null;
          msg.on('body', (stream: NodeJS.ReadableStream) => {
            stream.on('data', (chunk: Buffer) => raw += chunk.toString('utf8'));
          });
          msg.once('attributes', (attrs: any) => attributes = attrs);
          msg.once('end', async () => {
            try {
              const parsed: ParsedMail = await simpleParser(raw);
              //@ts-ignore
              const to = parsed.to?.text || (parsed.to?.value?.map((v: any) => v.address).join(', ')) || '(destinatário desconhecido)';
              const subject = parsed.subject || '(sem assunto)';
              const attachmentsCount = parsed.attachments ? parsed.attachments.length : 0;
              const uid = attributes && attributes.uid;
              const messageId = parsed.messageId || '(sem message-id)';

              console.log('===================================');
              console.log('===MENSAGEM ENVIADA===');
              console.log('UID:', uid);
              console.log('Message-ID:', messageId);
              console.log('Para:', to);
              console.log('Assunto:', subject);
              console.log('Quantidade de anexos:', attachmentsCount);
              console.log('===================================');

              if (attachmentsCount > 0 && parsed.attachments) {
                try {
                  await saveAttachments(parsed.attachments, uid);
                } catch (e) {
                  console.error('[IMAP-SENT/ANEXOS] erro ao salvar anexos da mensagem enviada:', e);
                }
              }
            } catch (e) {
              console.error('[IMAP-SENT] erro ao parsear mensagem enviada:', e);
            }
          });
        });
        fetcher.once('error', (err: any) => console.error('[IMAP-SENT] fetch error:', err));
      });
    });

    imapSent.on('error', (err: any) => console.error('[IMAP-SENT] erro:', err));
    imapSent.on('end', () => {
      console.log('[IMAP-SENT] conexão encerrada. Tentarei reconectar em 5s...');
      setTimeout(() => buildImapSent().catch((e) => console.error('[IMAP-SENT] falha ao reconectar:', e)), 5000);
    });

    imapSent.connect();
    return imapSent;
  }

  return buildImapSent();
}


// =========================
// MENSAGENS RECEBIDAS WHATSAPP
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
      try { await client.destroy(); } catch { }
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

/*
/chats → listar chats com filtros.
/chats/open → listar chats em aberto.
/chats/:id/messages → listar mensagens de um chat.
/chats/:id/finish → finalizar chat.
/messages/send → enviar texto.
/messages/send-media → enviar mídia por upload (multipart/form-data).
*/

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
  app.post('/whatsapp/messages/send', async (req: Request, res: Response) => {
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
  app.post('/whatsapp/messages/send-media', upload.single('file'), async (req: Request, res: Response) => {
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

  app.post('/send', upload.array('attachments'), async (req: Request, res: Response) => {
    try {
      const { to, subject, text } = req.body as { to?: string; subject?: string; text?: string };
      if (!to) return res.status(400).json({ error: 'Campo "to" é obrigatório' });
      const attachments = mapMulterFilesToNodemailerAttachments((req as any).files);
      const mail: SendMailOptions = {
        from: process.env.EMAIL,
        to,
        subject: subject || 'Mensagem via API',
        text: text || '',
        attachments,
      };
      if (!transporterGlobal) return res.status(500).json({ error: 'Transporter não inicializado' });
      const info = await transporterGlobal.sendMail(mail);
      console.log('===================================');
      console.log('===MENSAGEM ENVIADA===');
      console.log('Para:', to);
      console.log('Assunto:', mail.subject);
      console.log('Message-ID:', info.messageId || info.response || '(sem id)');
      console.log('===================================');
      return res.json({ ok: true, messageId: info.messageId || info.response });
    } catch (e: any) {
      console.error('[HTTP /send] erro:', e);
      return res.status(500).json({ error: e.message || String(e) });
    }
  });

  app.post('/reply', upload.array('attachments'), async (req: Request, res: Response) => {
    try {
      const { uid, messageId, text } = req.body as { uid?: string; messageId?: string; text?: string };
      if (!uid && !messageId) return res.status(400).json({ error: 'Informe "uid" ou "messageId" do e-mail original' });

      let original: ParsedMail;
      if (uid) original = await fetchMessageByUid(uid);
      else original = await fetchMessageByMessageId(messageId!);

      const originalFrom = original.from?.value?.[0];
      const replyTo = originalFrom?.address || original.from?.text;
      const originalSubject = original.subject || '';
      const originalMessageId = original.messageId || null;

      if (!replyTo) return res.status(500).json({ error: 'Não foi possível identificar destinatário original para a resposta' });

      const subject = originalSubject.match(/^Re:/i) ? originalSubject : 'Re: ' + originalSubject;
      const attachments = mapMulterFilesToNodemailerAttachments((req as any).files);
      const mail: SendMailOptions = {
        from: process.env.EMAIL,
        to: replyTo,
        subject,
        text: text || '',
        attachments,
        inReplyTo: originalMessageId || undefined,
        references: originalMessageId ? originalMessageId : undefined,
      };

      if (!transporterGlobal) return res.status(500).json({ error: 'Transporter não inicializado' });
      const info = await transporterGlobal.sendMail(mail);

      console.log('===================================');
      console.log('===MENSAGEM ENVIADA===');
      console.log('Para:', replyTo);
      console.log('Assunto:', subject);
      console.log('Message-ID:', info.messageId || info.response || '(sem id)');
      console.log('===================================');

      return res.json({ ok: true, messageId: info.messageId || info.response });
    } catch (e: any) {
      console.error('[HTTP /reply] erro:', e);
      return res.status(500).json({ error: e.message || String(e) });
    }
  });

  app.listen(Number(process.env.PORT) || 3000, () => {
    console.log(`[HTTP] API escutando em http://localhost:${Number(process.env.PORT) || 3000}`);
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

    transporterGlobal = await createTransporter();

    const imapInbox = await connectImapInboxListener();
    const imapSent = await connectSentListener();
  } catch (err) {
    console.error('[BOOT] Erro ao iniciar aplicação:', err);
    process.exit(1);
  }
})();
