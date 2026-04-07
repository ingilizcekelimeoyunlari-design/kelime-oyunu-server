const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

// 1. Sunucu Kurulumu ve CORS Ayarları
const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, { 
    cors: { origin: "*", methods:["GET", "POST"] } 
});

// 2. Bellekteki Odalar ve Oyuncu Verileri
const rooms = {};

// 3. Genişletilmiş Küfür ve Argo Filtresi
const badWords =[
    "amk", "aq", "oç", "oc", "pic", "piç", "sik", "yarrak", "yarak", "amcik", "amcık", 
    "göt", "got", "siktir", "yavsak", "yavşak", "orospu", "kahpe", "pezevenk", "salak", 
    "aptal", "gerizekali", "fuck", "bitch", "shit", "asshole", "dick", "pussy", "cunt"
];

// İngilizce İsim Jeneratörü (Sunucu Tarafında Güvenli Atama İçin)
const adjectives =["Epic", "Golden", "Neon", "Swift", "Wild", "Hyper", "Magic", "Cool", "Super", "Flying"];
const animals =["Tiger", "Falcon", "Eagle", "Lion", "Dragon", "Wolf", "Panda", "Shark", "Fox", "Phoenix"];

function isNameClean(name) {
    if (!name) return false;
    const cleanName = name.replace(/[^a-zA-ZğüşıöçĞÜŞİÖÇ]/gi, '').toLowerCase();
    return !badWords.some(word => cleanName.includes(word));
}

