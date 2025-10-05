const {
  Client, GatewayIntentBits, Partials,
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  SlashCommandBuilder, Collection,
  ModalBuilder, TextInputBuilder, TextInputStyle, PermissionsBitField
} = require('discord.js');
const sqlite3 = require('sqlite3').verbose();
const express = require('express');

// === KEEP-ALIVE SERVER (Render) ===
const app = express();
app.get('/', (req, res) => res.send('🛒 Discord Market Bot działa!'));
app.listen(3000, () => console.log('✅ Keep-alive server running'));

// === KONFIGURACJA ===
const LOG_CHANNEL_ID = "1371824300360990740"; // Kanał do logów
const ADMIN_ROLE_ID = "1369060137892843530"; // Rola administratora
const DAILY_POINTS = 4; // Punkty codzienne
const PREMIUM_COLOR = 0x1E3A8A; // Ciemny niebieski

// === BAZA DANYCH ===
const DB = new sqlite3.Database('./market.db', (err) => {
  if (err) console.error('❌ Błąd bazy danych:', err);
  else console.log('✅ Połączono z bazą danych SQLite');
});

DB.serialize(() => {
  DB.run(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, 
    points INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_daily DATETIME
  )`);

  DB.run(`CREATE TABLE IF NOT EXISTS listings (
    id INTEGER PRIMARY KEY AUTOINCREMENT, 
    seller TEXT, 
    price INTEGER, 
    name TEXT, 
    description TEXT, 
    link TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  DB.run(`CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT,
    user_id TEXT,
    target_user_id TEXT,
    points INTEGER,
    listing_id INTEGER,
    details TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
});

// === BOT ===
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ],
  partials: [Partials.Channel]
});

client.commands = new Collection();

// === KOMENDY ===
const commands = [
  new SlashCommandBuilder().setName('wystaw').setDescription('🛒 Wystaw produkt na sprzedaż'),
  new SlashCommandBuilder()
    .setName('dodajpunkty')
    .setDescription('➕ Dodaj punkty użytkownikowi (Tylko administratorzy)')
    .addUserOption(opt => opt.setName('uzytkownik').setDescription('Użytkownik').setRequired(true))
    .addIntegerOption(opt => opt.setName('ilosc').setDescription('Ilość punktów').setRequired(true).setMinValue(1)),
  new SlashCommandBuilder()
    .setName('usunpunkty')
    .setDescription('➖ Usuń punkty użytkownikowi')
    .addUserOption(opt => opt.setName('uzytkownik').setDescription('Użytkownik').setRequired(true))
    .addIntegerOption(opt => opt.setName('ilosc').setDescription('Ilość punktów').setRequired(true).setMinValue(1)),
  new SlashCommandBuilder().setName('saldo').setDescription('💰 Sprawdź swoje saldo punktów').addUserOption(opt => opt.setName('uzytkownik').setDescription('Użytkownik (opcjonalnie)').setRequired(false)),
  new SlashCommandBuilder().setName('sklep').setDescription('🏪 Pokaż dostępne produkty'),
  new SlashCommandBuilder()
    .setName('przelew')
    .setDescription('💸 Przelej punkty innemu użytkownikowi')
    .addUserOption(opt => opt.setName('uzytkownik').setDescription('Do kogo chcesz przelać punkty').setRequired(true))
    .addIntegerOption(opt => opt.setName('ilosc').setDescription('Ilość punktów do przelewu').setRequired(true).setMinValue(1)),
  new SlashCommandBuilder().setName('codzienne').setDescription('🎁 Odbierz codzienne punkty'),
  new SlashCommandBuilder().setName('ranking').setDescription('🏆 Top 10 użytkowników z najwięcej punktami'),
  new SlashCommandBuilder().setName('usunogloszenie').setDescription('🗑️ Usuń ogłoszenie (admin)')
    .addIntegerOption(opt => opt.setName('idogloszenia').setDescription('ID ogłoszenia').setRequired(true))
].map(cmd => cmd.toJSON());

// === FUNKCJE POMOCNICZE ===
function ensureUser(userId, callback = () => {}) {
  DB.run("INSERT OR IGNORE INTO users (id, points, last_daily) VALUES (?, 0, NULL)", [userId], callback);
}

function addPoints(userId, amount, callback = () => {}) {
  ensureUser(userId, () => DB.run("UPDATE users SET points = points + ? WHERE id = ?", [amount, userId], callback));
}

function canRemovePoints(userId, amount, callback) {
  DB.get("SELECT points FROM users WHERE id = ?", [userId], (err, row) => {
    if (err) return callback(false, 0);
    callback(row && row.points >= amount, row ? row.points : 0);
  });
}

function removePoints(userId, amount, callback) {
  ensureUser(userId, () => canRemovePoints(userId, amount, (ok) => {
    if (!ok) return callback(false);
    DB.run("UPDATE users SET points = points - ? WHERE id = ?", [amount, userId], () => callback(true));
  }));
}

function getPoints(userId, callback) {
  DB.get("SELECT points FROM users WHERE id = ?", [userId], (err, row) => callback(row ? row.points : 0));
}

function transferPoints(fromUserId, toUserId, amount, callback) {
  canRemovePoints(fromUserId, amount, (canRemove) => {
    if (!canRemove) return callback(false);
    removePoints(fromUserId, amount, (success) => {
      if (!success) return callback(false);
      addPoints(toUserId, amount, () => callback(true));
    });
  });
}

function addLog(type, userId, targetUserId = null, points = 0, listingId = null, details = '') {
  DB.run("INSERT INTO logs (type, user_id, target_user_id, points, listing_id, details) VALUES (?, ?, ?, ?, ?, ?)",
    [type, userId, targetUserId, points, listingId, details]);
}

function hasAdminPermission(member) {
  return member.permissions.has(PermissionsBitField.Flags.Administrator) || member.roles.cache.has(ADMIN_ROLE_ID);
}

async function sendLog(type, user, targetUser = null, points = 0, listing = null, details = '') {
  try {
    const logChannel = await client.channels.fetch(LOG_CHANNEL_ID);
    if (!logChannel) return;
    const embed = new EmbedBuilder().setTimestamp().setFooter({ text: `ID: ${user.id}` }).setColor(PREMIUM_COLOR);
    switch(type){
      case 'listing_created':
        embed.setTitle('🛒 Nowa oferta').setDescription(`**${user.username}** wystawił produkt`)
          .addFields(
            {name:'Produkt', value: listing.name, inline:true},
            {name:'Cena', value: `${listing.price} pkt`, inline:true},
            {name:'Sprzedawca', value: `<@${user.id}>`, inline:true},
            {name:'ID oferty', value: `${listing.id}`, inline:true}
          ); break;
      case 'purchase':
        embed.setTitle('✅ Zakup produktu').setDescription(`**${user.username}** kupił od **${targetUser.username}**`)
          .addFields(
            {name:'Produkt', value: listing.name, inline:true},
            {name:'Cena', value: `${listing.price} pkt`, inline:true},
            {name:'Kupujący', value:`<@${user.id}>`, inline:true},
            {name:'Sprzedawca', value:`<@${targetUser.id}>`, inline:true},
            {name:'ID oferty', value:`${listing.id}`, inline:true}
          ); break;
    }
    await logChannel.send({ embeds:[embed] });
  } catch(e){ console.error(e); }
}

// Funkcja sprawdzająca dzień
function isSameDay(d1,d2){ return d1.getFullYear()===d2.getFullYear()&&d1.getMonth()===d2.getMonth()&&d1.getDate()===d2.getDate(); }

// Codzienne nagrody
function setupDailyRewards(){
  setInterval(()=>{
    const now=new Date();
    if(now.getHours()===0&&now.getMinutes()===0){
      DB.run("UPDATE users SET last_daily=NULL");
    }
  },60000);
}

// === EVENT READY ===
client.once('ready', async () => {
  console.log(`✅ Zalogowano jako ${client.user.tag}`);
  try { await client.application.commands.set(commands); console.log('✅ Komendy zarejestrowane'); } 
  catch(err){ console.error('❌ Błąd rejestracji komend:',err); }
  setupDailyRewards();
});

// === INTERAKCJE ===
client.on('interactionCreate', async (interaction)=>{
  // /wystaw
  if(interaction.isChatInputCommand()&&interaction.commandName==='wystaw'){
    const embed=new EmbedBuilder().setColor(PREMIUM_COLOR).setTitle('🛒 Wystaw produkt')
      .setDescription('Kliknij przycisk aby wypełnić formularz')
      .addFields({name:'📝 Potrzebne', value:'Nazwa, opis, cena, link do produktu'})
      .setFooter({text:'Formularz otworzy się w nowym oknie'});
    const row=new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('open_wystaw_modal').setLabel('📝 Formularz').setStyle(ButtonStyle.Primary)
    );
    return interaction.reply({embeds:[embed],components:[row],ephemeral:true});
  }

  // Otwórz modal
  if(interaction.isButton()&&interaction.customId==='open_wystaw_modal'){
    const modal=new ModalBuilder().setCustomId('wystawModal').setTitle('🛒 Wystaw produkt');
    const nazwa=new TextInputBuilder().setCustomId('nazwa').setLabel('Nazwa').setPlaceholder('Np. Kod Steam').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100);
    const opis=new TextInputBuilder().setCustomId('opis').setLabel('Opis').setPlaceholder('Szczegóły').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1000);
    const cena=new TextInputBuilder().setCustomId('cena').setLabel('Cena w punktach').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(10);
    const link=new TextInputBuilder().setCustomId('link').setLabel('Link (prywatny)').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(500);
    modal.addComponents(
      new ActionRowBuilder().addComponents(nazwa),
      new ActionRowBuilder().addComponents(opis),
      new ActionRowBuilder().addComponents(cena),
      new ActionRowBuilder().addComponents(link)
    );
    return interaction.showModal(modal);
  }

  // Obsługa modala
  if(interaction.isModalSubmit()&&interaction.customId==='wystawModal'){
    await interaction.deferReply({ephemeral:true});
    const nazwa=interaction.fields.getTextInputValue('nazwa');
    const opis=interaction.fields.getTextInputValue('opis');
    const cena=parseInt(interaction.fields.getTextInputValue('cena'));
    const link=interaction.fields.getTextInputValue('link');
    if(isNaN(cena)||cena<=0) return interaction.editReply({content:'❌ Cena musi być liczbą > 0',ephemeral:true});
    if(!link.startsWith('http')) return interaction.editReply({content:'❌ Link musi zaczynać się od http(s)',ephemeral:true});
    DB.run("INSERT INTO listings (seller, price, name, description, link) VALUES (?,?,?,?,?)",[interaction.user.id,cena,nazwa,opis,link],function(err){
      if(err) return interaction.editReply({content:'❌ Błąd wystawienia produktu',ephemeral:true});
      const listingId=this.lastID;
      sendLog('listing_created',interaction.user,null,cena,{id:listingId,name:nazwa});
      addLog('listing_created',interaction.user.id,null,cena,listingId,nazwa);

      const embed=new EmbedBuilder()
        .setColor(PREMIUM_COLOR)
        .setTitle(`🛒 ${nazwa}`)
        .setDescription(opis)
        .addFields(
          {name:"💰 Cena",value:`**${cena}** pkt`,inline:true},
          {name:"👤 Sprzedawca",value:`<@${interaction.user.id}>`,inline:true},
          {name:"🔐 Produkt",value:"Link dostępny po zakupie"}
        ).setFooter({text:`ID oferty: ${listingId}`}).setTimestamp();

      const row=new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`buy_${listingId}`).setLabel(`🛒 Kup za ${cena} pkt`).setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`info_${listingId}`).setLabel('ℹ️ Info').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`edit_${listingId}`).setLabel('✏️ Edytuj').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`delete_${listingId}`).setLabel('🗑️ Usuń').setStyle(ButtonStyle.Danger)
      );

      interaction.channel.send({embeds:[embed],components:[row]});
      interaction.editReply({content:`✅ Produkt "${nazwa}" wystawiony!`,ephemeral:true});
    });
  }

  // --- Kupowanie produktu wielokrotne ---
  if(interaction.isButton()&&interaction.customId.startsWith('buy_')){
    await interaction.deferReply({ephemeral:true});
    const listingId=interaction.customId.split('_')[1];
    DB.get("SELECT * FROM listings WHERE id=?",[listingId],(err,listing)=>{
      if(err||!listing) return interaction.editReply({content:'❌ Nie znaleziono produktu',ephemeral:true});
      if(listing.seller===interaction.user.id) return interaction.editReply({content:'❌ Nie możesz kupić własnego produktu',ephemeral:true});
      removePoints(interaction.user.id,listing.price,success=>{
        if(!success) return getPoints(interaction.user.id,pts=>interaction.editReply({content:`❌ Masz tylko ${pts} pkt`}));
        addPoints(listing.seller,listing.price,()=>{
          getPoints(interaction.user.id,buyerPts=>{
            const confirmEmbed=new EmbedBuilder()
              .setColor(PREMIUM_COLOR)
              .setTitle('✅ Zakup udany!')
              .setDescription(`Kupiłeś **${listing.name}**`)
              .addFields(
                {name:"👤 Sprzedawca",value:`<@${listing.seller}>`,inline:true},
                {name:"💰 Cena",value:`**${listing.price}** pkt`,inline:true},
                {name:"🔗 Link",value:listing.link,inline:false},
                {name:"💰 Twoje saldo",value:`**${buyerPts}** pkt`,inline:true}
              ).setTimestamp();
            interaction.editReply({embeds:[confirmEmbed]});
            client.users.fetch(listing.seller).then(sellerUser=>{
              getPoints(listing.seller,sellerPts=>{
                const sellerEmbed=new EmbedBuilder()
                  .setColor(PREMIUM_COLOR)
                  .setTitle('💰 Produkt sprzedany!')
                  .setDescription(`Twój produkt "${listing.name}" został zakupiony!`)
                  .addFields(
                    {name:'Kupujący',value:`<@${interaction.user.id}>`,inline:true},
                    {name:'Cena',value:`${listing.price} pkt`,inline:true},
                    {name:'Saldo',value:`${sellerPts} pkt`,inline:true}
                  ).setTimestamp();
                sellerUser.send({embeds:[sellerEmbed]}).catch(()=>{});
              });
            });
            sendLog('purchase',interaction.user,{id:listing.seller,username:'Sprzedawca'},listing.price,{id:listing.id,name:listing.name});
            addLog('purchase',interaction.user.id,listing.seller,listing.price,listing.id,listing.name);
          });
        });
      });
    });
  }
});

client.login(process.env.TOKEN);
