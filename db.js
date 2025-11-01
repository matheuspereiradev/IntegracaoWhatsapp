// db.js
const { MongoClient } = require('mongodb');
require('dotenv').config();

let client;
let db;

/**
 * Conecta (singleton) no MongoDB e cria índices básicos.
 */
async function connect() {
  if (db) return db;

  const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017';
  const dbName = process.env.MONGODB_DB || 'whatsapp';

  client = new MongoClient(uri, {
    maxPoolSize: 10,
  });

  await client.connect();
  db = client.db(dbName);

  // Índices para messages e chats
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
  ]);

  console.log('[DB] Conectado ao MongoDB e índices criados.');
  return db;
}

function getDb() {
  if (!db) {
    throw new Error('MongoDB não conectado. Chame connect() antes.');
  }
  return db;
}

module.exports = {
  connect,
  getDb,
};
