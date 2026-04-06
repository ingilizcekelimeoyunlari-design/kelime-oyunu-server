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

// Küfür Filtresi
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
            status: 'waiting' // waiting, playing, finished
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
        const newPlayer = { id: socket.id, name: playerName, score: 0 };
        room.players.push(newPlayer);

        socket.emit('join_success', { roomCode: roomCode, players: room.players });
        socket.to(roomCode).emit('player_joined', newPlayer);
    });

    // --- OYUNU BAŞLATMA (Öğretmenden Gelen Sinyal) ---
    socket.on('start_game', (data) => {
        const { roomCode, questions } = data;
        const room = rooms[roomCode];

        if (room) {
            room.questions = questions;
            room.currentQIndex = 0;
            room.status = 'playing';

            // Herkese lobiden çıkıp oyun ekranına geçmesini söyle (3 saniye sayacı başlar)
            io.to(roomCode).emit('game_starting');

            // 3 saniye sonra ilk soruyu fırlat
            setTimeout(() => {
                sendNextQuestion(roomCode);
            }, 3000);
        }
    });

    // --- SIRADAKİ SORUYU GÖNDERME FONKSİYONU ---
    function sendNextQuestion(roomCode) {
        const room = rooms[roomCode];
        if (!room) return;

        // Sorular bittiyse oyunu bitir
        if (room.currentQIndex >= room.questions.length) {
            room.status = 'finished';
            // Oyuncuları puana göre sırala
            room.players.sort((a, b) => b.score - a.score);
            io.to(roomCode).emit('game_over', { leaderboard: room.players });
            return;
        }

        const q = room.questions[room.currentQIndex];
        
        // HİLE KORUMASI: Öğrencilere doğru cevabın hangisi olduğunu yollamıyoruz! 
        // Sadece seçenek metinlerini yolluyoruz.
        const safeQuestionData = {
            questionText: q.questionText,
            options: q.options,
            questionNumber: room.currentQIndex + 1,
            totalQuestions: room.questions.length
        };

        io.to(roomCode).emit('new_question', safeQuestionData);
    }

    // --- ÖĞRENCİ CEVAP VERDİĞİNDE ---
    socket.on('submit_answer', (data) => {
        const { roomCode, selectedOption } = data;
        const room = rooms[roomCode];
        if (!room || room.status !== 'playing') return;

        const currentQ = room.questions[room.currentQIndex];
        const player = room.players.find(p => p.id === socket.id);

        if (player) {
            // Öğrencinin seçtiği metin, sunucudaki doğru metinle eşleşiyorsa
            if (selectedOption === currentQ.correctAnswer) {
                // Şimdilik sabit 100 puan. İleride hıza göre bonus ekleyeceğiz!
                player.score += 100; 
                socket.emit('answer_result', { isCorrect: true, score: player.score });
            } else {
                socket.emit('answer_result', { isCorrect: false, score: player.score });
            }

            // Canlı liderlik tablosunu herkese güncelle
            room.players.sort((a, b) => b.score - a.score);
            io.to(roomCode).emit('update_leaderboard', room.players);
        }
    });

    // --- SONRAKİ SORUYA GEÇİŞ (Şimdilik Öğretmen Tetikliyor) ---
    socket.on('next_question_trigger', (data) => {
        const room = rooms[data.roomCode];
        if(room) {
            room.currentQIndex++;
            sendNextQuestion(data.roomCode);
        }
    });

    socket.on('disconnect', () => {
        console.log('Birisi ayrıldı:', socket.id);
        // İleride kopan oyuncuları odadan silme mantığını buraya ekleyeceğiz
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { console.log(`Sunucu ${PORT} portunda çalışıyor...`); });
