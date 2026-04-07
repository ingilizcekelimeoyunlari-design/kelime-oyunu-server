/** 
 * PROJE: ONLINE WORD GAME - MASTER V5.9 (FULL DETAY)
 * Bu kod, 700+ satırlık bir operasyonu tek bir merkezden yöneten sistemdir.
 */

// 1. NODE.JS SERVER (Beyin) - Ayrı bir dosya veya GitHub server.js için
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

const rooms = {};

// Gelişmiş Filtreleme
const badWords = ["amk", "aq", "oç", "sik", "siktir", "pic", "yavsak"];
function isNameClean(name) {
    if(!name) return false;
    const clean = name.replace(/[^a-zA-Zğüşıöç]/gi, '').toLowerCase();
    return !badWords.some(w => clean.includes(w));
}

io.on('connection', (socket) => {
    // Oda Yönetimi
    socket.on('create_room', () => {
        const roomCode = Math.floor(100000 + Math.random() * 900000).toString();
        rooms[roomCode] = { players: {}, questions: [], status: 'waiting' };
        socket.join(roomCode);
        socket.emit('room_created', { roomCode });
    });

    // Lobi Yönetimi
    socket.on('join_room', (data) => {
        const room = rooms[data.roomCode];
        if (!room) return socket.emit('join_error', { message: '❌ Oda yok!' });
        if (room.status !== 'waiting') return socket.emit('join_error', { message: '⛔ Oyun başladı!' });
        if (!isNameClean(data.playerName)) return socket.emit('join_error', { message: '⚠️ Uygunsuz isim!' });

        socket.join(data.roomCode);
        room.players[socket.id] = { id: socket.id, name: data.playerName, score: 0, combo: 0, currentIndex: 0, status: 'playing' };
        io.to(data.roomCode).emit('lobby_update', { players: Object.values(room.players) });
    });

    // Oyun Başlatma (25 Soru)
    socket.on('start_game', (data) => {
        const room = rooms[data.roomCode];
        if (room) {
            room.questions = data.questions;
            room.status = 'playing';
            Object.keys(room.players).forEach(pId => {
                room.players[pId].shuffledOrder = Array.from({length: data.questions.length}, (_, i) => i).sort(() => Math.random() - 0.5);
            });
            io.to(data.roomCode).emit('game_starting');
            setTimeout(() => { Object.keys(room.players).forEach(pId => sendQuestion(data.roomCode, pId)); }, 4000);
        }
    });

    function sendQuestion(roomCode, pId) {
        const room = rooms[roomCode];
        const player = room ? room.players[pId] : null;
        if (!player || player.currentIndex >= room.questions.length) {
            if(player) player.status = 'finished';
            io.to(pId).emit('player_finished');
            return;
        }
        const qIdx = player.shuffledOrder[player.currentIndex];
        const q = room.questions[qIdx];
        io.to(pId).emit('new_question', { questionText: q.questionText, options: q.options, qNum: player.currentIndex + 1, total: room.questions.length, startTime: Date.now() });
    }

    socket.on('submit_answer', (data) => {
        const room = rooms[data.roomCode];
        const player = room ? room.players[socket.id] : null;
        if (!player || room.status !== 'playing') return;

        const qIdx = player.shuffledOrder[player.currentIndex];
        const currentQ = room.questions[qIdx];
        const responseTime = Date.now() - data.clientStartTime;
        let isCorrect = (data.selectedOption === currentQ.correctAnswer);
        let earned = 0;

        if (isCorrect) {
            player.combo++;
            earned = Math.floor(500 + (Math.max(0, 10000 - responseTime) * 0.1) + (player.combo * 50));
            player.score += earned;
        } else { player.combo = 0; }

        socket.emit('answer_feedback', { isCorrect, correctAnswer: currentQ.correctAnswer, combo: player.combo, totalScore: player.score, earnedPoints: earned });
        player.currentIndex++;
        io.to(data.roomCode).emit('update_leaderboard', Object.values(room.players).sort((a,b) => b.score - a.score));
        setTimeout(() => sendQuestion(data.roomCode, socket.id), 1500);
    });

    socket.on('teacher_force_quit', (roomCode) => {
        if(rooms[roomCode]) {
            const lb = Object.values(rooms[roomCode].players).sort((a,b) => b.score - a.score);
            io.to(roomCode).emit('game_over', { winners: lb.slice(0, 3) });
            delete rooms[roomCode];
        }
    });
});
server.listen(3000, () => console.log('Master Engine v5.9 Online'));
