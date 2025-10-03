const {
  Client, GatewayIntentBits, Partials,
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  SlashCommandBuilder, Collection,
  ModalBuilder, TextInputBuilder, TextInputStyle
} = require('discord.js');
const sqlite3 = require('sqlite3').verbose();
const express = require('express');

// === KEEP-ALIVE SERVER (Render) ===
const app = express();
app.get('/', (req, res) => res.send('Bot działa!'));
app.listen(3000, () => console.log('Keep-alive server running'));

// === BAZA ===
const DB = new sqlite3.Database('./market.db');
DB.serialize(() => {
  DB.run("CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, points INTEGER)");
  DB.run("CREATE TABLE IF NOT EXISTS listings (id INTEGER PRIMARY KEY AUTOINCREMENT, seller TEXT, price INTEGER, name TEXT, description TEXT, link TEXT, sold INTEGER DEFAULT 0)");
});

// === BOT ===
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
  partials: [Partials.Channel]
});

client.commands = new Collection();

// === KOMENDY ===
const commands = [
  new SlashCommandBuilder()
    .setName('wystaw')
    .setDescription('Wystaw produkt na sprzedaż'),

  new SlashCommandBuilder()
    .setName('dodajpunkty')
    .setDescription('Dodaj punkty użytkownikowi')
    .addUserOption(opt => opt.setName('uzytkownik').setDescription('Użytkownik').setRequired(true))
    .addIntegerOption(opt => opt.setName('ilosc').setDescription('Ilość punktów').setRequired(true)),

  new SlashCommandBuilder()
    .setName('usunpunkty')
    .setDescription('Usuń punkty użytkownikowi')
    .addUserOption(opt => opt.setName('uzytkownik').setDescription('Użytkownik').setRequired(true))
    .addIntegerOption(opt => opt.setName('ilosc').setDescription('Ilość punktów').setRequired(true)),

  new SlashCommandBuilder()
    .setName('saldo')
    .setDescription('Sprawdź swoje saldo punktów'),
].map(cmd => cmd.toJSON());

// === FUNKCJE POMOCNICZE ===
function ensureUser(userId, callback) {
  DB.run("INSERT INTO users (id, points) VALUES (?, ?) ON CONFLICT(id) DO NOTHING", [userId, 0], callback);
}

function addPoints(userId, amount, callback = () => {}) {
  ensureUser(userId, () => {
    DB.run("UPDATE users SET points = COALESCE(points,0) + ? WHERE id = ?", [amount, userId], callback);
  });
}

function canRemovePoints(userId, amount, callback) {
  DB.get("SELECT points FROM users WHERE id = ?", [userId], (err, row) => {
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
    callback(row ? row.points : 0);
  });
}

// === EVENT READY ===
client.once('ready', async () => {
  console.log(`Zalogowano jako ${client.user.tag}`);

  // 👇 WSTAW ID SWOJEGO SERWERA
  const GUILD_ID = "TWOJE_ID_SERWERA";
  const guild = client.guilds.cache.get(GUILD_ID);

  if (guild) {
    await guild.commands.set(commands);
    console.log("Komendy slash zarejestrowane lokalnie w guild (natychmiast).");
  } else {
    console.log("Nie znaleziono gildii – sprawdź ID serwera.");
  }
});

