// index.js
// Requisitos: Node 18+
// Dependências: whatsapp-web.js, qrcode-terminal
// Execução: node index.js

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

function openWithDefaultApp(filePath) {
  if (!AUTO_OPEN_MEDIA) return;
  const platform = process.platform;
  if (platform === 'win32') exec(`start "" "${filePath}"`);
  else if (platform === 'darwin') exec(`open "${filePath}"`);
  else exec(`xdg-open "${filePath}"`);
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

  openWithDefaultApp(filePath);
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
client.on('message', async (msg) => {
  try {
    const chat = await msg.getChat();
    const contact = await msg.getContact();

    const who =
      (contact?.pushname || contact?.name || contact?.number || msg.author || msg.from);

    const type = msg.type || 'unknown';

    if (type === 'chat') {
      // Texto
      console.log(`\n[Msg recebida] De: ${who}${chat.isGroup ? ` (grupo: ${chat.name})` : ''}`);
      console.log(`Conteúdo: ${msg.body}`);
      return;
    }

    // Mídia/arquivo (inclui imagem, áudio, PTT, vídeo e documentos)
    const typeLabel = labelForType(type);
    console.log(`\n[Arquivo recebido] De: ${who}${chat.isGroup ? ` (grupo: ${chat.name})` : ''}`);
    console.log(`Tipo: ${typeLabel}${msg.caption ? ` | Legenda: ${msg.caption}` : ''}`);

    // Agora baixamos e abrimos TAMBÉM 'video' e 'document'
    if (['image', 'audio', 'ptt', 'video', 'document'].includes(type)) {
      await saveMediaMessage(msg, chat, who);
    }
  } catch (err) {
    console.error('[ERRO message handler]', err);
  }
});

// -------- Loga mensagens ENVIADAS pela sua conta (qualquer dispositivo) --------
client.on('message_create', async (msg) => {
  try {
    if (!msg.fromMe) return; // apenas mensagens que você enviou

    const chat = await msg.getChat();
    let destinoNome = '';

    if (chat.isGroup) {
      destinoNome = chat.name;
    } else {
      const contato = await chat.getContact();
      destinoNome = contato?.pushname || contato?.name || contato?.number || msg.to;
    }

    if (msg.type === 'chat') {
      console.log(`mensagem enviada para ${destinoNome} >> ${msg.body}`);
    } else {
      const tipo = labelForType(msg.type);
      const sufixo = msg.caption ? ` >> ${msg.caption}` : '';
      console.log(`${tipo} enviada para ${destinoNome}${sufixo}`);
    }
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
client.initialize();
