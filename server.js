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

// 1. İsim Filtresi
const badWords = ["amk", "aq", "oç", "sik", "siktir", "pic", "yavsak"];
function isNameClean(name) {
    if (!name) return false;
    const cleanName = name.replace(/[^a-zA-ZğüşıöçĞÜŞİÖÇ]/gi, '').toLowerCase();
    return !badWords.some(word => cleanName.includes(word));
}

io.on('connection', (socket) => {
    console.log('Sunucu Bağlantısı:', socket.id);

    // ODA KURMA
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
        
        if (!room) return socket.emit('join_error', { message: '❌ Oda bulunamadı!' });
        if (room.status !== 'waiting') return socket.emit('join_error', { message: '⛔ Oyun çoktan başladı!' });
        if (!isNameClean(playerName)) return socket.emit('join_error', { message: '⚠️ Uygunsuz isim!' });

        socket.join(roomCode);
        room.players[socket.id] = { 
            id: socket.id, name: playerName, score: 0, combo: 0, currentIndex: 0 
        };
        io.to(roomCode).emit('lobby_update', { players: Object.values(room.players) });
    });

    // OYUN BAŞLATMA
    socket.on('start_game', (data) => {
        const room = rooms[data.roomCode];
        if (room) {
            room.questions = data.questions;
            room.status = 'playing';
            Object.keys(room.players).forEach(pId => {
                let order = Array.from({length: data.questions.length}, (_, i) => i);
                room.players[pId].shuffledOrder = order.sort(() => Math.random() - 0.5);
            });
            io.to(data.roomCode).emit('game_starting');
            setTimeout(() => { 
                Object.keys(room.players).forEach(pId => sendQuestion(data.roomCode, pId)); 
            }, 4000);
        }
    });

    // SORU GÖNDERME
    function sendQuestion(roomCode, pId) {
        const room = rooms[roomCode];
        const player = room ? room.players[pId] : null;
        if (!player) return;

        if (player.currentIndex >= room.questions.length) {
            io.to(pId).emit('player_finished');
            return;
        }

        const qIdx = player.shuffledOrder[player.currentIndex];
        const q = room.questions[qIdx];
        io.to(pId).emit('new_question', { 
            questionText: q.questionText, 
            options: q.options, 
            qNum: player.currentIndex + 1, 
            total: room.questions.length, 
            startTime: Date.now() 
        });
    }

    // CEVAP KONTROLÜ
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
            // PUANLAMA: 500 + Hız Bonusu + Kombo Bonusu
            const timeBonus = Math.max(0, 10000 - responseTime) * 0.1;
            const comboBonus = player.combo * 50;
            earned = Math.floor(500 + timeBonus + comboBonus);
            player.score += earned;
        } else {
            player.combo = 0;
        }

        // Öğrenciye geri bildirim gönder
        socket.emit('answer_feedback', { 
            isCorrect: isCorrect, 
            correctAnswer: currentQ.correctAnswer, 
            combo: player.combo, 
            totalScore: player.score, 
            earnedPoints: earned 
        });

        player.currentIndex++;
        // Liderlik tablosunu güncelle
        io.to(data.roomCode).emit('update_leaderboard', Object.values(room.players).sort((a,b) => b.score - a.score));
        
        // Sonraki soruyu getir
        setTimeout(() => sendQuestion(data.roomCode, socket.id), 1500);
    });

    socket.on('disconnect', () => { console.log('Bağlantı kesildi'); });
});

server.listen(process.env.PORT || 3000, () => { console.log('Sunucu Yayında (v5.9)'); });
