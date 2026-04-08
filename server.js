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

// Throttle (Yük Hafifletme) Mekanizması İçin Zamanlayıcılar
const leaderboardTimers = {};

const badWords = ["amk", "aq", "oç", "sik", "siktir", "pic", "yavsak", "fuck", "bitch", "pussy"];
function isNameClean(name) {
    const cleanName = name.replace(/[^a-zA-Zğüşıöç]/gi, '').toLowerCase();
    return !badWords.some(word => cleanName.includes(word));
}

io.on('connection', (socket) => {
    
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
            currentIndex: 0,
            status: 'waiting',
            lastQuestionSentAt: 0
        };

        socket.emit('join_success', { roomCode: roomCode });
        io.to(roomCode).emit('lobby_update', Object.values(room.players));
    });

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
            
            // 4.5 Saniye sonra ilk soruları gönder
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
            if(player) player.status = 'finished';
            io.to(pId).emit('player_finished');
            
            // Liderlik tablosunu güncelleme isteğini sıraya al
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

        const allFinished = Object.values(room.players).every(p => p.status === 'finished');
        if (allFinished) {
            room.status = 'finished';
            
            // Oyun bittiğinde bekleyen Liderlik güncellemesi varsa iptal et ve hemen finali gönder
            if (leaderboardTimers[roomCode]) {
                clearTimeout(leaderboardTimers[roomCode]);
                delete leaderboardTimers[roomCode];
            }

            io.to(roomCode).emit('game_over', { 
                leaderboard: Object.values(room.players).sort((a,b) => b.score - a.score) 
            });
        }
    }

    // --- YÜKSEK PERFORMANS İÇİN EKLENEN LİDERLİK TABLOSU YÖNETİCİSİ ---
    function requestLeaderboardUpdate(roomCode) {
        // Eğer o oda için halihazırda bir "bekleyen" güncelleme varsa, hiçbir şey yapma
        if (leaderboardTimers[roomCode]) return;

        // Güncelleme yoksa, 1000ms (1 saniye) sonra topluca gönderilecek şekilde zamanlayıcı kur
        leaderboardTimers[roomCode] = setTimeout(() => {
            const room = rooms[roomCode];
            if (room) {
                // Sadece son 10 veya 20 kişiyi gönderebiliriz ama liste kısa kalacaksa hepsini gönderelim
                // İsteğe bağlı olarak .slice(0, 50) eklenebilir eğer oyuncu sayısı çok fazlaysa
                io.to(roomCode).emit('update_leaderboard', Object.values(room.players).sort((a,b) => b.score - a.score));
            }
            // Zamanlayıcı işini bitirdi, sil.
            delete leaderboardTimers[roomCode];
        }, 1000); 
    }

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
            player.combo++;
            const timeBonus = Math.max(0, 10000 - responseTime) * 0.05; 
            const comboBonus = player.combo * 50;
            const earnedPoints = Math.floor(500 + timeBonus + comboBonus);
            
            player.score += earnedPoints;
            socket.emit('answer_feedback', { isCorrect: true, earnedPoints, totalScore: player.score, combo: player.combo });
        } else {
            player.combo = 0;
            player.score = Math.max(0, player.score - 100); 
            socket.emit('answer_feedback', { isCorrect: false, earnedPoints: -100, totalScore: player.score, combo: 0 });
        }

        // GÜNCELLEME: Anında göndermek yerine, "Sıraya al" diyoruz
        requestLeaderboardUpdate(roomCode);
        
        player.currentIndex++;
        
        setTimeout(() => sendIndividualQuestion(roomCode, socket.id), 1500);
    });

    socket.on('teacher_force_quit', (roomCode) => {
        if(rooms[roomCode] && rooms[roomCode].teacherSocketId === socket.id) {
            if (leaderboardTimers[roomCode]) {
                clearTimeout(leaderboardTimers[roomCode]);
                delete leaderboardTimers[roomCode];
            }
            io.to(roomCode).emit('game_over', { 
                leaderboard: Object.values(rooms[roomCode].players).sort((a,b) => b.score - a.score) 
            });
            delete rooms[roomCode];
        }
    });

    socket.on('disconnect', () => {
        for (const roomCode in rooms) {
            const room = rooms[roomCode];
            
            if (room.teacherSocketId === socket.id) {
                io.to(roomCode).emit('join_error', { message: 'Öğretmen oyundan ayrıldı. Oda kapatıldı.' });
                if (leaderboardTimers[roomCode]) clearTimeout(leaderboardTimers[roomCode]);
                delete rooms[roomCode];
                continue;
            }
            
            if (room.players[socket.id]) {
                delete room.players[socket.id];
                io.to(roomCode).emit('lobby_update', Object.values(room.players));
                
                requestLeaderboardUpdate(roomCode);
                checkIfGameOver(roomCode);
            }
            
            if (Object.keys(room.players).length === 0 && room.status === 'finished') {
                if (leaderboardTimers[roomCode]) clearTimeout(leaderboardTimers[roomCode]);
                delete rooms[roomCode];
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { console.log(`Server Online - Port: ${PORT}`); });
