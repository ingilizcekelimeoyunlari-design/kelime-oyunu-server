const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

const rooms = {};

// Gelişmiş İsim Filtresi
const badWords = ["amk", "aq", "oç", "sik", "siktir", "pic", "yavsak", "fuck", "bitch", "pussy"];
function isNameClean(name) {
    const cleanName = name.replace(/[^a-zA-Zğüşıöç]/gi, '').toLowerCase();
    return !badWords.some(word => cleanName.includes(word));
}

io.on('connection', (socket) => {
    // Oda Kurma
    socket.on('create_room', () => {
        const roomCode = Math.floor(100000 + Math.random() * 900000).toString();
        rooms[roomCode] = { players: {}, questions: [], status: 'waiting', createdAt: Date.now() };
        socket.join(roomCode);
        socket.emit('room_created', { roomCode });
    });

    // Katılma
    socket.on('join_room', (data) => {
        const { roomCode, playerName } = data;
        const room = rooms[roomCode];
        if (!room) return socket.emit('join_error', { message: '❌ Oda yok!' });
        if (room.status !== 'waiting') return socket.emit('join_error', { message: '⛔ Oyun başlamış!' });
        if (!isNameClean(playerName)) return socket.emit('join_error', { message: '⚠️ Uygunsuz isim!' });

        socket.join(roomCode);
        room.players[socket.id] = { id: socket.id, name: playerName, score: 0, combo: 0, currentIndex: 0 };
        io.to(roomCode).emit('lobby_update', { players: Object.values(room.players) });
    });

    // Yarışmayı Başlat
    socket.on('start_game', (data) => {
        const room = rooms[data.roomCode];
        if (room) {
            room.questions = data.questions;
            room.status = 'playing';
            io.to(data.roomCode).emit('game_starting');
            setTimeout(() => { Object.keys(room.players).forEach(pId => sendQuestion(data.roomCode, pId)); }, 4000);
        }
    });

    function sendQuestion(roomCode, pId) {
        const room = rooms[roomCode];
        const player = room ? room.players[pId] : null;
        if (!player || player.currentIndex >= room.questions.length) {
            io.to(pId).emit('player_finished');
            return;
        }
        const q = room.questions[player.currentIndex];
        io.to(pId).emit('new_question', { questionText: q.questionText, options: q.options, qNum: player.currentIndex + 1, total: room.questions.length, startTime: Date.now() });
    }

    socket.on('submit_answer', (data) => {
        const room = rooms[data.roomCode];
        const player = room ? room.players[socket.id] : null;
        if (!player || room.status !== 'playing') return;

        const q = room.questions[player.currentIndex];
        let earned = (data.selectedOption === q.correctAnswer) ? Math.floor(500 + (Math.max(0, 10000 - (Date.now() - data.clientStartTime)) * 0.1) + (player.combo * 50)) : 0;
        
        if (earned > 0) { player.score += earned; player.combo++; } else { player.combo = 0; }
        
        socket.emit('answer_feedback', { isCorrect: earned > 0, correctAnswer: q.correctAnswer, totalScore: player.score, earnedPoints: earned, combo: player.combo });
        player.currentIndex++;
        io.to(data.roomCode).emit('update_leaderboard', Object.values(room.players).sort((a,b) => b.score - a.score));
        setTimeout(() => sendQuestion(data.roomCode, socket.id), 1500);
    });

    socket.on('teacher_force_quit', (roomCode) => {
        if(rooms[roomCode]) {
            io.to(roomCode).emit('game_over', { winners: Object.values(rooms[roomCode].players).sort((a,b) => b.score - a.score).slice(0, 3) });
            delete rooms[roomCode];
        }
    });
});

server.listen(process.env.PORT || 3000, () => console.log('v5.8 Active'));
