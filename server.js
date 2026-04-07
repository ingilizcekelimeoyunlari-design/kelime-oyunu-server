const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

// --- 1. SUNUCU VE CORS AYARLARI ---
const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, { 
    cors: { 
        origin: "*", 
        methods: ["GET", "POST"] 
    } 
});

// ODA VERİLERİNİ TUTTUĞUMUZ ANA BELLEK
const rooms = {};

// --- 2. KÜFÜR VE ARGO FİLTRESİ ---
const badWords =[
    "amk", "aq", "oç", "sik", "siktir", "pic", "piç", "yavsak", "yavşak", 
    "fuck", "bitch", "pussy", "göt", "got", "yarrak", "yarak", "orospu", "kahpe"
];

function isNameClean(name) {
    if (!name) return false;
    const cleanName = name.replace(/[^a-zA-ZğüşıöçĞÜŞİÖÇ]/gi, '').toLowerCase();
    return !badWords.some(word => cleanName.includes(word));
}

// --- 3. ANA BAĞLANTI (SOCKET.IO) ---
io.on('connection', (socket) => {
    console.log(`🟢 Yeni cihaz bağlandı: ${socket.id}`);

    // ==========================================
    // A. ÖĞRETMEN ODA KURAR
    // ==========================================
    socket.on('create_room', (data) => {
        const roomCode = Math.floor(100000 + Math.random() * 900000).toString();
        
        rooms[roomCode] = { 
            teacherId: socket.id, // Öğretmenin kimliğini kaydet (Düşerse odayı kapatmak için)
            players: {}, 
            questions:[], 
            status: 'waiting',
            randomNamesConfig: data ? data.randomNames : false 
        };
        
        socket.join(roomCode); 
        socket.emit('room_created', { roomCode });
        console.log(`🏫 Oda Kuruldu! KOD: ${roomCode} | Öğretmen: ${socket.id}`);
    });

    // ==========================================
    // B. ÖĞRENCİ ODAYA KATILIR
    // ==========================================
    socket.on('join_room', (data) => {
        const { roomCode, playerName } = data;
        const room = rooms[roomCode];
        
        if (!room) {
            return socket.emit('join_error', { message: '❌ HATA: Böyle bir oyun odası bulunamadı!' });
        }
        
        if (room.status !== 'waiting') {
            return socket.emit('join_error', { message: '⛔ Yarışma çoktan başladı, artık katılamazsınız!' });
        }

        if (!isNameClean(playerName)) {
            return socket.emit('join_error', { message: '⚠️ Lütfen daha uygun bir isim seçiniz.' });
        }

        socket.join(roomCode);
        
        // Öğrenciyi odaya kaydet
        room.players[socket.id] = { 
            id: socket.id, 
            name: playerName, 
            score: 0, 
            combo: 0, 
            currentIndex: 0, 
            status: 'waiting',
            shuffledOrder:[]
        };

        console.log(`👦 ${playerName} odaya katıldı. (Oda: ${roomCode})`);

        // Lobideki HERKESE güncel oyuncu listesini gönder
        io.to(roomCode).emit('lobby_update', { 
            players: Object.values(room.players), 
            roomCode: roomCode 
        });
    });

    // ==========================================
    // C. OYUNU BAŞLATMA
    // ==========================================
    socket.on('start_game', (data) => {
        const { roomCode, questions } = data;
        const room = rooms[roomCode];
        
        if (room && questions.length > 0) {
            room.questions = questions;
            room.status = 'playing'; // Odayı dışarıya kapatır
            
            // Her öğrenci için soruları KARIŞTIR (Kopya çekmeyi önler)
            Object.keys(room.players).forEach(pId => {
                let order = Array.from({length: questions.length}, (_, i) => i);
                room.players[pId].shuffledOrder = order.sort(() => Math.random() - 0.5);
                room.players[pId].status = 'playing';
            });

            io.to(roomCode).emit('game_starting');
            console.log(`🚀 Yarışma Başladı! Oda: ${roomCode} | Soru: ${questions.length}`);

            // 4 Saniyelik FIGHT! animasyonunu bekle ve soruları yolla
            setTimeout(() => { 
                Object.keys(room.players).forEach(pId => sendQuestion(roomCode, pId)); 
            }, 4000);
        }
    });

    // --- SORU GÖNDERME MOTORU ---
    function sendQuestion(roomCode, pId) {
        const room = rooms[roomCode];
        const player = room ? room.players[pId] : null;
        
        if (!player) return;

        // Eğer öğrenci 25 soruyu da bitirdiyse
        if (player.currentIndex >= room.questions.length) {
            player.status = 'finished';
            io.to(pId).emit('player_finished');
            console.log(`🏁 ${player.name} yarışı bitirdi! Puan: ${player.score}`);
            return;
        }

        const qIdx = player.shuffledOrder[player.currentIndex];
        const q = room.questions[qIdx];
        
        // Öğrenciye sıradaki sorusunu yolla
        io.to(pId).emit('new_question', { 
            questionText: q.questionText, 
            options: q.options, 
            qNum: player.currentIndex + 1, 
            total: room.questions.length, 
            startTime: Date.now() 
        });
    }

    // ==========================================
    // D. CEVAP DEĞERLENDİRME VE SALİSE PUANLAMA
    // ==========================================
    socket.on('submit_answer', (data) => {
        const { roomCode, selectedOption, clientStartTime } = data;
        const room = rooms[roomCode];
        const player = room ? room.players[socket.id] : null;
        
        if (!player || player.status !== 'playing') return;

        const qIdx = player.shuffledOrder[player.currentIndex];
        const currentQ = room.questions[qIdx];
        
        // Salise hesaplaması (Ne kadar hızlı çözdü?)
        const responseTime = Date.now() - clientStartTime;
        let isCorrect = (selectedOption === currentQ.correctAnswer);
        let earnedPoints = 0;

        if (isCorrect) {
            player.combo++;
            // PUAN FORMÜLÜ: Temel 500 + Kalan Süre Bonusu + Combo
            const timeBonus = Math.max(0, 10000 - responseTime) * 0.1;
            earnedPoints = Math.floor(500 + timeBonus + (player.combo * 50));
            player.score += earnedPoints;
        } else {
            player.combo = 0; // Yanlış yapınca Combo sıfırlanır
        }

        // Öğrencinin ekranına Doğru/Yanlış ve Puan bilgisini gönder
        socket.emit('answer_feedback', { 
            isCorrect: isCorrect, 
            correctAnswer: currentQ.correctAnswer, 
            combo: player.combo, 
            totalScore: player.score, 
            earnedPoints: earnedPoints 
        });

        // Tüm sınıfın (öğretmen dahil) liderlik tablosunu anında güncelle
        player.currentIndex++;
        io.to(roomCode).emit('update_leaderboard', Object.values(room.players).sort((a,b) => b.score - a.score));
        
        // 1.5 Saniye sonra sıradaki soruyu gönder
        setTimeout(() => sendQuestion(roomCode, socket.id), 1500);
    });

    // ==========================================
    // E. ÖĞRETMEN OYUNU ZORLA BİTİRİRSE
    // ==========================================
    socket.on('teacher_force_quit', (roomCode) => {
        if(rooms[roomCode]) {
            const leaderboard = Object.values(rooms[roomCode].players).sort((a,b) => b.score - a.score);
            io.to(roomCode).emit('game_over', { winners: leaderboard.slice(0, 3) });
            delete rooms[roomCode]; // Odayı RAM'den temizle
            console.log(`🛑 Öğretmen odayı zorla kapattı: ${roomCode}`);
        }
    });

    // ==========================================
    // F. KOPMA / İNTERNET GİTME (DISCONNECT)
    // ==========================================
    socket.on('disconnect', () => {
        console.log(`🔴 Cihaz koptu: ${socket.id}`);
        
        // Bütün odaları tara, kopan kişi kimdi bul
        for (const roomCode in rooms) {
            const room = rooms[roomCode];
            
            // Eğer kopan kişi ÖĞRETMENSE, odayı tamamen kapat (Maç iptal)
            if (room.teacherId === socket.id) {
                io.to(roomCode).emit('join_error', { message: 'Öğretmenin bağlantısı koptuğu için oyun iptal edildi.' });
                delete rooms[roomCode];
                console.log(`🗑️ Öğretmen koptuğu için oda silindi: ${roomCode}`);
                break;
            }
            
            // Eğer kopan kişi ÖĞRENCİYSE
            if (room.players[socket.id]) {
                const playerName = room.players[socket.id].name;
                delete room.players[socket.id]; // Öğrenciyi RAM'den sil
                
                // Eğer oyun henüz lobi aşamasındaysa, kalanlara listeyi güncelle
                if (room.status === 'waiting') {
                    io.to(roomCode).emit('lobby_update', { 
                        players: Object.values(room.players), 
                        roomCode: roomCode 
                    });
                }
                console.log(`🏃‍♂️ ${playerName} odadan ayrıldı.`);
                break;
            }
        }
    });
});

// SUNUCUYU AYAĞA KALDIR
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { 
    console.log(`=================================`);
    console.log(`🚀 Wayground Engine v6.1 Aktif`);
    console.log(`🌐 Port: ${PORT}`);
    console.log(`=================================`);
});
