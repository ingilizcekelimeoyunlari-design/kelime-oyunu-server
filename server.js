const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

const rooms = {};

// İngilizce İsim Jeneratörü (Sunucu Tarafında Güvenli Atama İçin)
const adjectives =["Epic", "Golden", "Neon", "Swift", "Wild", "Hyper", "Magic", "Cool", "Super", "Flying"];
const animals =["Tiger", "Falcon", "Eagle", "Lion", "Dragon", "Wolf", "Panda", "Shark", "Fox", "Phoenix"];

io.on('connection', (socket) => {
    
    // --- ODA OLUŞTURMA ---
    socket.on('create_room', (data) => {
        const roomCode = Math.floor(100000 + Math.random() * 900000).toString();
        rooms[roomCode] = { 
            players: {}, 
            questions:[], 
            status: 'waiting',
            autoName: data.autoName // Öğretmen "Sistem İsim Atasın" dediyse true olur
        };
        socket.join(roomCode); 
        socket.emit('room_created', { roomCode, autoName: data.autoName });
    });

    // --- ODAYA KATILMA ---
    socket.on('join_room', (data) => {
        let { roomCode, playerName } = data;
        const room = rooms[roomCode];
        
        if (!room) {
            socket.emit('join_error', { message: '❌ Oda bulunamadı!' });
            return;
        }
        if (room.status !== 'waiting') {
            socket.emit('join_error', { message: '⛔ Yarışma çoktan başladı, artık giremezsiniz!' });
            return;
        }

        // Eğer öğretmen otomatik isim istemişse, öğrencinin yazdığını yok sayıp sistemden atarız
        if (room.autoName) {
            const rAdj = adjectives[Math.floor(Math.random() * adjectives.length)];
            const rAni = animals[Math.floor(Math.random() * animals.length)];
            playerName = rAdj + " " + rAni;
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
        
        // Herkese lobiyi güncelle
        io.to(roomCode).emit('lobby_update', Object.values(room.players));
        // Öğrenciye atanan ismi bildir
        socket.emit('join_success', { assignedName: playerName });
    });

    // --- OYUNU BAŞLATMA ---
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
            questionText: q.questionText, options: q.options, 
            qNum: player.currentIndex + 1, total: room.questions.length, startTime: Date.now() 
        });
    }

    // --- CEVAP KONTROLÜ VE PUANLAMA ---
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
