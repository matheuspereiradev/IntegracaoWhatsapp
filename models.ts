import { Db, ObjectId } from "mongodb";
import { CHAT_STATUS, ChatDoc, ChatStatus, SavedMessageDoc } from "./types";
import { getDb } from "./db";
import { nowIso } from "./utils";
import { ParsedMail } from "mailparser";

export async function saveMessage(doc: SavedMessageDoc): Promise<void> {
  try {
    const db: Db = getDb();
    await db.collection('messages').insertOne(doc);
  } catch (err: any) {
    console.error('[DB] Falha ao salvar mensagem:', err?.message || err);
  }
}

export async function getOpenChatByWaChatId(waChatId: string): Promise<ChatDoc | null> {
  const db: Db = getDb();
  return db.collection<ChatDoc>('chats').findOne({
    waChatId,
    status: { $ne: CHAT_STATUS.FINALIZADO },
  });
}

export async function createChatFromMessage({
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
    channel: 'whatsapp',
    isGroup: !!isGroup,
    title: title || null,
    tags: [],
    participants,
    status: initialStatus || CHAT_STATUS.NOVO,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    lastMessageAt: firstTs || new Date(),
  };
  const res = await db.collection<ChatDoc>('chats').insertOne(doc);
  return { ...doc, _id: res.insertedId };
}

export async function updateChatStatus(chatId: ObjectId | string, newStatus: ChatStatus): Promise<void> {
  const db: Db = getDb();
  await db.collection('chats').updateOne(
    { _id: new ObjectId(String(chatId)) },
    { $set: { status: newStatus, updatedAt: nowIso() } }
  );
}

export async function updateChatTags(chatId: ObjectId | string, tags: string[]): Promise<void> {
  const db: Db = getDb();
  await db.collection('chats').updateOne(
    { _id: new ObjectId(String(chatId)) },
    { $set: { tags, updatedAt: nowIso() } }
  );
}

export async function touchChat(chatId: ObjectId | string, ts: Date): Promise<void> {
  const db: Db = getDb();
  await db.collection('chats').updateOne(
    { _id: new ObjectId(String(chatId)) },
    { $set: { lastMessageAt: ts, updatedAt: nowIso() } }
  );
}

