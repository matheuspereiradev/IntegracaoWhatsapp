# 📱 WA CLI — Integração WhatsApp com Node.js + MongoDB

Um servidor completo em **Node.js + TypeScript** que integra com o **WhatsApp Web** usando a biblioteca [`whatsapp-web.js`](https://github.com/pedroslopez/whatsapp-web.js).  
Ele permite **enviar e receber mensagens**, gerenciar **chats com status**, salvar **mídias automaticamente**, e expor uma **API HTTP RESTful** para comunicação com outros sistemas.

---

## 🚀 Funcionalidades Principais

✅ Recebe mensagens em tempo real (texto, imagem, vídeo, áudio, documento, etc.)  
✅ Armazena todas as mensagens e mídias no MongoDB  
✅ Gerencia chats com status: `novo`, `em_andamento`, `finalizado`  
✅ Envia mensagens via **terminal** ou **API HTTP**  
✅ Suporte a envio de **mídias** (upload direto ou via URL)  
✅ Mantém sessão WhatsApp persistente (via `LocalAuth`)  
✅ API REST pronta para integrar com ERPs, CRMs ou chatbots

---

## ⚙️ Estrutura do Projeto

```
📦 projeto/
├── index.ts          # App principal (WhatsApp + API HTTP)
├── db.ts             # Conexão e índices MongoDB
├── utils.ts          # Funções auxiliares
├── types.ts          # Tipos e enums globais
├── models.ts         # Interfaces de dados
├── package.json
└── downloads/        # Mídias baixadas automaticamente
```

---

## 🧩 Dependências Principais

- Node.js 18+
- TypeScript
- express
- whatsapp-web.js
- mongodb
- multer
- axios
- dotenv
- cors

---

## ⚡ Instalação

```bash
# 1. Instalar dependências
npm install

# 2. Configurar variáveis de ambiente
cp .env.example .env
```

Edite o arquivo `.env` com suas configurações:

```env
MONGODB_URI=mongodb://localhost:27017
MONGODB_DB=whatsapp
PORT=3000
```

---

## ▶️ Execução

### Modo desenvolvimento
```bash
npm run dev
```

### Modo produção
```bash
npm run build
node dist/index.js
```

---

## 🔐 Autenticação WhatsApp

Na primeira execução, será exibido um **QR Code** no terminal:

```
[QR CODE] Escaneie com o WhatsApp (Menu > Aparelhos conectados)
```

Após escanear, a sessão é salva automaticamente em:

```
.wwebjs_auth/wa-cli/
```

A autenticação permanece ativa **indefinidamente**, ou até:
- você desconectar o dispositivo pelo aplicativo WhatsApp;
- apagar a pasta `.wwebjs_auth`;
- ficar **30 dias sem uso** (WhatsApp expira a sessão inativa).

---

## 💬 Enviar mensagens pelo terminal

Você pode enviar mensagens diretamente pelo terminal:

```bash
+5588999999999 >> "Olá, deu certo!"
```

Saia com:
```
exit
```

---

## 🌐 Endpoints da API

Base URL padrão:
```
http://localhost:3000
```

### 🩺 Health Check
```
GET /health
```
**Resposta:**
```json
{ "ok": true, "status": "up" }
```

---

### 💬 Listar chats
```
GET /chats?status=novo,em_andamento&q=João&limit=50
```
**Parâmetros opcionais:**
- `status`: Filtra por status (pode ser múltiplo separado por vírgula)
- `q`: Busca no título/nome do chat
- `limit`: Limite máximo (padrão 50, máx. 200)

**Resposta:**
```json
{
  "ok": true,
  "data": [
    {
      "_id": "671f64e2c3...",
      "waChatId": "5588999999999@c.us",
      "status": "em_andamento",
      "title": "João Lima",
      "lastMessageAt": "2025-11-01T18:00:00Z"
    }
  ]
}
```

---

### 💬 Listar chats em aberto
```
GET /chats/open
```
Retorna todos os chats com status diferente de `finalizado`.

---

### 📨 Listar mensagens de um chat
```
GET /chats/:id/messages?limit=50&type=image&direction=inbound
```

**Parâmetros opcionais:**
- `limit`: número máximo de mensagens (padrão 50)
- `type`: filtra tipo (`chat`, `image`, `video`, `document`, `audio`, etc.)
- `direction`: `inbound` (recebidas) ou `outbound` (enviadas)
- `mediaOnly`: `true` para retornar apenas mensagens com mídia
- `since` / `until`: ISODate para intervalo de datas

---

### ✅ Finalizar um chat
```
POST /chats/:id/finish
```
**Resposta:**
```json
{ "ok": true, "data": { "_id": "671f...", "status": "finalizado" } }
```

---

### ✉️ Enviar mensagem de texto
```
POST /messages/send
```

**Body (JSON):**
```json
{
  "phoneNumber": "+5588999999999",
  "message": "Olá, tudo bem?"
}
```

ou

```json
{
  "chatId": "671f64e2c3...",
  "message": "Atualizando sua solicitação"
}
```

**Resposta:**
```json
{
  "ok": true,
  "data": {
    "chatId": "671f64e2c3...",
    "waChatId": "5588999999999@c.us",
    "status": "em_andamento",
    "messagePreview": "Olá, tudo bem?"
  }
}
```

---

### 🖼️ Enviar mídia (upload direto)
```
POST /messages/send-media
Content-Type: multipart/form-data
```

**Campos:**
- `file` — arquivo binário (obrigatório)
- `phoneNumber` ou `chatId` — destino
- `caption` — legenda opcional
- `forceDocument` — `"true"` para enviar como documento
- `voice` — `"true"` para enviar áudio como PTT

**Exemplo com `curl`:**
```bash
curl -X POST http://localhost:3000/messages/send-media   -F "phoneNumber=+5588999999999"   -F "caption=Foto do produto"   -F "file=@./foto.jpg"
```

---

### 🌍 Enviar mídia (a partir de uma URL)
```
POST /messages/send-media-url
Content-Type: application/json
```

**Body:**
```json
{
  "phoneNumber": "+5588999999999",
  "url": "https://example.com/imagem.png",
  "caption": "Produto em estoque"
}
```

**Resposta:**
```json
{
  "ok": true,
  "data": {
    "chatId": "67200...",
    "waChatId": "5588999999999@c.us",
    "filename": "imagem.png",
    "mimetype": "image/png",
    "size": 102400,
    "caption": "Produto em estoque"
  }
}
```

---

## 💾 Banco de Dados

O projeto usa **MongoDB** com duas coleções principais:

| Coleção | Descrição |
|----------|------------|
| `chats` | Armazena informações sobre conversas (título, status, participantes) |
| `messages` | Armazena todas as mensagens recebidas e enviadas, incluindo metadados e mídias |

Índices automáticos criados para otimizar buscas por:
- `timestamp`
- `chatId`, `chatRefId`
- `waChatId`, `status`, `lastMessageAt`

---

## 🗂️ Estrutura das mensagens no MongoDB

```json
{
  "_id": "671f65a2...",
  "chatRefId": "671f64e2...",
  "direction": "inbound",
  "type": "image",
  "from": "5588999999999@c.us",
  "to": "me",
  "body": null,
  "caption": "Foto da entrega",
  "media": {
    "savedPath": "downloads/2025-11-01/JoaoLima/foto.jpg",
    "mimetype": "image/jpeg",
    "filename": "foto.jpg"
  },
  "timestamp": "2025-11-01T17:00:00.000Z"
}
```

---

## 🧠 Regras de Chat

| Situação | Ação | Status |
|-----------|-------|--------|
| Nova mensagem recebida | Cria chat se não existir | `novo` |
| Primeira resposta enviada | Atualiza status | `em_andamento` |
| Chat finalizado manualmente | Atualiza status | `finalizado` |

---

## 🔁 Sessão e Expiração

- A sessão WhatsApp é **persistente** via `LocalAuth`.
- Arquivos de autenticação: `.wwebjs_auth/wa-cli/`
- Expiração automática: **30 dias sem uso.**
- Você pode transferir o login para outro servidor copiando essa pasta.

---

## 🧰 Ferramentas de Desenvolvimento

- **ts-node-dev** com reload automático:
  ```bash
  npm run dev
  ```
- **Compilação e build:**
  ```bash
  npm run build
  npm start
  ```

---

## 📜 Licença

MIT © 2025 — Desenvolvido por Matheus Lima.
