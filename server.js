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

// Küfür Filtresi Fonksiyonu
const badWords = ["amk", "aq", "oç", "sik", "siktir", "pic", "yavsak", "fuck", "bitch", "pussy"];
function isNameClean(name) {
    const cleanName = name.replace(/[^a-zA-Zğüşıöç]/gi, '').toLowerCase();
    return !badWords.some(word => cleanName.includes(word));
}

io.on('connection', (socket) => {
    // --- ODA OLUŞTURMA (Öğretmen) ---
    socket.on('create_room', () => {
        const roomCode = Math.floor(100000 + Math.random() * 900000).toString();
        rooms[roomCode] = { 
            players: {}, 
            questions: [], 
            status: 'waiting'
        };
        socket.join(roomCode); 
        socket.emit('room_created', { roomCode: roomCode });
    });

    // --- ODAYA KATILMA (Öğrenci) ---
    socket.on('join_room', (data) => {
        const { roomCode, playerName } = data;
        const room = rooms[roomCode];

        if (!room) return socket.emit('join_error', { message: '❌ Oda bulunamadı! Sunucu uyanıyor olabilir, lütfen tekrar deneyin.' });
        if (room.status !== 'waiting') return socket.emit('join_error', { message: '⛔ Yarışma çoktan başladı!' });
        if (!isNameClean(playerName)) return socket.emit('join_error', { message: '⚠️ Lütfen başka bir isim seçin!' });

        socket.join(roomCode);
        room.players[socket.id] = {
            id: socket.id,
            name: playerName,
            score: 0,
            combo: 0,
            currentIndex: 0,
            status: 'waiting', // waiting, playing, finished
            shuffledOrder: [] // Soruların her oyuncuya özel sırası
        };

        socket.emit('join_success', { roomCode: roomCode, players: Object.values(room.players) });
        socket.to(roomCode).emit('player_joined', { name: playerName });
    });

    // --- OYUNU BAŞLATMA (Öğretmen Sinyali ve 25 Soru) ---
    socket.on('start_game', (data) => {
        const { roomCode, questions } = data;
        const room = rooms[roomCode];

        if (room) {
            room.questions = questions; // Sabit 25 soru
            room.status = 'playing';

            // Her oyuncu için 0-24 arası sayıları karıştır (Soru Sırası)
            Object.keys(room.players).forEach(pId => {
                let order = Array.from({length: questions.length}, (_, i) => i);
                room.players[pId].shuffledOrder = order.sort(() => Math.random() - 0.5);
                room.players[pId].status = 'playing';
            });

            io.to(roomCode).emit('game_starting');
            
            // İlk soruları her oyuncuya özel sırasıyla gönder
            setTimeout(() => {
                Object.keys(room.players).forEach(pId => {
                    sendIndividualQuestion(roomCode, pId);
                });
            }, 3000);
        }
    });

    function sendIndividualQuestion(roomCode, pId) {
        const room = rooms[roomCode];
        const player = room.players[pId];
        if (!player || player.currentIndex >= room.questions.length) {
            player.status = 'finished';
            io.to(pId).emit('player_finished');
            checkRoomFinished(roomCode);
            return;
        }

        const questionIndex = player.shuffledOrder[player.currentIndex];
        const q = room.questions[questionIndex];

        io.to(pId).emit('new_question', {
            questionText: q.questionText,
            options: q.options,
            qNum: player.currentIndex + 1,
            total: room.questions.length,
            startTime: Date.now() // Salise hesabı için başlangıç zamanı
        });
    }

    // --- CEVAP GÖNDERME (Salise Hassasiyeti) ---
    socket.on('submit_answer', (data) => {
        const { roomCode, selectedOption, clientStartTime } = data;
        const room = rooms[roomCode];
        const player = room.players[socket.id];
        
        if (!room || !player || player.status !== 'playing') return;

        const questionIndex = player.shuffledOrder[player.currentIndex];
        const currentQ = room.questions[questionIndex];
        const responseTime = Date.now() - clientStartTime; // Milisaniye cinsinden hız

        let earnedPoints = 0;
        let isCorrect = (selectedOption === currentQ.correctAnswer);

        if (isCorrect) {
            player.combo++;
            // PUAN FORMÜLÜ: Temel 500 + (Kalan Süre Payı) + (Kombo Bonusu)
            // 10 saniye (10000ms) üzerinden hesap
            const timeBonus = Math.max(0, 10000 - responseTime) * 0.1; // Max 1000 puan hızdan
            const comboBonus = player.combo * 50;
            earnedPoints = Math.floor(500 + timeBonus + comboBonus);
            player.score += earnedPoints;
        } else {
            player.combo = 0;
        }

        socket.emit('answer_feedback', { 
            isCorrect, 
            earnedPoints, 
            totalScore: player.score,
            correctAnswer: currentQ.correctAnswer
        });

        // Skor Tablosunu Güncelle (Tüm odaya)
        const leaderboard = Object.values(room.players)
            .sort((a, b) => b.score - a.score);
        io.to(roomCode).emit('update_leaderboard', leaderboard);

        // Hemen sonraki soruya geç (Öğrenci beklemez!)
        player.currentIndex++;
        setTimeout(() => {
            sendIndividualQuestion(roomCode, socket.id);
        }, 1500); // 1.5 saniye feedback görsün
    });

    function checkRoomFinished(roomCode) {
        const room = rooms[roomCode];
        const allFinished = Object.values(room.players).every(p => p.status === 'finished');
        if (allFinished) {
            room.status = 'finished';
        }
    }

    socket.on('disconnect', () => { /* Kopma yönetimi eklenebilir */ });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { console.log(`Wayground Engine running on ${PORT}`); });
