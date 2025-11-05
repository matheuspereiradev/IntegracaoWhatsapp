import { Server as IOServer } from 'socket.io';
import http from 'http';

let io: IOServer | null = null;

export function initSocket(server: http.Server) {
    if (io) return io;
    io = new IOServer(server);
    io.on('connection', (socket) => {
        console.log('[socket] client connected', socket.id);
        socket.on('join', (room) => {
            try {
                if (!room) return;
                console.log('[socket] join request', { socketId: socket.id, room: String(room) });
                socket.join(String(room));
            } catch (e) {
                console.error('[socket] join error', e);
            }
        });

        socket.on('leave', (room) => {
            try {
                if (!room) return;
                console.log('[socket] leave request', { socketId: socket.id, room: String(room) });
                socket.leave(String(room));
            } catch (e) {
                console.error('[socket] leave error', e);
            }
        });
        socket.on('disconnect', () => console.log('[socket] client disconnected', socket.id));
    });
    return io;
}

export function getIo(): IOServer {
    if (!io) throw new Error('Socket.IO not initialized. Call initSocket(server) first.');
    return io;
}
