const { connect, getDb } = require('./db');
require('dotenv').config();

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

// ============== Configurações ==============
const AUTO_OPEN_MEDIA = true; // Coloque false para NÃO abrir mídia/arquivos automaticamente
// ===========================================

// -------- Utilitários de arquivo/mídia --------
function ensureDirSync(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function sanitizeName(name) {
  return String(name || '')
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
}

function nowIso() {
  return new Date().toISOString();
}

/**
 * Salva mensagem no MongoDB
 * @param {Object} doc - Documento já normalizado
 */
async function saveMessage(doc) {
  try {
    const db = getDb();
    await db.collection('messages').insertOne(doc);
  } catch (err) {
    console.error('[DB] Falha ao salvar mensagem:', err?.message || err);
  }
}


// Mapeamentos comuns do WhatsApp e de documentos
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
  const media = await msg.downloadMedia(); // { data(base64), mimetype, filename? }
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

// -------- Utilitários de telefone/CLI --------
function toChatId(inputPhone) {
  if (!inputPhone) return null;
  const digits = String(inputPhone).replace(/[^\d]/g, '');
  if (digits.length < 10) return null;
  return `${digits}@c.us`; // contatos (não grupos)
}

function parseCommandLine(line) {
  // Exemplos:
  // +5588999999999 >> "Olá mundo"
  // +5588999999999>>"Sem espaços"
  // 5588999999999 >> oi
  const pattern = /^\s*([+]?[\d\s\-\(\)]+)\s*>>\s*(?:"([^"]+)"|(.+))\s*$/;
  const m = line.match(pattern);
  if (!m) return null;

  const phoneRaw = m[1]?.trim();
  const message = (m[2] ?? m[3] ?? '').trim();

  const chatId = toChatId(phoneRaw);
  if (!chatId || !message) return null;

  return { chatId, message };
}

// -------- Rótulos de tipos --------
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

