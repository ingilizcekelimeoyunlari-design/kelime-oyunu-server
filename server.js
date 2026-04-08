const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*", 
        methods: ["GET", "POST"]
    }
});

// Oda verilerini hafızada tutacağımız yer
const rooms = {};

// Küfür/Kaba kelime filtresi (Bu listeyi istediğin kadar uzatabilirsin)
// Araya tire, nokta konmasını asıl kod (Regex) çözecek.
const badWords =["kötükelime1", "kötükelime2", "aptal", "salak", "siktir", "pic", "yavsak"];

// İsim temiz mi diye kontrol eden beyin
function isNameClean(name) {
    // İsmin içindeki boşluk, tire, nokta gibi harf OLMAYAN her şeyi silip küçük harfe çevirir.
    // Örn: "S-i.k  t-i_r" yazarsa, sistem bunu "siktir" olarak algılar!
    const cleanName = name.replace(/[^a-zA-Zğüşıöç]/gi, '').toLowerCase();
    
    for (let i = 0; i < badWords.length; i++) {
        if (cleanName.includes(badWords[i])) return false;
    }
    return true;
}

// Biri bağlandığında:
io.on('connection', (socket) => {
    console.log('Birisi bağlandı:', socket.id);

    // 1. ÖĞRETMEN ODA KURMAK İSTEDİĞİNDE
    socket.on('create_room', () => {
        // 6 haneli rastgele bir kod üret (Örn: 485102)
        const roomCode = Math.floor(100000 + Math.random() * 900000).toString();
        
        // Odayı hafızaya al
        rooms[roomCode] = { players:[] };
        
        // Öğretmeni odaya yerleştir
        socket.join(roomCode); 
        
        // Öğretmene "Odan hazır, kodun bu" de
        socket.emit('room_created', { roomCode: roomCode });
        console.log(`Yeni oyun odası kuruldu. KOD: ${roomCode}`);
    });

    // 2. ÖĞRENCİ ODAYA KATILMAK İSTEDİĞİNDE
    socket.on('join_room', (data) => {
        const { roomCode, playerName } = data;

        // Oda gerçekten var mı?
        if (!rooms[roomCode]) {
            return socket.emit('join_error', { message: '❌ Böyle bir oyun kodu bulunamadı!' });
        }

        // İsim temiz mi? (Küfür filtresi)
        if (!isNameClean(playerName)) {
            return socket.emit('join_error', { message: '⚠️ Lütfen daha uygun bir isim seçin!' });
        }

        // Her şey tamamsa öğrenciyi odaya al
        socket.join(roomCode);
        const newPlayer = { id: socket.id, name: playerName, score: 0 };
        rooms[roomCode].players.push(newPlayer);

        // Öğrenciye "Odaya girdin" mesajı ve odadaki diğer kişilerin listesini at
        socket.emit('join_success', { roomCode: roomCode, players: rooms[roomCode].players });

        // Odadaki DİĞER herkese (Öğretmen dahil) "Yeni biri geldi, listeye ekleyin" diye bağır
        socket.to(roomCode).emit('player_joined', newPlayer);

        console.log(`${playerName} odaya katıldı. Oda: ${roomCode}`);
    });

    socket.on('disconnect', () => {
        console.log('Birisi ayrıldı:', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Sunucu ${PORT} portunda çalışıyor...`);
});
