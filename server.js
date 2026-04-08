const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

const rooms = {};
const badWords = ["amk", "aq", "oç", "sik", "siktir", "pic", "yavsak", "fuck", "bitch", "pussy"];

function isNameClean(name) {
    if (!name) return false;
    const clean = name.replace(/[^a-zA-ZğüşıöçĞÜŞİÖÇ]/gi, '').toLowerCase();
    return !badWords.some(w => clean.includes(w));
}

io.on('connection', (socket) => {
    socket.on('create_room', () => {
        const roomCode = Math.floor(100000 + Math.random() * 900000).toString();
        rooms[roomCode] = { players: {}, questions: [], status: 'waiting' };
        socket.join(roomCode);
        socket.emit('room_created', { roomCode });
    });

    socket.on('join_room', (data) => {
        const room = rooms[data.roomCode];
        if (!room) return socket.emit('join_error', { message: '❌ Oda bulunamadı!' });
        if (room.status !== 'waiting') return socket.emit('join_error', { message: '⛔ Oyun başladı!' });
        if (!isNameClean(data.playerName)) return socket.emit('join_error', { message: '⚠️ Uygunsuz isim!' });

        socket.join(data.roomCode);
        room.players[socket.id] = { id: socket.id, name: data.playerName, score: 0, combo: 0, currentIndex: 0, status: 'playing' };
        io.to(data.roomCode).emit('lobby_update', { players: Object.values(room.players) });
    });

    socket.on('start_game', (data) => {
        const room = rooms[data.roomCode];
        if (room) {
            room.questions = data.questions;
            room.status = 'playing';
            Object.keys(room.players).forEach(pId => {
                let order = Array.from({length: data.questions.length}, (_, i) => i);
                room.players[pId].shuffledOrder = order.sort(() => Math.random() - 0.5);
                room.players[pId].status = 'playing';
            });
            io.to(data.roomCode).emit('game_starting');
            setTimeout(() => { Object.keys(room.players).forEach(pId => sendQuestion(data.roomCode, pId)); }, 4000);
        }
    });

    function sendQuestion(roomCode, pId) {
        const room = rooms[roomCode];
        const player = room ? room.players[pId] : null;
        if (!player) return;
        if (player.currentIndex >= room.questions.length) {
            player.status = 'finished';
            io.to(pId).emit('player_finished');
            return;
        }
        const q = room.questions[player.shuffledOrder[player.currentIndex]];
        io.to(pId).emit('new_question', { questionText: q.questionText, options: q.options, qNum: player.currentIndex + 1, total: room.questions.length, startTime: Date.now() });
    }

    socket.on('submit_answer', (data) => {
        const room = rooms[data.roomCode];
        const player = room ? room.players[socket.id] : null;
        if (!player || room.status !== 'playing') return;

        const q = room.questions[player.shuffledOrder[player.currentIndex]];
        const resTime = Date.now() - data.clientStartTime;
        let isCorrect = (data.selectedOption === q.correctAnswer);
        let earned = isCorrect ? Math.floor(500 + Math.max(0, 10000 - resTime) * 0.1 + (player.combo * 50)) : 0;
        
        if (isCorrect) { player.combo++; player.score += earned; } else { player.combo = 0; }
        
        socket.emit('answer_feedback', { isCorrect, correctAnswer: q.correctAnswer, combo: player.combo, totalScore: player.score, earnedPoints: earned });
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
server.listen(process.env.PORT || 3000, () => console.log('v6.0 MASTER ONLINE'));
