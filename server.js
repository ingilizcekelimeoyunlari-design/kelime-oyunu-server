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
const leaderboardTimers = {}; // Sıralama güncellemelerini yavaşlatıp sunucuyu korur

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
        rooms[roomCode] = { 
            teacherSocketId: socket.id,
            players: {}, 
            questions: [], 
            status: 'waiting' 
        };
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
            correct: 0, 
            wrong: 0,   
            currentIndex: 0,
            status: 'waiting',
            lastQuestionSentAt: 0
        };

        socket.emit('join_success', { roomCode: roomCode });
        io.to(roomCode).emit('lobby_update', Object.values(room.players));
    });

    // --- OYUNU BAŞLATMA ---
    socket.on('start_game', (data) => {
        const { roomCode, questions } = data;
        const room = rooms[roomCode];
        if (room && room.teacherSocketId === socket.id) {
            room.questions = questions;
            room.status = 'playing';
            
            Object.keys(room.players).forEach(pId => {
                let order = Array.from({length: questions.length}, (_, i) => i);
                room.players[pId].shuffledOrder = order.sort(() => Math.random() - 0.5);
                room.players[pId].status = 'playing';
            });

            io.to(roomCode).emit('game_starting');
            
            // 4.5 Saniye sonra ilk soruları gönder (3-2-1 Fight sesi bitsin diye)
            setTimeout(() => {
                Object.keys(room.players).forEach(pId => sendIndividualQuestion(roomCode, pId));
            }, 4500);
        }
    });

    // --- KİŞİYE ÖZEL SORU GÖNDERME ---
    function sendIndividualQuestion(roomCode, pId) {
        const room = rooms[roomCode];
        if (!room) return;
        const player = room.players[pId];
        
        if (!player || player.currentIndex >= room.questions.length) {
            // Sadece oyundan kopmamışsa bitti de (Kopanlar zaten 'left' durumunda)
            if(player && player.status !== 'left') player.status = 'finished';
            io.to(pId).emit('player_finished');
            requestLeaderboardUpdate(roomCode);
            checkIfGameOver(roomCode);
            return;
        }

        const questionIndex = player.shuffledOrder[player.currentIndex];
        const q = room.questions[questionIndex];
        player.lastQuestionSentAt = Date.now();

        io.to(pId).emit('new_question', {
            questionText: q.questionText,
            options: q.options,
            qNum: player.currentIndex + 1,
            total: room.questions.length
        });
    }

    // --- OYUN BİTTİ Mİ KONTROLÜ (Tüm oyuncular 'finished' veya 'left' ise) ---
    function checkIfGameOver(roomCode) {
        const room = rooms[roomCode];
        if (!room) return;
        const allFinished = Object.values(room.players).every(p => p.status === 'finished' || p.status === 'left');
        if (allFinished && Object.keys(room.players).length > 0) {
            room.status = 'finished';
            if (leaderboardTimers[roomCode]) clearTimeout(leaderboardTimers[roomCode]);
            io.to(roomCode).emit('game_over', { 
                leaderboard: Object.values(room.players).sort((a,b) => b.score - a.score) 
            });
        }
    }

    // --- CEVAP GÖNDERME VE PUANLAMA ---
    socket.on('submit_answer', (data) => {
        const { roomCode, selectedOption } = data;
        const room = rooms[roomCode];
        const player = room ? room.players[socket.id] : null;
        if (!player || player.status !== 'playing') return;

        const currentQ = room.questions[player.shuffledOrder[player.currentIndex]];
        const responseTime = Date.now() - player.lastQuestionSentAt;
        let isCorrect = (selectedOption === currentQ.correctAnswer);

        if (isCorrect) {
            player.correct++;
            player.combo++;
            const timeBonus = Math.max(0, 10000 - responseTime) * 0.05; 
            const comboBonus = player.combo * 50;
            const earnedPoints = Math.floor(500 + timeBonus + comboBonus);
            player.score += earnedPoints;
            socket.emit('answer_feedback', { isCorrect: true, earnedPoints, totalScore: player.score, combo: player.combo });
        } else {
            player.wrong++;
            player.combo = 0;
            // GÜNCELLEME: -100 yerine -500 oldu. Skor eksiye düşmez (Math.max(0, ...))
            player.score = Math.max(0, player.score - 500); 
            socket.emit('answer_feedback', { isCorrect: false, earnedPoints: -500, totalScore: player.score, combo: 0 });
        }
        
        requestLeaderboardUpdate(roomCode);
        player.currentIndex++;
        setTimeout(() => sendIndividualQuestion(roomCode, socket.id), 1500);
    });

    // --- LİDERLİK TABLOSUNU YAVAŞLATARAK GÜNCELLE (Sunucu Performansı) ---
    function requestLeaderboardUpdate(roomCode) {
        if (leaderboardTimers[roomCode]) return;
        leaderboardTimers[roomCode] = setTimeout(() => {
            const room = rooms[roomCode];
            if (room) {
                io.to(roomCode).emit('update_leaderboard', Object.values(room.players).sort((a,b) => b.score - a.score));
            }
            delete leaderboardTimers[roomCode];
        }, 1000); 
    }

    // --- ÖĞRETMEN OYUNU ZORLA BİTİRİR ---
    socket.on('teacher_force_quit', (roomCode) => {
        if(rooms[roomCode] && rooms[roomCode].teacherSocketId === socket.id) {
            io.to(roomCode).emit('game_over', { 
                leaderboard: Object.values(rooms[roomCode].players).sort((a,b) => b.score - a.score) 
            });
            delete rooms[roomCode];
        }
    });

    // --- KOPMA YÖNETİMİ (OYUNCUYU SİLMEME - HAYALET OYUNCU) ---
    socket.on('disconnect', () => {
        for (const roomCode in rooms) {
            const room = rooms[roomCode];
            if (room.teacherSocketId === socket.id) {
                // Eğer öğretmen çıkarsa odayı kapat ve herkese haber ver
                io.to(roomCode).emit('join_error', { message: 'Öğretmen oyundan ayrıldı. Oda kapatıldı.' });
                delete rooms[roomCode];
            } else if (room.players[socket.id]) {
                // Eğer oyuncu çıkarsa onu silme, sadece 'left' olarak işaretle
                // Böylece puanı ve istatistikleri listede kalmaya devam eder
                room.players[socket.id].status = 'left';
                requestLeaderboardUpdate(roomCode);
                checkIfGameOver(roomCode);
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { console.log(`Server Online - Port: ${PORT}`); });
