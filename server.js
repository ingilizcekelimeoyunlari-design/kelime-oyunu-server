const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

const rooms = {};

// Statik Hızlı Filtre (AI öncesi temel koruma)
const badWords =["amk", "aq", "oç", "sik", "siktir", "pic", "yavsak", "fuck", "bitch", "pussy"];
function isNameClean(name) {
    const cleanName = name.replace(/[^a-zA-Zğüşıöç]/gi, '').toLowerCase();
    return !badWords.some(word => cleanName.includes(word));
}

io.on('connection', (socket) => {
    console.log('Yeni Bağlantı:', socket.id);

    // ODA OLUŞTURMA (Auto-Name ayarı eklendi)
    socket.on('create_room', (data) => {
        const roomCode = Math.floor(100000 + Math.random() * 900000).toString();
        rooms[roomCode] = { 
            players: {}, 
            questions:[], 
            status: 'waiting',
            autoName: data ? data.autoName : false 
        };
        socket.join(roomCode); 
        socket.emit('room_created', { roomCode, autoName: rooms[roomCode].autoName });
    });

    // ODA BİLGİSİ SORGULAMA (Öğrenci linke tıkladığında Auto-Name var mı diye sorar)
    socket.on('check_room', (code, callback) => {
        if (rooms[code]) {
            callback({ exists: true, autoName: rooms[code].autoName, status: rooms[code].status });
        } else {
            callback({ exists: false });
        }
    });

    // ODAYA KATILMA
    socket.on('join_room', (data) => {
        const { roomCode, playerName } = data;
        const room = rooms[roomCode];
        
        if (!room) return socket.emit('join_error', { message: '❌ Oda bulunamadı!' });
        if (room.status !== 'waiting') return socket.emit('join_error', { message: '⛔ Yarışma başladı, artık katılamazsınız!' });
        if (!isNameClean(playerName)) return socket.emit('join_error', { message: '⚠️ Lütfen başka bir isim seçin!' });

        socket.join(roomCode);
        room.players[socket.id] = { 
            id: socket.id, name: playerName, score: 0, combo: 0, currentIndex: 0, status: 'waiting' 
        };
        io.to(roomCode).emit('lobby_update', { players: Object.values(room.players), roomCode });
    });

    // OYUNU BAŞLATMA
    socket.on('start_game', (data) => {
        const { roomCode, questions } = data;
        const room = rooms[roomCode];
        if (room && questions.length > 0) {
            room.questions = questions;
            room.status = 'playing';
            Object.keys(room.players).forEach(pId => {
                let order = Array.from({length: questions.length}, (_, i) => i);
                room.players[pId].shuffledOrder = order.sort(() => Math.random() - 0.5);
                room.players[pId].status = 'playing';
            });
            io.to(roomCode).emit('game_starting');
            setTimeout(() => { Object.keys(room.players).forEach(pId => sendQuestion(roomCode, pId)); }, 4000);
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
            questionText: q.questionText, options: q.options, 
            qNum: player.currentIndex + 1, total: room.questions.length, startTime: Date.now() 
        });
    }

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
        } else { player.combo = 0; }

        socket.emit('answer_feedback', { isCorrect, correctAnswer: currentQ.correctAnswer, combo: player.combo, totalScore: player.score, earnedPoints: earned });
        player.currentIndex++;
        io.to(roomCode).emit('update_leaderboard', Object.values(room.players).sort((a,b) => b.score - a.score));
        setTimeout(() => sendQuestion(roomCode, socket.id), 1500);
    });

    socket.on('teacher_force_quit', (roomCode) => {
        if(rooms[roomCode]) {
            const lb = Object.values(rooms[roomCode].players).sort((a,b) => b.score - a.score);
            io.to(roomCode).emit('game_over', { winners: lb.slice(0, 3) });
            delete rooms[roomCode];
        }
    });

    socket.on('disconnect', () => { });
});

server.listen(process.env.PORT || 3000, () => { console.log('v6.0 Ultimate Active'); });
