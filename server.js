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
const badWords = ["amk", "aq", "oç", "sik", "siktir", "pic", "yavsak"];
function isNameClean(name) {
    if (!name) return false;
    const cleanName = name.replace(/[^a-zA-ZğüşıöçĞÜŞİÖÇ]/gi, '').toLowerCase();
    return !badWords.some(word => cleanName.includes(word));
}

io.on('connection', (socket) => {
    console.log('Sunucuya bağlanan oyuncu ID:', socket.id);

    // 1. Oda Kurma
    socket.on('create_room', () => {
        const roomCode = Math.floor(100000 + Math.random() * 900000).toString();
        rooms[roomCode] = { players: {}, questions: [], status: 'waiting' };
        socket.join(roomCode);
        socket.emit('room_created', { roomCode });
    });

    // 2. Odaya Katılma
    socket.on('join_room', (data) => {
        const { roomCode, playerName } = data;
        const room = rooms[roomCode];
        
        if (!room) return socket.emit('join_error', { message: '❌ Oda bulunamadı!' });
        if (room.status !== 'waiting') return socket.emit('join_error', { message: '⛔ Oyun başlamış!' });
        if (!isNameClean(playerName)) return socket.emit('join_error', { message: '⚠️ Uygunsuz isim!' });

        socket.join(roomCode);
        room.players[socket.id] = { 
            id: socket.id, name: playerName, score: 0, combo: 0, currentIndex: 0, status: 'playing' 
        };
        io.to(roomCode).emit('lobby_update', { players: Object.values(room.players) });
    });

    // 3. Oyun Başlatma
    socket.on('start_game', (data) => {
        const room = rooms[data.roomCode];
        if (room) {
            room.questions = data.questions;
            room.status = 'playing';
            // Her oyuncu için özel soru sırası
            Object.keys(room.players).forEach(pId => {
                room.players[pId].shuffledOrder = Array.from({length: data.questions.length}, (_, i) => i).sort(() => Math.random() - 0.5);
                room.players[pId].status = 'playing';
            });
            io.to(data.roomCode).emit('game_starting');
            setTimeout(() => { Object.keys(room.players).forEach(pId => sendQuestion(data.roomCode, pId)); }, 4000);
        }
    });

    // 4. Soru Dağıtma Motoru
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

    // 5. Cevap Kontrol ve Puanlama
    socket.on('submit_answer', (data) => {
        const room = rooms[data.roomCode];
        const player = room ? room.players[socket.id] : null;
        if (!player || room.status !== 'playing') return;

        const qIdx = player.shuffledOrder[player.currentIndex];
        const currentQ = room.questions[qIdx];
        const responseTime = Date.now() - data.clientStartTime;
        let isCorrect = (data.selectedOption === currentQ.correctAnswer);
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
        io.to(data.roomCode).emit('update_leaderboard', Object.values(room.players).sort((a,b) => b.score - a.score));
        
        // 1.5 saniye sonra diğer soruya geç
        setTimeout(() => sendQuestion(data.roomCode, socket.id), 1500);
    });

    socket.on('disconnect', () => console.log('Bağlantı koptu:', socket.id));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('v5.9 Server Online - Tam Puanlama ve Lobi Modu'));
