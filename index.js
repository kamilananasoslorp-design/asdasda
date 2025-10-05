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

// === KOLORYSTYKA ===
const COLORS = {
  PRIMARY: 0x1e3a8a,     // Ciemny niebieski
  SUCCESS: 0x059669,     // Ciemny zielony
  WARNING: 0xd97706,     // Ciemny pomarańczowy
  ERROR: 0xdc2626,       // Ciemny czerwony
  PREMIUM: 0x7c3aed      // Ciemny fioletowy
};

// === BAZA DANYCH ===
const DB = new sqlite3.Database('./market.db', (err) => {
  if (err) {
    console.error('❌ Błąd bazy danych:', err);
  } else {
    console.log('✅ Połączono z bazą danych SQLite');
  }
});

// Inicjalizacja bazy danych
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
    sold INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    buyer_id TEXT,
    sold_at DATETIME
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
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Channel, Partials.Message]
});

client.commands = new Collection();

// === KOMENDY ===
const commands = [
  new SlashCommandBuilder()
    .setName('wystaw')
    .setDescription('🛒 Wystaw produkt na sprzedaż'),

  new SlashCommandBuilder()
    .setName('dodajpunkty')
    .setDescription('➕ Dodaj punkty użytkownikowi (Tylko administratorzy)')
    .addUserOption(opt => 
      opt.setName('uzytkownik')
        .setDescription('Użytkownik')
        .setRequired(true))
    .addIntegerOption(opt => 
      opt.setName('ilosc')
        .setDescription('Ilość punktów')
        .setRequired(true)
        .setMinValue(1)),

  new SlashCommandBuilder()
    .setName('usunpunkty')
    .setDescription('➖ Usuń punkty użytkownikowi')
    .addUserOption(opt => 
      opt.setName('uzytkownik')
        .setDescription('Użytkownik')
        .setRequired(true))
    .addIntegerOption(opt => 
      opt.setName('ilosc')
        .setDescription('Ilość punktów')
        .setRequired(true)
        .setMinValue(1)),

  new SlashCommandBuilder()
    .setName('saldo')
    .setDescription('💰 Sprawdź swoje saldo punktów')
    .addUserOption(opt => 
      opt.setName('uzytkownik')
        .setDescription('Użytkownik (opcjonalnie)')
        .setRequired(false)),

  new SlashCommandBuilder()
    .setName('sklep')
    .setDescription('🏪 Pokaż dostępne produkty'),

  new SlashCommandBuilder()
    .setName('przelew')
    .setDescription('💸 Przelej punkty innemu użytkownikowi')
    .addUserOption(opt => 
      opt.setName('uzytkownik')
        .setDescription('Do kogo chcesz przelać punkty')
        .setRequired(true))
    .addIntegerOption(opt => 
      opt.setName('ilosc')
        .setDescription('Ilość punktów do przelewu')
        .setRequired(true)
        .setMinValue(1)),

  new SlashCommandBuilder()
    .setName('codzienne')
    .setDescription('🎁 Odbierz codzienne punkty'),

  new SlashCommandBuilder()
    .setName('ranking')
    .setDescription('🏆 Top 10 użytkowników z najwięcej punktami'),

  new SlashCommandBuilder()
    .setName('usunogloszenie')
    .setDescription('🗑️ Usuń ogłoszenie (Administracja)')
    .addIntegerOption(opt => 
      opt.setName('id')
        .setDescription('ID ogłoszenia do usunięcia')
        .setRequired(true)),
].map(cmd => cmd.toJSON());

// === FUNKCJE POMOCNICZE ===
function ensureUser(userId, callback = () => {}) {
  DB.run("INSERT OR IGNORE INTO users (id, points, last_daily) VALUES (?, 0, NULL)", [userId], callback);
}

function addPoints(userId, amount, callback = () => {}) {
  ensureUser(userId, () => {
    DB.run("UPDATE users SET points = points + ? WHERE id = ?", [amount, userId], callback);
  });
}

function canRemovePoints(userId, amount, callback) {
  DB.get("SELECT points FROM users WHERE id = ?", [userId], (err, row) => {
    if (err) {
      console.error('Błąd bazy danych:', err);
      return callback(false, 0);
    }
    const current = row ? row.points : 0;
    callback(current >= amount, current);
  });
}

function removePoints(userId, amount, callback) {
  ensureUser(userId, () => {
    canRemovePoints(userId, amount, (ok) => {
      if (!ok) return callback(false);
      DB.run("UPDATE users SET points = points - ? WHERE id = ?", [amount, userId], () => callback(true));
    });
  });
}

function getPoints(userId, callback) {
  DB.get("SELECT points FROM users WHERE id = ?", [userId], (err, row) => {
    if (err) {
      console.error('Błąd bazy danych:', err);
      return callback(0);
    }
    callback(row ? row.points : 0);
  });
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
  DB.run(
    "INSERT INTO logs (type, user_id, target_user_id, points, listing_id, details) VALUES (?, ?, ?, ?, ?, ?)",
    [type, userId, targetUserId, points, listingId, details]
  );
}

// Funkcja sprawdzająca uprawnienia administratora
function hasAdminPermission(member) {
  return member.permissions.has(PermissionsBitField.Flags.Administrator) || 
         member.roles.cache.has(ADMIN_ROLE_ID);
}

