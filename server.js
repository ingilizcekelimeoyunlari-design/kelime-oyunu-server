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

io.on('connection', (socket) => {
    
    // --- 1. ODA OLUŞTURMA ---
    socket.on('create_room', () => {
        const roomCode = Math.floor(100000 + Math.random() * 900000).toString();
        rooms[roomCode] = { 
            teacherSocketId: socket.id,
            teacherDisconnectTimeout: null, // Kopma toleransı için zamanlayıcı
            players: {}, 
            questions:[], 
            status: 'waiting' 
        };
        socket.join(roomCode); 
        socket.emit('room_created', { roomCode: roomCode });
    });

    // --- 2. ÖĞRETMEN YENİDEN BAĞLANMA (SAYFA YENİLEME / KOPMA KORUMASI) ---
    socket.on('teacher_reconnect', (data) => {
        const { roomCode } = data;
        const room = rooms[roomCode];
        
        if (room) {
            // Eğer öğretmen için silinme sayacı başladıysa iptal et
            if (room.teacherDisconnectTimeout) {
                clearTimeout(room.teacherDisconnectTimeout);
                room.teacherDisconnectTimeout = null;
            }

            room.teacherSocketId = socket.id; // Yeni soketi kaydet
            socket.join(roomCode);
            
            // Öğretmene odanın güncel durumunu gönder
            socket.emit('teacher_reconnected_success', {
                status: room.status,
                players: Object.values(room.players)
            });

            // Ekranı güncelle
            if (room.status === 'waiting') {
                socket.emit('lobby_update', Object.values(room.players));
            } else if (room.status === 'playing') {
                socket.emit('update_leaderboard', Object.values(room.players).sort((a,b) => b.score - a.score));
            }
        }
    });

    // --- 3. ÖĞRENCİYİ ODADAN ATMA (KICK) ---
    socket.on('kick_player', (data) => {
        const { roomCode, playerId } = data;
        const room = rooms[roomCode];

        // İsteğin gerçekten o odanın öğretmeninden geldiğinden emin ol
        if (room && room.teacherSocketId === socket.id) {
            if (room.players[playerId]) {
                // 1. Hedef öğrenciye atıldığını bildir
                io.to(playerId).emit('kicked_out', 'Öğretmen tarafından odadan çıkarıldınız.');
                
                // 2. Hedef öğrenciyi odadan çıkmaya zorla
                const targetSocket = io.sockets.sockets.get(playerId);
                if (targetSocket) targetSocket.leave(roomCode);

                // 3. Odanın hafızasından sil
                delete room.players[playerId];

                // 4. Öğretmenin ve diğer öğrencilerin listesini anında güncelle
                if (room.status === 'waiting') {
                    io.to(roomCode).emit('lobby_update', Object.values(room.players));
                } else if (room.status === 'playing') {
                    requestLeaderboardUpdate(roomCode);
                    checkIfGameOver(roomCode);
                }
            }
        }
    });

    // --- 4. ODAYA KATILMA (ÖĞRENCİ) ---
    socket.on('join_room', (data) => {
        const { roomCode, playerName } = data;
        const room = rooms[roomCode];

        if (!room) return socket.emit('join_error', { message: '❌ Oda bulunamadı veya süresi doldu!' });
        if (room.status !== 'waiting') return socket.emit('join_error', { message: '⛔ Yarışma çoktan başladı!' });

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

    // --- 5. OYUNU BAŞLATMA ---
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

    // --- 6. KİŞİYE ÖZEL SORU GÖNDERME ---
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

    // --- 7. OYUN BİTTİ Mİ KONTROLÜ ---
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

    // --- 8. CEVAP GÖNDERME VE PUANLAMA ---
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

    // --- 9. KOPMA YÖNETİMİ (DISCONNECT) ---
    socket.on('disconnect', () => {
        for (const roomCode in rooms) {
            const room = rooms[roomCode];
            
            if (room.teacherSocketId === socket.id) {
                // ÖĞRETMEN KOPTU VEYA SAYFAYI YENİLEDİ: Hemen silme, 60 saniye bekle!
                room.teacherDisconnectTimeout = setTimeout(() => {
                    io.to(roomCode).emit('join_error', { message: 'Öğretmen oyundan ayrıldı. Oda kapatıldı.' });
                    delete rooms[roomCode];
                }, 60000); // 60 Saniye süre

            } else if (room.players[socket.id]) {
                // ÖĞRENCİ KOPTU: Hayalet oyuncu olarak kalır (Puanı silinmez)
                room.players[socket.id].status = 'left';
                requestLeaderboardUpdate(roomCode);
                checkIfGameOver(roomCode);
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { console.log(`Server Online - Port: ${PORT}`); });
