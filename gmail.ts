import path from "path";
import { ensureDirSync, extFromMime, getBaseDir, getExtension, sanitizeName } from "./utils";
import fs from "fs";
import nodemailer, { Transporter } from "nodemailer";
import { simpleParser, ParsedMail, Attachment as MailparserAttachment } from 'mailparser';
import { AnyObject } from "./types";


export async function saveAttachments(attachments: MailparserAttachment[], uid?: number | string): Promise<string[]> {
    if (!attachments || !attachments.length) return [];
    const baseDir = getBaseDir();
    ensureDirSync(baseDir);
    const saved: string[] = [];
    const timestamp = Date.now();
    for (const att of attachments) {

        let baseName =
            sanitizeName(att.filename || 'midia')
        const guessedExt = getExtension(att.filename);

        baseName = `${timestamp}_email_${baseName}`

        baseName = baseName + '.' + guessedExt


        const filepath = path.join(baseDir, baseName);

        try {
            if (att.content) {
                // content é Buffer geralmente
                fs.writeFileSync(filepath, att.content as Buffer);
            } else if ((att as any).contentStream) {
                // contentStream (caso fornecido)
                const stream = (att as any).contentStream as NodeJS.ReadableStream;
                const writeStream = fs.createWriteStream(filepath);
                await new Promise<void>((resolve, reject) => {
                    stream.pipe(writeStream);
                    stream.on('end', () => resolve());
                    stream.on('error', (err) => reject(err));
                    writeStream.on('error', (err) => reject(err));
                });
            } else {
                console.warn(`[ANEXOS] não foi possível salvar anexo sem conteúdo: ${baseName}`);
                continue;
            }
            saved.push(baseName);
            console.log(`[ANEXOS] salvo: ${baseName}`);
        } catch (e) {
            console.error(`[ANEXOS] erro ao salvar anexo ${baseName}:`, e);
        }
    }
    return saved;
}

export async function createTransporter(): Promise<Transporter> {
    const port = process.env.SMTP_PORT ? parseInt(process.env.SMTP_PORT) : 0;
    return nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port,
        secure: port === 465,
        auth: {
            user: process.env.EMAIL,
            pass: process.env.APP_PASSWORD,
        },
    });
}



export function createImapConfigCopy(): AnyObject {
    const IMAP_HOST = process.env.IMAP_HOST || 'imap.gmail.com';
    const IMAP_PORT = parseInt(process.env.IMAP_PORT || '993', 10);
    return {
        user: process.env.EMAIL,
        password: process.env.APP_PASSWORD,
        host: IMAP_HOST,
        port: IMAP_PORT,
        tls: true,
        autotls: 'always',
    };
}