// -------- Inicializa cliente WhatsApp --------
const client = new Client({
  authStrategy: new LocalAuth({ clientId: 'wa-cli' }),
  puppeteer: {
    headless: true, // mude para false se quiser ver o navegador
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
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

// -------- Recebimento de mensagens --------
// Recebimento de mensagens (com download/abertura e persistência no MongoDB)
client.on('message', async (msg) => {
  try {
    // Metadados básicos do chat/contato
    const chat = await msg.getChat();
    const contact = await msg.getContact();

    const who =
      contact?.pushname ||
      contact?.name ||
      contact?.number ||
      msg.author ||      // em grupos, autor real
      msg.from;          // fallback

    const isGroup = chat.isGroup;
    const chatName = isGroup ? chat.name : null;
    const type = msg.type || 'unknown';
    const typeLabel = labelForType(type);

    // Normaliza timestamp do WhatsApp (segundos -> Date)
    const ts = typeof msg.timestamp === 'number'
      ? new Date(msg.timestamp * 1000)
      : new Date();

    // 1) TEXTO
    if (type === 'chat') {
      console.log(`\n[Msg recebida] De: ${who}${isGroup ? ` (grupo: ${chatName})` : ''}`);
      console.log(`Conteúdo: ${msg.body}`);

      // Persistência (MongoDB)
      await saveMessage({
        waMessageId: msg.id?._serialized || msg.id?.id || null,
        direction: 'inbound',
        chatId: msg.from,                 // id do chat de origem
        isGroup,
        chatName,
        from: msg.author || msg.from,     // em grupo, participante; 1-1, o remetente
        to: msg.to || null,
        authorDisplay: who,
        type: 'chat',
        body: msg.body,
        caption: null,
        media: null,                      // sem mídia
        timestamp: ts,
        receivedAt: nowIso()
      });
      return;
    }

    // 2) MÍDIA / ARQUIVOS (imagem, áudio, ptt, vídeo, documento, etc.)
    console.log(`\n[Arquivo recebido] De: ${who}${isGroup ? ` (grupo: ${chatName})` : ''}`);
    console.log(`Tipo: ${typeLabel}${msg.caption ? ` | Legenda: ${msg.caption}` : ''}`);

    // Baixa & abre para tipos suportados
    let savedPath = null;
    if (['image', 'audio', 'ptt', 'video', 'document'].includes(type)) {
      savedPath = await saveMediaMessage(msg, chat, who);
    }

    // Persistência (MongoDB)
    await saveMessage({
      waMessageId: msg.id?._serialized || msg.id?.id || null,
      direction: 'inbound',
      chatId: msg.from,
      isGroup,
      chatName,
      from: msg.author || msg.from,
      to: msg.to || null,
      authorDisplay: who,
      type,                                // image, audio, ptt, video, document, ...
      body: null,                          // não-texto
      caption: msg.caption || null,
      media: savedPath
        ? {
            savedPath,                     // caminho salvo em disco
            mimetype: msg._data?.mimetype || null,
            filename: msg._data?.filename || null,
          }
        : null,
      timestamp: ts,
      receivedAt: nowIso()
    });
  } catch (err) {
    console.error('[ERRO message handler]', err);
  }
});

// -------- Loga mensagens ENVIADAS pela sua conta (qualquer dispositivo) --------
// Mensagens ENVIADAS pela sua conta (de qualquer dispositivo vinculado)
client.on('message_create', async (msg) => {
  try {
    // Ignore mensagens que não são suas
    if (!msg.fromMe) return;

    const chat = await msg.getChat();
    const isGroup = chat.isGroup;
    const chatName = isGroup ? chat.name : null;

    // Destino amigável (nome do grupo ou do contato)
    let destinoNome = '';
    if (isGroup) {
      destinoNome = chat.name;
    } else {
      const contato = await chat.getContact();
      destinoNome =
        contato?.pushname ||
        contato?.name ||
        contato?.number ||
        msg.to; // fallback
    }

    const type = msg.type || 'unknown';
    const typeLabel = labelForType(type);

    // Timestamp normalizado (WhatsApp envia em segundos)
    const ts = typeof msg.timestamp === 'number'
      ? new Date(msg.timestamp * 1000)
      : new Date();

    // 1) TEXTO
    if (type === 'chat') {
      // Log humano
      console.log(`mensagem enviada para ${destinoNome} >> ${msg.body}`);

      // Persistência (MongoDB)
      await saveMessage({
        waMessageId: msg.id?._serialized || msg.id?.id || null,
        direction: 'outbound',
        chatId: msg.to,          // para quem foi enviada
        isGroup,
        chatName,
        from: msg.from,          // seu id
        to: msg.to,
        authorDisplay: 'me',
        type: 'chat',
        body: msg.body,
        caption: null,
        media: null,
        timestamp: ts,
        sentAt: nowIso()
      });

      return;
    }

    // 2) MÍDIA / ARQUIVOS (imagem, áudio, ptt, vídeo, documento, etc.)
    const legenda = msg.caption ? ` >> ${msg.caption}` : '';
    console.log(`${typeLabel} enviada para ${destinoNome}${legenda}`);

    // Baixar & abrir mídias que você enviou (inclusive de outro dispositivo)
    let savedPath = null;
    if (['image', 'audio', 'ptt', 'video', 'document'].includes(type)) {
      // Em alguns casos de mídia enviada por outro device, o download pode não estar
      // imediatamente disponível; o try/catch evita que isso quebre o fluxo.
      try {
        savedPath = await saveMediaMessage(msg, chat, destinoNome);
      } catch (e) {
        console.warn('[MÍDIA OUTBOUND] Não foi possível baixar/abrir a mídia enviada:', e?.message || e);
      }
    }

    // Persistência (MongoDB)
    await saveMessage({
      waMessageId: msg.id?._serialized || msg.id?.id || null,
      direction: 'outbound',
      chatId: msg.to,
      isGroup,
      chatName,
      from: msg.from,            // você
      to: msg.to,
      authorDisplay: 'me',
      type,                      // image, audio, ptt, video, document, ...
      body: null,                // não-texto
      caption: msg.caption || null,
      media: savedPath
        ? {
            savedPath,
            mimetype: msg._data?.mimetype || null,
            filename: msg._data?.filename || null,
          }
        : null,
      timestamp: ts,
      sentAt: nowIso()
    });
  } catch (err) {
    console.error('[ERRO message_create]', err);
  }
});


// -------- Envio via terminal --------
process.stdin.setEncoding('utf8');
process.stdin.on('data', async (chunk) => {
  const lines = chunk.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    if (/^(exit|quit)$/i.test(line)) {
      console.log('Saindo...');
      try { await client.destroy(); } catch {}
      process.exit(0);
    }

    const parsed = parseCommandLine(line);
    if (!parsed) {
      console.log('Formato inválido. Use: +55DDDNÚMERO >> "mensagem"  (ou digite exit para sair)');
      continue;
    }

    try {
      await client.sendMessage(parsed.chatId, parsed.message);
      console.log(`[ENVIADO] Para ${parsed.chatId}: ${parsed.message}`);
    } catch (err) {
      console.error('[ERRO ao enviar]', err?.message || err);
    }
  }
});

// -------- Encerramento gracioso --------
process.on('SIGINT', async () => {
  console.log('\nEncerrando...');
  try { await client.destroy(); } catch {}
  process.exit(0);
});

// -------- Start --------
(async () => {
  try {
    await connect();
    console.log('[DB] MongoDB conectado com sucesso.');
  } catch (e) {
    console.error('[DB] Erro ao conectar no MongoDB:', e);
    process.exit(1);
  }
})();

client.initialize();
