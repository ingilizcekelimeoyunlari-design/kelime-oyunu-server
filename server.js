const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
// Tüm sitelerden (Cross-Origin) gelen isteklere izin ver
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

// Aktif odaları ve performans zamanlayıcılarını tutan hafıza
const rooms = {};
const leaderboardTimers = {}; 

// Küfür Filtresi (Öğrencilerin uygunsuz isimlerle girmesini engeller)
const badWords = ["amk", "aq", "oç", "sik", "siktir", "pic", "yavsak", "fuck", "bitch", "pussy", "kasar"];
function isNameClean(name) {
    const cleanName = name.replace(/[^a-zA-Zğüşıöç]/gi, '').toLowerCase();
    return !badWords.some(word => cleanName.includes(word));
}

io.on('connection', (socket) => {
    
    // ==========================================
    // 1. ODA OLUŞTURMA (ÖĞRETMEN BAĞLANTISI)
    // ==========================================
    socket.on('create_room', () => {
        // 6 haneli rastgele ve benzersiz oda kodu
        let roomCode;
        do {
            roomCode = Math.floor(100000 + Math.random() * 900000).toString();
        } while (rooms[roomCode]);

        rooms[roomCode] = { 
            teacherSocketId: socket.id,
            teacherDisconnectTimeout: null, 
            gameType: 'arena', // Varsayılan oyun türü
            players: {}, 
            questions: [], 
            status: 'waiting',
            gameState: {} // Dots & Boxes gibi oyunlar için anlık tahta durumu
        };
        
        socket.join(roomCode); 
        socket.emit('room_created', { roomCode: roomCode });
        console.log(`[ODA KURULDU] Kod: ${roomCode} | Öğretmen: ${socket.id}`);
    });

    // ==========================================
    // 2. ÖĞRETMEN KOPMA VE YENİDEN BAĞLANMA (HAYAT KURTARAN FİX)
    // ==========================================
    socket.on('teacher_reconnect', (data) => {
        const { roomCode } = data;
        const room = rooms[roomCode];
        
        if (room) {
            if (room.teacherDisconnectTimeout) {
                clearTimeout(room.teacherDisconnectTimeout);
                room.teacherDisconnectTimeout = null;
            }

            room.teacherSocketId = socket.id; 
            socket.join(roomCode);
            
            socket.emit('teacher_reconnected_success', {
                status: room.status,
                players: Object.values(room.players)
            });

            if (room.status === 'waiting') {
                socket.emit('lobby_update', Object.values(room.players));
            } else if (room.status === 'playing') {
                socket.emit('update_leaderboard', Object.values(room.players).sort((a,b) => b.score - a.score));
            }
            console.log(`[ÖĞRETMEN DÖNDÜ] Oda: ${roomCode}`);
        } else {
            socket.emit('join_error', { message: 'Oda bulunamadı veya kapatılmış.' });
        }
    });

    // ==========================================
    // 3. ÖĞRENCİ ODAYA KATILMA
    // ==========================================
    socket.on('join_room', (data) => {
        const { roomCode, playerName, playerSection } = data;
        const room = rooms[roomCode];

        if (!room) return socket.emit('join_error', { message: '❌ Oda bulunamadı veya süresi doldu!' });
        if (room.status !== 'waiting') return socket.emit('join_error', { message: '⛔ Yarışma çoktan başladı, girişler kapalı!' });
        if (!isNameClean(playerName)) return socket.emit('join_error', { message: '⚠️ Lütfen gerçek ve uygun bir isim kullanın!' });

        socket.join(roomCode);
        room.players[socket.id] = {
            id: socket.id,
            name: playerName,
            section: playerSection || 'A',
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
        console.log(`[ÖĞRENCİ KATILDI] ${playerName} -> Oda: ${roomCode}`);
    });

    // ==========================================
    // 4. ÖĞRENCİYİ ODADAN ATMA (KICK)
    // ==========================================
    socket.on('kick_player', (data) => {
        const { roomCode, playerId } = data;
        const room = rooms[roomCode];

        if (room && room.teacherSocketId === socket.id) {
            if (room.players[playerId]) {
                io.to(playerId).emit('kicked_out', 'Öğretmen tarafından odadan çıkarıldınız.');
                delete room.players[playerId];

                const targetSocket = io.sockets.sockets.get(playerId);
                if (targetSocket) targetSocket.leave(roomCode);

                if (room.status === 'waiting') {
                    io.to(roomCode).emit('lobby_update', Object.values(room.players));
                } else if (room.status === 'playing') {
                    requestLeaderboardUpdate(roomCode);
                    checkIfGameOver(roomCode);
                }
            }
        }
    });

    // ==========================================
    // 5. OYUNU BAŞLATMA VE TOPLU SORU GÖNDERME (CANLI ARENA)
    // ==========================================
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

    // ==========================================
    // 6. CEVAPLARI TOPLAMA VE PUANLAMA
    // ==========================================
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

    // ==========================================
    // 7. EVRENSEL OYUN MOTORU (DOTS & BOXES DESTEĞİ İÇİN)
    // ==========================================
    
    socket.on('sync_game_state', (data) => {
        const { roomCode, state } = data;
        socket.to(roomCode).emit('game_state_updated', state);
    });

    socket.on('send_personal_question', (data) => {
        const { roomCode, targetPlayerId, questionData } = data;
        io.to(targetPlayerId).emit('personal_question_received', questionData);
    });

    socket.on('submit_personal_answer', (data) => {
        const { roomCode, answerData } = data;
        const room = rooms[roomCode];
        if (room && room.teacherSocketId) {
            io.to(room.teacherSocketId).emit('personal_answer_submitted', {
                playerId: socket.id,
                answerData: answerData
            });
        }
    });

    // ==========================================
    // 8. OYUN BİTİŞ VE ZORLA KAPATMA KONTROLLERİ
    // ==========================================
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
            console.log(`[OYUN BİTTİ] Oda: ${roomCode}`);
        }
    }

    socket.on('teacher_force_quit', (roomCode) => {
        if(rooms[roomCode] && rooms[roomCode].teacherSocketId === socket.id) {
            io.to(roomCode).emit('game_over', { 
                leaderboard: Object.values(rooms[roomCode].players).sort((a,b) => b.score - a.score) 
            });
            delete rooms[roomCode];
            console.log(`[ÖĞRETMEN OYUNU BİTİRDİ] Oda kapatıldı: ${roomCode}`);
        }
    });

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

    // ==========================================
    // 9. BAĞLANTI KOPMASI (DISCONNECT) YÖNETİMİ
    // ==========================================
    socket.on('disconnect', () => {
        for (const roomCode in rooms) {
            const room = rooms[roomCode];
            
            if (room.teacherSocketId === socket.id) {
                room.teacherDisconnectTimeout = setTimeout(() => {
                    io.to(roomCode).emit('join_error', { message: 'Öğretmen oyundan ayrıldı. Oda kapatıldı.' });
                    delete rooms[roomCode];
                    console.log(`[ODA SİLİNDİ] Öğretmen dönmedi. Oda: ${roomCode}`);
                }, 60000);

            } else if (room.players[socket.id]) {
                room.players[socket.id].status = 'left';
                requestLeaderboardUpdate(roomCode);
                checkIfGameOver(roomCode);
                console.log(`[ÖĞRENCİ KOPTU] ID: ${socket.id} -> Oda: ${roomCode}`);
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { 
    console.log(`=================================`);
    console.log(`🚀 Kelime Oyunu Server Aktif`);
    console.log(`📡 Dinlenen Port: ${PORT}`);
    console.log(`=================================`);
});