// === OBSŁUGA KOMEND I PRZYCISKÓW ===
client.on('interactionCreate', async (interaction) => {
  // --- /wystaw otwiera modal ---
  if (interaction.isChatInputCommand() && interaction.commandName === 'wystaw') {
    const modal = new ModalBuilder()
      .setCustomId('wystawModal')
      .setTitle('🛒 Wystaw produkt');

    const cena = new TextInputBuilder()
      .setCustomId('cena')
      .setLabel('Cena w punktach')
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    const nazwa = new TextInputBuilder()
      .setCustomId('nazwa')
      .setLabel('Nazwa produktu')
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    const opis = new TextInputBuilder()
      .setCustomId('opis')
      .setLabel('Opis produktu')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true);

    const link = new TextInputBuilder()
      .setCustomId('link')
      .setLabel('Link do produktu')
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    modal.addComponents(
      new ActionRowBuilder().addComponents(cena),
      new ActionRowBuilder().addComponents(nazwa),
      new ActionRowBuilder().addComponents(opis),
      new ActionRowBuilder().addComponents(link)
    );

    await interaction.showModal(modal);
  }

  // --- Obsługa modala ---
  if (interaction.isModalSubmit() && interaction.customId === 'wystawModal') {
    const cena = parseInt(interaction.fields.getTextInputValue('cena'));
    const nazwa = interaction.fields.getTextInputValue('nazwa');
    const opis = interaction.fields.getTextInputValue('opis');
    const link = interaction.fields.getTextInputValue('link');

    DB.run(
      "INSERT INTO listings (seller, price, name, description, link) VALUES (?, ?, ?, ?, ?)",
      [interaction.user.id, cena, nazwa, opis, link],
      function () {
        const listingId = this.lastID;

        getPoints(interaction.user.id, (pts) => {
          const embed = new EmbedBuilder()
            .setColor(0x5865F2)
            .setAuthor({ name: interaction.user.username, iconURL: interaction.user.displayAvatarURL() })
            .setTitle(`🛒 ${nazwa}`)
            .setDescription(opis)
            .addFields(
              { name: "💰 Cena", value: `${cena} pkt`, inline: true },
              { name: "👤 Sprzedawca", value: `<@${interaction.user.id}>`, inline: true },
              { name: "📊 Saldo sprzedawcy", value: `${pts} pkt`, inline: true }
            )
            .setFooter({ text: `ID oferty: ${listingId}` })
            .setTimestamp();

          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`buy_${listingId}`)
              .setLabel(`Kup za ${cena} pkt`)
              .setStyle(ButtonStyle.Success)
          );

          interaction.reply({ embeds: [embed], components: [row] });
        });
      }
    );
  }

  // --- /dodajpunkty ---
  if (interaction.isChatInputCommand() && interaction.commandName === 'dodajpunkty') {
    const user = interaction.options.getUser('uzytkownik');
    const ilosc = interaction.options.getInteger('ilosc');
    addPoints(user.id, ilosc, () => {
      interaction.reply(`Dodano ${ilosc} punktów dla ${user.username}`);
    });
  }

  // --- /usunpunkty ---
  if (interaction.isChatInputCommand() && interaction.commandName === 'usunpunkty') {
    const user = interaction.options.getUser('uzytkownik');
    const ilosc = interaction.options.getInteger('ilosc');
    removePoints(user.id, ilosc, (success) => {
      if (success) interaction.reply(`Usunięto ${ilosc} punktów od ${user.username}`);
      else interaction.reply(`${user.username} nie ma wystarczającej liczby punktów`);
    });
  }

  // --- /saldo ---
  if (interaction.isChatInputCommand() && interaction.commandName === 'saldo') {
    getPoints(interaction.user.id, (pts) => {
      interaction.reply(`Twoje saldo: ${pts} pkt`);
    });
  }

  // --- Kupowanie oferty ---
  if (interaction.isButton() && interaction.customId.startsWith('buy_')) {
    const listingId = interaction.customId.split('_')[1];

    DB.get("SELECT * FROM listings WHERE id = ?", [listingId], (err, listing) => {
      if (!listing) {
        return interaction.reply({ content: "❌ Ten produkt już nie istnieje.", ephemeral: true });
      }
      if (listing.sold === 1) {
        return interaction.reply({ content: "❌ Produkt został już kupiony.", ephemeral: true });
      }

      // UWAGA: pozwalamy kupować własne oferty (dla testów)
      removePoints(interaction.user.id, listing.price, (success) => {
        if (!success) {
          return interaction.reply({ content: "💸 Nie masz wystarczającej liczby punktów!", ephemeral: true });
        }

        // Dodaj punkty sprzedawcy
        addPoints(listing.seller, listing.price, () => {
          DB.run("UPDATE listings SET sold = 1 WHERE id = ?", [listingId], () => {
            // Pobierz saldo kupującego i sprzedawcy
            getPoints(interaction.user.id, (buyerPts) => {
              getPoints(listing.seller, (sellerPts) => {
                const embed = new EmbedBuilder()
                  .setColor(0x57F287)
                  .setTitle("✅ Zakup udany!")
                  .setDescription(`Kupiłeś **${listing.name}** od <@${listing.seller}>`)
                  .addFields(
                    { name: "🔗 Link do produktu", value: listing.link },
                    { name: "💰 Cena", value: `${listing.price} pkt`, inline: true },
                    { name: "👤 Twoje saldo", value: `${buyerPts} pkt`, inline: true },
                    { name: "👤 Saldo sprzedawcy", value: `${sellerPts} pkt`, inline: true }
                  )
                  .setFooter({ text: `ID oferty: ${listingId}` })
                  .setTimestamp();

                interaction.reply({ embeds: [embed], ephemeral: true });
              });
            });
          });
        });
      });
    });
  }
});

// === START ===
client.login(process.env.DISCORD_TOKEN);
