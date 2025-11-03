import fs from 'fs';
import path from 'path';

export function ensureDirSync(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function getBaseDir(name:string): string {
  const date = new Date();
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return path.join(
    __dirname,
    'downloads',
    `${yyyy}-${mm}-${dd}`,
    name
  );
}

export function sanitizeName(name: string): string {
  return String(name || '')
    .replaceAll(/[^a-zA-Z0-9]/g, '')
    .trim();
}

export function extFromMime(mime: string | undefined): string {
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

export async function saveMediaMessage(msg: any, chat: any, whoLabel: string = 'desconhecido'): Promise<string | null> {
  const media = await msg.downloadMedia();
  if (!media) {
    console.log('[MÍDIA] Não foi possível baixar o conteúdo.');
    return null;
  }


  const baseDir = getBaseDir(sanitizeName(chat.isGroup ? chat.name : whoLabel))

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

export function nowIso(): string {
  return new Date().toISOString();
}

export function toChatId(inputPhone?: string | null): string | null {
  if (!inputPhone) return null;
  const digits = String(inputPhone).replace(/[^\d]/g, '');
  if (digits.length < 10) return null;
  return `${digits}@c.us`;
}

export function labelForType(type?: string): string {
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

export function parseBool(v: unknown, def: boolean = false): boolean {
  if (v == null) return def;
  if (typeof v === 'boolean') return v;
  const s = String(v).toLowerCase();
  return ['1', 'true', 'yes', 'y', 'on'].includes(s);
}

export function mapMulterFilesToNodemailerAttachments(filesArray?: Express.Multer.File[] | undefined) {
  if (!filesArray || !filesArray.length) return [];
  return filesArray.map(f => ({
    filename: f.originalname,
    content: f.buffer,
    contentType: f.mimetype,
  }));
}