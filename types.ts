import { ObjectId } from "mongodb";

export const CHAT_STATUS = {
  NOVO: 'novo',
  EM_ANDAMENTO: 'em_andamento',
  FINALIZADO: 'finalizado',
} as const;

export type ChatStatus = typeof CHAT_STATUS[keyof typeof CHAT_STATUS];

export type SavedMedia = {
  savedPath: string;
  mimetype: string | null;
  filename: string | null;
} | null;

export type SavedMessageDoc = {
  _id?: ObjectId;
  waMessageId: string | null;
  chatRefId: ObjectId;
  direction: 'inbound' | 'outbound';
  chatId: string;
  isGroup: boolean;
  chatName: string | null;
  from: string | null;
  to: string | null;
  authorDisplay: string;
  type: string;
  body: string | null;
  caption: string | null;
  media: SavedMedia;
  timestamp: Date;
  receivedAt?: string;
  sentAt?: string;
};

export type ChatDoc = {
  _id?: ObjectId;
  waChatId: string;
  isGroup: boolean;
  title: string | null;
  participants: string[];
  status: ChatStatus;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: Date;
};
