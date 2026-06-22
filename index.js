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
const MIN_UPTIME_HOURS = 4;
const CHECK_INTERVAL_MS = 30 * 1000; // every 30 seconds
// ============================================

if (!BOT_TOKEN || !ROBLOX_COOKIE) {
  console.error('❌ ERROR: BOT_TOKEN or ROBLOX_COOKIE is missing!');
  process.exit(1);
}

// Keep-alive HTTP server so Railway doesn't kill the process
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200);
  res.end('Bot is running!');
}).listen(PORT, () => {
  console.log(`✅ Keep-alive server running on port ${PORT}`);
});

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const DATA_FILE = './setup_data.json';
const TRACKER_FILE = './server_tracker.json';
let setupData = {};

// serverTracker stores: { [serverId]: { firstSeen: timestamp, lastSeen: timestamp, posted: bool } }
let serverTracker = {};

function loadData() {
  if (fs.existsSync(DATA_FILE)) {
    try { setupData = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (e) { setupData = {}; }
  }
  if (fs.existsSync(TRACKER_FILE)) {
    try { serverTracker = JSON.parse(fs.readFileSync(TRACKER_FILE, 'utf8')); } catch (e) { serverTracker = {}; }
  }
}

function saveData() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(setupData, null, 2));
}

function saveTracker() {
  fs.writeFileSync(TRACKER_FILE, JSON.stringify(serverTracker, null, 2));
}

function formatUptime(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${h}h ${m}m ${s}s`;
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
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
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

    const now = Date.now();
    const minUptimeMs = MIN_UPTIME_HOURS * 60 * 60 * 1000;

    // Get current low player server IDs
    const lowServers = data.data.filter(server =>
      server.playing >= 1 && server.playing <= MAX_PLAYERS
    );

    const currentIds = new Set(lowServers.map(s => s.id));

    // Remove servers that disappeared from tracker
    for (const id of Object.keys(serverTracker)) {
      if (!currentIds.has(id)) {
        console.log(`Server ${id} disappeared, removing from tracker.`);
        delete serverTracker[id];
      }
    }

    // Add new servers or update existing ones
    for (const server of lowServers) {
      if (!serverTracker[server.id]) {
        // New server — start tracking
        serverTracker[server.id] = {
          firstSeen: now,
          lastSeen: now,
          players: server.playing,
          maxPlayers: server.maxPlayers,
          posted: false
        };
        console.log(`🆕 Started tracking server ${server.id} with ${server.playing} player(s)`);
      } else {
        // Update last seen
        serverTracker[server.id].lastSeen = now;
        serverTracker[server.id].players = server.playing;
      }
    }

    saveTracker();

    // Find servers that have been tracked for 4+ hours and not yet posted
    const readyServers = Object.entries(serverTracker).filter(([id, info]) => {
      const uptime = now - info.firstSeen;
      return uptime >= minUptimeMs && !info.posted;
    });

    if (readyServers.length === 0) {
      // Log how close the nearest server is
      const closest = Object.entries(serverTracker)
        .filter(([id, info]) => !info.posted)
        .sort((a, b) => b[1].firstSeen - a[1].firstSeen);

      if (closest.length > 0) {
        const [id, info] = closest[0];
        const uptime = now - info.firstSeen;
        const remaining = minUptimeMs - uptime;
        console.log(`⏳ Closest server has been tracked for ${formatUptime(uptime)}, needs ${formatUptime(remaining)} more.`);
      } else {
        console.log('No servers being tracked yet.');
      }
      return;
    }

    // Post the first ready server
    const [serverId, serverInfo] = readyServers[0];
    const uptime = now - serverInfo.firstSeen;
    const joinLink = `https://www.roblox.com/games/start?placeId=${PLACE_ID}&gameInstanceId=${serverId}`;

    console.log(`✅ Server ${serverId} has been up for ${formatUptime(uptime)}! Posting...`);

    for (const [guildId, channelId] of Object.entries(setupData)) {
      const channel = await client.channels.fetch(channelId).catch(() => null);
      if (!channel) {
        console.log(`Could not find channel ${channelId}`);
        continue;
      }

      const embed = new EmbedBuilder()
        .setTitle('🌱 4+ Hour Low Player Server Found!')
        .setColor(0x57F287)
        .setDescription(`A server with only **${serverInfo.players}** player(s) has been running for over 4 hours in Grow a Garden 2!`)
        .addFields(
          { name: '👥 Players', value: `${serverInfo.players} / ${serverInfo.maxPlayers}`, inline: true },
          { name: '⏱️ Server Uptime', value: formatUptime(uptime), inline: true },
          { name: '🔗 Join Link', value: `[Click to Join Now!](${joinLink})`, inline: false }
        )
        .setFooter({ text: 'Grow a Garden 2 Server Finder • Checks every 30 seconds' })
        .setTimestamp();

      await channel.send({ embeds: [embed] });
      console.log(`✅ Posted to channel ${channelId}`);
    }

    // Mark server as posted so it doesn't spam
    serverTracker[serverId].posted = true;
    saveTracker();

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

  const statusCommand = new SlashCommandBuilder()
    .setName('status')
    .setDescription('Show how many servers are currently being tracked')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

  await client.application.commands.set([setupCommand, stopCommand, checkCommand, statusCommand]);
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
      content: `✅ Done! The bot will post 4+ hour low player servers to ${channel} automatically.\n⏳ Note: It may take up to 4 hours before the first server is posted since tracking just started!`,
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

  if (interaction.commandName === 'status') {
    const now = Date.now();
    const minUptimeMs = MIN_UPTIME_HOURS * 60 * 60 * 1000;
    const total = Object.keys(serverTracker).length;
    const ready = Object.values(serverTracker).filter(s => (now - s.firstSeen) >= minUptimeMs && !s.posted).length;
    const posted = Object.values(serverTracker).filter(s => s.posted).length;

    await interaction.reply({
      content: `📊 **Server Tracker Status**\n🔍 Tracking: **${total}** servers\n✅ Ready to post (4h+): **${ready}** servers\n📨 Already posted: **${posted}** servers`,
      flags: MessageFlags.Ephemeral
    });
  }
});

process.on('unhandledRejection', (error) => {
  console.error('Unhandled rejection:', error.message);
});

client.login(BOT_TOKEN);
