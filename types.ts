import { ObjectId } from "mongodb";

export const CHAT_STATUS = {
  NOVO: 'novo',
  EM_ANDAMENTO: 'em_andamento',
  FINALIZADO: 'finalizado',
  PENDENTE: 'pendente',
  EM_ESPERA: 'em_espera',
  AGUARDANDO_BACKLOG: 'aguardando_backlog',
} as const;

export type Channel = 'whatsapp' | 'email';

export type ChatStatus = typeof CHAT_STATUS[keyof typeof CHAT_STATUS];

export type MessageDirection = 'inbound' | 'outbound';

/** Tipos de mensagem suportados */
export type MessageType =
  | 'chat'            // texto (whatsapp)
  | 'image'
  | 'video'
  | 'audio'
  | 'ptt'             // áudio de voz (push-to-talk)
  | 'document'
  | 'sticker'
  | 'location'
  | 'contact'
  | 'contacts_array'
  | 'reaction'
  | 'unknown'
  | 'email';


export interface SavedMedia {
  savedPath: string;
  mimetype: string | null;
  filename: string | null;
  size?: number;
}

/* Detalhes específicos de e-mail (Gmail) quando channel = 'email' */
export interface EmailMessageDetails {
  id: string;                   // Gmail message id
  threadId: string;             // Gmail thread id
  headers: {
    subject?: string;
    from?: string;
    to?: string;
    cc?: string;
    bcc?: string;
    date?: string;
    messageId?: string;
    references?: string;
    inReplyTo?: string;
  };
  snippet?: string;             // preview curto do Gmail
  bodyText?: string | null;     // corpo texto (se extraído)
  bodyHtml?: string | null;     // corpo HTML (se extraído)
  attachments?: Array<{
    filename: string;
    savedPath: string;          // onde o anexo foi salvo
    mimeType: string;
    size?: number;              // bytes
  }>;
}

export interface ChatDoc {
  _id?: ObjectId;
  channel: Channel;             // 'whatsapp' | 'email'
  isGroup: boolean;              // grupos (WA) ou múltiplos recipientes (e-mail) se quiser evoluir
  title: string | null;          // nome amigável do chat (contato/assunto)
  participants: string[];        // WA: números; Email: endereços
  status: ChatStatus;            // 'novo' | 'em_andamento' | 'finalizado'
  tags: string[];              // tags customizáveis

  /** ====== Campos de WhatsApp ====== */
  waChatId?: string | null;     // ex.: '5588999999999@c.us' ou '@g.us' para grupos

  /** ====== Campos de Email ====== */
  emailThreadId?: string | null; // para agrupar por thread (Gmail)
  emailPeer?: string | null;     // e-mail principal do outro lado (ex.: From)

  createdAt: string;
  updatedAt: string;
  lastMessageAt: Date;
}

export interface SavedMessageDoc {
  _id?: ObjectId;
  channel: Channel;                      // 'whatsapp' | 'email'
  waMessageId?: string | null;           // id do WhatsApp quando aplicável
  chatRefId: ObjectId;                   // referência ao ChatDoc
  direction: MessageDirection;           // 'inbound' | 'outbound'
  type: MessageType;                     // 'chat' | 'image' | ... | 'email'
  timestamp: Date;
  messageAt?: string;
  isGroup: boolean;
  chatName: string | null;               // rótulo amigável do chat no momento
  from: string | null;                   // WA: autor/id; Email: endereço
  to: string | null;                     // WA: destinatário; Email: endereço
  authorDisplay: string;                 // nome a exibir no log
  body: string | null;                   // texto puro (WA) ou corpo texto do email (quando aplicável)
  caption: string | null;                // legenda de mídia (WA)
  chatId?: string;                       // WHATSAPP: ex.: '5588...@c.us' (compatibilidade com seu código)
  media?: SavedMedia | null;             // WHATSAPP mídia única (WA) salva; nulo se texto
  email?: EmailMessageDetails | null;    // GMAIL bloco com cabeçalhos, html, anexos, etc.
}

export type AnyObject = Record<string, any>;