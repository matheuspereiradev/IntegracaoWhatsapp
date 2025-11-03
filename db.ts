import { MongoClient, Db } from 'mongodb';
import 'dotenv/config';

let client: MongoClient | undefined;
let db: Db | undefined;

/**
 * Conecta (singleton) no MongoDB e cria índices básicos.
 */
export async function connect(): Promise<Db> {
  if (db) return db;

  const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017';
  const dbName = process.env.MONGODB_DB || 'whatsapp';

  client = new MongoClient(uri, {
    maxPoolSize: 10,
  });

  await client.connect();
  db = client.db(dbName);

  await Promise.all([
    // messages
    db.collection('messages').createIndex({ direction: 1, timestamp: -1 }),
    db.collection('messages').createIndex({ chatId: 1, timestamp: -1 }),
    db.collection('messages').createIndex({ chatRefId: 1, timestamp: -1 }),
    db.collection('messages').createIndex({ from: 1, to: 1, timestamp: -1 }),
    db.collection('messages').createIndex({ type: 1 }),
    db.collection('messages').createIndex({ isGroup: 1 }),

    // chats
    db.collection('chats').createIndex({ waChatId: 1, status: 1 }),
    db.collection('chats').createIndex({ updatedAt: -1 }),
    db.collection('chats').createIndex({ lastMessageAt: -1 }),

    db.collection('silenced_clients').createIndex({ identifier: 1 }, { unique: true }),
    db.collection('silenced_clients').createIndex({ identifier: 1, createdAt: -1 }),
  ]);

  console.log('[DB] Conectado ao MongoDB e índices criados.');
  return db;
}

export function getDb(): Db {
  if (!db) {
    throw new Error('MongoDB não conectado. Chame connect() antes.');
  }
  return db;
}
