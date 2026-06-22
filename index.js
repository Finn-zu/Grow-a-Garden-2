const { Client, GatewayIntentBits, SlashCommandBuilder, PermissionFlagsBits, ChannelType, EmbedBuilder, MessageFlags } = require('discord.js');
const https = require('https');
const http = require('http');
const fs = require('fs');

// ============================================
// CONFIG — loaded from Railway environment variables
// ============================================
const BOT_TOKEN = process.env.BOT_TOKEN;
const ROBLOX_COOKIE = process.env.ROBLOX_COOKIE;
const PLACE_ID = '97598239454123';
const MAX_PLAYERS = 2;
const CHECK_INTERVAL_MS = 30 * 1000; // every 30 seconds
// ============================================

if (!BOT_TOKEN || !ROBLOX_COOKIE) {
  console.error('❌ ERROR: BOT_TOKEN or ROBLOX_COOKIE is missing!');
  process.exit(1);
}

// Keep-alive so Railway doesn't kill the process
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200);
  res.end('Bot is running!');
}).listen(PORT, () => {
  console.log(`✅ Keep-alive server running on port ${PORT}`);
});

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const DATA_FILE = './setup_data.json';
let setupData = {};
let lastPostedServerId = null;

function loadData() {
  if (fs.existsSync(DATA_FILE)) {
    try {
      setupData = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    } catch (e) {
      setupData = {};
    }
  }
}

function saveData() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(setupData, null, 2));
}

function fetchRobloxServers() {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'games.roblox.com',
      path: `/v1/games/${PLACE_ID}/servers/Public?sortOrder=Asc&limit=100`,
      method: 'GET',
      headers: {
        'Cookie': `.ROBLOSECURITY=${ROBLOX_COOKIE}`,
        'User-Agent': 'Mozilla/5.0'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.end();
  });
}

async function checkAndPostServers() {
  if (Object.keys(setupData).length === 0) return;

  try {
    const data = await fetchRobloxServers();
    if (!data || !data.data) return;

    // Filter: only 1-2 player servers
    const lowServers = data.data.filter(server =>
      server.playing >= 1 && server.playing <= MAX_PLAYERS
    );

    if (lowServers.length === 0) {
      console.log('No low player servers found this check.');
      return;
    }

    // Pick the first one, skip if same as last posted
    const server = lowServers[0];
    if (server.id === lastPostedServerId) {
      console.log('Same server as last post, skipping.');
      return;
    }

    lastPostedServerId = server.id;
    console.log(`✅ Found a low player server! Players: ${server.playing}`);

    const joinLink = `https://www.roblox.com/games/start?placeId=${PLACE_ID}&gameInstanceId=${server.id}`;

    for (const [guildId, channelId] of Object.entries(setupData)) {
      const channel = await client.channels.fetch(channelId).catch(() => null);
      if (!channel) {
        console.log(`Could not find channel ${channelId}`);
        continue;
      }

      const embed = new EmbedBuilder()
        .setTitle('🌱 Low Player Server Found!')
        .setColor(0x57F287)
        .setDescription(`A server with only **${server.playing}** player(s) was found in Grow a Garden 2!`)
        .addFields(
          { name: '👥 Players', value: `${server.playing} / ${server.maxPlayers}`, inline: true },
          { name: '🔗 Join Link', value: `[Click to Join Now!](${joinLink})`, inline: false }
        )
        .setFooter({ text: 'Grow a Garden 2 Server Finder • Checks every 30 seconds' })
        .setTimestamp();

      await channel.send({ embeds: [embed] });
      console.log(`✅ Posted to channel ${channelId}`);
    }
  } catch (err) {
    console.error('Error checking servers:', err.message);
  }
}

client.once('ready', async () => {
  console.log(`✅ Bot is online as ${client.user.tag}`);
  loadData();

  const setupCommand = new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Set up the channel for low player server alerts')
    .addChannelOption(option =>
      option.setName('channel')
        .setDescription('The channel to send low player server alerts to')
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

  const stopCommand = new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Stop sending low player server alerts')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

  const checkCommand = new SlashCommandBuilder()
    .setName('check')
    .setDescription('Manually check for low player servers now')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

  await client.application.commands.set([setupCommand, stopCommand, checkCommand]);
  console.log('✅ Slash commands registered!');

  setInterval(checkAndPostServers, CHECK_INTERVAL_MS);
  console.log(`✅ Auto-checking every ${CHECK_INTERVAL_MS / 1000} seconds.`);
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'setup') {
    const channel = interaction.options.getChannel('channel');
    setupData[interaction.guildId] = channel.id;
    saveData();

    await interaction.reply({
      content: `✅ Done! Low player server alerts will be sent to ${channel} automatically every 30 seconds.`,
      flags: MessageFlags.Ephemeral
    });

    console.log(`Setup done for guild ${interaction.guildId} → channel ${channel.id}`);
    checkAndPostServers();
  }

  if (interaction.commandName === 'stop') {
    if (setupData[interaction.guildId]) {
      delete setupData[interaction.guildId];
      saveData();
      await interaction.reply({
        content: '🛑 Stopped sending server alerts.',
        flags: MessageFlags.Ephemeral
      });
    } else {
      await interaction.reply({
        content: '⚠️ No alert channel was set up yet.',
        flags: MessageFlags.Ephemeral
      });
    }
  }

  if (interaction.commandName === 'check') {
    await interaction.reply({
      content: '🔍 Checking for low player servers now...',
      flags: MessageFlags.Ephemeral
    });
    checkAndPostServers();
  }
});

process.on('unhandledRejection', (error) => {
  console.error('Unhandled rejection:', error.message);
});

client.login(BOT_TOKEN);