// Funkcja wysyłająca logi na kanał
async function sendLog(type, user, targetUser = null, points = 0, listing = null, details = '') {
  try {
    const logChannel = await client.channels.fetch(LOG_CHANNEL_ID);
    if (!logChannel) {
      console.log('❌ Nie znaleziono kanału do logów');
      return;
    }

    const embed = new EmbedBuilder()
      .setTimestamp()
      .setFooter({ text: `ID: ${user.id}` });

    switch (type) {
      case 'listing_created':
        embed.setColor(COLORS.PRIMARY)
          .setTitle('🛒 Nowa oferta')
          .setDescription(`**${user.username}** wystawił produkt na sprzedaż`)
          .addFields(
            { name: '📦 Produkt', value: listing.name, inline: true },
            { name: '💰 Cena', value: `${listing.price} pkt`, inline: true },
            { name: '👤 Sprzedawca', value: `<@${user.id}>`, inline: true },
            { name: '🆔 ID oferty', value: `${listing.id}`, inline: true }
          );
        break;

      case 'purchase':
        embed.setColor(COLORS.SUCCESS)
          .setTitle('✅ Zakup produktu')
          .setDescription(`**${user.username}** kupił produkt od **${targetUser.username}**`)
          .addFields(
            { name: '📦 Produkt', value: listing.name, inline: true },
            { name: '💰 Cena', value: `${listing.price} pkt`, inline: true },
            { name: '👤 Kupujący', value: `<@${user.id}>`, inline: true },
            { name: '👤 Sprzedawca', value: `<@${targetUser.id}>`, inline: true },
            { name: '🆔 ID oferty', value: `${listing.id}`, inline: true }
          );
        break;

      case 'points_added':
        embed.setColor(COLORS.SUCCESS)
          .setTitle('➕ Punkty dodane')
          .setDescription(`**${user.username}** dodał punkty użytkownikowi **${targetUser.username}**`)
          .addFields(
            { name: '👤 Administrator', value: `<@${user.id}>`, inline: true },
            { name: '👤 Odbiorca', value: `<@${targetUser.id}>`, inline: true },
            { name: '💰 Ilość', value: `${points} pkt`, inline: true }
          );
        break;

      case 'points_removed':
        embed.setColor(COLORS.WARNING)
          .setTitle('➖ Punkty usunięte')
          .setDescription(`**${user.username}** usunął punkty użytkownikowi **${targetUser.username}**`)
          .addFields(
            { name: '👤 Administrator', value: `<@${user.id}>`, inline: true },
            { name: '👤 Odbiorca', value: `<@${targetUser.id}>`, inline: true },
            { name: '💰 Ilość', value: `${points} pkt`, inline: true }
          );
        break;

      case 'daily_reward':
        embed.setColor(COLORS.PREMIUM)
          .setTitle('🎁 Codzienna nagroda')
          .setDescription(`**${user.username}** odebrał codzienne punkty`)
          .addFields(
            { name: '👤 Użytkownik', value: `<@${user.id}>`, inline: true },
            { name: '💰 Otrzymane', value: `${points} pkt`, inline: true }
          );
        break;

      case 'transfer':
        embed.setColor(COLORS.PRIMARY)
          .setTitle('💸 Przelew punktów')
          .setDescription(`**${user.username}** przelał punkty do **${targetUser.username}**`)
          .addFields(
            { name: '👤 Od', value: `<@${user.id}>`, inline: true },
            { name: '👤 Do', value: `<@${targetUser.id}>`, inline: true },
            { name: '💰 Ilość', value: `${points} pkt`, inline: true }
          );
        break;

      case 'listing_edited':
        embed.setColor(COLORS.WARNING)
          .setTitle('✏️ Oferta edytowana')
          .setDescription(`**${user.username}** edytował ofertę`)
          .addFields(
            { name: '📦 Produkt', value: listing.name, inline: true },
            { name: '💰 Cena', value: `${listing.price} pkt`, inline: true },
            { name: '🆔 ID oferty', value: `${listing.id}`, inline: true }
          );
        break;

      case 'listing_deleted':
        embed.setColor(COLORS.ERROR)
          .setTitle('🗑️ Oferta usunięta')
          .setDescription(`**${user.username}** usunął ofertę`)
          .addFields(
            { name: '📦 Produkt', value: details, inline: true },
            { name: '🆔 ID oferty', value: `${listingId}`, inline: true }
          );
        break;
    }

    await logChannel.send({ embeds: [embed] });
  } catch (error) {
    console.error('Błąd wysyłania loga:', error);
  }
}

// Funkcja wysyłająca wiadomość prywatną po zakupie
async function sendPurchaseDM(buyer, listing, seller) {
  try {
    const dmEmbed = new EmbedBuilder()
      .setColor(COLORS.SUCCESS)
      .setTitle('✅ Zakup zakończony pomyślnie!')
      .setDescription(`Dziękujemy za zakup **${listing.name}**`)
      .addFields(
        { name: '📦 Produkt', value: listing.name, inline: true },
        { name: '💰 Cena', value: `${listing.price} pkt`, inline: true },
        { name: '👤 Sprzedawca', value: `<@${seller.id}>`, inline: true },
        { name: '🔗 Link do produktu', value: listing.link, inline: false },
        { name: '🆔 ID transakcji', value: `#${listing.id}`, inline: true }
      )
      .setFooter({ text: 'W razie problemów skontaktuj się ze sprzedawcą' })
      .setTimestamp();

    await buyer.send({ embeds: [dmEmbed] });
    return true;
  } catch (error) {
    console.error('Nie udało się wysłać wiadomości prywatnej:', error);
    return false;
  }
}

// Funkcja codziennych nagród
function setupDailyRewards() {
  setInterval(() => {
    const now = new Date();
    if (now.getHours() === 0 && now.getMinutes() === 0) {
      DB.run("UPDATE users SET last_daily = NULL", (err) => {
        if (err) {
          console.error('❌ Błąd resetowania codziennych nagród:', err);
        } else {
          console.log('🔄 Zresetowano codzienne nagrody');
        }
      });
    }
  }, 60000);

  console.log('✅ Uruchomiono system codziennych nagród');
}

// === EVENT READY ===
client.once('ready', async () => {
  console.log(`✅ Zalogowano jako ${client.user.tag}`);
  console.log(`📊 Bot jest na ${client.guilds.cache.size} serwerach`);

  // Rejestracja komend globalnie
  try {
    await client.application.commands.set(commands);
    console.log("✅ Komendy slash zarejestrowane globalnie");
  } catch (error) {
    console.error("❌ Błąd rejestracji komend:", error);
  }

  // Uruchom codzienne nagrody
  setupDailyRewards();
});

