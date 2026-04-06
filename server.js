const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors()); // WordPress sitenden gelen isteklere izin verir

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*", // Her yerden bağlantıya izin ver (Test aşaması)
        methods: ["GET", "POST"]
    }
});

// Birisi bağlandığında çalışır
io.on('connection', (socket) => {
    console.log('Bir öğrenci bağlandı! ID:', socket.id);

    // Bağlanan kişiye "Merhaba" de
    socket.emit('welcome', { message: 'Canlı oyun sunucusuna başarıyla bağlandın!' });

    socket.on('disconnect', () => {
        console.log('Bir öğrenci ayrıldı.');
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Sunucu ${PORT} portunda çalışıyor...`);
});