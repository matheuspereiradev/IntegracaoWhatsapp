import { Db, ObjectId } from "mongodb";
import { CHAT_STATUS, ChatDoc, ChatStatus, SavedMessageDoc } from "./types";
import { getDb } from "./db";
import { nowIso } from "./utils";

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

export async function updateChatStatus(chatId: ObjectId | string, newStatus: ChatStatus): Promise<void> {
  const db: Db = getDb();
  await db.collection('chats').updateOne(
    { _id: new ObjectId(String(chatId)) },
    { $set: { status: newStatus, updatedAt: nowIso() } }
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