export async function ensureChat({
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

export async function getChatById(id: ObjectId | string): Promise<ChatDoc | null> {
  const db: Db = getDb();
  return db.collection<ChatDoc>('chats').findOne({ _id: new ObjectId(String(id)) });
}

export async function ensureChatByWaChatId(
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

export async function findOpenChatByEmailThread(threadId?: string, emailPeer?: string) {
  const db = getDb();
  const filter: any = { channel: 'email', status: { $ne: CHAT_STATUS.FINALIZADO } };
  if (threadId) filter.emailThreadId = threadId;
  if (emailPeer) filter.emailPeer = emailPeer;
  return db.collection<ChatDoc>('chats').findOne(filter);
}

export async function findChatByMessageId(gmailMessageId: string) {
  if (!gmailMessageId) return null;
  const db = getDb();
  // procura na coleção messages por email.id === gmailMessageId e retorna o chatRef
  const msg = await db.collection('messages').findOne({ 'email.id': gmailMessageId });
  if (msg) {
    return db.collection<ChatDoc>('chats').findOne({ _id: new ObjectId(String(msg.chatRefId)) });
  }
  return null;
}

export async function createEmailChat({
  emailPeer,
  threadId,
  title,
  participants = [],
  initialStatus = CHAT_STATUS.NOVO,
}: {
  emailPeer?: string;
  threadId?: string;
  title?: string | null;
  participants?: string[];
  initialStatus?: typeof CHAT_STATUS[keyof typeof CHAT_STATUS];
}) {
  const db = getDb();
  const doc: ChatDoc = {
    channel: 'email',
    isGroup: false,
    tags: [],
    title: title || emailPeer || threadId || null,
    participants: participants.length ? participants : (emailPeer ? [emailPeer] : []),
    status: initialStatus,
    waChatId: null,
    emailThreadId: threadId || null,
    emailPeer: emailPeer || null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastMessageAt: new Date(),
  };
  const res = await db.collection('chats').insertOne(doc);
  return { ...doc, _id: res.insertedId } as ChatDoc;
}

export async function upsertChatOnMessage(chatId: ObjectId | string, opts: { lastMessageAt?: Date; status?: typeof CHAT_STATUS[keyof typeof CHAT_STATUS]; threadId?: string; emailPeer?: string } = {}) {
  const db = getDb();
  const set: any = {};
  if (opts.lastMessageAt) set.lastMessageAt = opts.lastMessageAt;
  if (opts.status) set.status = opts.status;
  if (opts.threadId) set.emailThreadId = opts.threadId;
  if (opts.emailPeer) set.emailPeer = opts.emailPeer;
  set.updatedAt = new Date().toISOString();

  await db.collection('chats').updateOne({ _id: new ObjectId(String(chatId)) }, { $set: set });
}

export async function saveMessageDoc(msg: SavedMessageDoc) {
  const db = getDb();
  const r = await db.collection<SavedMessageDoc>('messages').insertOne(msg);
  return { ...msg, _id: r.insertedId } as SavedMessageDoc;
}

function extractAddressField(addrField: any): string | null {
  // addrField pode ser undefined | string | { text?: string, value?: Array<{address?,name?}> } | Array<...>
  if (!addrField) return null;
  try {
    if (typeof addrField === "string") return addrField;
    if (Array.isArray(addrField)) {
      // array de AddressObject
      return addrField
        .map((v: any) => (v?.address ? v.address : v?.name ? v.name : ''))
        .filter(Boolean)
        .join(", ") || null;
    }
    if (typeof addrField === "object") {
      if (typeof addrField.text === "string" && addrField.text.trim()) return addrField.text;
      if (Array.isArray(addrField.value)) {
        return (addrField.value
          .map((v: any) => (v?.address ? v.address : v?.name ? v.name : ''))
          .filter(Boolean)
          .join(", ")) || null;
      }
    }
    return null;
  } catch {
    return null;
  }
}

function safeString(v: any, fallback = ""): string {
  if (v == null) return fallback;
  return String(v);
}

function normalizeMessageId(v?: string | null): string | null {
  if (!v) return null;
  return String(v).replace(/[<>]/g, "").trim() || null;
}

// attachment mapper: o simpleParser Attachment pode não ter path
function mapAttachment(a: any) {
  // tipos possíveis: { filename, contentType, size, content(Buffer), cid, related } - path nem sempre
  const filename = safeString(a.filename || a.name || 'attachment');
  const savedPath = (typeof a.path === 'string' && a.path) ? a.path : (a.savedPath || '');
  const mimeType = safeString(a.contentType || a.mimeType || a.type || '');
  const size = typeof a.size === 'number' ? a.size : (a.length || undefined);
  return { filename, savedPath, mimeType, size };
}

/**
 * Salva um e-mail no banco e cria/associa ao chat correspondente.
 * - parsed: resultado do simpleParser
 * - direction: 'inbound' | 'outbound'
 */
export async function saveEmailMessage({
  parsed,
  direction,
}: {
  parsed: any; // ParsedMail, mas mantemos `any` aqui para flexibilidade com simpleParser
  direction: "inbound" | "outbound";
}) {
  const db = getDb();

  // Extrai remetente/destinatário
  const from = extractAddressField(parsed.from) || null;
  const to = extractAddressField(parsed.to) || null;

  const subject = safeString(parsed.subject || "(sem assunto)");
  const rawMessageId = normalizeMessageId(parsed.messageId || parsed.messageID || parsed['message-id']);
  const messageId = rawMessageId || `generated-${Date.now()}`; // garantir string não-nula
  const inReplyTo = normalizeMessageId(parsed.inReplyTo || (parsed.headers && parsed.headers['in-reply-to']));
  const referencesRaw = parsed.references || (parsed.headers && parsed.headers.references) || null;
  const references = Array.isArray(referencesRaw)
    ? referencesRaw.map((r: any) => normalizeMessageId(r)).filter(Boolean)
    : (typeof referencesRaw === "string"
      ? referencesRaw.split(/\s+/).map(r => normalizeMessageId(r)).filter(Boolean)
      : []);

  const bodyText = typeof parsed.text === 'string' ? parsed.text : null;
  const bodyHtml = typeof parsed.html === 'string' ? parsed.html : null;

  const attachmentsArr = Array.isArray(parsed.attachments) ? parsed.attachments : [];
  const attachments = attachmentsArr.map((a: any) => mapAttachment(a));

  // logs visuais
  if (direction === "inbound") {
    console.log("============================VOCÊ RECEBEU UM EMAIL=======================");
  } else {
    console.log("============TU MANDOU UM EMAIL=======================");
  }
  console.log("De:", from);
  console.log("Para:", to);
  console.log("Assunto:", subject);
  console.log("Message-ID:", messageId);
  console.log("In-Reply-To:", inReplyTo);
  console.log("Attachments:", attachments.length);
  console.log("================================================================");

  // Determinar/associar Chat
  let chat: ChatDoc | null = null;

  // 1) tentar por inReplyTo -> localizar mensagem existente pelo messageId (saved)
  if (inReplyTo) {
    chat = await findChatByMessageId(inReplyTo);
  }

  // 2) tentar por thread (se você tiver threadId no parsed.headers['thread-index'] ou similar) - IMAP pode não fornecer
  // como fallback, tentamos por emailPeer (from/to) em chats abertos
  if (!chat) {
    const emailPeer = direction === "inbound" ? from || undefined : to || undefined;
    chat = await findOpenChatByEmailThread(undefined, emailPeer);
  }

  // 3) se não achar, cria novo chat
  if (!chat) {
    chat = await createEmailChat({
      emailPeer: direction === "inbound" ? from || undefined : to || undefined,
      threadId: undefined,
      title: subject || (direction === "inbound" ? from || null : to || null),
      participants: direction === "inbound" ? (from ? [from] : []) : (to ? [to] : []),
      initialStatus: direction === "inbound" ? CHAT_STATUS.NOVO : CHAT_STATUS.EM_ANDAMENTO,
    });
  } else {
    // se chat existe, atualiza lastMessageAt e, se for NOVO e foi enviada menssagem outbound, passa para EM_ANDAMENTO
    const newStatus =
      chat.status === CHAT_STATUS.NOVO && direction === "outbound"
        ? CHAT_STATUS.EM_ANDAMENTO
        : chat.status;
    await upsertChatOnMessage(chat._id!, {
      lastMessageAt: new Date(),
      status: newStatus,
      // se tiver um threadId vindo de parsed.headers você pode setar aqui
    });
  }

  // Monta SavedMessageDoc (respeitando seu tipo)
  const messageDoc: SavedMessageDoc = {
    channel: "email",
    waMessageId: null,
    chatRefId: new ObjectId(String(chat._id)),
    direction,
    type: "email",
    timestamp: new Date(),
    messageAt: new Date().toISOString(),
    isGroup: false,
    chatName: chat.title,
    from,
    to,
    authorDisplay: direction === "inbound" ? (from || "(desconhecido)") : "me",
    body: bodyText || bodyHtml || null,
    caption: null,
    chatId: "", // compatibilidade com WA
    media: null,
    email: {
      id: messageId,
      threadId: chat.emailThreadId || "",
      headers: {
        subject,
        from: from || undefined,
        to: to || undefined,
        date: parsed.date ? (parsed.date instanceof Date ? parsed.date.toISOString() : String(parsed.date)) : undefined,
        messageId,
        inReplyTo: inReplyTo || undefined,
        references: references.length ? references.join(", ") : undefined,
      },
      snippet: (bodyText || "").substring(0, 120),
      bodyText,
      bodyHtml,
      attachments: attachments.map((a:any) => ({
        filename: a.filename,
        savedPath: a.savedPath,
        mimeType: a.mimeType,
        size: a.size,
      })),
    },
  };

  await saveMessageDoc(messageDoc);
}
