import express from 'express';
import { createServer as createViteServer } from 'vite';
import { createServer } from 'http';
import { Server } from 'socket.io';

async function startServer() {
  const app = express();
  const server = createServer(app);
  const io = new Server(server, {
    cors: {
      origin: '*',
    },
  });

  const PORT = 3000;

  // Store active sessions
  // Map of 6-digit code to session info
  const sessions = new Map<string, { senderId: string; filesInfo: any[] }>();

  io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // Sender creates a session
    socket.on('create-session', (data: { filesInfo: any[] }, callback) => {
      // Generate a random 6-digit code
      let code;
      do {
        code = Math.floor(100000 + Math.random() * 900000).toString();
      } while (sessions.has(code));

      sessions.set(code, { senderId: socket.id, filesInfo: data.filesInfo });
      
      // Join a room with the code
      socket.join(code);
      
      console.log(`Session created: ${code} by ${socket.id}`);
      callback({ code });
    });

    // Receiver joins a session
    socket.on('join-session', (code: string, callback) => {
      const session = sessions.get(code);
      if (session) {
        socket.join(code);
        console.log(`User ${socket.id} joined session ${code}`);
        
        // Notify sender that a receiver joined
        io.to(session.senderId).emit('receiver-joined', { receiverId: socket.id });
        
        callback({ success: true, filesInfo: session.filesInfo });
      } else {
        callback({ success: false, error: 'Session not found or expired' });
      }
    });

    // WebRTC Signaling
    socket.on('webrtc-offer', (data: { target: string; offer: any }) => {
      io.to(data.target).emit('webrtc-offer', {
        sender: socket.id,
        offer: data.offer,
      });
    });

    socket.on('webrtc-answer', (data: { target: string; answer: any }) => {
      io.to(data.target).emit('webrtc-answer', {
        sender: socket.id,
        answer: data.answer,
      });
    });

    socket.on('webrtc-ice-candidate', (data: { target: string; candidate: any }) => {
      io.to(data.target).emit('webrtc-ice-candidate', {
        sender: socket.id,
        candidate: data.candidate,
      });
    });

    socket.on('cancel-session', (code: string) => {
      const session = sessions.get(code);
      if (session && session.senderId === socket.id) {
        sessions.delete(code);
        io.to(code).emit('session-closed');
        console.log(`Session cancelled: ${code}`);
      }
    });

    socket.on('disconnect', () => {
      console.log('User disconnected:', socket.id);
      // Clean up sessions where this user was the sender
      for (const [code, session] of sessions.entries()) {
        if (session.senderId === socket.id) {
          sessions.delete(code);
          io.to(code).emit('session-closed');
        }
      }
    });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static('dist'));
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
