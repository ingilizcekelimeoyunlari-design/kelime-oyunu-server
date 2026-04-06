const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

const rooms = {};

// Küfür Filtresi
const badWords = ["amk", "aq", "oç", "sik", "siktir", "pic", "yavsak", "fuck", "bitch", "pussy"];
function isNameClean(name) {
    const cleanName = name.replace(/[^a-zA-Zğüşıöç]/gi, '').toLowerCase();
    return !badWords.some(word => cleanName.includes(word));
}

io.on('connection', (socket) => {
    // --- ODA OLUŞTURMA ---
    socket.on('create_room', () => {
        const roomCode = Math.floor(100000 + Math.random() * 900000).toString();
        rooms[roomCode] = { players: {}, questions: [], status: 'waiting' };
        socket.join(roomCode); 
        socket.emit('room_created', { roomCode: roomCode });
    });

    // --- ODAYA KATILMA ---
    socket.on('join_room', (data) => {
        const { roomCode, playerName } = data;
        const room = rooms[roomCode];

        if (!room) return socket.emit('join_error', { message: '❌ Oda bulunamadı!' });
        if (room.status !== 'waiting') return socket.emit('join_error', { message: '⛔ Yarışma başladı!' });
        if (!isNameClean(playerName)) return socket.emit('join_error', { message: '⚠️ Uygunsuz isim!' });

        socket.join(roomCode);
        room.players[socket.id] = {
            id: socket.id,
            name: playerName,
            score: 0,
            combo: 0,
            currentIndex: 0,
            status: 'waiting'
        };

        // Katılan kişiye tam listeyi gönder, diğerlerine yeni kişiyi haber ver
        io.to(roomCode).emit('lobby_update', Object.values(room.players));
    });

    // --- OYUNU BAŞLATMA ---
    socket.on('start_game', (data) => {
        const { roomCode, questions } = data;
        const room = rooms[roomCode];
        if (room) {
            room.questions = questions;
            room.status = 'playing';
            Object.keys(room.players).forEach(pId => {
                let order = Array.from({length: questions.length}, (_, i) => i);
                room.players[pId].shuffledOrder = order.sort(() => Math.random() - 0.5);
                room.players[pId].status = 'playing';
            });
            io.to(roomCode).emit('game_starting');
            setTimeout(() => {
                Object.keys(room.players).forEach(pId => sendIndividualQuestion(roomCode, pId));
            }, 3000);
        }
    });

    function sendIndividualQuestion(roomCode, pId) {
        const room = rooms[roomCode];
        const player = room.players[pId];
        if (!player || player.currentIndex >= room.questions.length) {
            if(player) player.status = 'finished';
            io.to(pId).emit('player_finished');
            io.to(roomCode).emit('update_leaderboard', Object.values(room.players).sort((a,b) => b.score - a.score));
            return;
        }
        const questionIndex = player.shuffledOrder[player.currentIndex];
        const q = room.questions[questionIndex];
        io.to(pId).emit('new_question', {
            questionText: q.questionText,
            options: q.options,
            qNum: player.currentIndex + 1,
            total: room.questions.length,
            startTime: Date.now()
        });
    }

    // --- CEVAP GÖNDERME ---
    socket.on('submit_answer', (data) => {
        const { roomCode, selectedOption, clientStartTime } = data;
        const room = rooms[roomCode];
        const player = room ? room.players[socket.id] : null;
        if (!player || player.status !== 'playing') return;

        const currentQ = room.questions[player.shuffledOrder[player.currentIndex]];
        const responseTime = Date.now() - clientStartTime;
        let isCorrect = (selectedOption === currentQ.correctAnswer);

        if (isCorrect) {
            player.combo++;
            const timeBonus = Math.max(0, 10000 - responseTime) * 0.1;
            const comboBonus = player.combo * 50;
            const earnedPoints = Math.floor(500 + timeBonus + comboBonus);
            player.score += earnedPoints;
            socket.emit('answer_feedback', { isCorrect: true, earnedPoints, totalScore: player.score, combo: player.combo });
        } else {
            player.combo = 0;
            socket.emit('answer_feedback', { isCorrect: false, earnedPoints: 0, totalScore: player.score, combo: 0 });
        }

        io.to(roomCode).emit('update_leaderboard', Object.values(room.players).sort((a,b) => b.score - a.score));
        player.currentIndex++;
        setTimeout(() => sendIndividualQuestion(roomCode, socket.id), 1200);
    });

    // --- ÖĞRETMEN OYUNU ZORLA BİTİRİR ---
    socket.on('teacher_force_quit', (roomCode) => {
        if(rooms[roomCode]) {
            io.to(roomCode).emit('game_over', { leaderboard: Object.values(rooms[roomCode].players).sort((a,b) => b.score - a.score) });
            delete rooms[roomCode];
        }
    });

    socket.on('disconnect', () => { /* Kopma yönetimi */ });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { console.log(`Server Online`); });
