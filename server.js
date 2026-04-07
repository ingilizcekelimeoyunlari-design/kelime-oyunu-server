const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

// 1. Sunucu Kurulumu ve CORS Ayarları (WordPress bağlantısı için şart)
const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, { 
    cors: { 
        origin: "*", 
        methods: ["GET", "POST"] 
    } 
});

// 2. Bellekteki Odalar ve Oyuncu Verileri
const rooms = {};

// 3. Küfür ve Uygunsuz İsim Filtresi (Genişletilmiş)
const badWords = ["amk", "aq", "oç", "sik", "siktir", "pic", "yavsak", "fuck", "bitch", "pussy", "yarrak", "göt"];

function isNameClean(name) {
    if (!name) return false;
    // İsimdeki harf dışı karakterleri (., - _) temizle ve kontrol et
    const cleanName = name.replace(/[^a-zA-ZğüşıöçĞÜŞİÖÇ]/gi, '').toLowerCase();
    return !badWords.some(word => cleanName.includes(word));
}

// 4. Ana İletişim Hattı (Socket.io Connection)
io.on('connection', (socket) => {
    console.log('Sisteme yeni bir cihaz bağlandı. ID:', socket.id);

    // --- A. ODA OLUŞTURMA (Öğretmen Paneli) ---
    socket.on('create_room', () => {
        // 6 Haneli benzersiz oda kodu üret
        const roomCode = Math.floor(100000 + Math.random() * 900000).toString();
        
        rooms[roomCode] = { 
            players: {}, 
            questions: [], 
            status: 'waiting', // Başlangıçta bekleme modunda
            createdAt: Date.now()
        };
        
        socket.join(roomCode); 
        socket.emit('room_created', { roomCode });
        console.log(`Oda Oluşturuldu: ${roomCode} (ID: ${socket.id})`);
    });

    // --- B. ODAYA KATILMA (Öğrenci Girişi) ---
    socket.on('join_room', (data) => {
        const { roomCode, playerName } = data;
        const room = rooms[roomCode];
        
        // Hata Kontrolleri
        if (!room) {
            return socket.emit('join_error', { message: '❌ Bu oyun kodu artık geçersiz veya hiç oluşturulmadı!' });
        }
        
        if (room.status !== 'waiting') {
            return socket.emit('join_error', { message: '⛔ Üzgünüm, yarışma çoktan başladı. Artık katılamazsın!' });
        }

        if (!isNameClean(playerName)) {
            return socket.emit('join_error', { message: '⚠️ Lütfen daha uygun bir takma ad seçin!' });
        }

        // Oyuncuyu Odaya Kaydet
        socket.join(roomCode);
        room.players[socket.id] = { 
            id: socket.id, 
            name: playerName, 
            score: 0, 
            combo: 0, 
            currentIndex: 0, 
            status: 'waiting',
            shuffledOrder: [] // Soruların kişiye özel karışık sırası
        };

        // Lobideki HERKESE (Yeni giren dahil) güncel listeyi gönder (Lobi senkronu)
        io.to(roomCode).emit('lobby_update', { 
            players: Object.values(room.players), 
            roomCode: roomCode 
        });
        
        console.log(`${playerName} odaya katıldı: ${roomCode}`);
    });

    // --- C. OYUNU BAŞLATMA (Öğretmen START tuşuna bastığında) ---
    socket.on('start_game', (data) => {
        const { roomCode, questions } = data;
        const room = rooms[roomCode];

        if (room && questions.length > 0) {
            room.questions = questions;
            room.status = 'playing'; // Odayı kilitle (Yeni giriş yapılamaz)

            // Her oyuncu için 25 soruyu farklı sırada karıştır (Asenkron Hız)
            Object.keys(room.players).forEach(pId => {
                let order = Array.from({length: questions.length}, (_, i) => i);
                room.players[pId].shuffledOrder = order.sort(() => Math.random() - 0.5);
                room.players[pId].status = 'playing';
            });

            // Tüm odaya "Fight!" animasyonu için sinyal gönder
            io.to(roomCode).emit('game_starting');
            console.log(`Oyun Başlatıldı: ${roomCode} | Soru Sayısı: ${questions.length}`);

            // 4 saniye (animasyon süresi) sonra ilk soruları dağıt
            setTimeout(() => { 
                Object.keys(room.players).forEach(pId => sendQuestionToPlayer(roomCode, pId)); 
            }, 4000);
        }
    });

    // --- D. SORU GÖNDERME MOTORU (Kişiye Özel Hız) ---
    function sendQuestionToPlayer(roomCode, pId) {
        const room = rooms[roomCode];
        const player = room ? room.players[pId] : null;
        
        if (!player) return;

        // Oyuncu tüm soruları bitirdiyse
        if (player.currentIndex >= room.questions.length) {
            player.status = 'finished';
            io.to(pId).emit('player_finished');
            return;
        }

        // Karıştırılmış sıradaki mevcut soruyu bul
        const qIdx = player.shuffledOrder[player.currentIndex];
        const questionData = room.questions[qIdx];

        // Öğrenciye soruyu gönder
        io.to(pId).emit('new_question', { 
            questionText: questionData.questionText, 
            options: questionData.options, 
            qNum: player.currentIndex + 1, 
            total: room.questions.length, 
            startTime: Date.now() // Salise/Milisaniye puanı için başlangıç zamanı
        });
    }

    // --- E. CEVAP DEĞERLENDİRME (Puan ve Combo Matematiği) ---
    socket.on('submit_answer', (data) => {
        const { roomCode, selectedOption, clientStartTime } = data;
        const room = rooms[roomCode];
        const player = room ? room.players[socket.id] : null;
        
        if (!player || player.status !== 'playing') return;

        const qIdx = player.shuffledOrder[player.currentIndex];
        const actualQuestion = room.questions[qIdx];
        const responseTime = Date.now() - clientStartTime; // Salise farkı
        
        let isCorrect = (selectedOption === actualQuestion.correctAnswer);
        let earnedPoints = 0;

        if (isCorrect) {
            player.combo++;
            // PUANLAMA: 500 (Temel) + (Kalan Süre Bonusu) + (Combo Bonusu)
            const timeBonus = Math.max(0, 10000 - responseTime) * 0.1;
            const comboBonus = player.combo * 50;
            earnedPoints = Math.floor(500 + timeBonus + comboBonus);
            player.score += earnedPoints;
        } else {
            player.combo = 0; // Yanlışta combo sıfırlanır
        }

        // Oyuncuya özel feedback (Doğru mu? Kaç puan kazandı?)
        socket.emit('answer_feedback', { 
            isCorrect, 
            correctAnswer: actualQuestion.correctAnswer, 
            combo: player.combo, 
            totalScore: player.score, 
            earnedPoints: earnedPoints 
        });

        // Oyuncunun soru numarasını artır ve bir sonraki soruyu hazırla
        player.currentIndex++;

        // Tüm odaya güncel liderlik tablosunu gönder (Barların ilerlemesi için)
        io.to(roomCode).emit('update_leaderboard', Object.values(room.players).sort((a,b) => b.score - a.score));

        // 1.5 saniye feedback süresinden sonra yeni soruyu gönder
        setTimeout(() => sendQuestionToPlayer(roomCode, socket.id), 1500);
    });

    // --- F. OYUNU ZORLA BİTİRME (Öğretmen BİTİR'e bastığında) ---
    socket.on('teacher_force_quit', (roomCode) => {
        if(rooms[roomCode]) {
            const finalLeaderboard = Object.values(rooms[roomCode].players).sort((a,b) => b.score - a.score);
            // Herkese oyunun bittiğini ve ilk 3'ü (podyum) gönder
            io.to(roomCode).emit('game_over', { 
                winners: finalLeaderboard.slice(0, 3), 
                fullList: finalLeaderboard 
            });
            // Belleği temizle (Sunucuyu yormamak için odayı sil)
            delete rooms[roomCode];
            console.log(`Oda Kapatıldı: ${roomCode}`);
        }
    });

    // --- G. AYRILMA YÖNETİMİ ---
    socket.on('disconnect', () => {
        console.log('Bir kullanıcı sistemden koptu. ID:', socket.id);
    });
});

// 5. Port Dinleme
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`========================================`);
    console.log(`🚀 WAYGROUND ENGINE v5.7 ONLINE`);
    console.log(`📡 Port: ${PORT}`);
    console.log(`========================================`);
});