// === OBSŁUGA KOMEND I PRZYCISKÓW ===
client.on('interactionCreate', async (interaction) => {
  // --- /wystaw - pokazuje tylko przycisk do otwarcia formularza ---
  if (interaction.isChatInputCommand() && interaction.commandName === 'wystaw') {
    const embed = new EmbedBuilder()
      .setColor(COLORS.PRIMARY)
      .setTitle('🛒 Wystaw produkt na sprzedaż')
      .setDescription('Kliknij przycisk poniżej, aby wypełnić formularz wystawienia produktu.')
      .addFields(
        { name: '📝 Co będzie potrzebne?', value: '• Nazwa produktu\n• Opis\n• Cena w punktach\n• Link do produktu (będzie widoczny dopiero po zakupie)' }
      )
      .setFooter({ text: 'Formularz otworzy się w nowym oknie' });

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('open_wystaw_modal')
        .setLabel('📝 Wypełnij formularz')
        .setStyle(ButtonStyle.Primary)
    );

    await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
  }

  // --- Przycisk otwierający modal ---
  if (interaction.isButton() && interaction.customId === 'open_wystaw_modal') {
    const modal = new ModalBuilder()
      .setCustomId('wystawModal')
      .setTitle('🛒 Wystaw produkt');

    const nazwa = new TextInputBuilder()
      .setCustomId('nazwa')
      .setLabel('Nazwa produktu')
      .setPlaceholder('Np. Kod Steam do gry XYZ')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(100);

    const opis = new TextInputBuilder()
      .setCustomId('opis')
      .setLabel('Opis produktu')
      .setPlaceholder('Opisz szczegóły produktu, warunki itp.')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
      .setMaxLength(1000);

    const cena = new TextInputBuilder()
      .setCustomId('cena')
      .setLabel('Cena w punktach')
      .setPlaceholder('100')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(10);

    const link = new TextInputBuilder()
      .setCustomId('link')
      .setLabel('Link do produktu (prywatny)')
      .setPlaceholder('https://example.com/produkt')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(500);

    modal.addComponents(
      new ActionRowBuilder().addComponents(nazwa),
      new ActionRowBuilder().addComponents(opis),
      new ActionRowBuilder().addComponents(cena),
      new ActionRowBuilder().addComponents(link)
    );

    await interaction.showModal(modal);
  }

  // --- Obsługa modala wystawiania ---
  if (interaction.isModalSubmit() && interaction.customId === 'wystawModal') {
    await interaction.deferReply({ ephemeral: true });

    const cena = parseInt(interaction.fields.getTextInputValue('cena'));
    const nazwa = interaction.fields.getTextInputValue('nazwa');
    const opis = interaction.fields.getTextInputValue('opis');
    const link = interaction.fields.getTextInputValue('link');

    // Walidacja ceny
    if (isNaN(cena) || cena <= 0) {
      return interaction.editReply({
        content: '❌ **Błąd:** Cena musi być liczbą większą od 0!',
        ephemeral: true
      });
    }

    // Walidacja linku
    if (!link.startsWith('http://') && !link.startsWith('https://')) {
      return interaction.editReply({
        content: '❌ **Błąd:** Link musi zaczynać się od http:// lub https://',
        ephemeral: true
      });
    }

    DB.run(
      "INSERT INTO listings (seller, price, name, description, link) VALUES (?, ?, ?, ?, ?)",
      [interaction.user.id, cena, nazwa, opis, link],
      function (err) {
        if (err) {
          console.error('Błąd zapisu oferty:', err);
          return interaction.editReply({
            content: '❌ **Błąd:** Nie udało się wystawić produktu!',
            ephemeral: true
          });
        }

        const listingId = this.lastID;
        const listing = { id: listingId, name: nazwa, price: cena };

        // Wyślij log
        sendLog('listing_created', interaction.user, null, cena, listing);

        // Dodaj log do bazy
        addLog('listing_created', interaction.user.id, null, cena, listingId, nazwa);

        getPoints(interaction.user.id, (pts) => {
          const embed = new EmbedBuilder()
            .setColor(COLORS.PRIMARY)
            .setAuthor({ 
              name: interaction.user.username, 
              iconURL: interaction.user.displayAvatarURL() 
            })
            .setTitle(`🛒 ${nazwa}`)
            .setDescription(opis)
            .addFields(
              { name: "💰 Cena", value: `**${cena}** pkt`, inline: true },
              { name: "👤 Sprzedawca", value: `<@${interaction.user.id}>`, inline: true },
              { name: "📊 Saldo sprzedawcy", value: `**${pts}** pkt`, inline: true },
              { name: "🔐 Dostęp do produktu", value: "Link będzie dostępny po zakupie", inline: false }
            )
            .setFooter({ text: `ID oferty: ${listingId} • ${new Date().toLocaleDateString('pl-PL')}` })
            .setTimestamp();

          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`buy_${listingId}`)
              .setLabel(`🛒 Kup za ${cena} pkt`)
              .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
              .setCustomId(`info_${listingId}`)
              .setLabel('ℹ️ Informacje')
              .setStyle(ButtonStyle.Secondary)
          );

          // Dodaj przyciski edycji i usuwania dla sprzedawcy
          const ownerRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`edit_${listingId}`)
              .setLabel('✏️ Edytuj')
              .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
              .setCustomId(`delete_${listingId}`)
              .setLabel('🗑️ Usuń')
              .setStyle(ButtonStyle.Danger)
          );

          interaction.channel.send({ 
            embeds: [embed], 
            components: [row, ownerRow] 
          });
          
          interaction.editReply({
            content: `✅ **Sukces!** Produkt "${nazwa}" został wystawiony na sprzedaż za **${cena}** punktów!\n\n**⚠️ Uwaga:** Link do produktu jest prywatny i będzie widoczny tylko dla kupującego.`,
            ephemeral: true
          });
        });
      }
    );
  }

  // --- /dodajpunkty (TYLKO ADMINISTRATORZY) ---
  if (interaction.isChatInputCommand() && interaction.commandName === 'dodajpunkty') {
    if (!hasAdminPermission(interaction.member)) {
      const embed = new EmbedBuilder()
        .setColor(COLORS.ERROR)
        .setTitle('❌ Brak uprawnień')
        .setDescription('Ta komenda jest dostępna tylko dla administratorów!')
        .setTimestamp();
      
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    await interaction.deferReply();
    
    const user = interaction.options.getUser('uzytkownik');
    const ilosc = interaction.options.getInteger('ilosc');

    addPoints(user.id, ilosc, () => {
      getPoints(user.id, (pts) => {
        const embed = new EmbedBuilder()
          .setColor(COLORS.SUCCESS)
          .setTitle('✅ Punkty dodane')
          .setDescription(`Dodano **${ilosc}** punktów do konta **${user.username}**`)
          .addFields(
            { name: '👤 Użytkownik', value: `<@${user.id}>`, inline: true },
            { name: '💰 Nowe saldo', value: `**${pts}** pkt`, inline: true },
            { name: '👨‍💼 Administrator', value: `<@${interaction.user.id}>`, inline: true }
          )
          .setTimestamp();

        interaction.editReply({ embeds: [embed] });

        sendLog('points_added', interaction.user, user, ilosc);
        addLog('points_added', interaction.user.id, user.id, ilosc);
      });
    });
  }

  // --- /usunpunkty ---
  if (interaction.isChatInputCommand() && interaction.commandName === 'usunpunkty') {
    await interaction.deferReply();
    
    const user = interaction.options.getUser('uzytkownik');
    const ilosc = interaction.options.getInteger('ilosc');

    removePoints(user.id, ilosc, (success) => {
      if (success) {
        getPoints(user.id, (pts) => {
          const embed = new EmbedBuilder()
            .setColor(COLORS.SUCCESS)
            .setTitle('✅ Punkty usunięte')
            .setDescription(`Usunięto **${ilosc}** punktów z konta **${user.username}**`)
            .addFields(
              { name: '👤 Użytkownik', value: `<@${user.id}>`, inline: true },
              { name: '💰 Nowe saldo', value: `**${pts}** pkt`, inline: true }
            )
            .setTimestamp();

          interaction.editReply({ embeds: [embed] });

          sendLog('points_removed', interaction.user, user, ilosc);
          addLog('points_removed', interaction.user.id, user.id, ilosc);
        });
      } else {
        const embed = new EmbedBuilder()
          .setColor(COLORS.ERROR)
          .setTitle('❌ Błąd')
          .setDescription(`**${user.username}** nie ma wystarczającej liczby punktów!`)
          .setTimestamp();

        interaction.editReply({ embeds: [embed] });
      }
    });
  }

  // --- /saldo ---
  if (interaction.isChatInputCommand() && interaction.commandName === 'saldo') {
    const targetUser = interaction.options.getUser('uzytkownik') || interaction.user;
    
    getPoints(targetUser.id, (pts) => {
      const embed = new EmbedBuilder()
        .setColor(COLORS.PRIMARY)
        .setTitle('💰 Saldo punktów')
        .setDescription(targetUser.id === interaction.user.id 
          ? `**${targetUser.username}**, masz **${pts}** punktów`
          : `**${targetUser.username}** ma **${pts}** punktów`
        )
        .setThumbnail(targetUser.displayAvatarURL())
        .setFooter({ text: 'System punktów premium' })
        .setTimestamp();

      interaction.reply({ embeds: [embed], ephemeral: targetUser.id !== interaction.user.id });
    });
  }

  // --- /codzienne ---
  if (interaction.isChatInputCommand() && interaction.commandName === 'codzienne') {
    await interaction.deferReply({ ephemeral: true });

    DB.get("SELECT last_daily FROM users WHERE id = ?", [interaction.user.id], (err, row) => {
      if (err) {
        console.error('Błąd bazy danych:', err);
        return interaction.editReply({
          content: '❌ Wystąpił błąd podczas sprawdzania nagrody.',
          ephemeral: true
        });
      }

      const now = new Date();
      const lastDaily = row?.last_daily ? new Date(row.last_daily) : null;

      if (lastDaily && isSameDay(lastDaily, now)) {
        const nextDaily = new Date(now);
        nextDaily.setDate(nextDaily.getDate() + 1);
        nextDaily.setHours(0, 0, 0, 0);

        const embed = new EmbedBuilder()
          .setColor(COLORS.ERROR)
          .setTitle('🎁 Codzienna nagroda')
          .setDescription('Dzisiejszą nagrodę już odebrałeś!')
          .addFields(
            { name: '⏰ Następna nagroda', value: `<t:${Math.floor(nextDaily.getTime() / 1000)}:R>`, inline: true }
          )
          .setTimestamp();

        return interaction.editReply({ embeds: [embed] });
      }

      addPoints(interaction.user.id, DAILY_POINTS, () => {
        DB.run("UPDATE users SET last_daily = CURRENT_TIMESTAMP WHERE id = ?", [interaction.user.id], () => {
          getPoints(interaction.user.id, (pts) => {
            const embed = new EmbedBuilder()
              .setColor(COLORS.SUCCESS)
              .setTitle('🎁 Codzienna nagroda')
              .setDescription(`Odebrałeś dzisiejszą nagrodę!`)
              .addFields(
                { name: '💰 Otrzymane punkty', value: `**${DAILY_POINTS}** pkt`, inline: true },
                { name: '💰 Twoje saldo', value: `**${pts}** pkt`, inline: true }
              )
              .setFooter({ text: 'Wróć jutro po kolejną nagrodę!' })
              .setTimestamp();

            interaction.editReply({ embeds: [embed] });

            sendLog('daily_reward', interaction.user, null, DAILY_POINTS);
            addLog('daily_reward', interaction.user.id, null, DAILY_POINTS);
          });
        });
      });
    });
  }

  // --- /ranking ---
  if (interaction.isChatInputCommand() && interaction.commandName === 'ranking') {
    DB.all(
      "SELECT id, points FROM users WHERE points > 0 ORDER BY points DESC LIMIT 10",
      async (err, rows) => {
        if (err) {
          console.error('Błąd bazy danych:', err);
          return interaction.reply({
            content: '❌ Wystąpił błąd podczas ładowania rankingu.',
            ephemeral: true
          });
        }

        if (rows.length === 0) {
          const embed = new EmbedBuilder()
            .setColor(COLORS.WARNING)
            .setTitle('🏆 Ranking punktów')
            .setDescription('Brak użytkowników z punktami.\nBądź pierwszy i zdobądź punkty!')
            .setTimestamp();

          return interaction.reply({ embeds: [embed] });
        }

        const embed = new EmbedBuilder()
          .setColor(COLORS.PREMIUM)
          .setTitle('🏆 Top 10 - Ranking punktów')
          .setDescription('Najbogatsi użytkownicy serwera:')
          .setTimestamp();

        for (let i = 0; i < rows.length; i++) {
          const user = rows[i];
          const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '🔹';
          
          try {
            const discordUser = await client.users.fetch(user.id);
            embed.addFields({
              name: `${medal} ${i + 1}. ${discordUser.username}`,
              value: `**${user.points}** punktów`,
              inline: false
            });
          } catch (error) {
            embed.addFields({
              name: `${medal} ${i + 1}. Nieznany użytkownik`,
              value: `**${user.points}** punktów`,
              inline: false
            });
          }
        }

        DB.get("SELECT COUNT(*) as position FROM users WHERE points > (SELECT points FROM users WHERE id = ?)", 
          [interaction.user.id], (err, row) => {
            if (!err && row) {
              const position = row.position + 1;
              getPoints(interaction.user.id, (userPts) => {
                embed.setFooter({ 
                  text: `Twoja pozycja: ${position} • Twoje punkty: ${userPts} • System premium` 
                });
                interaction.reply({ embeds: [embed] });
              });
            } else {
              interaction.reply({ embeds: [embed] });
            }
          }
        );
      }
    );
  }

  // --- /sklep ---
  if (interaction.isChatInputCommand() && interaction.commandName === 'sklep') {
    DB.all(
      "SELECT * FROM listings WHERE sold = 0 ORDER BY created_at DESC LIMIT 10",
      async (err, rows) => {
        if (err) {
          console.error('Błąd bazy danych:', err);
          return interaction.reply({
            content: '❌ Wystąpił błąd podczas ładowania ofert.',
            ephemeral: true
          });
        }

        if (rows.length === 0) {
          const embed = new EmbedBuilder()
            .setColor(COLORS.WARNING)
            .setTitle('🏪 Sklep - brak ofert')
            .setDescription('Aktualnie nie ma żadnych produktów w sklepie.\nBądź pierwszy i wystaw coś używając `/wystaw`!')
            .setTimestamp();

          return interaction.reply({ embeds: [embed] });
        }

        const embed = new EmbedBuilder()
          .setColor(COLORS.PRIMARY)
          .setTitle('🏪 Dostępne produkty')
          .setDescription(`Znaleziono **${rows.length}** dostępnych produktów:\n\n*🔐 Linki do produktów są prywatne i dostępne tylko po zakupie*`)
          .setFooter({ text: `Premium Market System • Użyj /wystaw aby dodać swój produkt` })
          .setTimestamp();

        rows.forEach((item, index) => {
          embed.addFields({
            name: `🛒 ${item.name} - ${item.price} pkt`,
            value: `**Opis:** ${item.description.substring(0, 100)}${item.description.length > 100 ? '...' : ''}\n**Sprzedawca:** <@${item.seller}> | **ID:** ${item.id}`,
            inline: false
          });
        });

        await interaction.reply({ embeds: [embed] });
      }
    );
  }

  // --- /przelew ---
  if (interaction.isChatInputCommand() && interaction.commandName === 'przelew') {
    await interaction.deferReply({ ephemeral: true });
    
    const targetUser = interaction.options.getUser('uzytkownik');
    const amount = interaction.options.getInteger('ilosc');

    if (targetUser.id === interaction.user.id) {
      return interaction.editReply({
        content: '❌ Nie możesz przelać punktów samemu sobie!'
      });
    }

    if (targetUser.bot) {
      return interaction.editReply({
        content: '❌ Nie możesz przelać punktów botowi!'
      });
    }

    transferPoints(interaction.user.id, targetUser.id, amount, (success) => {
      if (success) {
        getPoints(interaction.user.id, (senderPts) => {
          getPoints(targetUser.id, (receiverPts) => {
            const embed = new EmbedBuilder()
              .setColor(COLORS.SUCCESS)
              .setTitle('✅ Przelew wykonany')
              .setDescription(`Przelano **${amount}** punktów do **${targetUser.username}**`)
              .addFields(
                { name: '👤 Od', value: `<@${interaction.user.id}>`, inline: true },
                { name: '👤 Do', value: `<@${targetUser.id}>`, inline: true },
                { name: '💰 Twoje saldo', value: `**${senderPts}** pkt`, inline: true }
              )
              .setTimestamp();

            interaction.editReply({ embeds: [embed] });

            sendLog('transfer', interaction.user, targetUser, amount);
            addLog('transfer', interaction.user.id, targetUser.id, amount);

            // Powiadomienie dla odbiorcy
            const receiverEmbed = new EmbedBuilder()
              .setColor(COLORS.SUCCESS)
              .setTitle('💰 Otrzymałeś przelew')
              .setDescription(`**${interaction.user.username}** przelał Ci **${amount}** punktów!`)
              .addFields(
                { name: '💰 Twoje saldo', value: `**${receiverPts}** pkt`, inline: true }
              )
              .setTimestamp();

            targetUser.send({ embeds: [receiverEmbed] }).catch(() => {
              console.log('Nie udało się wysłać DM do użytkownika');
            });
          });
        });
      } else {
        interaction.editReply({
          content: '❌ Nie masz wystarczającej liczby punktów do wykonania tego przelewu!'
        });
      }
    });
  }

  // --- /usunogloszenie (ADMIN) ---
  if (interaction.isChatInputCommand() && interaction.commandName === 'usunogloszenie') {
    if (!hasAdminPermission(interaction.member)) {
      const embed = new EmbedBuilder()
        .setColor(COLORS.ERROR)
        .setTitle('❌ Brak uprawnień')
        .setDescription('Ta komenda jest dostępna tylko dla administratorów!')
        .setTimestamp();
      
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });
    
    const listingId = interaction.options.getInteger('id');

    DB.get("SELECT * FROM listings WHERE id = ?", [listingId], (err, listing) => {
      if (err || !listing) {
        return interaction.editReply({
          content: '❌ Nie znaleziono ogłoszenia o podanym ID.',
          ephemeral: true
        });
      }

      DB.run("DELETE FROM listings WHERE id = ?", [listingId], (err) => {
        if (err) {
          console.error('Błąd usuwania oferty:', err);
          return interaction.editReply({
            content: '❌ Wystąpił błąd podczas usuwania ogłoszenia.',
            ephemeral: true
          });
        }

        const embed = new EmbedBuilder()
          .setColor(COLORS.SUCCESS)
          .setTitle('🗑️ Ogłoszenie usunięte')
          .setDescription(`Pomyślnie usunięto ogłoszenie ID: **${listingId}**`)
          .addFields(
            { name: '📦 Produkt', value: listing.name, inline: true },
            { name: '💰 Cena', value: `${listing.price} pkt`, inline: true }
          )
          .setTimestamp();

        interaction.editReply({ embeds: [embed] });

        sendLog('listing_deleted', interaction.user, null, 0, { id: listingId }, listing.name);
        addLog('listing_deleted', interaction.user.id, null, 0, listingId, listing.name);
      });
    });
  }

  // --- Kupowanie oferty ---
  if (interaction.isButton() && interaction.customId.startsWith('buy_')) {
    await interaction.deferReply({ ephemeral: true });
    
    const listingId = interaction.customId.split('_')[1];
    
    console.log(`🔍 Próba zakupu oferty ID: ${listingId} przez użytkownika: ${interaction.user.username}`);

    DB.get("SELECT * FROM listings WHERE id = ?", [listingId], (err, listing) => {
      if (err) {
        console.error('❌ Błąd bazy danych przy pobieraniu oferty:', err);
        return interaction.editReply({
          content: '❌ Wystąpił błąd podczas przetwarzania zakupu.',
          ephemeral: true
        });
      }

      if (!listing) {
        return interaction.editReply({
          content: "❌ Ten produkt nie istnieje.",
          ephemeral: true
        });
      }

      if (listing.seller === interaction.user.id) {
        return interaction.editReply({
          content: "❌ Nie możesz kupić własnego produktu!",
          ephemeral: true
        });
      }

      removePoints(interaction.user.id, listing.price, (success) => {
        if (!success) {
          getPoints(interaction.user.id, (pts) => {
            const embed = new EmbedBuilder()
              .setColor(COLORS.ERROR)
              .setTitle('❌ Brak punktów')
              .setDescription(`Nie masz wystarczającej liczby punktów!`)
              .addFields(
                { name: '💰 Wymagane', value: `**${listing.price}** pkt`, inline: true },
                { name: '💰 Twoje saldo', value: `**${pts}** pkt`, inline: true }
              );

            return interaction.editReply({ embeds: [embed] });
          });
          return;
        }

        // Dodaj punkty sprzedawcy
        addPoints(listing.seller, listing.price, () => {
          // Oznacz jako sprzedane
          DB.run(
            "UPDATE listings SET sold = 1, buyer_id = ?, sold_at = CURRENT_TIMESTAMP WHERE id = ?",
            [interaction.user.id, listingId],
            (err) => {
              if (err) {
                console.error('❌ Błąd aktualizacji oferty:', err);
                return interaction.editReply({
                  content: '❌ Wystąpił błąd podczas finalizacji zakupu.',
                  ephemeral: true
                });
              }

              // Pobierz aktualne salda
              getPoints(interaction.user.id, (buyerPts) => {
                getPoints(listing.seller, (sellerPts) => {
                  // Wyślij wiadomość prywatną do kupującego
                  sendPurchaseDM(interaction.user, listing, { id: listing.seller });

                  // Embed potwierdzający zakup DLA KUPUJĄCEGO
                  const confirmEmbed = new EmbedBuilder()
                    .setColor(COLORS.SUCCESS)
                    .setTitle("✅ Zakup udany!")
                    .setDescription(`Kupiłeś **${listing.name}**`)
                    .addFields(
                      { name: "👤 Sprzedawca", value: `<@${listing.seller}>`, inline: true },
                      { name: "💰 Cena", value: `**${listing.price}** pkt`, inline: true },
                      { name: "💰 Twoje saldo", value: `**${buyerPts}** pkt`, inline: true }
                    )
                    .setFooter({ text: `Link do produktu został wysłany w wiadomości prywatnej • ID: ${listingId}` })
                    .setTimestamp();

                  interaction.editReply({ embeds: [confirmEmbed] });

                  // Aktualizacja oryginalnej wiadomości z ofertą
                  try {
                    const originalEmbed = interaction.message.embeds[0];
                    const updatedEmbed = EmbedBuilder.from(originalEmbed)
                      .setColor(0x6B7280)
                      .setTitle(`✅ SPRZEDANE: ${listing.name}`)
                      .setDescription(originalEmbed.description || '')
                      .spliceFields(0, originalEmbed.fields.length)
                      .addFields(
                        { name: "💰 Cena", value: `**${listing.price}** pkt`, inline: true },
                        { name: "👤 Sprzedawca", value: `<@${listing.seller}>`, inline: true },
                        { name: "👤 Kupujący", value: `<@${interaction.user.id}>`, inline: true },
                        { name: "🔐 Produkt", value: "Link został wysłany do kupującego", inline: false }
                      );

                    const disabledRow = new ActionRowBuilder().addComponents(
                      new ButtonBuilder()
                        .setCustomId(`buy_${listingId}`)
                        .setLabel(`✅ Sprzedane`)
                        .setStyle(ButtonStyle.Secondary)
                        .setDisabled(true),
                      new ButtonBuilder()
                        .setCustomId(`info_${listingId}`)
                        .setLabel('ℹ️ Informacje')
                        .setStyle(ButtonStyle.Secondary)
                        .setDisabled(true)
                    );

                    // Usuń przyciski edycji i usuwania
                    interaction.message.edit({ 
                      embeds: [updatedEmbed], 
                      components: [disabledRow] 
                    });
                  } catch (editError) {
                    console.error('Błąd przy aktualizacji wiadomości oferty:', editError);
                  }

                  // Wyślij log zakupu
                  client.users.fetch(listing.seller).then(sellerUser => {
                    sendLog('purchase', interaction.user, sellerUser, listing.price, listing);
                    addLog('purchase', interaction.user.id, listing.seller, listing.price, listingId, listing.name);

                    // Powiadomienie dla sprzedawcy
                    const sellerEmbed = new EmbedBuilder()
                      .setColor(COLORS.SUCCESS)
                      .setTitle('💰 Sprzedaż zakończona!')
                      .setDescription(`Twój produkt **"${listing.name}"** został sprzedany!`)
                      .addFields(
                        { name: "👤 Kupujący", value: `<@${interaction.user.id}>`, inline: true },
                        { name: "💰 Cena", value: `**${listing.price}** pkt`, inline: true },
                        { name: "💰 Twoje saldo", value: `**${sellerPts}** pkt`, inline: true }
                      )
                      .setTimestamp();

                    sellerUser.send({ embeds: [sellerEmbed] }).catch(() => {
                      console.log('Nie udało się wysłać DM do sprzedawcy');
                    });
                  });
                });
              });
            }
          );
        });
      });
    });
  }

  // --- Przycisk informacji o ofercie ---
  if (interaction.isButton() && interaction.customId.startsWith('info_')) {
    await interaction.deferReply({ ephemeral: true });
    
    const listingId = interaction.customId.split('_')[1];
    
    DB.get("SELECT * FROM listings WHERE id = ?", [listingId], (err, listing) => {
      if (err || !listing) {
        return interaction.editReply({
          content: '❌ Nie znaleziono informacji o tej ofercie.',
          ephemeral: true
        });
      }

      const embed = new EmbedBuilder()
        .setColor(COLORS.PRIMARY)
        .setTitle(`ℹ️ Informacje o ofercie: ${listing.name}`)
        .addFields(
          { name: '🆔 ID oferty', value: `**${listing.id}**`, inline: true },
          { name: '💰 Cena', value: `**${listing.price}** pkt`, inline: true },
          { name: '👤 Sprzedawca', value: `<@${listing.seller}>`, inline: true },
          { name: '📅 Wystawiono', value: `<t:${Math.floor(new Date(listing.created_at).getTime() / 1000)}:R>`, inline: true },
          { name: '📝 Opis', value: listing.description || 'Brak opisu', inline: false },
          { name: '🔐 Dostęp do produktu', value: 'Link będzie dostępny po zakupie', inline: false }
        )
        .setFooter({ text: listing.sold ? '✅ Sprzedane' : '🛒 Dostępne' })
        .setTimestamp();

      interaction.editReply({ embeds: [embed] });
    });
  }

  // --- Przycisk edycji oferty ---
  if (interaction.isButton() && interaction.customId.startsWith('edit_')) {
    await interaction.deferReply({ ephemeral: true });
    
    const listingId = interaction.customId.split('_')[1];
    
    DB.get("SELECT * FROM listings WHERE id = ?", [listingId], (err, listing) => {
      if (err || !listing) {
        return interaction.editReply({
          content: '❌ Nie znaleziono oferty.',
          ephemeral: true
        });
      }

      if (listing.seller !== interaction.user.id && !hasAdminPermission(interaction.member)) {
        return interaction.editReply({
          content: '❌ Tylko sprzedawca lub administrator może edytować tę ofertę.',
          ephemeral: true
        });
      }

      if (listing.sold === 1) {
        return interaction.editReply({
          content: '❌ Nie można edytować już sprzedanej oferty.',
          ephemeral: true
        });
      }

      const modal = new ModalBuilder()
        .setCustomId(`editModal_${listingId}`)
        .setTitle('✏️ Edytuj ofertę');

      const nazwa = new TextInputBuilder()
        .setCustomId('nazwa')
        .setLabel('Nazwa produktu')
        .setValue(listing.name)
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(100);

      const opis = new TextInputBuilder()
        .setCustomId('opis')
        .setLabel('Opis produktu')
        .setValue(listing.description)
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(1000);

      const cena = new TextInputBuilder()
        .setCustomId('cena')
        .setLabel('Cena w punktach')
        .setValue(listing.price.toString())
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(10);

      const link = new TextInputBuilder()
        .setCustomId('link')
        .setLabel('Link do produktu')
        .setValue(listing.link)
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(500);

      modal.addComponents(
        new ActionRowBuilder().addComponents(nazwa),
        new ActionRowBuilder().addComponents(opis),
        new ActionRowBuilder().addComponents(cena),
        new ActionRowBuilder().addComponents(link)
      );

      interaction.showModal(modal);
    });
  }

  // --- Obsługa modala edycji ---
  if (interaction.isModalSubmit() && interaction.customId.startsWith('editModal_')) {
    await interaction.deferReply({ ephemeral: true });
    
    const listingId = interaction.customId.split('_')[1];
    const cena = parseInt(interaction.fields.getTextInputValue('cena'));
    const nazwa = interaction.fields.getTextInputValue('nazwa');
    const opis = interaction.fields.getTextInputValue('opis');
    const link = interaction.fields.getTextInputValue('link');

    // Walidacja
    if (isNaN(cena) || cena <= 0) {
      return interaction.editReply({
        content: '❌ Cena musi być liczbą większą od 0!',
        ephemeral: true
      });
    }

    if (!link.startsWith('http://') && !link.startsWith('https://')) {
      return interaction.editReply({
        content: '❌ Link musi zaczynać się od http:// lub https://',
        ephemeral: true
      });
    }

    DB.run(
      "UPDATE listings SET name = ?, description = ?, price = ?, link = ? WHERE id = ?",
      [nazwa, opis, cena, link, listingId],
      (err) => {
        if (err) {
          console.error('Błąd aktualizacji oferty:', err);
          return interaction.editReply({
            content: '❌ Nie udało się zaktualizować oferty!',
            ephemeral: true
          });
        }

        const listing = { id: listingId, name: nazwa, price: cena };
        sendLog('listing_edited', interaction.user, null, cena, listing);
        addLog('listing_edited', interaction.user.id, null, cena, listingId, nazwa);

        interaction.editReply({
          content: `✅ Oferta "${nazwa}" została zaktualizowana!`,
          ephemeral: true
        });

        // Aktualizuj wiadomość z ofertą
        DB.get("SELECT * FROM listings WHERE id = ?", [listingId], (err, updatedListing) => {
          if (!err && updatedListing) {
            try {
              const embed = new EmbedBuilder()
                .setColor(COLORS.PRIMARY)
                .setAuthor({ 
                  name: interaction.user.username, 
                  iconURL: interaction.user.displayAvatarURL() 
                })
                .setTitle(`🛒 ${updatedListing.name} ✏️`)
                .setDescription(updatedListing.description)
                .addFields(
                  { name: "💰 Cena", value: `**${updatedListing.price}** pkt`, inline: true },
                  { name: "👤 Sprzedawca", value: `<@${updatedListing.seller}>`, inline: true },
                  { name: "🔐 Dostęp do produktu", value: "Link będzie dostępny po zakupie", inline: false }
                )
                .setFooter({ text: `ID oferty: ${listingId} • Edytowano • ${new Date().toLocaleDateString('pl-PL')}` })
                .setTimestamp();

              const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                  .setCustomId(`buy_${listingId}`)
                  .setLabel(`🛒 Kup za ${updatedListing.price} pkt`)
                  .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                  .setCustomId(`info_${listingId}`)
                  .setLabel('ℹ️ Informacje')
                  .setStyle(ButtonStyle.Secondary)
              );

              const ownerRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                  .setCustomId(`edit_${listingId}`)
                  .setLabel('✏️ Edytuj')
                  .setStyle(ButtonStyle.Primary),
                new ButtonBuilder()
                  .setCustomId(`delete_${listingId}`)
                  .setLabel('🗑️ Usuń')
                  .setStyle(ButtonStyle.Danger)
              );

              // Znajdź oryginalną wiadomość i zaktualizuj ją
              const channel = interaction.channel;
              // Tutaj potrzebujemy messageReference do oryginalnej wiadomości
              // W praktyce może być potrzebne przechowywanie ID wiadomości w bazie danych
            } catch (error) {
              console.error('Błąd przy aktualizacji wiadomości:', error);
            }
          }
        });
      }
    );
  }

  // --- Przycisk usuwania oferty ---
  if (interaction.isButton() && interaction.customId.startsWith('delete_')) {
    await interaction.deferReply({ ephemeral: true });
    
    const listingId = interaction.customId.split('_')[1];
    
    DB.get("SELECT * FROM listings WHERE id = ?", [listingId], (err, listing) => {
      if (err || !listing) {
        return interaction.editReply({
          content: '❌ Nie znaleziono oferty.',
          ephemeral: true
        });
      }

      if (listing.seller !== interaction.user.id && !hasAdminPermission(interaction.member)) {
        return interaction.editReply({
          content: '❌ Tylko sprzedawca lub administrator może usunąć tę ofertę.',
          ephemeral: true
        });
      }

      DB.run("DELETE FROM listings WHERE id = ?", [listingId], (err) => {
        if (err) {
          console.error('Błąd usuwania oferty:', err);
          return interaction.editReply({
            content: '❌ Wystąpił błąd podczas usuwania oferty.',
            ephemeral: true
          });
        }

        // Usuń wiadomość z ofertą
        try {
          interaction.message.delete();
        } catch (error) {
          console.error('Błąd przy usuwaniu wiadomości:', error);
        }

        const embed = new EmbedBuilder()
          .setColor(COLORS.SUCCESS)
          .setTitle('🗑️ Oferta usunięta')
          .setDescription(`Pomyślnie usunięto ofertę **"${listing.name}"**`)
          .setTimestamp();

        interaction.editReply({ embeds: [embed] });

        sendLog('listing_deleted', interaction.user, null, 0, { id: listingId }, listing.name);
        addLog('listing_deleted', interaction.user.id, null, 0, listingId, listing.name);
      });
    });
  }
});

// Funkcja sprawdzająca czy to ten sam dzień
function isSameDay(date1, date2) {
  return date1.getFullYear() === date2.getFullYear() &&
         date1.getMonth() === date2.getMonth() &&
         date1.getDate() === date2.getDate();
}

// === OBSŁUGA BŁĘDÓW ===
process.on('unhandledRejection', (error) => {
  console.error('Nieobsłużony błąd:', error);
});

process.on('uncaughtException', (error) => {
  console.error('Nieprzechwycony wyjątek:', error);
});

// === START BOTA ===
const TOKEN = process.env.TOKEN;

if (!TOKEN) {
  console.error('❌ Brak tokena! Ustaw zmienną środowiskową TOKEN w ustawieniach hostingu.');
  process.exit(1);
}

client.login(TOKEN)
  .then(() => console.log('🚀 Bot uruchomiony poprawnie!'))
  .catch(err => {
    console.error('❌ Błąd logowania:', err);
    process.exit(1);
});
