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

// Çok daha kapsamlı Türkçe/İngilizce Küfür ve Argo Listesi
const badWords =[
    "amk", "aq", "oç", "oc", "pic", "piç", "sik", "yarrak", "yarak", "amcik", "amcık", 
    "göt", "got", "siktir", "yavsak", "yavşak", "orospu", "kahpe", "pezevenk", "salak", 
    "aptal", "gerizekali", "fuck", "bitch", "shit", "asshole", "dick", "pussy", "cunt"
];

// Zeki Filtre (Hem aradaki sembolleri siler hem de köke bakar)
function isNameClean(name) {
    // 1. Boşluk, tire, nokta vb. harf dışındaki her şeyi sil (s-i.k -> sik olur)
    const cleanName = name.replace(/[^a-zA-Zğüşıöç]/gi, '').toLowerCase();
    
    for (let i = 0; i < badWords.length; i++) {
        const badWord = badWords[i];
        // 2. Eğer küfür 3 veya daha az harfliyse (sik, amk, aq) TAM eşleşme ararız.
        // Neden? "klasik" kelimesi banlanmasın diye.
        if (badWord.length <= 3) {
            if (cleanName === badWord) return false; // İsim sadece "sik" ise engelle
        } 
        // 3. Eğer küfür uzunsa, ismin neresinde geçerse geçsin engelle (örn: Alisiktir)
        else {
            if (cleanName.includes(badWord)) return false;
        }
    }
    return true; // Temizse geçsin
}

io.on('connection', (socket) => {
    console.log('Birisi bağlandı:', socket.id);

    socket.on('create_room', () => {
        const roomCode = Math.floor(100000 + Math.random() * 900000).toString();
        rooms[roomCode] = { players:[] };
        socket.join(roomCode); 
        socket.emit('room_created', { roomCode: roomCode });
    });

    socket.on('join_room', (data) => {
        const { roomCode, playerName } = data;

        if (!rooms[roomCode]) {
            return socket.emit('join_error', { message: 'Hata: Böyle bir oyun kodu bulunamadı!' });
        }

        // Filtreyi devreye sok!
        if (!isNameClean(playerName)) {
            return socket.emit('join_error', { message: 'Lütfen daha kibar bir isim seçin! 😎' });
        }

        socket.join(roomCode);
        const newPlayer = { id: socket.id, name: playerName, score: 0 };
        rooms[roomCode].players.push(newPlayer);

        socket.emit('join_success', { roomCode: roomCode, players: rooms[roomCode].players });
        socket.to(roomCode).emit('player_joined', newPlayer);
    });

    socket.on('disconnect', () => {
        console.log('Birisi ayrıldı:', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { console.log(`Sunucu ${PORT} portunda çalışıyor...`); });