// 4. Ana İletişim Hattı (Socket.io Connection)
io.on('connection', (socket) => {
    console.log('🟢 Yeni Bağlantı:', socket.id);

    // --- A. ODA OLUŞTURMA (Öğretmen Paneli) ---
    socket.on('create_room', (data) => {
        const roomCode = Math.floor(100000 + Math.random() * 900000).toString();
        
        rooms[roomCode] = { 
            teacherId: socket.id, // Öğretmenin kimliğini kaydet
            players: {}, 
            questions:[], 
            status: 'waiting',
            autoName: data && data.autoName ? true : false,
            createdAt: Date.now()
        };
        
        socket.join(roomCode); 
        socket.emit('room_created', { roomCode, autoName: rooms[roomCode].autoName });
        console.log(`🏠 Oda Kuruldu: ${roomCode} (Öğretmen: ${socket.id})`);
    });

    // --- B. ODAYA KATILMA (Öğrenci Girişi) ---
    socket.on('join_room', (data) => {
        let { roomCode, playerName } = data;
        const room = rooms[roomCode];
        
        if (!room) {
            return socket.emit('join_error', { message: '❌ Bu oyun kodu artık geçersiz veya hiç oluşturulmadı!' });
        }
        if (room.status !== 'waiting') {
            return socket.emit('join_error', { message: '⛔ Üzgünüm, yarışma çoktan başladı. Artık katılamazsın!' });
        }

        // Otomatik isim atama devredeyse
        if (room.autoName) {
            const rAdj = adjectives[Math.floor(Math.random() * adjectives.length)];
            const rAni = animals[Math.floor(Math.random() * animals.length)];
            playerName = rAdj + " " + rAni;
        } else {
            // Basit filtre (Gemini öncesi güvenlik)
            if (!isNameClean(playerName)) {
                return socket.emit('join_error', { message: '⚠️ Lütfen daha uygun bir isim seçin!' });
            }
        }

        socket.join(roomCode);
        room.players[socket.id] = { 
            id: socket.id, 
            name: playerName, 
            score: 0, 
            combo: 0, 
            currentIndex: 0, 
            status: 'waiting' 
        };
        
        // Lobiyi güncelle
        io.to(roomCode).emit('lobby_update', Object.values(room.players));
        socket.emit('join_success', { assignedName: playerName });
        console.log(`👤 ${playerName} katıldı (${roomCode})`);
    });

    // --- C. OYUNU BAŞLATMA ---
    socket.on('start_game', (data) => {
        const { roomCode, questions } = data;
        const room = rooms[roomCode];

        if (room && questions.length > 0) {
            room.questions = questions;
            room.status = 'playing'; // Kapıları kilitle

            // Her oyuncuya özel soru sırası oluştur
            Object.keys(room.players).forEach(pId => {
                let order = Array.from({length: questions.length}, (_, i) => i);
                room.players[pId].shuffledOrder = order.sort(() => Math.random() - 0.5);
                room.players[pId].status = 'playing';
            });

            io.to(roomCode).emit('game_starting');
            console.log(`🚀 Oyun Başlıyor: ${roomCode}`);

            // Animasyon sonrası soruları gönder
            setTimeout(() => { 
                Object.keys(room.players).forEach(pId => sendQuestion(roomCode, pId)); 
            }, 4000);
        }
    });

    function sendQuestion(roomCode, pId) {
        const room = rooms[roomCode];
        const player = room ? room.players[pId] : null;
        if (!player) return;
        
        if (player.currentIndex >= room.questions.length) {
            player.status = 'finished';
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

    // --- D. CEVAP KONTROLÜ VE PUANLAMA ---
    socket.on('submit_answer', (data) => {
        const { roomCode, selectedOption, clientStartTime } = data;
        const room = rooms[roomCode];
        const player = room ? room.players[socket.id] : null;
        
        if (!player || player.status !== 'playing') return;

        const qIdx = player.shuffledOrder[player.currentIndex];
        const currentQ = room.questions[qIdx];
        const responseTime = Date.now() - clientStartTime;
        let isCorrect = (selectedOption === currentQ.correctAnswer);

        let earned = 0;
        if (isCorrect) {
            player.combo++;
            const timeBonus = Math.max(0, 10000 - responseTime) * 0.1;
            earned = Math.floor(500 + timeBonus + (player.combo * 50));
            player.score += earned;
        } else { 
            player.combo = 0; 
        }

        socket.emit('answer_feedback', { 
            isCorrect, 
            correctAnswer: currentQ.correctAnswer, 
            combo: player.combo, 
            totalScore: player.score, 
            earnedPoints: earned 
        });

        player.currentIndex++;
        io.to(roomCode).emit('update_leaderboard', Object.values(room.players).sort((a,b) => b.score - a.score));
        
        setTimeout(() => sendQuestion(roomCode, socket.id), 1500);
    });

    // --- E. ÖĞRETMEN ZORLA BİTİRİR ---
    socket.on('teacher_force_quit', (roomCode) => {
        if(rooms[roomCode]) {
            const lb = Object.values(rooms[roomCode].players).sort((a,b) => b.score - a.score);
            io.to(roomCode).emit('game_over', { winners: lb.slice(0, 3), fullList: lb });
            delete rooms[roomCode];
            console.log(`🛑 Öğretmen oyunu bitirdi: ${roomCode}`);
        }
    });

    // --- F. OYUNCU VEYA ÖĞRETMEN KOPMASI (GELİŞMİŞ SENARYO) ---
    socket.on('disconnect', () => {
        console.log('🔴 Bağlantı koptu:', socket.id);
        
        // Hangi odada olduğunu bul
        for (const roomCode in rooms) {
            const room = rooms[roomCode];
            
            // Eğer kopan kişi öğretmense odayı tamamen iptal et
            if (room.teacherId === socket.id) {
                io.to(roomCode).emit('join_error', { message: 'Öğretmen oyundan ayrıldı, oda kapatıldı.' });
                delete rooms[roomCode];
                console.log(`Oda silindi (Öğretmen ayrıldı): ${roomCode}`);
                break;
            }

            // Kopan kişi öğrenciyse
            if (room.players[socket.id]) {
                const playerName = room.players[socket.id].name;
                delete room.players[socket.id]; // Oyuncuyu sil
                
                // Oyun henüz başlamadıysa lobidekilerin ekranından o öğrenciyi sil
                if (room.status === 'waiting') {
                    io.to(roomCode).emit('lobby_update', Object.values(room.players));
                    console.log(`Lobi güncellendi, ${playerName} ayrıldı.`);
                }
                break;
            }
        }
    });
});

// 5. Port Dinleme
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { 
    console.log(`=================================`);
    console.log(`🚀 Wayground Engine v6.1 ACTIVE`);
    console.log(`📡 Port: ${PORT}`);
    console.log(`=================================`);
});
