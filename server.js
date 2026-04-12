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
    
    // --- ODA OLUŞTURMA (ÖĞRETMEN) ---
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

    // --- ODAYA KATILMA (ÖĞRENCİ) ---
    socket.on('join_room', (data) => {
        const { roomCode, playerName } = data;
        const room = rooms[roomCode];

        if (!room) return socket.emit('join_error', { message: '❌ Oda bulunamadı veya kapandı!' });
        if (room.status !== 'waiting') return socket.emit('join_error', { message: '⛔ Yarışma zaten başladı!' });
        if (!isNameClean(playerName)) return socket.emit('join_error', { message: '⚠️ Uygunsuz isim kullanımı!' });

        socket.join(roomCode);
        room.players[socket.id] = {
            id: socket.id,
            name: playerName,
            score: 0,
            combo: 0,
            correct: 0, // Yeni: Doğru sayısı
            wrong: 0,   // Yeni: Yanlış sayısı
            currentIndex: 0,
            status: 'playing',
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
            
            setTimeout(() => {
                Object.keys(room.players).forEach(pId => sendIndividualQuestion(roomCode, pId));
            }, 4500); 
        }
    });

    function sendIndividualQuestion(roomCode, pId) {
        const room = rooms[roomCode];
        if (!room) return;
        const player = room.players[pId];
        
        if (!player || player.currentIndex >= room.questions.length) {
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

    function checkIfGameOver(roomCode) {
        const room = rooms[roomCode];
        if (!room) return;
        const allFinished = Object.values(room.players).every(p => p.status === 'finished' || p.status === 'left');
        if (allFinished) {
            room.status = 'finished';
            if (leaderboardTimers[roomCode]) clearTimeout(leaderboardTimers[roomCode]);
            io.to(roomCode).emit('game_over', { leaderboard: Object.values(room.players).sort((a,b) => b.score - a.score) });
        }
    }

    // --- CEVAP GÖNDERME VE PUANLAMA ---
    socket.on('submit_answer', (data) => {
        const { roomCode, selectedOption } = data;
        const room = rooms[roomCode];
        if (!room) return;
        
        const player = room.players[socket.id];
        if (!player || player.status !== 'playing') return;

        const currentQ = room.questions[player.shuffledOrder[player.currentIndex]];
        const responseTime = Date.now() - player.lastQuestionSentAt; 
        let isCorrect = (selectedOption === currentQ.correctAnswer);

        if (isCorrect) {
            player.correct++; // Doğruyu artır
            player.combo++;
            const timeBonus = Math.max(0, 10000 - responseTime) * 0.05; 
            const comboBonus = player.combo * 50;
            const earnedPoints = Math.floor(500 + timeBonus + comboBonus);
            player.score += earnedPoints;
            socket.emit('answer_feedback', { isCorrect: true, earnedPoints, totalScore: player.score, combo: player.combo });
        } else {
            player.wrong++; // Yanlışı artır
            player.combo = 0;
            player.score = Math.max(0, player.score - 100); 
            socket.emit('answer_feedback', { isCorrect: false, earnedPoints: -100, totalScore: player.score, combo: 0 });
        }

        requestLeaderboardUpdate(roomCode);
        player.currentIndex++;
        setTimeout(() => sendIndividualQuestion(roomCode, socket.id), 1500);
    });

    // --- LİDERLİK TABLOSU GÜNCELLEME (Hafifletilmiş) ---
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
            io.to(roomCode).emit('game_over', { leaderboard: Object.values(rooms[roomCode].players).sort((a,b) => b.score - a.score) });
            delete rooms[roomCode];
        }
    });

    // --- KOPMA YÖNETİMİ (OYUNCUYU LİSTEDE TUTAN KISIM) ---
    socket.on('disconnect', () => {
        for (const roomCode in rooms) {
            const room = rooms[roomCode];
            
            if (room.teacherSocketId === socket.id) {
                io.to(roomCode).emit('join_error', { message: 'Öğretmen oyundan ayrıldı.' });
                delete rooms[roomCode];
                continue;
            }
            
            if (room.players[socket.id]) {
                // KRİTİK: Oyuncuyu silmiyoruz, sadece 'left' (ayrıldı) diyoruz.
                // Böylece liderlik tablosunda puanı ve ismi kalmaya devam ediyor.
                room.players[socket.id].status = 'left';
                requestLeaderboardUpdate(roomCode);
                checkIfGameOver(roomCode);
            }
        }
    });
});
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { console.log(`Server Online - Port: ${PORT}`); });
