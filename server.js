const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

const rooms = {};

io.on('connection', (socket) => {
    // ODA OLUŞTURMA
    socket.on('create_room', () => {
        const roomCode = Math.floor(100000 + Math.random() * 900000).toString();
        rooms[roomCode] = { players: {}, questions: [], status: 'waiting' };
        socket.join(roomCode);
        socket.emit('room_created', { roomCode });
    });

    // ODAYA KATILMA
    socket.on('join_room', (data) => {
        const { roomCode, playerName } = data;
        const room = rooms[roomCode];
        if (!room) return socket.emit('join_error', { message: '❌ Geçersiz Kod!' });
        if (room.status !== 'waiting') return socket.emit('join_error', { message: '⛔ Yarışma başladı!' });

        socket.join(roomCode);
        room.players[socket.id] = { id: socket.id, name: playerName, score: 0, currentIndex: 0 };
        io.to(roomCode).emit('lobby_update', { players: Object.values(room.players) });
    });

    // BAŞLATMA
    socket.on('start_game', (data) => {
        const { roomCode, questions } = data;
        if (rooms[roomCode]) {
            rooms[roomCode].questions = questions;
            rooms[roomCode].status = 'playing';
            io.to(roomCode).emit('game_starting');
            Object.keys(rooms[roomCode].players).forEach(pId => sendQuestion(roomCode, pId));
        }
    });

    function sendQuestion(roomCode, pId) {
        const room = rooms[roomCode];
        if (!room || !room.players[pId]) return;
        const p = room.players[pId];
        if (p.currentIndex >= room.questions.length) return io.to(pId).emit('game_over');
        
        const q = room.questions[p.currentIndex];
        io.to(pId).emit('new_question', { ...q, qNum: p.currentIndex + 1 });
    }

    socket.on('submit_answer', (data) => {
        const { roomCode, selectedOption } = data;
        const room = rooms[roomCode];
        if (room && room.players[socket.id]) {
            const p = room.players[socket.id];
            if (selectedOption === room.questions[p.currentIndex].correctAnswer) p.score += 500;
            p.currentIndex++;
            sendQuestion(roomCode, socket.id);
        }
    });

    socket.on('disconnect', () => {
        // Temizlik: 1 saat sonra boş odaları silen bir interval eklenebilir
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Wayground Server Running on ${PORT}`));
