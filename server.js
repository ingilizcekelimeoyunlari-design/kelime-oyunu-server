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
const leaderboardTimers = {}; // Sıralama güncellemelerini yavaşlatıp sunucuyu koruyan sistem

// --- SUNUCU İÇİ YEDEK KÜFÜR VE LAKAP FİLTRESİ ---
// Yapay zeka devrede olsa bile, Node.js sunucusu bu kelimeleri asla odaya almaz.
const badWords =[
    "amk", "aq", "oç", "sik", "siktir", "pic", "yavsak", "fuck", "bitch", "pussy", "yarrak", "göt",
    "bok", "uzayli", "uzaylı", "mage", "lord", "mami", "allah", "peygamber", "ataturk", "atatürk"
];

function isNameClean(name) {
    if (!name) return false;
    // İsimdeki harf dışı karakterleri (., - _) temizle ve kontrol et
    const cleanName = name.replace(/[^a-zA-ZğüşıöçĞÜŞİÖÇ]/gi, '').toLowerCase();
    return !badWords.some(word => cleanName.includes(word));
}

io.on('connection', (socket) => {
    console.log('Sisteme bir cihaz bağlandı. ID:', socket.id);

    // ==========================================
    // 1. ODA KURULUMU (ÖĞRETMEN)
    // ==========================================
    socket.on('create_room', () => {
        const roomCode = Math.floor(100000 + Math.random() * 900000).toString();
        rooms[roomCode] = { 
            teacherSocketId: socket.id,
            teacherDisconnectTimeout: null, 
            isNameGenOnly: data ? data.isNameGenOnly : false, // YENİ EKLENDİ
            players: {}, 
            questions:[], 
            status: 'waiting',
            createdAt: Date.now()
        };
        socket.join(roomCode); 
        socket.emit('room_created', { roomCode: roomCode });
        console.log(`Oda Oluşturuldu: ${roomCode} (Öğretmen ID: ${socket.id})`);
    });

    // ==========================================
    // 2. ÖĞRETMEN YENİDEN BAĞLANMA (SAYFA YENİLEME KORUMASI)
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
        }
    });

    // ==========================================
    // 3. ÖĞRENCİYİ ODADAN ATMA (KICK)
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
// 3.5 ODA KURALINI SORGULAMA (ÖĞRENCİ)
    // ==========================================
    socket.on('check_room_rules', (roomCode) => {
        const room = rooms[roomCode];
        if (room) {
            socket.emit('room_rules_info', { isNameGenOnly: room.isNameGenOnly });
        } else {
            socket.emit('join_error', { message: 'Oda bulunamadı.' });
        }
    });
    // ==========================================
    // 4. ODAYA KATILMA (ÖĞRENCİ)
    // ==========================================
    socket.on('join_room', (data) => {
        const { roomCode, playerName } = data;
        const room = rooms[roomCode];

        if (!room) return socket.emit('join_error', { message: '❌ Oda bulunamadı veya süresi doldu!' });
        if (room.status !== 'waiting') return socket.emit('join_error', { message: '⛔ Yarışma çoktan başladı! Artık katılamazsınız.' });
        if (!isNameClean(playerName)) return socket.emit('join_error', { message: '⚠️ Uygunsuz isim kullanımı reddedildi!' });

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
        // Tüm odaya (öğretmen dahil) lobi listesini yayınla
        io.to(roomCode).emit('lobby_update', Object.values(room.players));
    });

    // ==========================================
    // 5. OYUNU BAŞLATMA (ÖĞRETMEN SİNYALİ)
    // ==========================================
    socket.on('start_game', (data) => {
        const { roomCode, questions } = data;
        const room = rooms[roomCode];
        
        if (room && room.teacherSocketId === socket.id) {
            room.questions = questions;
            room.status = 'playing'; // Kapıları kilitle
            
            // Her öğrenci için soruları karıştır (Asenkron deneyim)
            Object.keys(room.players).forEach(pId => {
                let order = Array.from({length: questions.length}, (_, i) => i);
                room.players[pId].shuffledOrder = order.sort(() => Math.random() - 0.5);
                room.players[pId].status = 'playing';
            });

            io.to(roomCode).emit('game_starting');
            
            // 3-2-1 Fight animasyonu bitene kadar bekle (yaklaşık 4.5 sn)
            setTimeout(() => {
                Object.keys(room.players).forEach(pId => sendIndividualQuestion(roomCode, pId));
            }, 4500); 
        }
    });

    // ==========================================
    // 6. KİŞİYE ÖZEL SORU GÖNDERME MOTORU
    // ==========================================
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

        const allFinished = Object.values(room.players).every(p => p.status === 'finished' || p.status === 'left' || p.status === 'disconnected');
        if (allFinished && Object.keys(room.players).length > 0) {
            room.status = 'finished';
            
            if (leaderboardTimers[roomCode]) {
                clearTimeout(leaderboardTimers[roomCode]);
                delete leaderboardTimers[roomCode];
            }

            io.to(roomCode).emit('game_over', { 
                leaderboard: Object.values(room.players).sort((a,b) => b.score - a.score) 
            });
        }
    }

    // ==========================================
    // 7. PERFORMANS: LİDERLİK TABLOSU YAVAŞLATICISI
    // ==========================================
    function requestLeaderboardUpdate(roomCode) {
        if (leaderboardTimers[roomCode]) return; // Zaten bir geri sayım varsa bekle

        // Sunucuyu yormamak için sıralamayı saniyede en fazla 1 kez yayınla
        leaderboardTimers[roomCode] = setTimeout(() => {
            const room = rooms[roomCode];
            if (room) {
                io.to(roomCode).emit('update_leaderboard', Object.values(room.players).sort((a,b) => b.score - a.score));
            }
            delete leaderboardTimers[roomCode];
        }, 1000); 
    }

    // ==========================================
    // 8. CEVAP KONTROLÜ VE PUAN HESAPLAMA
    // ==========================================
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
            player.correct++;
            player.combo++;
            // MAX 10 saniye (10000ms) üzerinden hız bonusu
            const timeBonus = Math.max(0, 10000 - responseTime) * 0.05; 
            const comboBonus = player.combo * 50;
            const earnedPoints = Math.floor(500 + timeBonus + comboBonus);
            
            player.score += earnedPoints;
            socket.emit('answer_feedback', { isCorrect: true, earnedPoints, totalScore: player.score, combo: player.combo, correctAnswer: currentQ.correctAnswer });
        } else {
            player.wrong++;
            player.combo = 0;
            player.score = Math.max(0, player.score - 200); // Yanlış cevap cezası (Sıfırın altına düşmez)
            socket.emit('answer_feedback', { isCorrect: false, earnedPoints: -200, totalScore: player.score, combo: 0, correctAnswer: currentQ.correctAnswer });
        }

        requestLeaderboardUpdate(roomCode);
        player.currentIndex++;
        
        // Şıkkın yeşil/kırmızı yanmasını görmesi için 1.5 saniye mola
        setTimeout(() => sendIndividualQuestion(roomCode, socket.id), 1500);
    });

    // ==========================================
    // 9. OYUNU ZORLA BİTİRME (ÖĞRETMEN)
    // ==========================================
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
            console.log(`Müsabaka öğretmen tarafından bitirildi: ${roomCode}`);
        }
    });

    // ==========================================
    // 10. KOPMA YÖNETİMİ (DISCONNECT)
    // ==========================================
    socket.on('disconnect', () => {
        for (const roomCode in rooms) {
            const room = rooms[roomCode];
            
            // Eğer öğretmen koptuysa
            if (room.teacherSocketId === socket.id) {
                // 60 Saniye tolerans ver (Belki yanlışlıkla sayfayı yeniledi)
                room.teacherDisconnectTimeout = setTimeout(() => {
                    io.to(roomCode).emit('join_error', { message: 'Öğretmen oyundan ayrıldı. Oda kapatıldı.' });
                    delete rooms[roomCode];
                }, 60000); 

            } 
            // Eğer öğrenci koptuysa
            else if (room.players[socket.id]) {
                room.players[socket.id].status = 'disconnected';
                requestLeaderboardUpdate(roomCode);
                checkIfGameOver(roomCode);
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`========================================`);
    console.log(`🚀 ONLINE WORD GAME ENGINE v6.0 (STABLE)`);
    console.log(`🛡️ Strict Name Filter: ACTIVE`);
    console.log(`📡 Port: ${PORT}`);
    console.log(`========================================`);
});
