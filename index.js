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
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
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
});

// === BOT ===
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

client.commands = new Collection();

// ID roli administratora (tylko ta rola i administratorzy mogą używać /dodajpunkty)
const ADMIN_ROLE_ID = "1369060137892843530";

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
    .setDescription('💰 Sprawdź swoje saldo punktów'),

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
].map(cmd => cmd.toJSON());

// === FUNKCJE POMOCNICZE ===
function ensureUser(userId, callback = () => {}) {
  DB.run("INSERT OR IGNORE INTO users (id, points) VALUES (?, 0)", [userId], callback);
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

// Funkcja sprawdzająca uprawnienia administratora
function hasAdminPermission(member) {
  return member.permissions.has(PermissionsBitField.Flags.Administrator) || 
         member.roles.cache.has(ADMIN_ROLE_ID);
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
});

// === OBSŁUGA KOMEND I PRZYCISKÓW ===
client.on('interactionCreate', async (interaction) => {
  // --- /wystaw - pokazuje tylko przycisk do otwarcia formularza ---
  if (interaction.isChatInputCommand() && interaction.commandName === 'wystaw') {
    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
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

        getPoints(interaction.user.id, (pts) => {
          const embed = new EmbedBuilder()
            .setColor(0x5865F2)
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

          interaction.channel.send({ embeds: [embed], components: [row] });
          
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
    // Sprawdź uprawnienia
    if (!hasAdminPermission(interaction.member)) {
      const embed = new EmbedBuilder()
        .setColor(0xED4245)
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
          .setColor(0x57F287)
          .setTitle('✅ Punkty dodane')
          .setDescription(`Dodano **${ilosc}** punktów do konta **${user.username}**`)
          .addFields(
            { name: '👤 Użytkownik', value: `<@${user.id}>`, inline: true },
            { name: '💰 Nowe saldo', value: `**${pts}** pkt`, inline: true },
            { name: '👨‍💼 Administrator', value: `<@${interaction.user.id}>`, inline: true }
          )
          .setTimestamp();

        interaction.editReply({ embeds: [embed] });
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
            .setColor(0x57F287)
            .setTitle('✅ Punkty usunięte')
            .setDescription(`Usunięto **${ilosc}** punktów z konta **${user.username}**`)
            .addFields(
              { name: '👤 Użytkownik', value: `<@${user.id}>`, inline: true },
              { name: '💰 Nowe saldo', value: `**${pts}** pkt`, inline: true }
            )
            .setTimestamp();

          interaction.editReply({ embeds: [embed] });
        });
      } else {
        const embed = new EmbedBuilder()
          .setColor(0xED4245)
          .setTitle('❌ Błąd')
          .setDescription(`**${user.username}** nie ma wystarczającej liczby punktów!`)
          .setTimestamp();

        interaction.editReply({ embeds: [embed] });
      }
    });
  }

  // --- /saldo ---
  if (interaction.isChatInputCommand() && interaction.commandName === 'saldo') {
    getPoints(interaction.user.id, (pts) => {
      const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('💰 Twoje saldo')
        .setDescription(`**${interaction.user.username}**, masz **${pts}** punktów`)
        .setThumbnail(interaction.user.displayAvatarURL())
        .setTimestamp();

      interaction.reply({ embeds: [embed], ephemeral: true });
    });
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
            .setColor(0xFEE75C)
            .setTitle('🏪 Sklep - brak ofert')
            .setDescription('Aktualnie nie ma żadnych produktów w sklepie.\nBądź pierwszy i wystaw coś używając `/wystaw`!')
            .setTimestamp();

          return interaction.reply({ embeds: [embed] });
        }

        const embed = new EmbedBuilder()
          .setColor(0x5865F2)
          .setTitle('🏪 Dostępne produkty')
          .setDescription(`Znaleziono **${rows.length}** dostępnych produktów:\n\n*🔐 Linki do produktów są prywatne i dostępne tylko po zakupie*`)
          .setFooter({ text: `Użyj /wystaw aby dodać swój produkt` })
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
              .setColor(0x57F287)
              .setTitle('✅ Przelew wykonany')
              .setDescription(`Przelano **${amount}** punktów do **${targetUser.username}**`)
              .addFields(
                { name: '👤 Od', value: `<@${interaction.user.id}>`, inline: true },
                { name: '👤 Do', value: `<@${targetUser.id}>`, inline: true },
                { name: '💰 Twoje saldo', value: `**${senderPts}** pkt`, inline: true }
              )
              .setTimestamp();

            interaction.editReply({ embeds: [embed] });

            // Powiadomienie dla odbiorcy
            const receiverEmbed = new EmbedBuilder()
              .setColor(0x57F287)
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

  // --- Kupowanie oferty ---
  if (interaction.isButton() && interaction.customId.startsWith('buy_')) {
    await interaction.deferReply({ ephemeral: true });
    
    const listingId = interaction.customId.split('_')[1];

    DB.get("SELECT * FROM listings WHERE id = ?", [listingId], (err, listing) => {
      if (err) {
        console.error('Błąd bazy danych:', err);
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

      if (listing.sold === 1) {
        return interaction.editReply({
          content: "❌ Produkt został już sprzedany.",
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
              .setColor(0xED4245)
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
                console.error('Błąd aktualizacji oferty:', err);
                return interaction.editReply({
                  content: '❌ Wystąpił błąd podczas finalizacji zakupu.',
                  ephemeral: true
                });
              }

              // Pobierz aktualne salda
              getPoints(interaction.user.id, (buyerPts) => {
                getPoints(listing.seller, (sellerPts) => {
                  // Embed potwierdzający zakup DLA KUPUJĄCEGO (Z LINKIEM)
                  const confirmEmbed = new EmbedBuilder()
                    .setColor(0x57F287)
                    .setTitle("✅ Zakup udany!")
                    .setDescription(`Kupiłeś **${listing.name}**`)
                    .addFields(
                      { name: "👤 Sprzedawca", value: `<@${listing.seller}>`, inline: true },
                      { name: "💰 Cena", value: `**${listing.price}** pkt`, inline: true },
                      { name: "🔗 Link do produktu", value: listing.link, inline: false },
                      { name: "💰 Twoje saldo", value: `**${buyerPts}** pkt`, inline: true }
                    )
                    .setFooter({ text: `ID oferty: ${listingId}` })
                    .setTimestamp();

                  interaction.editReply({ embeds: [confirmEmbed] });

                  // Aktualizacja oryginalnej wiadomości z ofertą (BEZ LINKU)
                  const updatedEmbed = EmbedBuilder.from(interaction.message.embeds[0])
                    .setColor(0x95A5A6)
                    .setTitle(`✅ SPRZEDANE: ${listing.name}`)
                    .addFields(
                      { name: "👤 Kupujący", value: `<@${interaction.user.id}>`, inline: true },
                      { name: "💰 Cena", value: `**${listing.price}** pkt`, inline: true },
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

                  interaction.message.edit({ 
                    embeds: [updatedEmbed], 
                    components: [disabledRow] 
                  });

                  // Powiadomienie dla sprzedawcy (BEZ LINKU)
                  client.users.fetch(listing.seller).then(sellerUser => {
                    const sellerEmbed = new EmbedBuilder()
                      .setColor(0x57F287)
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

  // --- Przycisk informacji o ofercie (BEZ LINKU) ---
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
        .setColor(0x5865F2)
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
});

// === OBSŁUGA BŁĘDÓW ===
process.on('unhandledRejection', (error) => {
  console.error('Nieobsłużony błąd:', error);
});

process.on('uncaughtException', (error) => {
  console.error('Nieprzechwycony wyjątek:', error);
});

// === START BOTA ===
client.login(process.env.DISCORD_TOKEN).then(() => {
  console.log('🚀 Bot uruchamia się...');
}).catch(error => {
  console.error('❌ Błąd logowania:', error);
});
