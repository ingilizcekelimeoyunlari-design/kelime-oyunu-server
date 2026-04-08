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

// Küfür Filtresi (Gelişmiş)
const badWords =[
    "amk", "aq", "oç", "oc", "pic", "piç", "sik", "yarrak", "yarak", "amcik", "amcık", 
    "göt", "got", "siktir", "yavsak", "yavşak", "orospu", "kahpe", "pezevenk", "salak", 
    "aptal", "gerizekali", "fuck", "bitch", "shit", "asshole", "dick", "pussy", "cunt"
];

function isNameClean(name) {
    const cleanName = name.replace(/[^a-zA-Zğüşıöç]/gi, '').toLowerCase();
    for (let i = 0; i < badWords.length; i++) {
        const badWord = badWords[i];
        if (badWord.length <= 3) {
            if (cleanName === badWord) return false;
        } else {
            if (cleanName.includes(badWord)) return false;
        }
    }
    return true;
}

io.on('connection', (socket) => {
    console.log('Birisi bağlandı:', socket.id);

    // --- ÖĞRETMEN ODA KURAR ---
    socket.on('create_room', () => {
        const roomCode = Math.floor(100000 + Math.random() * 900000).toString();
        rooms[roomCode] = { 
            players: [], 
            questions:[], 
            currentQIndex: 0, 
            status: 'waiting',
            timer: null,
            answersThisRound: 0
        };
        socket.join(roomCode); 
        socket.emit('room_created', { roomCode: roomCode });
    });

    // --- ÖĞRENCİ ODAYA GİRER ---
    socket.on('join_room', (data) => {
        const { roomCode, playerName } = data;
        const room = rooms[roomCode];

        if (!room) return socket.emit('join_error', { message: '❌ Böyle bir oyun kodu bulunamadı!' });
        if (room.status !== 'waiting') return socket.emit('join_error', { message: '⛔ Bu oyun zaten başlamış!' });
        if (!isNameClean(playerName)) return socket.emit('join_error', { message: '⚠️ Lütfen daha uygun bir isim seçin!' });

        socket.join(roomCode);
        const newPlayer = { id: socket.id, name: playerName, score: 0, lastAnswerCorrect: false };
        room.players.push(newPlayer);

        socket.emit('join_success', { roomCode: roomCode, players: room.players });
        socket.to(roomCode).emit('player_joined', newPlayer);
    });

    // --- OYUNU BAŞLATMA ---
    socket.on('start_game', (data) => {
        const { roomCode, questions } = data;
        const room = rooms[roomCode];

        if (room) {
            room.questions = questions;
            room.currentQIndex = 0;
            room.status = 'playing';

            io.to(roomCode).emit('game_starting');
            setTimeout(() => { sendNextQuestion(roomCode); }, 3000);
        }
    });

    // --- SORU GÖNDERME VE SÜRE (TIMER) MANTIĞI ---
    function sendNextQuestion(roomCode) {
        const room = rooms[roomCode];
        if (!room) return;

        // Sorular bittiyse oyunu bitir
        if (room.currentQIndex >= room.questions.length) {
            room.status = 'finished';
            room.players.sort((a, b) => b.score - a.score);
            io.to(roomCode).emit('game_over', { leaderboard: room.players });
            return;
        }

        const q = room.questions[room.currentQIndex];
        room.answersThisRound = 0; // Bu turdaki cevapları sıfırla
        
        // Tüm oyuncuların son cevap durumunu sıfırla
        room.players.forEach(p => p.lastAnswerCorrect = false);

        const safeQuestionData = {
            questionText: q.questionText,
            options: q.options,
            questionNumber: room.currentQIndex + 1,
            totalQuestions: room.questions.length,
            timeLimit: 15 // Soru başına 15 saniye
        };

        io.to(roomCode).emit('new_question', safeQuestionData);

        // Sunucu taraflı geri sayım
        let timeLeft = 15;
        clearInterval(room.timer);
        room.timer = setInterval(() => {
            timeLeft--;
            io.to(roomCode).emit('timer_tick', timeLeft);

            if (timeLeft <= 0) {
                endQuestionRound(roomCode); // Süre bitti, soruyu kapat
            }
        }, 1000);
    }

    // --- SORUYU KAPAT VE SONUÇLARI GÖSTER ---
    function endQuestionRound(roomCode) {
        const room = rooms[roomCode];
        if (!room) return;
        clearInterval(room.timer);

        const currentQ = room.questions[room.currentQIndex];
        
        // Puanlara göre sırala
        room.players.sort((a, b) => b.score - a.score);

        // Herkese doğru cevabı ve güncel tabloyu gönder
        io.to(roomCode).emit('question_result', { 
            correctAnswer: currentQ.correctAnswer, 
            leaderboard: room.players 
        });

        // 4 Saniye sonra otomatik diğer soruya geç
        setTimeout(() => {
            room.currentQIndex++;
            sendNextQuestion(roomCode);
        }, 4000);
    }

    // --- ÖĞRENCİ CEVAP VERDİĞİNDE ---
    socket.on('submit_answer', (data) => {
        const { roomCode, selectedOption, timeLeft } = data;
        const room = rooms[roomCode];
        if (!room || room.status !== 'playing') return;

        const currentQ = room.questions[room.currentQIndex];
        const player = room.players.find(p => p.id === socket.id);

        if (player) {
            // Sadece ilk cevabı kabul et (çift tıklamayı önler)
            room.answersThisRound++;

            if (selectedOption === currentQ.correctAnswer) {
                player.lastAnswerCorrect = true;
                // Hızlı cevap verene daha çok puan (Kalan saniye * 10) + Temel Puan (100)
                player.score += 100 + (timeLeft * 10); 
            } else {
                player.lastAnswerCorrect = false;
            }

            socket.emit('answer_received'); // Öğrencinin ekranını beklemeye al

            // Odadaki HERKES cevap verdiyse süreyi bekleme, soruyu hemen kapat!
            if (room.answersThisRound >= room.players.length) {
                endQuestionRound(roomCode);
            }
        }
    });

    socket.on('disconnect', () => {
        console.log('Birisi ayrıldı:', socket.id);
        // Odalardan oyuncuyu silme mantığı eklenebilir
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { console.log(`Sunucu ${PORT} portunda çalışıyor...`); });
