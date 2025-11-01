// db.js
const { MongoClient } = require('mongodb');
require('dotenv').config();

let client;
let db;

async function connect() {
  if (db) return db;

  const uri = process.env.MONGODB_URI;
  const dbName = process.env.MONGODB_DB || 'wa_cli';

  client = new MongoClient(uri, { maxPoolSize: 10 });
  await client.connect();
  db = client.db(dbName);

  // Índices úteis
  await Promise.all([
    db.collection('messages').createIndex({ direction: 1, timestamp: -1 }),
    db.collection('messages').createIndex({ chatId: 1, timestamp: -1 }),
    db.collection('messages').createIndex({ from: 1, to: 1, timestamp: -1 }),
    db.collection('messages').createIndex({ type: 1 }),
    db.collection('messages').createIndex({ isGroup: 1 }),
  ]);

  return db;
}

function getDb() {
  if (!db) throw new Error('MongoDB não conectado. Chame connect() antes.');
  return db;
}

module.exports = { connect, getDb };
