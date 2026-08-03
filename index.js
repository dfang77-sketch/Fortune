//hi
const fs = require('fs');
const path = require('path');
const { MongoClient } = require('mongodb');
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  PermissionFlagsBits,
  ChannelType
} = require('discord.js');
require('dotenv').config();
const DEVELOPER_ID = '1299875574894039184';
const CO_DEVELOPER_ID = '742955843498278943';

function isDeveloper(userId) {
  return userId === DEVELOPER_ID || userId === CO_DEVELOPER_ID;
}


const HARDCODED_BLACKLISTED_SERVERS = new Set([
  '1029577794935595048'
]);

async function isServerBlacklisted(guildId) {
  if (!guildId) return false;
  if (HARDCODED_BLACKLISTED_SERVERS.has(guildId)) return true;
  if (!serverBlacklistCollection) return false;
  const doc = await serverBlacklistCollection.findOne({ _id: guildId });
  return !!(doc && doc.blacklisted);
}

async function setServerBlacklist(guildId, blacklisted) {
  if (!serverBlacklistCollection) return;
  await serverBlacklistCollection.updateOne(
    { _id: guildId },
    { $set: { _id: guildId, blacklisted, updatedAt: Date.now() } },
    { upsert: true }
  );
}

const PREFIX_CACHE = new Map();

function validatePrefix(input) {
  if (typeof input !== 'string') return { ok: false, reason: 'Prefix must be text.' };
  const trimmed = input.trim();
  if (trimmed.length === 0) return { ok: false, reason: 'Prefix cannot be empty.' };
  if (trimmed.length > 5) return { ok: false, reason: 'Prefix must be 5 characters or less.' };
  if (/\s/.test(trimmed)) return { ok: false, reason: 'Prefix cannot contain spaces or whitespace.' };
  if (/[<>@#`/\\]/.test(trimmed)) return { ok: false, reason: 'Prefix cannot contain any of: < > @ # ` / \\' };
  if (!/^[\x21-\x7E]+$/.test(trimmed)) return { ok: false, reason: 'Prefix must be standard printable ASCII characters only.' };
  return { ok: true, prefix: trimmed };
}

async function getGuildPrefix(guildId) {
  if (!guildId) return null;
  if (PREFIX_CACHE.has(guildId)) return PREFIX_CACHE.get(guildId);
  if (!guildSettingsCollection) return null;
  try {
    const doc = await guildSettingsCollection.findOne({ _id: guildId });
    const prefix = doc && doc.prefix ? doc.prefix : null;
    PREFIX_CACHE.set(guildId, prefix);
    return prefix;
  } catch (err) {
    console.error('Failed to load guild prefix:', err);
    return null;
  } 
}

async function setGuildPrefix(guildId, prefix) {
  if (!guildSettingsCollection) throw new Error('Database not ready');
  await guildSettingsCollection.updateOne(
    { _id: guildId },
    { $set: { prefix: prefix } },
    { upsert: true }
  );
  PREFIX_CACHE.set(guildId, prefix);
}


const token = process.env.DISCORD_BOT_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;

if (!token) {
  console.error('ERROR: DISCORD_BOT_TOKEN is not set in environment variables');
  process.exit(1);
}

if (!clientId) {
  console.error('ERROR: DISCORD_CLIENT_ID is not set in environment variables');
  process.exit(1);
}
let mongoClient;
let db;
let usersCollection;
let cooldownsCollection;
let eventSystemCollection;
let guildItemsCollection;
let globalItemsCollection;
let guildSettingsCollection;
let marketStateCollection;
let raidSeasonCollection;
let raidPlayersCollection;
let serverBlacklistCollection;

async function initializeDatabase() {
  try {
    const mongoUri = process.env.MONGODB_URI;
    if (!mongoUri) {
      console.error('ERROR: MONGODB_URI is not set in environment variables');
      process.exit(1);
    }

    mongoClient = new MongoClient(mongoUri, {
      ssl: true,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
    });
    await mongoClient.connect();
    console.log('Connected to MongoDB Atlas');

    db = mongoClient.db('fortunebot');
    usersCollection = db.collection('users');
    cooldownsCollection = db.collection('cooldowns');
    eventSystemCollection = db.collection('eventSystem');
    guildItemsCollection = db.collection('guildItems');
    globalItemsCollection = db.collection('globalItems');
    guildSettingsCollection = db.collection('guildSettings');
    marketStateCollection = db.collection('marketState');
    raidSeasonCollection      = db.collection('raidSeason');
    raidPlayersCollection     = db.collection('raidPlayers');
    serverBlacklistCollection = db.collection('serverBlacklist');

    const eventSystem = await eventSystemCollection.findOne({ _id: 'main' });
    if (!eventSystem) {
      await eventSystemCollection.insertOne({
        _id: 'main',
        currentEvent: null,
        lastEventStart: 0,
        nextEventTime: Date.now() + (4 * 24 * 60 * 60 * 1000),
        eventHistory: []
      });
    }

    await performDatabaseHealthCheck();

    await logDatabaseDiagnostics();

    await initializeGlobalItems();
    await ensureGlobalItems();

  } catch (error) {
    console.error('Failed to connect to MongoDB:', error);
    process.exit(1);
  }
}

let userData = {};
let cooldowns = { scavenge: {}, labor: {}, steal: {}, fish: {} };
global.tempItems = {};
global.activeTrades = {};
global.activeMarbleGames = {};
global.activeDuelGames = {};
global.activeCardDuelGames = {};
global.messageTracker = {};
global.giveArtefactSessions = {};
global.massSellSessions = {};
global.activeFishSessions = {};
global.activeRaidBrowseSessions = {};


const FISH_COOLDOWN = 20 * 60 * 1000; // 20 minutes

const BAIT_CATALOG = {
  'Earthworm': {
    name: 'Earthworm', basePrice: 150, type: 'bait', category: 'minigame', emoji: '🪱',
    description: 'A humble worm dug from the riverbank. Great for lazy afternoons. Attracts mostly common catches.',
    weights: { junk: 55, common: 28, uncommon: 12, rare: 4, legendary: 1 }
  },
  'Cricket': {
    name: 'Cricket', basePrice: 400, type: 'bait', category: 'minigame', emoji: '🦗',
    description: 'Lively bait that attracts livelier fish. Noticeably better odds on uncommon catches.',
    weights: { junk: 35, common: 27, uncommon: 25, rare: 10, legendary: 3 }
  },
  'Salted Lure': {
    name: 'Salted Lure', basePrice: 900, type: 'bait', category: 'minigame', emoji: '🎣',
    description: 'A handcrafted saltwater lure. Rare fish can\'t seem to resist the shimmer.',
    weights: { junk: 18, common: 15, uncommon: 37, rare: 22, legendary: 8 }
  },
  'Gilded Hook': {
    name: 'Gilded Hook', basePrice: 2000, type: 'bait', category: 'minigame', emoji: '🪝',
    description: 'A gold-plated hook said to lure even legendary creatures from the deep. Never snags junk.',
    weights: { junk: 0, common: 15, uncommon: 30, rare: 35, legendary: 20 }
  }
};

const FISH_TABLE = {
  junk: [
    { name: 'Old Boot',           value: 0,  emoji: '🥾', description: 'A waterlogged boot. Not yours, thankfully.' },
    { name: 'Rusty Tin Can',      value: 0,  emoji: '🥫', description: 'Label long gone. Contents unknown. Definitely not fish.' },
    { name: 'Soggy Journal',      value: 25, emoji: '📓', description: 'Most pages illegible — but a curious collector pays for novelty.' },
    { name: 'Strange Pebble',     value: 50, emoji: '🪨', description: 'Oddly round. Not quite artefact-grade, but someone online wants it.' },
    { name: 'Tangled Net Scrap',  value: 10, emoji: '🕸️', description: 'Probably from a commercial fisher. Barely worth hauling in.' }
  ],
  common: [
    { name: 'Minnow',   value: [100, 200], emoji: '🐟', description: 'Tiny but plentiful. Sells at standard market rate.' },
    { name: 'Carp',     value: [150, 280], emoji: '🐡', description: 'Reliable and meaty. The market always wants carp.' },
    { name: 'Perch',    value: [120, 240], emoji: '🐠', description: 'Feisty for its size. Puts up a decent fight.' },
    { name: 'Catfish',  value: [180, 320], emoji: '🐟', description: 'Bottom-feeder with surprising value. A solid catch.' },
    { name: 'Gudgeon',  value: [100, 180], emoji: '🐡', description: 'Not glamorous, but a dependable earner.' },
    { name: 'Roach',    value: [110, 220], emoji: '🐠', description: 'Schools near the riverbed. Easy pickings with the right bait.' }
  ],
  uncommon: [
    { name: 'Bass',     value: [400, 700], emoji: '🐟', description: 'Firm flesh and high demand. A respectable haul.' },
    { name: 'Trout',    value: [420, 750], emoji: '🐠', description: 'Cold-water prize. Buyers line up for fresh trout.' },
    { name: 'Eel',      value: [450, 800], emoji: '🐍', description: 'Slippery and stubborn, but absolutely worth the effort.' },
    { name: 'Pike',     value: [500, 850], emoji: '🐟', description: 'Apex river predator. Sells for a handsome sum.' },
    { name: 'Tench',    value: [380, 680], emoji: '🐡', description: 'Golden scales catch the eye of collectors and chefs alike.' },
    { name: 'Grayling', value: [400, 720], emoji: '🐠', description: 'An uncommon river find, prized for its delicate flavour.' }
  ],
  rare: [
    { name: 'Artefact-Marked Sturgeon', value: [1000, 2000], emoji: '🐟', description: 'Ancient glyphs run along its scales. Centuries of river history, embodied.' },
    { name: 'Crystal Perch',            value: [1200, 2200], emoji: '💎', description: 'Scales shimmer like raw quartz. Scientists are offering serious money.' },
    { name: 'Iron-Scaled Carp',         value: [1100, 2100], emoji: '⚙️', description: 'Mineral deposits hardened its scales to near-metal. A remarkable specimen.' },
    { name: 'Fossilled Snapper',        value: [1300, 2500], emoji: '🦴', description: 'Half fossil, half fish. The palaeontology guild will pay handsomely.' }
  ],
  legendary: [
    { name: 'The Ancient Leviathan', value: [4000, 8000], emoji: '🐉', description: 'A creature from before the artefact age itself. Your hands won\'t stop trembling.' },
    { name: 'The Gilded Carp',       value: [3500, 7000], emoji: '✨', description: 'Solid gold scales. The market hasn\'t seen one in decades.' },
    { name: 'The Phantom Eel',       value: [4500, 8500], emoji: '👻', description: 'Translucent and bioluminescent. Worth more than your entire bank balance.' },
    { name: 'The Spectral Pike',     value: [5000, 9000], emoji: '🌊', description: 'Ethereal and immense. Legends say catching one brings fortune for a month.' }
  ]
};

function rollFishTier(baitName) {
  const bait = BAIT_CATALOG[baitName];
  if (!bait) return 'common';
  const { weights } = bait;
  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (const [tier, w] of Object.entries(weights)) {
    r -= w;
    if (r <= 0) return tier;
  }
  return 'common';
}

function pickFish(tier) {
  const pool = FISH_TABLE[tier];
  return pool[Math.floor(Math.random() * pool.length)];
}

function rollFishValue(fish) {
  if (typeof fish.value === 'number') return fish.value;
  const [min, max] = fish.value;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}


const RAID_UNITS = [
  { id: 'peasant_levy',   name: 'Peasant Levy',    cost: 100,  baseCP: 8,   archetype: 'mob',        ascii: ' ( o )\n  \\|/\n  / \\',   description: 'Conscripted farmers armed with whatever they could find. Individually unremarkable — but coin is scarce and bodies are not.' },
  { id: 'crossbowman',   name: 'Crossbowman',      cost: 350,  baseCP: 18,  archetype: 'ranged',     ascii: ' ( o )\n--|-->\n  / \\',   description: 'A disciplined ranged fighter trained to loose bolts before the lines ever meet. Keeps the enemy honest at distance.' },
  { id: 'spearman',      name: 'Spearman',         cost: 300,  baseCP: 15,  archetype: 'phalanx',    ascii: ' ( o )\n  \\|/\\\n  / \\',  description: 'A steady line-holder trained to brace against charges. The wall that keeps your ground when everything else breaks.' },
  { id: 'man_at_arms',   name: 'Man-at-Arms',      cost: 600,  baseCP: 28,  archetype: 'armored',    ascii: ' { o }\n [|||]\n /| |\\',  description: 'Professional infantry clad in chainmail and carrying the scars to prove it. The backbone of any army worth fearing.' },
  { id: 'squire',        name: 'Squire',           cost: 500,  baseCP: 22,  archetype: 'skirmisher', ascii: ' ( o )\n  -\\|-\n  / \\',   description: 'A knight-in-training burning to prove his worth. Quick, capable, and hungrier than his superiors.' },
  { id: 'sergeant',      name: 'Sergeant',         cost: 900,  baseCP: 40,  archetype: 'veteran',    ascii: ' [_o_]\n  )|(\n /| |\\',   description: 'A battle-hardened veteran who has buried too many men to fear anything. Holds the line so others do not break.' },
  { id: 'knight',        name: 'Knight',           cost: 2000, baseCP: 90,  archetype: 'vanguard',   ascii: ' [#o#]\n [|||]\n /|_|\\',  description: 'A fully armoured warrior bound by blood and blade. Among the most feared on any field — and they know it.' },
  { id: 'cavalry',       name: 'Cavalry',          cost: 1800, baseCP: 75,  archetype: 'mounted',    ascii: ' ( o )\n /VVV\\\n/     \\', description: 'Mounted warriors who shatter enemy lines with terrifying charges. No formation survives a flank unchanged.' },
  { id: 'siege_engineer',name: 'Siege Engineer',   cost: 1500, baseCP: 60,  archetype: 'siege',      ascii: ' ( o )\n_|_[==\n  / \\',   description: 'Operates trebuchets, ballistae, and battering rams. Where walls stand, the siege engineer ends them.' },
  { id: 'battle_mage',   name: 'Battle Mage',      cost: 3000, baseCP: 130, archetype: 'mystical',   ascii: ' (***)\n  ~|~\n  / \\',    description: 'A sorcerer who traded grimoires for war. Commands arcane force that tears through armour and morale in equal measure.' }
];


const RAID_ARCHETYPES = {
  mob: {
    name: 'Mob', emoji: '🪖',
    description: '🪖 Conscripted bodies with no discipline and no future. Strength in numbers alone — and even that has its limits.',
    counters: [],
    weakTo:   ['ranged', 'veteran', 'vanguard']
  },
  ranged: {
    name: 'Ranged', emoji: '🏹',
    description: '🏹 Looses bolts before the lines ever meet. Controls the gap, punishes exposed formations, and dictates the terms of engagement.',
    counters: ['mob', 'mounted'],
    weakTo:   ['armored', 'skirmisher']
  },
  phalanx: {
    name: 'Phalanx', emoji: '🛡️',
    description: '🛡️ A wall of overlapping shields and forward spears. Unmovable when it holds — devastating when it advances.',
    counters: ['mounted', 'vanguard'],
    weakTo:   ['siege']
  },
  armored: {
    name: 'Armored', emoji: '⚔️',
    description: '⚔️ Heavy steel and professional discipline. Absorbs what would kill lesser men and keeps marching forward.',
    counters: ['ranged'],
    weakTo:   ['siege', 'mystical']
  },
  skirmisher: {
    name: 'Skirmisher', emoji: '🗡️',
    description: '🗡️ Fast, unpredictable, and dangerous up close. Dismantles ranged lines and siege machinery before either can respond.',
    counters: ['ranged', 'siege'],
    weakTo:   ['veteran', 'mounted']
  },
  veteran: {
    name: 'Veteran', emoji: '🎖️',
    description: '🎖️ Hardened by campaigns no one else survived. Reads the enemy before they move and crushes the undisciplined without pause.',
    counters: ['mob', 'skirmisher'],
    weakTo:   ['vanguard', 'mounted']
  },
  vanguard: {
    name: 'Vanguard', emoji: '⚜️',
    description: '⚜️ The blade edge of an army. Elite, devastating, and bred for decisive engagements where lesser soldiers would break.',
    counters: ['veteran', 'mob'],
    weakTo:   ['phalanx', 'mystical']
  },
  mounted: {
    name: 'Mounted', emoji: '🐎',
    description: '🐎 Speed, momentum, and shock. Shatters lines that cannot brace in time and pursues anything that tries to run.',
    counters: ['veteran', 'skirmisher'],
    weakTo:   ['phalanx', 'ranged', 'mystical']
  },
  siege: {
    name: 'Siege', emoji: '🪨',
    description: '🪨 Slow, methodical, and catastrophic at range. No formation endures sustained bombardment — and none can close the distance in time.',
    counters: ['armored', 'phalanx'],
    weakTo:   ['skirmisher']
  },
  mystical: {
    name: 'Mystical', emoji: '🔮',
    description: '🔮 Force that operates entirely outside the rules of conventional warfare. Steel, armour, and formation are meaningless to it.',
    counters: ['armored', 'vanguard', 'mounted'],
    weakTo:   []
  }
};

const RAID_COUNTER_NARRATIVES = {
  'ranged_mob':         'Bolts tear through the packed ranks before a single levy can close the gap. Range wins before the fight truly begins.',
  'ranged_mounted':     'Volleys of fire punish the charge while momentum is still building. Horse and rider go down before the line is reached.',
  'armored_ranged':     'Chainmail and plate turn aside what the bolts intended. The crossbow line runs out of answers as the steel keeps walking forward.',
  'phalanx_mounted':   'The spear wall braces and holds its ground. The cavalry charge breaks against a hedge of pikes — momentum converted to carnage.',
  'phalanx_vanguard':  'For all their individual skill, the knights find no gap. The spear wall holds what the blade alone cannot cut through.',
  'siege_armored':     'Trebuchet stones do not negotiate with chainmail. The bombardment turns heavy infantry into a liability — nowhere to shelter, nothing to absorb it.',
  'siege_phalanx':     'A tight formation is a siege engine\'s favourite target. Stone and fire scatter the spear wall before it can ever press forward.',
  'skirmisher_ranged': 'The skirmishers close the distance before the crossbow line can reload. Up close, the ranged advantage disappears entirely.',
  'skirmisher_siege':  'Fast and irregular, the skirmishers reach the war machines before the engineers can respond. The siege line collapses from within.',
  'veteran_mob':       'Discipline meets chaos. The sergeants hold their line as the levy breaks against it — never finding purchase, never threatening the formation.',
  'veteran_skirmisher':'The veterans read the feints and do not take the bait. Experience outlasts unpredictability every time.',
  'vanguard_veteran':  'Even hardened soldiers struggle when elite steel arrives. Battle-worn iron bends under the weight of the charge.',
  'vanguard_mob':      'The knights carve through the mob without slowing. No formation, no discipline — the levy has nothing to offer a Vanguard advance.',
  'mounted_veteran':   'The cavalry flanks before the veterans can adjust their line. Speed renders earned experience irrelevant.',
  'mounted_skirmisher':'The horses are faster. The skirmishers scatter trying to disengage, but mounted pursuit closes every gap they open.',
  'mystical_armored':  'Arcane force passes through plate and chain as though they are not there. The heaviest infantry on the field suddenly has no answer.',
  'mystical_vanguard': 'The knights charge toward an enemy that does not obey the rules of the field. Elite steel meets arcane force — and the steel loses.',
  'mystical_mounted':  'Speed means nothing when the threat reaches you without moving. The cavalry charge ends before it covers the ground.'
};

const BATTLE_SECTION_NAMES = [
  'THE EASTERN FLANK', 'THE WESTERN FLANK', 'THE LEFT WING',
  'THE RIGHT WING',    'THE CENTER',         'THE VANGUARD LINE',
  'THE REAR GUARD',    'THE OPEN FIELD',     'THE RIDGE LINE'
];

function generateBattleScenes(attackerData, defenderData, attackerName, defenderName, deployMerc) {
  const scenes      = [];
  const usedPairs   = new Set();
  const usedSections = [];

  const matchups = [];
  for (const uA of RAID_UNITS) {
    const aCount = (attackerData.soldiers?.[uA.id] || 0);
    if (aCount === 0) continue;
    const archA = RAID_ARCHETYPES[uA.archetype];
    for (const uD of RAID_UNITS) {
      const dCount = (defenderData.soldiers?.[uD.id] || 0);
      if (dCount === 0) continue;
      const aCountersD = archA.counters.includes(uD.archetype);
      const dCountersA = RAID_ARCHETYPES[uD.archetype].counters.includes(uA.archetype);
      if (!aCountersD && !dCountersA) continue;
      matchups.push({ uA, uD, aCount, dCount, aCountersD, dCountersA, significance: aCount * uA.baseCP + dCount * uD.baseCP });
    }
  }
  matchups.sort((a, b) => b.significance - a.significance);

  for (const m of matchups) {
    if (scenes.length >= 3) break;
    const pairKey = `${m.uA.archetype}_${m.uD.archetype}`;
    const pairKeyR = `${m.uD.archetype}_${m.uA.archetype}`;
    if (usedPairs.has(pairKey) || usedPairs.has(pairKeyR)) continue;
    usedPairs.add(pairKey);

    let sectionName = BATTLE_SECTION_NAMES.find(s => !usedSections.includes(s)) || BATTLE_SECTION_NAMES[0];
    usedSections.push(sectionName);

    const artA = m.uA.ascii.split('\n')[0].trim();
    const artD = m.uD.ascii.split('\n')[0].trim();

    let narrative, advantageLine;
    if (m.aCountersD && !m.dCountersA) {
      narrative     = RAID_COUNTER_NARRATIVES[`${m.uA.archetype}_${m.uD.archetype}`] || `${m.uA.name} has the advantage over ${m.uD.name} on this line.`;
      advantageLine = `ADVANTAGE -- ${attackerName}`;
    } else if (m.dCountersA && !m.aCountersD) {
      narrative     = RAID_COUNTER_NARRATIVES[`${m.uD.archetype}_${m.uA.archetype}`] || `${m.uD.name} has the advantage over ${m.uA.name} on this line.`;
      advantageLine = `ADVANTAGE -- ${defenderName}`;
    } else {
      narrative     = 'Both sides press forward. The advantage shifts with every exchange — neither formation is willing to break first.';
      advantageLine = 'CONTESTED';
    }

    scenes.push([
      '==========================================',
      `  ${sectionName}`,
      `  ${attackerName}: ${artA} x${m.aCount} ${m.uA.name}`,
      `  ${defenderName}: ${artD} x${m.dCount} ${m.uD.name}`,
      '==========================================',
      `  ${narrative}`,
      '',
      `  ${advantageLine}`,
      '==========================================',
    ].join('\n'));
  }

  if (scenes.length === 0) {
    scenes.push([
      '==========================================',
      `  ${BATTLE_SECTION_NAMES[0]}`,
      `  ${attackerName} meets ${defenderName} on open ground`,
      '==========================================',
      '  No decisive archetype advantage on any line.',
      '  The outcome rests on training and numbers alone.',
      '==========================================',
    ].join('\n'));
  }

  if (deployMerc) {
    scenes.push([
      '==========================================',
      '  THE SELLSWORD',
      `  ${attackerName} deploys a Sellsword Captain`,
      '==========================================',
      '  The captain cuts through the chaos, fighting for coin',
      '  and not crown — bringing ruthlessness no formation',
      '  can account for.',
      '==========================================',
    ].join('\n'));
  }

  return scenes;
}

function calcRaidCPWithMatchups(attackerRaidData, defenderRaidData, deployMerc = false) {
  const defArchetypes = new Set();
  const attArchetypes = new Set();
  for (const u of RAID_UNITS) {
    if ((attackerRaidData.soldiers?.[u.id] || 0) > 0) attArchetypes.add(u.archetype);
    if ((defenderRaidData.soldiers?.[u.id] || 0) > 0) defArchetypes.add(u.archetype);
  }

  let attackerAdjusted = 0, defenderAdjusted = 0;

  for (const u of RAID_UNITS) {
    const arch = RAID_ARCHETYPES[u.archetype];

    const aCount = (attackerRaidData.soldiers?.[u.id] || 0);
    if (aCount > 0) {
      const aLevel = (attackerRaidData.trainingLevels?.[u.id] || 1);
      let aCP = aCount * u.baseCP * (TRAINING_MULTIPLIERS[aLevel] || 1.0);
      if (arch.counters.some(c => defArchetypes.has(c))) aCP *= 1.1;
      if (arch.weakTo.some(w => defArchetypes.has(w)))   aCP *= 0.9;
      attackerAdjusted += aCP;
    }

    const dCount = (defenderRaidData.soldiers?.[u.id] || 0);
    if (dCount > 0) {
      const dLevel = (defenderRaidData.trainingLevels?.[u.id] || 1);
      let dCP = dCount * u.baseCP * (TRAINING_MULTIPLIERS[dLevel] || 1.0);
      if (arch.counters.some(c => attArchetypes.has(c))) dCP *= 1.1;
      if (arch.weakTo.some(w => attArchetypes.has(w)))   dCP *= 0.9;
      defenderAdjusted += dCP;
    }
  }

  if (deployMerc) attackerAdjusted += RAID_MERCENARY.cp;
  return { attackerAdjusted: Math.floor(attackerAdjusted), defenderAdjusted: Math.floor(defenderAdjusted) };
}

const RAID_UNITS_PER_PAGE = 3;

const RAID_MERCENARY = {
  id: 'sellsword_captain', name: 'Sellsword Captain', cost: 5000, cp: 250,
  ascii: ' (XoX)\n /|\\/|\n  / \\',
  description: 'A ruthless captain who fights for coin, not crown. Deployed once per raid and gone when it ends — win or lose. Does not count toward standing Relative CP.'
};

const TRAINING_MULTIPLIERS = { 1: 1.00, 2: 1.20, 3: 1.40, 4: 1.65, 5: 2.00 };
const TRAINING_COSTS       = { 2: 800, 3: 2500, 4: 7000, 5: 18000 };
const TRAINING_LABELS      = { 2: 'Lv.2 (+20%)', 3: 'Lv.3 (+40%)', 4: 'Lv.4 (+65%)', 5: 'Lv.5 (+100%)' };

const RAID_PAYOUT_RATE = 500;
const RAID_PAYOUT_CAP  = 5000;


async function getRaidSeason() {
  if (!raidSeasonCollection) return { active: false, startedAt: null, endsAt: null, seasonId: 0 };
  const doc = await raidSeasonCollection.findOne({ _id: 'main' });
  return doc || { active: false, startedAt: null, endsAt: null, seasonId: 0 };
}

async function saveRaidSeason(data) {
  await raidSeasonCollection.replaceOne({ _id: 'main' }, { _id: 'main', ...data }, { upsert: true });
}


function defaultRaidPlayer(userId) {
  const soldiers = {}, trainingLevels = {};
  for (const u of RAID_UNITS) { soldiers[u.id] = 0; trainingLevels[u.id] = 1; }
  return { _id: userId, soldiers, trainingLevels, mercenariesOwned: 0, raidsInitiated: [], raidsCompleted: 0, victories: 0, losses: 0 };
}

async function getRaidPlayer(userId) {
  if (!raidPlayersCollection) return defaultRaidPlayer(userId);
  return (await raidPlayersCollection.findOne({ _id: userId })) || defaultRaidPlayer(userId);
}

async function saveRaidPlayer(data) {
  await raidPlayersCollection.replaceOne({ _id: data._id }, data, { upsert: true });
}

async function getAllRaidPlayers() {
  if (!raidPlayersCollection) return [];
  return await raidPlayersCollection.find({}).toArray();
}


function calcRaidCP(raidData) {
  let relative = 0, actual = 0;
  for (const u of RAID_UNITS) {
    const count = (raidData.soldiers || {})[u.id] || 0;
    const level = (raidData.trainingLevels || {})[u.id] || 1;
    relative += count * u.baseCP;
    actual   += count * u.baseCP * (TRAINING_MULTIPLIERS[level] || 1.0);
  }
  return { relative: Math.floor(relative), actual: Math.floor(actual) };
}


async function buildRaidStoreSection(raidSubTab, raidPage, userId) {
  const raidData  = await getRaidPlayer(userId);
  const pageCount = raidSubTab === 'mercenaries' ? 1 : Math.ceil(RAID_UNITS.length / RAID_UNITS_PER_PAGE);
  const safePage  = Math.max(0, Math.min(raidPage, pageCount - 1));

  const subNavRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('store_tab_raid_military_0').setLabel('Buy Military')
      .setStyle(raidSubTab === 'military' ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('store_tab_raid_training_0').setLabel('Training')
      .setStyle(raidSubTab === 'training' ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('store_tab_raid_mercenaries_0').setLabel('Mercenaries')
      .setStyle(raidSubTab === 'mercenaries' ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`store_tab_raid_${raidSubTab}_${safePage - 1}_prev`).setLabel('< Prev')
      .setStyle(ButtonStyle.Secondary).setDisabled(safePage === 0 || raidSubTab === 'mercenaries'),
    new ButtonBuilder().setCustomId(`store_tab_raid_${raidSubTab}_${safePage + 1}_next`).setLabel('Next >')
      .setStyle(ButtonStyle.Secondary).setDisabled(safePage >= pageCount - 1 || raidSubTab === 'mercenaries')
  );

  const additionalComponents = [subNavRow];
  const fields = [];

  if (raidSubTab === 'military') {
    const pageUnits = RAID_UNITS.slice(safePage * RAID_UNITS_PER_PAGE, (safePage + 1) * RAID_UNITS_PER_PAGE);
    for (const u of pageUnits) {
      const owned = (raidData.soldiers || {})[u.id] || 0;
      const arch  = RAID_ARCHETYPES[u.archetype];
      const countersText = arch.counters.length > 0 ? arch.counters.map(c => RAID_ARCHETYPES[c].name).join(', ') : 'None';
      const weakToText   = arch.weakTo.length   > 0 ? arch.weakTo.map(w => RAID_ARCHETYPES[w].name).join(', ')   : 'None';
      fields.push({
        name:  `${u.name}   |   $${u.cost.toLocaleString()} each   |   Base CP: ${u.baseCP}   |   ${arch.emoji} ${arch.name}`,
        value: `\`\`\`\n${u.ascii}\n\`\`\`${u.description}\n${arch.description}\nCounters: **${countersText}**   |   Weak to: **${weakToText}**\nOwned: **${owned}**   |   CP contribution: **${(u.baseCP * owned).toLocaleString()}**`,
        inline: false
      });
      additionalComponents.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`raid_buy_${u.id}_1_p${safePage}`).setLabel(`${u.name} x1 ($${u.cost.toLocaleString()})`).setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`raid_buy_${u.id}_5_p${safePage}`).setLabel(`${u.name} x5 ($${(u.cost*5).toLocaleString()})`).setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`raid_buy_${u.id}_10_p${safePage}`).setLabel(`${u.name} x10 ($${(u.cost*10).toLocaleString()})`).setStyle(ButtonStyle.Success)
      ));
    }
    const { relative } = calcRaidCP(raidData);
    return {
      embeds: [new EmbedBuilder()
        .setTitle('RAID SEASON  --  Buy Military')
        .setDescription(`Recruit soldiers for your empire. Costs come from your cash on hand.\nPage ${safePage + 1} of ${pageCount}`)
        .addFields(...fields, { name: 'Your Current Relative CP', value: relative.toLocaleString(), inline: true })
        .setColor(0x8B0000).setFooter({ text: 'Limited Time Event -- Raid Season  |  Train soldiers to increase Actual CP' }).setTimestamp()],
      additionalComponents
    };

  } else if (raidSubTab === 'training') {
    const pageUnits = RAID_UNITS.slice(safePage * RAID_UNITS_PER_PAGE, (safePage + 1) * RAID_UNITS_PER_PAGE);
    for (const u of pageUnits) {
      const currentLevel = (raidData.trainingLevels || {})[u.id] || 1;
      const nextLevel    = currentLevel + 1;
      const nextCost     = TRAINING_COSTS[nextLevel];
      const currentMult  = TRAINING_MULTIPLIERS[currentLevel];
      const owned        = (raidData.soldiers || {})[u.id] || 0;
      fields.push({
        name:  `${u.name}   |   Training Lv.${currentLevel} / 5   |   CP Mult: x${currentMult.toFixed(2)}`,
        value: `\`\`\`\n${u.ascii}\n\`\`\`Owned: **${owned}**  |  Actual CP per soldier: **${Math.floor(u.baseCP * currentMult)}** (base ${u.baseCP} x ${currentMult.toFixed(2)})\n${currentLevel < 5 ? `Next: **${TRAINING_LABELS[nextLevel]}** -- costs **$${nextCost.toLocaleString()}**` : 'Fully trained. This unit type has reached its peak.'}`,
        inline: false
      });
      additionalComponents.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`raid_train_${u.id}_p${safePage}`)
          .setLabel(currentLevel < 5 ? `${u.name} -> Lv.${nextLevel}  ($${nextCost.toLocaleString()})` : `${u.name} MAX`)
          .setStyle(currentLevel < 5 ? ButtonStyle.Primary : ButtonStyle.Secondary)
          .setDisabled(currentLevel >= 5)
      ));
    }
    return {
      embeds: [new EmbedBuilder()
        .setTitle('RAID SEASON  --  Training')
        .setDescription(`Upgrade unit types to increase their Actual CP. Costs apply per unit type, not per soldier.\nPage ${safePage + 1} of ${pageCount}`)
        .addFields(...fields)
        .setColor(0x8B0000).setFooter({ text: 'Actual CP is hidden from other players  |  Relative CP uses base values only' }).setTimestamp()],
      additionalComponents
    };

  } else {
    const owned = raidData.mercenariesOwned || 0;
    additionalComponents.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('raid_hire_merc_1').setLabel(`Hire x1  ($${RAID_MERCENARY.cost.toLocaleString()})`).setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('raid_hire_merc_3').setLabel(`Hire x3  ($${(RAID_MERCENARY.cost*3).toLocaleString()})`).setStyle(ButtonStyle.Success)
    ));
    return {
      embeds: [new EmbedBuilder()
        .setTitle('RAID SEASON  --  Mercenaries')
        .setDescription('Hire Sellsword Captains to deploy in a single raid. Each captain adds significant Actual CP for that raid only — then their contract ends, win or lose.')
        .addFields({
          name:  `${RAID_MERCENARY.name}   |   $${RAID_MERCENARY.cost.toLocaleString()} per hire   |   +${RAID_MERCENARY.cp} Actual CP (raid only)`,
          value: `\`\`\`\n${RAID_MERCENARY.ascii}\n\`\`\`${RAID_MERCENARY.description}\nCaptains on retainer: **${owned}**`,
          inline: false
        })
        .setColor(0x8B0000).setFooter({ text: 'One captain per raid  |  Does not count toward standing Relative CP' }).setTimestamp()],
      additionalComponents
    };
  }
}

async function gracefulShutdown(signal) {
  console.log(`🔄 Received ${signal}, performing graceful shutdown...`);

  try {
    console.log('💾 Saving all user data before shutdown...');
    await saveUserData();
    await saveCooldowns();

    if (mongoClient) {
      console.log('🔌 Closing MongoDB connection...');
      await mongoClient.close();
    }

    console.log('✅ Graceful shutdown completed');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error during graceful shutdown:', error);
    process.exit(1);
  }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGUSR2', () => gracefulShutdown('SIGUSR2')); // Nodemon restart

async function getUser(userId) {
  if (!userData[userId]) {
    console.log(`🔍 Loading user ${userId} from database...`);
    const user = await usersCollection.findOne({ _id: userId });
    console.log(`🔍 Database returned for ${userId}:`, JSON.stringify(user, null, 2));
    userData[userId] = user || {
      cash: 0,
      artefacts: [],
      items: [],
      bankBalance: 0,
      joinedDate: Date.now(),
      commandCount: 0,
      observationPermission: 'prohibit',
      discoveredArtefacts: []
    };
    console.log(`🔍 Final userData for ${userId}:`, JSON.stringify(userData[userId], null, 2));
  }
  return userData[userId];
}

async function saveUser(userId) {
  if (!usersCollection) {
    console.warn('Users collection not ready, skipping save');
    return;
  }
  if (userData[userId]) {
    try {
      console.log(`💾 Attempting to save user ${userId} with data:`, JSON.stringify(userData[userId], null, 2));
      const result = await usersCollection.replaceOne(
        { _id: userId },
        { _id: userId, ...userData[userId] },
        { upsert: true }
      );
      console.log(`💾 Save result for ${userId}: Matched=${result.matchedCount}, Upserted=${result.upsertedCount}`);

      const verification = await usersCollection.findOne({ _id: userId });
      console.log(`🔍 Verification read for ${userId}:`, JSON.stringify(verification, null, 2));
    } catch (error) {
      console.error(`❌ Failed to save user ${userId}:`, error.message);
      throw error;
    }
  } else {
    console.warn(`⚠️  No data to save for user ${userId}`);
  }
}

async function getCooldowns() {
  const cooldownDoc = await cooldownsCollection.findOne({ _id: 'main' });
  const defaults = { scavenge: {}, labor: {}, steal: {}, fish: {} };

  if (!cooldownDoc) {
    return defaults;
  }

  return {
    scavenge: cooldownDoc.scavenge || {},
    labor: cooldownDoc.labor || {},
    steal: cooldownDoc.steal || {},
    fish: cooldownDoc.fish || {}
  };
}

async function saveCooldowns() {
  if (!cooldownsCollection) {
    console.warn('Cooldowns collection not ready, skipping save');
    return;
  }
  try {
    const result = await cooldownsCollection.replaceOne(
      { _id: 'main' },
      { _id: 'main', ...cooldowns },
      { upsert: true }
    );
    console.log(`💾 Cooldowns: Matched=${result.matchedCount}, Upserted=${result.upsertedCount}`);
  } catch (error) {
    console.error('❌ Failed to save cooldowns:', error.message);
    throw error;
  }
}

async function getEventSystem() {
  return await eventSystemCollection.findOne({ _id: 'main' });
}

async function saveEventSystem(eventData) {
  try {
    const result = await eventSystemCollection.replaceOne(
      { _id: 'main' },
      { _id: 'main', ...eventData },
      { upsert: true }
    );
    console.log(`💾 Event System: Matched=${result.matchedCount}, Upserted=${result.upsertedCount}`);
  } catch (error) {
    console.error('❌ Failed to save event system:', error.message);
    throw error;
  }
}

async function getXpData(userId) {
  const user = await getUser(userId);
  if (!user.xpData) {
    user.xpData = { xp: 0, messageCount: 0, lastMessage: 0 };
    await saveUser(userId);
  }
  return user.xpData;
}

async function getGuildItems(guildId) {
  const guildDoc = await guildItemsCollection.findOne({ _id: guildId });
  return guildDoc?.items || {};
}

async function saveGuildItems(guildId, items) {
  try {
    const result = await guildItemsCollection.replaceOne(
      { _id: guildId },
      { _id: guildId, items },
      { upsert: true }
    );
    console.log(`💾 Guild Items [${guildId}]: Matched=${result.matchedCount}, Upserted=${result.upsertedCount}`);
  } catch (error) {
    console.error(`❌ Failed to save guild items for ${guildId}:`, error.message);
    throw error;
  }
}

async function initializeGlobalItems() {
  try {
    const globalItems = await globalItemsCollection.findOne({ _id: 'main' });
    if (!globalItems) {
      await globalItemsCollection.insertOne({
        _id: 'main',
        items: {
          'Bank Expansion Ticket': {
            name: 'Bank Expansion Ticket',
            basePrice: 25000,
            description: 'Increases your bank capacity by 25%. Price increases with each purchase.',
            type: 'bank_expansion',
            multiplier: 1.25
          }
        }
      });
      console.log('✅ Global items initialized with Bank Expansion Ticket');
    }
  } catch (error) {
    console.error('❌ Failed to initialize global items:', error.message);
    throw error;
  }
}

async function ensureGlobalItems() {
  const setFields = {};
  for (const [key, val] of Object.entries(BAIT_CATALOG)) {
    const { emoji: _emoji, weights: _weights, ...storeEntry } = val;
    setFields[`items.${key}`] = storeEntry;
  }
  await globalItemsCollection.updateOne(
    { _id: 'main' },
    { $set: setFields },
    { upsert: true }
  );
}

async function getGlobalItems() {
  const globalDoc = await globalItemsCollection.findOne({ _id: 'main' });
  return globalDoc?.items || {};
}

async function calculateBankCapacity(userId) {
  const user = await getUser(userId);
  const expansions = user.bankExpansions || 0;
  const baseCapacity = 50000;
  const expansionPercent = 0.25; // 25% per expansion

  return Math.floor(baseCapacity * Math.pow(1 + expansionPercent, expansions));
}

async function calculateExpansionPrice(userId) {
  const user = await getUser(userId);
  const expansions = user.bankExpansions || 0;
  const basePrice = 25000;
  const multiplier = 1.25;

  return Math.floor(basePrice * Math.pow(multiplier, expansions));
}

async function getUserBankExpansions(userId) {
  const user = await getUser(userId);
  return user.bankExpansions || 0;
}

async function purchaseBankExpansion(userId) {
  try {
    const user = await getUser(userId);
    const currentExpansions = user.bankExpansions || 0;
    const price = await calculateExpansionPrice(userId);

    if (user.cash < price) {
      return { success: false, error: 'insufficient_funds', price, cash: user.cash };
    }

    user.cash -= price;
    user.bankExpansions = currentExpansions + 1;
    await saveUser(userId);

    const newCapacity = await calculateBankCapacity(userId);

    return { 
      success: true, 
      newExpansions: user.bankExpansions,
      newCapacity: newCapacity,
      price: price
    };
  } catch (error) {
    console.error(`❌ Failed to purchase bank expansion for ${userId}:`, error.message);
    return { success: false, error: 'system_error' };
  }
}

async function logDatabaseDiagnostics() {
  try {
    console.log('📊 MongoDB Connection Diagnostics:');
    console.log(`   Database: ${db.databaseName}`);

    const userCount = await usersCollection.countDocuments();
    console.log(`   Users collection: ${userCount} documents`);

    const connStatus = await db.admin().command({ connectionStatus: 1 });
    if (connStatus.authInfo && connStatus.authInfo.authenticatedUsers) {
      const users = connStatus.authInfo.authenticatedUsers;
      console.log(`   Authenticated as: ${JSON.stringify(users)}`);
    }

    const mongoUri = process.env.MONGODB_URI;
    const hostMatch = mongoUri.match(/@([^/]+)/);
    if (hostMatch) {
      console.log(`   MongoDB Host: ${hostMatch[1]}`);
    }

    console.log('📊 Database diagnostics completed');
  } catch (error) {
    console.error('❌ Database diagnostics failed:', error.message);
  }
}

async function performDatabaseHealthCheck() {
  try {
    console.log('🏥 Performing MongoDB health check...');

    const testDoc = { _id: 'health_check', timestamp: Date.now(), test: 'write_read_test' };
    const writeResult = await usersCollection.replaceOne(
      { _id: 'health_check' },
      testDoc,
      { upsert: true }
    );

    console.log(`✅ Write test - Matched: ${writeResult.matchedCount}, Upserted: ${writeResult.upsertedCount}`);

    const readResult = await usersCollection.findOne({ _id: 'health_check' });

    if (readResult && readResult.test === 'write_read_test') {
      console.log('✅ Read test - SUCCESS');

      await usersCollection.deleteOne({ _id: 'health_check' });
      console.log('✅ Database health check PASSED - Read/Write permissions confirmed');
    } else {
      console.error('❌ Read test FAILED - Could not read back test document');
      throw new Error('Database read test failed');
    }

  } catch (error) {
    console.error('❌ DATABASE HEALTH CHECK FAILED:', error.message);
    console.error('This explains why data is not persisting!');
    throw error;
  }
}

async function saveUserData() {
  if (!usersCollection) {
    console.warn('Users collection not ready, skipping save');
    return;
  }
  try {
    const userPromises = Object.keys(userData).map(userId => saveUser(userId));
    await Promise.all(userPromises);
    console.log(`💾 Saved data for ${Object.keys(userData).length} users to MongoDB`);
  } catch (error) {
    console.error('❌ SAVE FAILED:', error.message);
    throw error;
  }
}

const rarities = [
  { name:'1-Star', chance:65, color:0xAAAAAA, value:100,   sell:150,   stars:1, items:['Quartz','Mica','Olivine','Condensed Quartz','Calcite Crystal','Feldspar','Flint Chip','Shale Flake','Agate Cluster','Basalt Prism','Diorite Slab','Lignite Chip','Travertine Fragment','Smoky Quartz','Sandstone Carving','Pumice Dome'] },
  { name:'2-Star', chance:20, color:0x00FF00, value:500,   sell:500,   stars:2, items:['Garnet','Talc','Magnetite','Lithium Battery','Hornblende','Limestone Tablet','Serpentine','Ring of Malachite','Jade Scarab','Dolomite Tablet','Augite Crystal','Stibnite Wand','Chalcopyrite','Crown of Gypsum','Rhodochrosite'] },
  { name:'3-Star', chance:10, color:0x00008B, value:1500,  sell:1500,  stars:3, items:['Eye of Monazite','Chest of Xenotime','Euxenite','Beryl','Loparite','Amber Fossil','Obsidian Blade','Scepter of Rhodonite','Turquoise Idol','Spectrolite Lens','Vanadinite Cluster','Wulfenite Plate','Brazilianite Shard','Mask of Dioptase','Alexandrite Prism'] },
  { name:'4-Star', chance:4,  color:0xFFD700, value:4000,  sell:4000,  stars:4, items:['Watch of Scandium','Statue of Bastnasite','Allanite','Fluorite Shard','Ixiolite','Lapis Lazuli','Nephrite Goblet','Citrine Crest','Staff of Chrysoberyl','Relic of Moissanite','Orb of Tanzanite','Spessartine Dagger','Demantoid Shard','Crown of Benitoite','Throne of Jadeite','Taaffeite Pendant'] },
  { name:'5-Star', chance:1,  color:0x000000, value:10000, sell:10000, stars:5, items:['Gem of Diamond','Kyawthuite','Hazenite Droplet','Ephemeral Allanite','Meteorite Shard','Coesite Fragment','Painite Crystal','Scepter of Onyx','Primordial Opal','Musgravite Fragment','Pezzottaite Core','Void Calcite','Serendibite Relic','Grandidierite Prism','Stellar Obsidian'] }
];

const artefactTiers = {
  'Quartz': 2, 'Mica': 2, 'Olivine': 2,
  'Condensed Quartz': 2,
  'Calcite Crystal': 3,
  'Feldspar': 1, 'Flint Chip': 1, 'Shale Flake': 1,
  'Agate Cluster': 3, 'Basalt Prism': 3,
  'Diorite Slab': 4, 'Lignite Chip': 4, 'Travertine Fragment': 4,
  'Smoky Quartz': 5, 'Sandstone Carving': 5, 'Pumice Dome': 5,
  'Garnet': 2, 'Talc': 2, 'Magnetite': 2,
  'Lithium Battery': 3,
  'Hornblende': 1, 'Limestone Tablet': 1, 'Serpentine': 1,
  'Ring of Malachite': 3, 'Jade Scarab': 3,
  'Dolomite Tablet': 4, 'Augite Crystal': 4, 'Stibnite Wand': 4,
  'Chalcopyrite': 5, 'Crown of Gypsum': 5, 'Rhodochrosite': 5,
  'Eye of Monazite': 2, 'Chest of Xenotime': 2, 'Euxenite': 2,
  'Beryl': 1,
  'Loparite': 3,
  'Amber Fossil': 1, 'Obsidian Blade': 1,
  'Scepter of Rhodonite': 3, 'Turquoise Idol': 3,
  'Spectrolite Lens': 4, 'Vanadinite Cluster': 4, 'Wulfenite Plate': 4,
  'Brazilianite Shard': 5, 'Mask of Dioptase': 5, 'Alexandrite Prism': 5,
  'Watch of Scandium': 2, 'Statue of Bastnasite': 2, 'Allanite': 2,
  'Fluorite Shard': 1, 'Nephrite Goblet': 1,
  'Ixiolite': 2,
  'Lapis Lazuli': 3,
  'Citrine Crest': 1,
  'Staff of Chrysoberyl': 3, 'Relic of Moissanite': 3,
  'Orb of Tanzanite': 4, 'Spessartine Dagger': 4, 'Demantoid Shard': 4,
  'Crown of Benitoite': 5, 'Throne of Jadeite': 5, 'Taaffeite Pendant': 5,
  'Gem of Diamond': 2, 'Kyawthuite': 2,
  'Hazenite Droplet': 1,
  'Ephemeral Allanite': 3,
  'Meteorite Shard': 1, 'Coesite Fragment': 1,
  'Painite Crystal': 2,
  'Scepter of Onyx': 3, 'Primordial Opal': 3,
  'Musgravite Fragment': 4, 'Pezzottaite Core': 4, 'Void Calcite': 4,
  'Serendibite Relic': 5, 'Grandidierite Prism': 5, 'Stellar Obsidian': 5
};

const TIER_MULTIPLIERS = { 1: 0.65, 2: 0.75, 3: 1.0, 4: 1.25, 5: 1.35 };

function getArtefactTier(name) {
  const cleanName = name.startsWith('✨ SHINY ') && name.endsWith(' ✨')
    ? name.replace('✨ SHINY ', '').replace(' ✨', '')
    : name;
  return artefactTiers[cleanName] || 2;
}

function calcArtefactSellValue(name, rarity) {
  const tier = getArtefactTier(name);
  const base = rarity ? rarity.sell : 100;
  const mult = getMarketMultiplier(name);
  return Math.floor(base * TIER_MULTIPLIERS[tier] * mult);
}

function calcArtefactTradeValue(name, rarity) {
  const isShiny = name.startsWith('✨ SHINY ') && name.endsWith(' ✨');
  const base = calcArtefactSellValue(name, rarity);
  return isShiny ? base * 5 : base;
}

function calcArtefactValue(name, rarity) {
  const tier = getArtefactTier(name);
  const base = rarity ? rarity.value : 100;
  const mult = getMarketMultiplier(name);
  return Math.floor(base * TIER_MULTIPLIERS[tier] * mult);
}

function getRarityByArtefact(name) {
  const cleanName = name.startsWith('✨ SHINY ') && name.endsWith(' ✨') ? name.replace('✨ SHINY ', '').replace(' ✨', '') : name;
  return rarities.find(r => r.items.includes(cleanName));
}

const MARKET_REFRESH_INTERVAL = 6 * 60 * 60 * 1000; // 6 hours
const MARKET_MULT_FLOOR = 0.4;
const MARKET_MULT_CEILING = 3.0;

const MARKET_VOLATILITY = {
  '1-Star': { stay: 0.90, swing: 0.02 },
  '2-Star': { stay: 0.80, swing: 0.05 },
  '3-Star': { stay: 0.70, swing: 0.10 },
  '4-Star': { stay: 0.50, swing: 0.12 },
  '5-Star': { stay: 0.40, swing: 0.15 }
};

const MARKET_CACHE = {
  multipliers: {},          // { artefactName: number }
  previousMultipliers: {},  // last refresh's values, for change display
  lastRefresh: 0,
  refreshCount: 0
};

function getMarketMultiplier(name) {
  const cleanName = name.startsWith('✨ SHINY ') && name.endsWith(' ✨')
    ? name.replace('✨ SHINY ', '').replace(' ✨', '')
    : name;
  const m = MARKET_CACHE.multipliers[cleanName];
  return (typeof m === 'number' && m > 0) ? m : 1.0;
}

function getAllArtefactNames() {
  const names = [];
  for (const r of rarities) for (const item of r.items) names.push(item);
  return names;
}

function rollNewMultiplier(currentMult, rarityName) {
  const profile = MARKET_VOLATILITY[rarityName] || MARKET_VOLATILITY['1-Star'];
  if (Math.random() < profile.stay) return currentMult;
  const goingUp = Math.random() < 0.5;
  const next = goingUp ? currentMult * (1 + profile.swing) : currentMult * (1 - profile.swing);
  return Math.min(MARKET_MULT_CEILING, Math.max(MARKET_MULT_FLOOR, next));
}

async function loadMarketState() {
  if (!marketStateCollection) return;
  let doc = await marketStateCollection.findOne({ _id: 'global' });
  if (!doc) {
    const seed = {};
    for (const name of getAllArtefactNames()) seed[name] = 1.0;
    doc = {
      _id: 'global',
      multipliers: seed,
      previousMultipliers: { ...seed },
      lastRefresh: Date.now(),
      refreshCount: 0
    };
    await marketStateCollection.insertOne(doc);
    console.log('Market state initialized with neutral multipliers');
  }
  MARKET_CACHE.multipliers = doc.multipliers || {};
  MARKET_CACHE.previousMultipliers = doc.previousMultipliers || {};
  MARKET_CACHE.lastRefresh = doc.lastRefresh || 0;
  MARKET_CACHE.refreshCount = doc.refreshCount || 0;
  MARKET_CACHE.lastCrashout = doc.lastCrashout || 0;
  MARKET_CACHE.crashoutHistory = Array.isArray(doc.crashoutHistory) ? doc.crashoutHistory : [];

  let added = false;
  for (const name of getAllArtefactNames()) {
    if (typeof MARKET_CACHE.multipliers[name] !== 'number') {
      MARKET_CACHE.multipliers[name] = 1.0;
      added = true;
    }
  }
  if (added) {
    await marketStateCollection.updateOne(
      { _id: 'global' },
      { $set: { multipliers: MARKET_CACHE.multipliers } }
    );
  }
}

async function runMarketRefresh() {
  if (!marketStateCollection) return;
  const previousMultipliers = { ...MARKET_CACHE.multipliers };
  const newMultipliers = {};
  for (const r of rarities) {
    for (const item of r.items) {
      const current = MARKET_CACHE.multipliers[item] ?? 1.0;
      newMultipliers[item] = Number(rollNewMultiplier(current, r.name).toFixed(4));
    }
  }
  MARKET_CACHE.multipliers = newMultipliers;
  MARKET_CACHE.previousMultipliers = previousMultipliers;
  MARKET_CACHE.lastRefresh = Date.now();
  MARKET_CACHE.refreshCount += 1;
  await marketStateCollection.updateOne(
    { _id: 'global' },
    { $set: {
        multipliers: newMultipliers,
        previousMultipliers,
        lastRefresh: MARKET_CACHE.lastRefresh,
        refreshCount: MARKET_CACHE.refreshCount
    } },
    { upsert: true }
  );
  console.log(`Market refresh #${MARKET_CACHE.refreshCount} complete`);
}

async function maybeRefreshMarket() {
  if (!marketStateCollection) return;
  if (Date.now() - MARKET_CACHE.lastRefresh >= MARKET_REFRESH_INTERVAL) {
    try { await runMarketRefresh(); }
    catch (err) { console.error('Market refresh failed:', err); }
  }
}

const CRASHOUT_INTERVAL = 7 * 24 * 60 * 60 * 1000; // 7 days
const CRASHOUT_CRASH_FACTOR = 0.85;   // -15%
const CRASHOUT_BUBBLE_FACTOR = 1.10;  // +10%
const CRASHOUT_HISTORY_LIMIT = 10;

const ANNOUNCEMENT_CACHE = new Map(); // guildId -> channelId | null

async function getAnnouncementChannelId(guildId) {
  if (!guildId) return null;
  if (ANNOUNCEMENT_CACHE.has(guildId)) return ANNOUNCEMENT_CACHE.get(guildId);
  if (!guildSettingsCollection) return null;
  try {
    const doc = await guildSettingsCollection.findOne({ _id: guildId });
    const channelId = doc && doc.announcementChannelId ? doc.announcementChannelId : null;
    ANNOUNCEMENT_CACHE.set(guildId, channelId);
    return channelId;
  } catch (err) {
    console.error('Failed to load announcement channel:', err);
    return null;
  }
}

async function setAnnouncementChannelId(guildId, channelId) {
  if (!guildSettingsCollection) throw new Error('Database not ready');
  await guildSettingsCollection.updateOne(
    { _id: guildId },
    { $set: { announcementChannelId: channelId } },
    { upsert: true }
  );
  ANNOUNCEMENT_CACHE.set(guildId, channelId);
}


const QUEST_SECTION_BONUS_CASH = 300;
const QUEST_SECTION_BONUS_XP = 5;
const QUEST_FULL_CLEAR_BONUS_CASH = 1000;
const QUEST_FULL_CLEAR_BONUS_XP = 20;

const DAILY_QUEST_ACTION_POOL = [
  { id: 'act_scavenge3', section: 'action', track: 'scavenge', target: 3, label: 'Scavenge 3 Times', desc: 'Use /scavenge 3 times.', cashReward: 300, xpReward: 5 },
  { id: 'act_labor2', section: 'action', track: 'labor', target: 2, label: 'Work 2 Shifts', desc: 'Use /labor 2 times.', cashReward: 250, xpReward: 4 },
  { id: 'act_fish1', section: 'action', track: 'fish', target: 1, label: 'Go Fishing', desc: 'Reel in a catch with /fish.', cashReward: 200, xpReward: 4 },
  { id: 'act_duelwin1', section: 'action', track: 'duelWin', target: 1, label: 'Win a Duel', desc: 'Win 1 /card-duel or /marble-duel.', cashReward: 400, xpReward: 6 },
  { id: 'act_steal1', section: 'action', track: 'stealSuccess', target: 1, label: 'Pull Off a Heist', desc: 'Successfully /steal from someone.', cashReward: 350, xpReward: 5 },
  { id: 'act_trade1', section: 'action', track: 'tradeComplete', target: 1, label: 'Strike a Deal', desc: 'Complete a /trade with another player.', cashReward: 300, xpReward: 5 }
];

const DAILY_QUEST_ECONOMY_POOL = [
  { id: 'eco_sell1', section: 'economy', track: 'sellArtefact', target: 1, label: 'Make a Sale', desc: 'Sell an artefact via /mass-sell or trade.', cashReward: 200, xpReward: 4, weight: 4 },
  { id: 'eco_deposit1', section: 'economy', track: 'bankDeposit', target: 1, label: 'Bank It', desc: 'Deposit cash into /bank.', cashReward: 150, xpReward: 3, weight: 4 },
  { id: 'eco_find3star', section: 'economy', track: 'find3StarPlus', target: 1, label: 'Strike It Rich', desc: 'Find a 3-Star artefact or higher.', cashReward: 500, xpReward: 8, weight: 4 },
  { id: 'eco_findshiny', section: 'economy', track: 'findShiny', target: 1, label: 'Shiny Hunter', desc: 'Find a ✨ Shiny artefact (rare bonus quest!).', cashReward: 2000, xpReward: 20, weight: 1 }
];

const DAILY_QUEST_SOCIAL_POOL = [
  { id: 'soc_messages20', section: 'social', track: 'sendMessage', target: 20, label: 'Stay Chatty', desc: 'Send 20 messages in the server.', cashReward: 200, xpReward: 4 },
  { id: 'soc_observe1', section: 'social', track: 'observeUsed', target: 1, label: 'Scout a Rival', desc: 'Use /observe on another player.', cashReward: 150, xpReward: 3 },
  { id: 'soc_convert1', section: 'social', track: 'convertXp', target: 1, label: 'Cash Out XP', desc: 'Convert your XP to cash via /convert.', cashReward: 150, xpReward: 3 }
];

const COMMUNITY_QUEST_POOL = [
  { id: 'comm_scavenge', track: 'scavenge', target: 400, label: 'Community Mining Spree', desc: 'Scavenge 400 times as a server this week.', cashReward: 600, xpReward: 12 },
  { id: 'comm_labor', track: 'labor', target: 300, label: 'All Hands on Deck', desc: 'Complete 300 labor shifts as a server this week.', cashReward: 600, xpReward: 12 },
  { id: 'comm_sell', track: 'sellArtefact', target: 250, label: 'Market Day', desc: 'Sell 250 artefacts as a server this week.', cashReward: 600, xpReward: 12 },
  { id: 'comm_messages', track: 'sendMessage', target: 1200, label: 'Server Chatter', desc: 'Send 1,200 messages as a server this week.', cashReward: 400, xpReward: 8 },
  { id: 'comm_trade', track: 'tradeComplete', target: 100, label: 'Trading Frenzy', desc: 'Complete 100 trades as a server this week.', cashReward: 800, xpReward: 16 }
];

function getTodayDateKey() {
  return new Date().toISOString().slice(0, 10);
}

function getWeekDateKey() {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${weekNo}`;
}

function pickRandomQuests(pool, count) {
  const arr = pool.slice();
  const chosen = [];
  const n = Math.min(count, arr.length);
  for (let i = 0; i < n; i++) {
    const totalWeight = arr.reduce((sum, q) => sum + (q.weight || 1), 0);
    let roll = Math.random() * totalWeight;
    let idx = 0;
    for (; idx < arr.length; idx++) {
      roll -= (arr[idx].weight || 1);
      if (roll <= 0) break;
    }
    idx = Math.min(idx, arr.length - 1);
    chosen.push(arr[idx]);
    arr.splice(idx, 1);
  }
  return chosen;
}

function buildDailyQuestSet() {
  const action = pickRandomQuests(DAILY_QUEST_ACTION_POOL, 3);
  const economy = pickRandomQuests(DAILY_QUEST_ECONOMY_POOL, 3);
  const social = DAILY_QUEST_SOCIAL_POOL.slice();
  return [...action, ...economy, ...social].map(q => ({
    id: q.id, section: q.section, track: q.track, label: q.label, desc: q.desc,
    target: q.target, progress: 0, completed: false, claimed: false,
    cashReward: q.cashReward, xpReward: q.xpReward
  }));
}

function ensureDailyQuests(user) {
  const today = getTodayDateKey();
  if (!user.dailyQuests || user.dailyQuests.date !== today) {
    user.dailyQuests = {
      date: today,
      quests: buildDailyQuestSet(),
      sectionBonuses: { action: false, economy: false, social: false },
      fullClearBonus: false
    };
  }
  return user.dailyQuests;
}

async function ensureCommunityQuest(guildId) {
  if (!guildId || !guildSettingsCollection) return null;
  const weekKey = getWeekDateKey();
  const doc = await guildSettingsCollection.findOne({ _id: guildId });
  const existing = doc && doc.communityQuest;
  if (existing && existing.weekKey === weekKey) return existing;

  const template = COMMUNITY_QUEST_POOL[Math.floor(Math.random() * COMMUNITY_QUEST_POOL.length)];
  const fresh = {
    weekKey, id: template.id, track: template.track, label: template.label, desc: template.desc,
    target: template.target, progress: 0, contributors: [], completed: false, claimedBy: [],
    cashReward: template.cashReward, xpReward: template.xpReward
  };
  await guildSettingsCollection.updateOne({ _id: guildId }, { $set: { communityQuest: fresh } }, { upsert: true });
  await announceNewCommunityQuest(guildId, fresh);
  return fresh;
}

async function announceNewCommunityQuest(guildId, community) {
  try {
    const channelId = await getAnnouncementChannelId(guildId);
    if (!channelId) return;
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel) return;

    const embed = new EmbedBuilder()
      .setTitle('🌍 New Weekly Server Quest!')
      .setDescription(`This week's community goal: **${community.label}**\n${community.desc}`)
      .addFields(
        { name: 'Target', value: `${community.target.toLocaleString()}`, inline: true },
        { name: 'Reward (per contributor)', value: `$${community.cashReward.toLocaleString()} + ${community.xpReward} XP`, inline: true }
      )
      .setColor(0x3498DB)
      .setFooter({ text: 'Everyone who contributes can claim a reward once the goal is reached. Resets weekly!' })
      .setTimestamp();

    await channel.send({ embeds: [embed] });
  } catch (err) {
    console.error('announceNewCommunityQuest error:', err);
  }
}

async function dmQuestCompletion(userId, quest) {
  try {
    const discordUser = await client.users.fetch(userId);
    const embed = new EmbedBuilder()
      .setTitle('🎯 Daily Quest Ready to Claim!')
      .setDescription(`You finished **${quest.label}**!\n${quest.desc}`)
      .addFields(
        { name: 'Reward Waiting', value: `$${quest.cashReward.toLocaleString()} + ${quest.xpReward} XP`, inline: true },
        { name: 'Section', value: quest.section.charAt(0).toUpperCase() + quest.section.slice(1), inline: true }
      )
      .setColor(0x2ECC71)
      .setFooter({ text: 'Run /quests and hit Claim to collect your reward!' })
      .setTimestamp();
    await discordUser.send({ embeds: [embed] });
  } catch (err) {
    console.warn(`Could not DM user ${userId} for quest completion (DMs may be closed).`);
  }
}

async function announceCommunityQuestComplete(guildId, community) {
  try {
    const channelId = await getAnnouncementChannelId(guildId);
    if (!channelId) return;
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel) return;

    const embed = new EmbedBuilder()
      .setTitle('🌍 Server Quest Complete!')
      .setDescription(`The server has completed this week's community goal: **${community.label}**!\n${community.desc}\n\nContributors can claim their reward below.`)
      .addFields(
        { name: 'Contributors', value: `${community.contributors.length} player(s)`, inline: true },
        { name: 'Reward (each)', value: `$${community.cashReward.toLocaleString()} + ${community.xpReward} XP`, inline: true }
      )
      .setColor(0x1ABC9C)
      .setFooter({ text: 'A new community quest will appear next week!' })
      .setTimestamp();

    const claimRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`quest_claim_community_${guildId}`)
        .setLabel('🎁 Claim Community Reward')
        .setStyle(ButtonStyle.Success)
    );

    await channel.send({ embeds: [embed], components: [claimRow] });
  } catch (err) {
    console.error('announceCommunityQuestComplete error:', err);
  }
}

async function updateQuestProgress(userId, guildId, track, amount = 1) {
  try {
    if (userId) {
      const user = await getUser(userId);
      const dq = ensureDailyQuests(user);
      let changed = false;

      for (const quest of dq.quests) {
        if (quest.track !== track || quest.completed) continue;
        quest.progress = Math.min(quest.target, quest.progress + amount);
        changed = true;

        if (quest.progress >= quest.target) {
          quest.completed = true;
          await dmQuestCompletion(userId, quest);
        }
      }

      if (changed) await saveUser(userId);
    }
  } catch (err) {
    console.error('updateQuestProgress (personal) error:', err);
  }

  try {
    if (guildId) {
      const community = await ensureCommunityQuest(guildId);
      if (community && community.track === track && !community.completed) {
        community.progress = Math.min(community.target, community.progress + amount);
        if (userId && !community.contributors.includes(userId)) community.contributors.push(userId);

        if (community.progress >= community.target) {
          community.completed = true;
          await announceCommunityQuestComplete(guildId, community);
        }

        await guildSettingsCollection.updateOne({ _id: guildId }, { $set: { communityQuest: community } });
      }
    }
  } catch (err) {
    console.error('updateQuestProgress (community) error:', err);
  }
}

async function broadcastToAnnouncementChannels(embed) {
  let delivered = 0;
  let failed = 0;
  const guilds = client.guilds.cache;
  for (const [guildId] of guilds) {
    try {
      const channelId = await getAnnouncementChannelId(guildId);
      if (!channelId) continue;
      const channel = await client.channels.fetch(channelId).catch(() => null);
      if (!channel || !channel.isTextBased || !channel.isTextBased()) continue;
      await channel.send({ embeds: [embed] });
      delivered++;
    } catch (err) {
      failed++;
      console.error(`Announcement send failed for guild ${guildId}:`, err.message);
    }
  }
  console.log(`Announcement broadcast: delivered=${delivered} failed=${failed}`);
  return { delivered, failed };
}

async function runCrashout() {
  if (!marketStateCollection) return null;

  const rarity = rarities[Math.floor(Math.random() * rarities.length)];
  const isBubble = Math.random() < 0.5;
  const factor = isBubble ? CRASHOUT_BUBBLE_FACTOR : CRASHOUT_CRASH_FACTOR;
  const type = isBubble ? 'bubble' : 'crash';

  const updated = { ...MARKET_CACHE.multipliers };
  for (const item of rarity.items) {
    const current = updated[item] ?? 1.0;
    const next = Math.min(MARKET_MULT_CEILING, Math.max(MARKET_MULT_FLOOR, current * factor));
    updated[item] = Number(next.toFixed(4));
  }
  MARKET_CACHE.multipliers = updated;
  MARKET_CACHE.lastCrashout = Date.now();
  const event = {
    timestamp: MARKET_CACHE.lastCrashout,
    rarity: rarity.name,
    type,
    factor,
  };
  MARKET_CACHE.crashoutHistory = [event, ...(MARKET_CACHE.crashoutHistory || [])].slice(0, CRASHOUT_HISTORY_LIMIT);

  await marketStateCollection.updateOne(
    { _id: 'global' },
    { $set: {
        multipliers: updated,
        lastCrashout: MARKET_CACHE.lastCrashout,
        crashoutHistory: MARKET_CACHE.crashoutHistory,
    } },
    { upsert: true }
  );

  console.log(`Crashout event: ${type.toUpperCase()} on ${rarity.name} (factor ${factor})`);

  const pctLabel = isBubble ? '+10%' : '-15%';
  const embed = new EmbedBuilder()
    .setTitle(isBubble ? 'Speculative Bubble!' : 'Market Crash!')
    .setDescription(
      isBubble
        ? `Speculation has swept the **${rarity.name}** market. Every ${rarity.name} artefact has surged **${pctLabel}** in value!`
        : `Disaster has hit the **${rarity.name}** market. Every ${rarity.name} artefact has plunged **${pctLabel}** in value.`
    )
    .addFields(
      { name: 'Affected Rarity', value: rarity.name, inline: true },
      { name: 'Price Shift', value: pctLabel, inline: true },
      { name: 'Items Hit', value: `${rarity.items.length} artefacts`, inline: true },
      { name: 'What Now?', value: isBubble
          ? `Sell while prices are high — or hold and hope the bubble keeps growing.`
          : `Now is a buying opportunity. Trade for cheap and hope for a recovery.`,
        inline: false }
    )
    .setColor(isBubble ? 0x2ECC71 : 0xE74C3C)
    .setFooter({ text: 'Fortune Bot • Weekly Market Event' })
    .setTimestamp();

  await broadcastToAnnouncementChannels(embed).catch(err =>
    console.error('Crashout broadcast error:', err)
  );

  return event;
}

async function maybeRunCrashout() {
  if (!marketStateCollection) return;
  const last = MARKET_CACHE.lastCrashout || 0;
  if (Date.now() - last >= CRASHOUT_INTERVAL) {
    try { await runCrashout(); }
    catch (err) { console.error('Crashout failed:', err); }
  }
}

const COLLECTORS_PREMIUM = 0.20;

const ARTEFACT_SETS = {
  volcanic: {
    name: 'The Volcanic Set',
    description: 'Born of fire and pressure deep beneath the crust.',
    items: ['Olivine', 'Basalt Prism', 'Pumice Dome', 'Obsidian Blade', 'Stellar Obsidian']
  },
  quartz: {
    name: 'The Quartz Set',
    description: 'Every form of crystalline silica, from common to crowned.',
    items: ['Quartz', 'Smoky Quartz', 'Condensed Quartz', 'Citrine Crest']
  },
  sedimentary: {
    name: 'The Sedimentary Set',
    description: 'Layer upon patient layer, history pressed into stone.',
    items: ['Shale Flake', 'Sandstone Carving', 'Travertine Fragment', 'Limestone Tablet', 'Dolomite Tablet']
  },
  royal: {
    name: 'The Royal Regalia Set',
    description: 'Crowns, thrones, and sceptres fit for a forgotten dynasty.',
    items: ['Crown of Gypsum', 'Ring of Malachite', 'Crown of Benitoite', 'Throne of Jadeite', 'Scepter of Onyx']
  },
  garnet: {
    name: 'The Garnet Family',
    description: 'Three siblings of the garnet line, in escalating brilliance.',
    items: ['Garnet', 'Spessartine Dagger', 'Demantoid Shard']
  },
  relics: {
    name: 'The Ancient Relics Set',
    description: 'Artefacts that predate memory, each one a riddle.',
    items: ['Amber Fossil', 'Statue of Bastnasite', 'Relic of Moissanite', 'Serendibite Relic']
  },
  arcane: {
    name: 'The Arcane Implements Set',
    description: 'Tools of practitioners now long lost to history.',
    items: ['Stibnite Wand', 'Scepter of Rhodonite', 'Staff of Chrysoberyl', 'Brazilianite Shard']
  },
  stellar: {
    name: 'The Stellar Set',
    description: 'For the most ambitious collectors only — pieces from beyond.',
    items: ['Meteorite Shard', 'Coesite Fragment', 'Primordial Opal', 'Grandidierite Prism']
  }
};

const ITEM_TO_SET = {};
for (const [setId, set] of Object.entries(ARTEFACT_SETS)) {
  for (const item of set.items) ITEM_TO_SET[item] = setId;
}

function stripShinyName(name) {
  return (name.startsWith('✨ SHINY ') && name.endsWith(' ✨'))
    ? name.replace('✨ SHINY ', '').replace(' ✨', '')
    : name;
}

function getSetIdForItem(name) {
  return ITEM_TO_SET[stripShinyName(name)] || null;
}

function computeCollectorsPremium(soldItems) {
  const byBase = {};
  for (const item of soldItems) {
    const base = stripShinyName(item.name);
    if (!byBase[base]) byBase[base] = [];
    byBase[base].push(item);
  }
  for (const base in byBase) byBase[base].sort((a, b) => b.sellValue - a.sellValue);

  let totalBonus = 0;
  const breakdown = [];

  for (const [setId, set] of Object.entries(ARTEFACT_SETS)) {
    let completeCopies = Infinity;
    for (const member of set.items) {
      const count = (byBase[member] || []).length;
      if (count < completeCopies) completeCopies = count;
    }
    if (!isFinite(completeCopies) || completeCopies === 0) continue;

    let bonusForSet = 0;
    for (let i = 0; i < completeCopies; i++) {
      let copyValue = 0;
      for (const member of set.items) {
        const next = byBase[member].shift();
        copyValue += next.sellValue;
      }
      bonusForSet += copyValue * COLLECTORS_PREMIUM;
    }
    totalBonus += bonusForSet;
    breakdown.push({
      setId,
      setName: set.name,
      copies: completeCopies,
      bonus: Math.floor(bonusForSet)
    });
  }
  return { totalBonus: Math.floor(totalBonus), breakdown };
}

function computeSetProgress(playerArtefacts) {
  const counts = {};
  for (const a of (playerArtefacts || [])) {
    const base = stripShinyName(a);
    counts[base] = (counts[base] || 0) + 1;
  }
  const out = [];
  for (const [setId, set] of Object.entries(ARTEFACT_SETS)) {
    const owned = set.items.filter(i => (counts[i] || 0) > 0).length;
    const completeCopies = Math.min(...set.items.map(i => counts[i] || 0));
    out.push({
      setId,
      set,
      ownedDistinct: owned,
      total: set.items.length,
      completeCopies,
      itemCounts: Object.fromEntries(set.items.map(i => [i, counts[i] || 0]))
    });
  }
  return out;
}



function getAllArtefacts() {
  return rarities.flatMap(rarity => rarity.items);
}

async function checkAndHandleEvents() {
  const now = Date.now();
  const eventData = await getEventSystem();

  if (eventData.currentEvent && now >= eventData.currentEvent.endTime) {
    await endCurrentEvent();
  }

  if (!eventData.currentEvent && now >= eventData.nextEventTime) {
    await startNewEvent();
  }
}

async function startNewEvent() {
  const allArtefacts = getAllArtefacts();
  const now = Date.now();

  const shuffledArtefacts = [...allArtefacts].sort(() => Math.random() - 0.5);
  const negativeArtefact = shuffledArtefacts[0];
  const positiveArtefact = shuffledArtefacts[1];

  const newEvent = {
    id: `event_${now}`,
    startTime: now,
    endTime: now + (24 * 60 * 60 * 1000), // 24 hours
    negativeArtefact,
    positiveArtefact,
    type: 'mine_collapse'
  };

  const eventData = await getEventSystem();
  eventData.currentEvent = newEvent;
  eventData.lastEventStart = now;
  eventData.nextEventTime = now + (4 * 24 * 60 * 60 * 1000); // Next event in 4 days
  eventData.eventHistory.unshift(newEvent);

  if (eventData.eventHistory.length > 10) {
    eventData.eventHistory = eventData.eventHistory.slice(0, 10);
  }

  await saveEventSystem(eventData);
  broadcastEventStart(newEvent);
}

async function endCurrentEvent() {
  const eventData = await getEventSystem();
  const event = eventData.currentEvent;
  if (!event) return;

  eventData.currentEvent = null;
  await saveEventSystem(eventData);
  broadcastEventEnd(event);
}

async function broadcastEventStart(event) {
  try {
    const eventEmbed = new EmbedBuilder()
      .setTitle('MINING CRISIS ALERT!')
      .setDescription(`**A catastrophic mine collapse has occurred in the ${event.negativeArtefact} mining sector!**`)
      .addFields(
        { 
          name: 'Mine Collapse Report', 
          value: `The **${event.negativeArtefact}** mine has suffered a devastating collapse! Explorers cannot approach the mining site due to unstable conditions and falling debris.`, 
          inline: false 
        },
        { 
          name: 'Scavenging Restriction', 
          value: `**${event.negativeArtefact}** cannot be scavenged during this 24-hour emergency period while repair crews work to stabilize the site.`, 
          inline: false 
        },
        { 
          name: 'Unexpected Opportunity', 
          value: `However, the nearby **${event.positiveArtefact}** mine has expanded due to shifting geological conditions, creating new accessible veins!`, 
          inline: false 
        },
        { 
          name: 'Enhanced Discovery Rate', 
          value: `**${event.positiveArtefact}** discovery chances have **doubled** during this event! Scavenge while this opportunity lasts!`, 
          inline: false 
        },
        { 
          name: 'Event Duration', 
          value: 'This mining crisis will last exactly **24 hours**', 
          inline: true 
        },
        { 
          name: 'Estimated Repair Time', 
          value: 'Mine restoration crews are working around the clock', 
          inline: true 
        }
      )
      .setColor(0xFF4500)
      .setFooter({ text: 'Fortune Bot Mining Authority • Emergency Broadcast System' })
      .setTimestamp();

    const sent = await broadcastToAnnouncementChannels(eventEmbed);
    console.log(`MINING EVENT STARTED: ${event.negativeArtefact} -> ${event.positiveArtefact} (broadcast to ${sent} channel(s))`);

  } catch (error) {
    console.error('Error broadcasting event start:', error);
  }
}

async function broadcastEventEnd(event) {
  try {
    const eventEmbed = new EmbedBuilder()
      .setTitle('MINING OPERATIONS RESTORED')
      .setDescription('**The mining crisis has been resolved!**')
      .addFields(
        { 
          name: 'Restoration Complete', 
          value: `The **${event.negativeArtefact}** mine has been fully repaired and stabilized. Safety inspectors have cleared the site for normal operations.`, 
          inline: false 
        },
        { 
          name: 'Mining Status', 
          value: `**${event.negativeArtefact}** is now available for scavenging again at normal rates.`, 
          inline: false 
        },
        { 
          name: 'Geological Shift', 
          value: `The **${event.positiveArtefact}** mine has returned to standard geological conditions and normal discovery rates.`, 
          inline: false 
        },
        { 
          name: 'Operations Summary', 
          value: 'All mining sectors have returned to baseline scavenging probabilities', 
          inline: false 
        }
      )
      .setColor(0x00FF7F)
      .setFooter({ text: 'Fortune Bot Mining Authority • All Clear Signal' })
      .setTimestamp();

    const sent = await broadcastToAnnouncementChannels(eventEmbed);
    console.log(`MINING EVENT ENDED: ${event.negativeArtefact} restored (broadcast to ${sent} channel(s))`);

  } catch (error) {
    console.error('Error broadcasting event end:', error);
  }
}

async function getModifiedArtefactChances() {
  const eventData = await getEventSystem();
  const event = eventData.currentEvent;
  if (!event) return rarities; // No event active, return normal chances

  return rarities.map(rarity => {
    const modifiedItems = rarity.items.map(item => {
      if (item === event.negativeArtefact) {
        return null;
      }
      return item;
    }).filter(item => item !== null);

    const hasPositiveArtefact = rarity.items.includes(event.positiveArtefact);

    return {
      ...rarity,
      items: modifiedItems,
      chance: hasPositiveArtefact ? rarity.chance * 1.5 : rarity.chance
    };
  }).filter(rarity => rarity.items.length > 0); // Remove rarities with no items
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  if (!usersCollection) return;

  if (message.guildId && await isServerBlacklisted(message.guildId)) {
    await message.reply({ embeds: [new EmbedBuilder()
      .setTitle('Server Blacklisted')
      .setDescription('This server has been blacklisted and can no longer use this bot. You can still use all commands in the official server.')
      .setColor(0xFF6B6B)
      .setTimestamp()] }).catch(() => {});
    return;
  }

  if (message.guildId) {
    try {
      const prefix = await getGuildPrefix(message.guildId);
      if (prefix && message.content.startsWith(prefix)) {
        const body = message.content.slice(prefix.length).trim();
        if (body.length) {
          const tokens = body.split(/\s+/);
          const handled = await dispatchPrefixCommand(message, tokens);
          if (handled) return;
        }
      }
    } catch (err) {
      console.error('Prefix dispatch error:', err);
    }
  }

  const userId = message.author.id;
  const channelId = message.channel.id;
  const now = Date.now();

  const user = await getUser(userId);
  if (!user.xpData) user.xpData = { xp: 0, messageCount: 0, lastMessage: 0 };

  if (!global.messageTracker[channelId]) global.messageTracker[channelId] = [];

  global.messageTracker[channelId].push({
    userId: userId,
    timestamp: now
  });

  global.messageTracker[channelId] = global.messageTracker[channelId].filter(
    msg => now - msg.timestamp < 300000 // 5 minutes
  );

  const recentMessages = global.messageTracker[channelId].filter(
    msg => now - msg.timestamp < 120000 // 2 minutes
  );

  const uniqueUsers = new Set(recentMessages.map(msg => msg.userId));

  if (uniqueUsers.size >= 2) {
    user.xpData.messageCount++;

    if (user.xpData.messageCount % 2 === 0) {
      user.xpData.xp++;
      user.xpData.lastMessage = now;
      await saveUserData();
    }
    await updateQuestProgress(userId, message.guildId, 'sendMessage', 1);
  }
});

client.once('clientReady', async () => {
  console.log(`Fortune Bot online as ${client.user.tag}`);

  await initializeDatabase();

  cooldowns = await getCooldowns();

  checkAndHandleEvents();

  setInterval(() => {
    checkAndHandleEvents();
  }, 15 * 60 * 1000);

  await loadMarketState();
  await maybeRefreshMarket();
  await maybeRunCrashout();
  setInterval(() => {
    maybeRefreshMarket();
    maybeRunCrashout();
  }, 60 * 1000);

  const commands = [
    new SlashCommandBuilder()
      .setName('info')
      .setDescription('Shows information about the bot'),

    new SlashCommandBuilder()
      .setName('bank')
      .setDescription('Deposit money into your secure bank account')
      .addIntegerOption(option =>
        option.setName('amount')
          .setDescription('Amount to deposit')
          .setRequired(true)
          .setMinValue(1)),

    new SlashCommandBuilder()
      .setName('bank-all')
      .setDescription('Deposit all cash on hand into your bank account'),

    new SlashCommandBuilder()
      .setName('withdraw')
      .setDescription('Withdraw money from your bank account')
      .addIntegerOption(option =>
        option.setName('amount')
          .setDescription('Amount to withdraw')
          .setRequired(true)
          .setMinValue(1)),

    new SlashCommandBuilder()
      .setName('steal')
      .setDescription('Attempt to steal cash from another player')
      .addUserOption(option =>
        option.setName('target')
          .setDescription('User to steal from')
          .setRequired(true))
      .addIntegerOption(option =>
        option.setName('amount')
          .setDescription('Amount to steal')
          .setRequired(true)
          .setMinValue(1)),

    new SlashCommandBuilder()
      .setName('scavenge')
      .setDescription('Search for rare artefacts (2 hour cooldown)'),

    new SlashCommandBuilder()
      .setName('labor')
      .setDescription('Work to earn money (40 minute cooldown)'),

    new SlashCommandBuilder()
      .setName('inventory')
      .setDescription('View your cash, bank balance and artefacts'),

    new SlashCommandBuilder()
      .setName('trade')
      .setDescription('Start a trade with another user')
      .addUserOption(option =>
        option.setName('user')
          .setDescription('User to trade with')
          .setRequired(true)),

    new SlashCommandBuilder()
      .setName('leaderboard')
      .setDescription('View the leaderboard and your current rating'),

    new SlashCommandBuilder()
      .setName('store')
      .setDescription('View available items in global and server stores')
      .setDMPermission(false),

    new SlashCommandBuilder()
      .setName('buy')
      .setDescription('Purchase an item from the global store')
      .addStringOption(option =>
        option.setName('item')
          .setDescription('Name of the item to purchase')
          .setRequired(true)),

    new SlashCommandBuilder()
      .setName('mass-sell')
      .setDescription('Open an interactive menu to select and sell artefacts from your inventory'),

    new SlashCommandBuilder()
      .setName('add-item')
      .setDescription('Add a custom server item (Admin only)')
      .addStringOption(option =>
        option.setName('name')
          .setDescription('Name of the item')
          .setRequired(true))
      .addIntegerOption(option =>
        option.setName('price')
          .setDescription('Price of the item')
          .setRequired(true)
          .setMinValue(1))
      .addStringOption(option =>
        option.setName('description')
          .setDescription('Description of the item')
          .setRequired(false))
      .setDMPermission(false),

    new SlashCommandBuilder()
      .setName('remove-item')
      .setDescription('Remove a custom server item (Admin only)')
      .addStringOption(option =>
        option.setName('name')
          .setDescription('Name of the item to remove')
          .setRequired(true))
      .setDMPermission(false),

    new SlashCommandBuilder()
      .setName('view-items')
      .setDescription('View all custom server items (Admin only)')
      .setDMPermission(false),

    new SlashCommandBuilder()
      .setName('fish')
      .setDescription('Cast your line and see what bites (20 min cooldown, requires bait from /store)')
      .addStringOption(option =>
        option.setName('bait')
          .setDescription('Bait to use — leave blank to auto-use your best bait')
          .setRequired(false)),

    new SlashCommandBuilder()
      .setName('viewcp')
      .setDescription('View your empire\'s Combat Power, or inspect another player\'s public Relative CP')
      .addUserOption(option =>
        option.setName('player')
          .setDescription('Player to inspect — leave blank to view your own full stats (private)')
          .setRequired(false)),

    new SlashCommandBuilder()
      .setName('raid')
      .setDescription('Browse active Raid Season participants and launch a raid against a rival empire')
      .setDMPermission(false),

    new SlashCommandBuilder()
      .setName('marble-game')
      .setDescription('Start a 4-player marble gambling game with cash betting')
      .addUserOption(option => 
        option.setName('player2')
          .setDescription('Second player to invite')
          .setRequired(true)
      )
      .addUserOption(option => 
        option.setName('player3')
          .setDescription('Third player to invite')
          .setRequired(true)
      )
      .addUserOption(option => 
        option.setName('player4')
          .setDescription('Fourth player to invite')
          .setRequired(true)
      )
      .setDMPermission(false),

    new SlashCommandBuilder()
      .setName('marble-duel')
      .setDescription('Challenge one player to a 1v1 marble duel with cash betting')
      .addUserOption(option =>
        option.setName('opponent')
          .setDescription('The player you want to duel')
          .setRequired(true)
      )
      .setDMPermission(false),

    new SlashCommandBuilder()
      .setName('card-duel')
      .setDescription('Challenge a player to a 1v1 card duel — pick the highest card each round')
      .addUserOption(option =>
        option.setName('opponent')
          .setDescription('The player you want to challenge')
          .setRequired(true))
      .addIntegerOption(option =>
        option.setName('bet')
          .setDescription('Amount to bet (each player puts this in)')
          .setRequired(true)
          .setMinValue(50))
      .setDMPermission(false),

    new SlashCommandBuilder()
      .setName('convert')
      .setDescription('Convert your XP into cash (1 XP = $2)'),

    new SlashCommandBuilder()
      .setName('mining-status')
      .setDescription('Check current mining events and sector status'),

    new SlashCommandBuilder()
      .setName('observe')
      .setDescription("View another player's inventory and stats (requires their permission)")
      .addUserOption(option =>
        option.setName('player')
          .setDescription('The player you want to observe')
          .setRequired(true)),

    new SlashCommandBuilder()
      .setName('configure-observation')
      .setDescription('Set whether other players can view your inventory and stats'),

    new SlashCommandBuilder()
      .setName('collection')
      .setDescription('Browse your artefact field guide — see what you have and have not discovered'),

    new SlashCommandBuilder()
      .setName('quests')
      .setDescription('View your daily quests and the server\'s weekly community quest'),

    new SlashCommandBuilder()
      .setName('give-roles')
      .setDescription('Assign a role to a server member (Admin only)')
      .addUserOption(option =>
        option.setName('user')
          .setDescription('Member to assign a role to')
          .setRequired(true))
      .setDMPermission(false),

    new SlashCommandBuilder()
      .setName('timeout')
      .setDescription('Timeout a member (Admin only)')
      .addUserOption(option =>
        option.setName('user')
          .setDescription('User to timeout')
          .setRequired(true))
      .addIntegerOption(option =>
        option.setName('duration')
          .setDescription('Timeout duration in minutes (max 40320 = 28 days)')
          .setRequired(true)
          .setMinValue(1)
          .setMaxValue(40320))
      .addStringOption(option =>
        option.setName('reason')
          .setDescription('Reason for the timeout')
          .setRequired(false))
      .setDMPermission(false),

    new SlashCommandBuilder()
      .setName('kick')
      .setDescription('Kick a member from the server (Admin only)')
      .addUserOption(option =>
        option.setName('user')
          .setDescription('User to kick')
          .setRequired(true))
      .addStringOption(option =>
        option.setName('reason')
          .setDescription('Reason for the kick')
          .setRequired(false))
      .setDMPermission(false),

    new SlashCommandBuilder()
      .setName('ban')
      .setDescription('Ban a member from the server (Admin only)')
      .addUserOption(option =>
        option.setName('user')
          .setDescription('User to ban')
          .setRequired(true))
      .addIntegerOption(option =>
        option.setName('duration')
          .setDescription('Temporary ban duration in hours (leave empty or 0 for permanent)')
          .setRequired(false)
          .setMinValue(0))
      .addIntegerOption(option =>
        option.setName('delete_messages')
          .setDescription('Days of messages to delete (0–7, default 0)')
          .setRequired(false)
          .setMinValue(0)
          .setMaxValue(7))
      .addStringOption(option =>
        option.setName('reason')
          .setDescription('Reason for the ban')
          .setRequired(false))
      .setDMPermission(false),

  ];

  const devCommands = [
    new SlashCommandBuilder()
      .setName('give-artefact')
      .setDescription('Open an interactive menu to give artefacts to a user (Developer only)')
      .setDefaultMemberPermissions(0)
      .addUserOption(option =>
        option.setName('user')
          .setDescription('User to give artefacts to')
          .setRequired(true)),

    new SlashCommandBuilder()
      .setName('add-money')
      .setDescription('Add cash to a user (Developer only)')
      .setDefaultMemberPermissions(0)
      .addUserOption(option =>
        option.setName('user')
          .setDescription('User to add cash to')
          .setRequired(true))
      .addIntegerOption(option =>
        option.setName('amount')
          .setDescription('Amount of cash to add')
          .setRequired(true)
          .setMinValue(1)),

    new SlashCommandBuilder()
      .setName('give-cash')
      .setDescription('Give cash to a user (Developer only)')
      .setDefaultMemberPermissions(0)
      .addUserOption(option =>
        option.setName('user')
          .setDescription('User to give cash to')
          .setRequired(true))
      .addIntegerOption(option =>
        option.setName('amount')
          .setDescription('Amount of cash to give')
          .setRequired(true)
          .setMinValue(1)),

    new SlashCommandBuilder()
      .setName('setevent')
      .setDescription('Manually trigger a mining event (Developer only)')
      .setDefaultMemberPermissions(0)
      .addStringOption(option =>
        option.setName('positive_artefact')
          .setDescription('Artefact that will have increased rates')
          .setRequired(true))
      .addStringOption(option =>
        option.setName('negative_artefact')
          .setDescription('Artefact that will be unavailable')
          .setRequired(true)),

    new SlashCommandBuilder()
      .setName('remove-artefact')
      .setDescription('Remove an artefact from a user (Developer only)')
      .setDefaultMemberPermissions(0)
      .addUserOption(option =>
        option.setName('user')
          .setDescription('User to remove artefact from')
          .setRequired(true))
      .addStringOption(option =>
        option.setName('artefact')
          .setDescription('Name of the artefact to remove')
          .setRequired(true)),

    new SlashCommandBuilder()
      .setName('remove-cash')
      .setDescription('Remove cash from a user (Developer only)')
      .setDefaultMemberPermissions(0)
      .addUserOption(option =>
        option.setName('user')
          .setDescription('User to remove cash from')
          .setRequired(true))
      .addIntegerOption(option =>
        option.setName('amount')
          .setDescription('Amount of cash to remove')
          .setRequired(true)
          .setMinValue(1)),

    new SlashCommandBuilder()
      .setName('reset-cooldowns')
      .setDescription('Reset cooldowns for a user or all users (Developer only)')
      .setDefaultMemberPermissions(0)
      .addUserOption(option =>
        option.setName('user')
          .setDescription('User to reset cooldowns for (leave empty for ALL users)')
          .setRequired(false)),

    new SlashCommandBuilder()
      .setName('devlog')
      .setDescription('Broadcast a developer update to all servers (Developer only)')
      .setDefaultMemberPermissions(0)
      .addStringOption(option =>
        option.setName('title')
          .setDescription('Title of the update')
          .setRequired(true))
      .addStringOption(option =>
        option.setName('message')
          .setDescription('The update message to broadcast')
          .setRequired(true))
      .addStringOption(option =>
        option.setName('version')
          .setDescription('Optional version tag e.g. v1.2.3')
          .setRequired(false)),

    new SlashCommandBuilder()
      .setName('start-raid')
      .setDescription('Begin a new Raid Season and broadcast to all servers (Developer only)')
      .setDefaultMemberPermissions(0),

    new SlashCommandBuilder()
      .setName('end-raid')
      .setDescription('End the active Raid Season, distribute payouts, and wipe all army data (Developer only)')
      .setDefaultMemberPermissions(0),

    new SlashCommandBuilder()
      .setName('serverblacklist')
      .setDescription('Blacklist or unblacklist a server from using the bot (Developer only)')
      .setDefaultMemberPermissions(0)
      .addStringOption(option =>
        option.setName('serverid')
          .setDescription('The server ID to blacklist or unblacklist')
          .setRequired(true))
      .addStringOption(option =>
        option.setName('action')
          .setDescription('Whether to blacklist or unblacklist the server')
          .setRequired(true)
          .addChoices(
            { name: 'Blacklist',   value: 'blacklist'   },
            { name: 'Unblacklist', value: 'unblacklist' }
          )),
  ];

  const extraPublicCommands = [
    new SlashCommandBuilder()
      .setName('setprefix')
      .setDescription('Set the prefix for text-based commands in this server (Admin only)'),
    new SlashCommandBuilder()
      .setName('market')
      .setDescription('See current artefact market prices, top gainers and losers'),
    new SlashCommandBuilder()
      .setName('setannouncements')
      .setDescription('Set the channel where market event announcements are posted (Admin only)')
      .addChannelOption(option =>
        option.setName('channel')
          .setDescription('Channel to post announcements in. Omit to disable.')
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setRequired(false))
  ];

  const allPublicCommands = [...commands, ...extraPublicCommands];

  const rest = new REST({ version:'10' }).setToken(token);

  try {
    console.log('Started refreshing application (/) commands.');

    await rest.put(Routes.applicationCommands(clientId), {
      body: allPublicCommands.map(command => command.toJSON())
    });

    const guilds = client.guilds.cache;
    for (const [guildId, guild] of guilds) {
      try {
        if (!guild.members.cache.has(DEVELOPER_ID) && !guild.members.cache.has(CO_DEVELOPER_ID)) {
          try {
            await guild.members.fetch();
          } catch (fetchErr) {
            console.log(`Could not fetch members for guild ${guildId}`);
          }
        }

        const hasDevelopers = guild.members.cache.has(DEVELOPER_ID) ||
                              guild.members.cache.has(CO_DEVELOPER_ID);

        if (hasDevelopers) {
          console.log(`Registering developer commands for guild: ${guild.name} (${guildId})`);
          await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
            body: [...allPublicCommands, ...devCommands].map(command => command.toJSON())
          });
        } else {
          console.log(`No developers found in guild: ${guild.name} (${guildId}), skipping dev commands`);
        }
      } catch (guildErr) {
        console.error(`Error registering commands for guild ${guildId}:`, guildErr);
      }
    }

    console.log('Successfully reloaded application (/) commands.');
  } catch (err) { 
    console.error('Error registering commands:', err); 
  }
});

client.on('interactionCreate', async interaction => {
  if (!usersCollection) {
    if (interaction.isAutocomplete()) {
      await interaction.respond([]);
      return;
    }
    if (interaction.isRepliable()) {
      await interaction.reply({ content: 'The bot is still starting up, please try again in a moment.', ephemeral: true });
      return;
    }
    return;
  }

  if (interaction.guildId && !isDeveloper(interaction.user.id)) {
    if (await isServerBlacklisted(interaction.guildId)) {
      if (interaction.isRepliable()) {
        await interaction.reply({ embeds: [new EmbedBuilder()
          .setTitle('Server Blacklisted')
          .setDescription('This server has been blacklisted and can no longer use this bot. You can still use all commands in the official server.')
          .setColor(0xFF6B6B)
          .setTimestamp()], ephemeral: true }).catch(() => {});
      }
      return;
    }
  }

  if (interaction.isAutocomplete()) {
    const { commandName, focusedOption } = interaction;

    if (commandName === 'sell' && focusedOption.name === 'artefact') {
      const userId = interaction.user.id;
      const user = await getUser(userId);

      const userArtefacts = user.artefacts || [];
      const focusedValue = focusedOption.value.toLowerCase();

      const filtered = userArtefacts
        .filter(artefact => artefact.toLowerCase().includes(focusedValue))
        .slice(0, 25);

      await interaction.respond(
        filtered.map(artefact => ({ name: artefact, value: artefact }))
      );
      return;
    }
  }

  if (interaction.isStringSelectMenu()) {
    return await handleComponentInteraction(interaction);
  }

  if (interaction.isButton()) {
    return await handleComponentInteraction(interaction);
  }

  if (interaction.isModalSubmit()) {
    const { customId } = interaction;

    if (customId.startsWith('number_modal_')) {
      const gameId = customId.replace('number_modal_', '');
      await processNumberGuess(interaction, gameId);
      return;
    }

    if (customId.startsWith('bet_modal_')) {
      const gameId = customId.replace('bet_modal_', '');
      await handleBetModalSubmit(interaction, gameId);
      return;
    }

    if (customId.startsWith('duel_number_modal_')) {
      const gameId = customId.replace('duel_number_modal_', '');
      await processDuelGuess(interaction, gameId);
      return;
    }

    if (customId.startsWith('duel_bet_modal_')) {
      const gameId = customId.replace('duel_bet_modal_', '');
      await handleDuelBetModal(interaction, gameId);
      return;
    }

    if (customId.startsWith('ms_amount_modal_')) {
      const sessionId = customId.replace('ms_amount_modal_', '');
      const session = global.massSellSessions[sessionId];

      if (!session) {
        return await interaction.reply({ content: 'This session has expired.', ephemeral: true });
      }

      const rawAmount = interaction.fields.getTextInputValue('ms_amount_input');
      const amount = parseInt(rawAmount);

      if (isNaN(amount) || amount < 1) {
        return await interaction.reply({ content: 'Please enter a valid number of 1 or more.', ephemeral: true });
      }

      const user = await getUser(session.userId);

      const owned = user.artefacts.filter(a => a === session.selectedArtefact).length;
      const alreadyQueued = session.queue.find(e => e.name === session.selectedArtefact)?.amount || 0;
      const available = owned - alreadyQueued;

      if (amount > available) {
        return await interaction.reply({
          content: `You only have **${available}** available copies of ${session.selectedArtefact} to queue.`,
          ephemeral: true
        });
      }

      const existing = session.queue.find(e => e.name === session.selectedArtefact);
      if (existing) {
        existing.amount += amount;
      } else {
        session.queue.push({ name: session.selectedArtefact, amount });
      }

      await interaction.deferUpdate();
      await session.message.edit({
        embeds: [buildMassSellEmbed(session, user.artefacts)],
        components: buildMassSellComponents(sessionId, session, user.artefacts)
      });
      return;
    }

    if (customId.startsWith('ms_search_modal_')) {
      const sessionId = customId.replace('ms_search_modal_', '');
      const session = global.massSellSessions[sessionId];

      if (!session) {
        return await interaction.reply({ content: 'This session has expired.', ephemeral: true });
      }

      const rawQuery = (interaction.fields.getTextInputValue('ms_search_input') || '').trim();
      session.searchQuery = rawQuery;
      session.page = 0;

      const user = await getUser(session.userId);

      await interaction.deferUpdate();
      await session.message.edit({
        embeds: [buildMassSellEmbed(session, user.artefacts)],
        components: buildMassSellComponents(sessionId, session, user.artefacts)
      });
      return;
    }

    if (customId.startsWith('trade_picker_search_modal_')) {
      const tradeId = customId.replace('trade_picker_search_modal_', '');
      const trade = global.activeTrades[tradeId];
      if (!trade) {
        return await interaction.reply({ content: 'Trade session not found.', ephemeral: true });
      }
      const userId = interaction.user.id;
      const picker = trade.pickers && trade.pickers[userId];
      if (!picker) {
        return await interaction.reply({ content: 'Picker session expired — close this and click Add/Remove Artefact again.', ephemeral: true });
      }
      const rawQuery = (interaction.fields.getTextInputValue('trade_picker_search_input') || '').trim();
      picker.query = rawQuery;
      picker.page = 0;
      await interaction.update(buildTradePickerPayload(trade, userId));
      return;
    }

    if (customId.startsWith('trade_cash_modal_')) {
      const tradeId = customId.replace('trade_cash_modal_', '');
      const trade = global.activeTrades[tradeId];
      if (!trade) {
        return await interaction.reply({ content: '❌ Trade session not found!', ephemeral: true });
      }
      const userId = interaction.user.id;
      if (userId !== trade.initiator && userId !== trade.recipient) {
        return await interaction.reply({ content: '❌ You are not part of this trade.', ephemeral: true });
      }
      const isInitiator = trade.initiator === userId;
      if ((isInitiator && trade.initiatorReady) || (!isInitiator && trade.recipientReady)) {
        return await interaction.reply({ content: '❌ You cannot modify your offer after marking ready!', ephemeral: true });
      }
      const rawInput = (interaction.fields.getTextInputValue('cash_amount') || '').trim();
      const cashAmount = parseCashInput(rawInput);
      if (isNaN(cashAmount) || cashAmount < 0) {
        return await interaction.reply({ content: '❌ Invalid amount. Use a number like `500`, `1.5k`, or `2m`.', ephemeral: true });
      }
      const userRecord = userData[userId] || { cash: 0 };
      if (cashAmount > (userRecord.cash || 0)) {
        return await interaction.reply({
          content: `❌ You only have **$${(userRecord.cash || 0).toLocaleString()}** available!`,
          ephemeral: true
        });
      }
      if (isInitiator) {
        trade.initiatorOffer.cash = cashAmount;
        trade.initiatorReady = false;
      } else {
        trade.recipientOffer.cash = cashAmount;
        trade.recipientReady = false;
      }
      const tradeEmbed = createTradeEmbed(trade, trade.initiator, trade.recipient);
      const components = createTradeComponents(tradeId);
      await interaction.update({ embeds: [tradeEmbed], components });
      return;
    }

    if (customId.startsWith('trade_artefact_qty_modal_')) {
      const tradeId = customId.replace('trade_artefact_qty_modal_', '');
      const trade = global.activeTrades[tradeId];
      if (!trade) {
        return await interaction.reply({ content: '❌ Trade session not found!', ephemeral: true });
      }
      const userId = interaction.user.id;
      const picker = trade.pickers && trade.pickers[userId];
      if (!picker || !picker.pendingAdd) {
        return await interaction.reply({ content: '❌ Picker session expired — please click Add Artefact again.', ephemeral: true });
      }
      const artefact = picker.pendingAdd;
      picker.pendingAdd = null;
      const rawQty = (interaction.fields.getTextInputValue('artefact_qty') || '').trim();
      const qty = parseInt(rawQty, 10);
      const userArtefacts = (userData[userId] && userData[userId].artefacts) || [];
      const offer = trade.initiator === userId ? trade.initiatorOffer : trade.recipientOffer;
      const owned = userArtefacts.filter(a => a === artefact).length;
      const alreadyOffered = offer.artefacts.filter(a => a === artefact).length;
      const available = owned - alreadyOffered;
      if (isNaN(qty) || qty < 1) {
        return await interaction.reply({ content: '❌ Please enter a number of 1 or more.', ephemeral: true });
      }
      if (qty > available) {
        return await interaction.reply({
          content: `❌ You only have **${available}** copy(ies) of **${artefact}** available to add.`,
          ephemeral: true
        });
      }
      for (let i = 0; i < qty; i++) offer.artefacts.push(artefact);
      const isInitiator = trade.initiator === userId;
      if (isInitiator) trade.initiatorReady = false;
      else trade.recipientReady = false;
      await refreshTradeMessage(trade);
      await interaction.update(buildTradePickerPayload(trade, userId));
      return;
    }

    if (customId.startsWith('trade_remove_artefact_qty_modal_')) {
      const tradeId = customId.replace('trade_remove_artefact_qty_modal_', '');
      const trade = global.activeTrades[tradeId];
      if (!trade) {
        return await interaction.reply({ content: '❌ Trade session not found!', ephemeral: true });
      }
      const userId = interaction.user.id;
      const picker = trade.pickers && trade.pickers[userId];
      if (!picker || !picker.pendingRemove) {
        return await interaction.reply({ content: '❌ Picker session expired — please click Remove Artefact again.', ephemeral: true });
      }
      const artefact = picker.pendingRemove;
      picker.pendingRemove = null;
      const rawQty = (interaction.fields.getTextInputValue('remove_qty') || '').trim();
      const qty = parseInt(rawQty, 10);
      const offer = trade.initiator === userId ? trade.initiatorOffer : trade.recipientOffer;
      const countInOffer = offer.artefacts.filter(a => a === artefact).length;
      if (isNaN(qty) || qty < 1) {
        return await interaction.reply({ content: '❌ Please enter a number of 1 or more.', ephemeral: true });
      }
      if (qty > countInOffer) {
        return await interaction.reply({
          content: `❌ You only have **${countInOffer}** copy(ies) of **${artefact}** in your offer.`,
          ephemeral: true
        });
      }
      let removed = 0;
      offer.artefacts = offer.artefacts.filter(a => {
        if (a === artefact && removed < qty) { removed++; return false; }
        return true;
      });
      const isInitiator = trade.initiator === userId;
      if (isInitiator) trade.initiatorReady = false;
      else trade.recipientReady = false;
      await refreshTradeMessage(trade);
      await interaction.update(buildTradePickerPayload(trade, userId));
      return;
    }

    if (customId.startsWith('ga_amount_modal_')) {
      const sessionId = customId.replace('ga_amount_modal_', '');
      const session = global.giveArtefactSessions[sessionId];

      if (!session) {
        return await interaction.reply({ content: 'This session has expired.', ephemeral: true });
      }

      const rawAmount = interaction.fields.getTextInputValue('ga_amount_input');
      const amount = parseInt(rawAmount);

      if (isNaN(amount) || amount < 1 || amount > 1000) {
        return await interaction.reply({ content: 'Please enter a valid number between 1 and 1000.', ephemeral: true });
      }

      const existing = session.queue.find(e => e.name === session.selectedArtefact);
      if (existing) {
        existing.amount += amount;
      } else {
        session.queue.push({ name: session.selectedArtefact, amount });
      }

      await interaction.deferUpdate();
      await session.message.edit({
        embeds: [buildGiveArtefactEmbed(session)],
        components: buildGiveArtefactComponents(sessionId, session)
      });
      return;
    }

    if (customId === 'setprefix_modal') {
      await handleSetPrefixModal(interaction);
      return;
    }
  }

  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'buy' || interaction.commandName === 'add-item' || interaction.commandName === 'fish') {
    await interaction.deferReply();
  }
  if (interaction.commandName === 'store') {
    await interaction.deferReply();
  }

  if (interaction.commandName === 'reset-cooldowns') {
    await interaction.deferReply({ ephemeral: true });
  }

  const userId = interaction.user.id;
  await getUser(userId);

  if (!userData[userId].commandCount) userData[userId].commandCount = 0;
  userData[userId].commandCount++;

  if (!userData[userId].joinedDate) {
    userData[userId].joinedDate = Date.now();
  }

  try {
    switch (interaction.commandName) {
      case 'info':
        await handleInfoCommand(interaction);
        break;
      case 'setprefix':
        await handleSetPrefixCommand(interaction);
        break;
      case 'market':
        await handleMarketCommand(interaction);
        break;
      case 'setannouncements':
        await handleSetAnnouncementsCommand(interaction);
        break;
      case 'bank':
        await handleBankCommand(interaction, userId);
        break;

      case 'bank-all':
        await handleBankAllCommand(interaction, userId);
        break;
      case 'withdraw':
        await handleWithdrawCommand(interaction, userId);
        break;
      case 'steal':
        await handleStealCommand(interaction, userId);
        break;
      case 'scavenge':
        await handleScavengeCommand(interaction, userId);
        break;
      case 'labor':
        await handleLaborCommand(interaction, userId);
        break;
      case 'inventory':
        await handleInventoryCommand(interaction, userId);
        break;
      case 'sell':
        break;
      case 'trade':
        await handleTradeCommand(interaction, userId);
        break;
      case 'leaderboard':
        await handleLeaderboardCommand(interaction);
        break;
      case 'store':
        await handleStoreCommand(interaction);
        break;
      case 'buy':
        await handleBuyCommand(interaction, userId);
        break;
      case 'mass-sell':
        await handleMassSellCommand(interaction, userId);
        break;
      case 'add-item':
        await handleAddItemCommand(interaction);
        break;
      case 'remove-item':
        await handleRemoveItemCommand(interaction);
        break;
      case 'view-items':
        await handleViewItemsCommand(interaction);
        break;

      case 'fish':
        await handleFishCommand(interaction, userId);
        break;

      case 'viewcp':
        await handleViewCPCommand(interaction);
        break;

      case 'raid':
        await handleRaidCommand(interaction);
        break;

      case 'marble-game':
        await handleMarbleGame(interaction);
        break;

      case 'marble-duel':
        await handleMarbleDuel(interaction);
        break;

      case 'card-duel':
        await handleCardDuelCommand(interaction);
        break;

      case 'convert':
        await handleConvertCommand(interaction, userId);
        break;

      case 'mining-status':
        await handleMiningStatusCommand(interaction);
        break;

      case 'give-artefact':
        await handleGiveArtefactCommand(interaction);
        break;

      case 'give-cash':
        await handleGiveCashCommand(interaction);
        break;

      case 'add-money':
        await handleAddMoneyCommand(interaction);
        break;

      case 'start-raid':
        await handleStartRaidCommand(interaction);
        break;

      case 'end-raid':
        await handleEndRaidCommand(interaction);
        break;

      case 'serverblacklist':
        await handleServerBlacklistCommand(interaction);
        break;

      case 'setevent':
        await handleSetEventCommand(interaction);
        break;

      case 'remove-artefact':
        await handleRemoveArtefactCommand(interaction);
        break;

      case 'remove-cash':
        await handleRemoveCashCommand(interaction);
        break;

      case 'reset-cooldowns':
        await handleResetCooldownsCommand(interaction);
        break;

      case 'devlog':
        await handleDevlogCommand(interaction);
        break;

      case 'observe':
        await handleObserveCommand(interaction, userId);
        break;

      case 'quests':
        await handleQuestsCommand(interaction, userId);
        break;

      case 'configure-observation':
        await handleConfigureObservationCommand(interaction, userId);
        break;

      case 'collection':
        await handleCollectionCommand(interaction, userId);
        break;

      case 'give-roles':
        await handleGiveRolesCommand(interaction);
        break;

      case 'timeout':
        await handleTimeoutCommand(interaction);
        break;

      case 'kick':
        await handleKickCommand(interaction);
        break;

      case 'ban':
        await handleBanCommand(interaction);
        break;
    }
  } catch (error) {
    console.error('Error handling slash command:', error);

    try {
      const errorEmbed = new EmbedBuilder()
        .setTitle('Command Error')
        .setDescription('An error occurred while processing your command. Please try again.')
        .setColor(0xFF6B6B)
        .setTimestamp();

      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ embeds: [errorEmbed], flags: 64 });
      } else if (interaction.deferred && !interaction.replied) {
        await interaction.editReply({ embeds: [errorEmbed] });
      }
    } catch (replyError) {
      console.error('Failed to send error message:', replyError);
    }
  }
});


async function handleGiveRolesCommand(interaction) {
  if (!isDeveloper(interaction.user.id) && !interaction.member?.permissions.has(PermissionFlagsBits.Administrator)) {
    return interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle('Access Denied')
          .setDescription('You need **Administrator** permissions or must be a bot developer to use this command.')
          .setColor(0xFF6B6B)
          .setTimestamp()
      ],
      ephemeral: true
    });
  }

  await interaction.deferReply({ ephemeral: true });

  const targetMember = interaction.options.getMember('user');
  if (!targetMember) {
    return interaction.editReply({ content: 'That user was not found in this server.' });
  }

  try {
    await interaction.guild.roles.fetch();
    await targetMember.fetch();
  } catch (e) {
    console.error('Failed to fetch data:', e);
  }

  const botMember = interaction.guild.members.me ?? await interaction.guild.members.fetchMe().catch(() => null);
  if (!botMember) {
    return interaction.editReply({ content: 'Unable to retrieve bot member data.' });
  }

  const botHighestRole = botMember.roles.highest;

  const allRoles = [...interaction.guild.roles.cache
    .filter(role => role.id !== interaction.guild.id)
    .sort((a, b) => b.position - a.position)
    .values()];

  if (allRoles.length === 0) {
    return interaction.editReply({ content: 'This server has no roles.' });
  }

  const PAGE_SIZE = 25;
  let currentPage = 0;
  let mode = 'add'; // 'add' or 'remove'

  function canManage(role) {
    return role.position < botHighestRole.position && !role.managed;
  }

  function getMemberRoles() {
    return targetMember.roles.cache
      .filter(r => r.id !== interaction.guild.id)
      .sort((a, b) => b.position - a.position);
  }

  function buildEmbed(page) {
    const totalPages = Math.ceil(allRoles.length / PAGE_SIZE);
    const start = page * PAGE_SIZE + 1;
    const end = Math.min((page + 1) * PAGE_SIZE, allRoles.length);

    const memberRoles = getMemberRoles();
    const roleList = memberRoles.size > 0
      ? [...memberRoles.values()].map(r => `<@&${r.id}>`).join(' ')
      : '*No roles assigned*';

    const modeColor = mode === 'add' ? 0x57F287 : 0xFF6B6B;
    const modeLabel = mode === 'add' ? '➕ Add Role' : '➖ Remove Role';

    return new EmbedBuilder()
      .setTitle(`Role Manager — ${targetMember.displayName}`)
      .setThumbnail(targetMember.user.displayAvatarURL({ dynamic: true }))
      .setDescription(
        `**Target:** <@${targetMember.id}>\n` +
        `**Mode:** ${modeLabel}\n\n` +
        `**Current Roles (${memberRoles.size}):**\n${roleList}`
      )
      .addFields({
        name: `All Server Roles — Page ${page + 1} / ${totalPages}`,
        value: `Showing **${start}–${end}** of **${allRoles.length}** roles.\n` +
               `⚠️ = above bot (cannot manage) • 🔒 = managed/integration`
      })
      .setColor(modeColor)
      .setFooter({ text: `Menu expires in 2 minutes • Bot\'s highest role: ${botHighestRole.name}` })
      .setTimestamp();
  }

  function buildComponents(page) {
    const totalPages = Math.ceil(allRoles.length / PAGE_SIZE);
    const pageRoles = allRoles.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

    const placeholder = mode === 'add'
      ? 'Select role(s) to add...'
      : 'Select role(s) to remove...';

    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId(`gr_select_${interaction.id}`)
      .setPlaceholder(placeholder)
      .setMinValues(1)
      .setMaxValues(pageRoles.length)
      .addOptions(pageRoles.map(role => {
        const memberHas = targetMember.roles.cache.has(role.id);
        const manageable = canManage(role);
        let statusIcon = manageable ? (memberHas ? '✅' : '◻️') : (role.managed ? '🔒' : '⚠️');
        let desc = ``;
        if (!manageable && role.managed) desc = 'Managed by integration';
        else if (!manageable) desc = 'Above bot — cannot assign';
        else if (memberHas) desc = 'Member already has this role';
        else desc = `Position ${role.position} • ${role.hexColor}`;

        return {
          label: `${statusIcon} ${role.name}`.substring(0, 100),
          value: role.id,
          description: desc.substring(0, 100)
        };
      }));

    const rows = [new ActionRowBuilder().addComponents(selectMenu)];

    const addBtn = new ButtonBuilder()
      .setCustomId(`gr_mode_add_${interaction.id}`)
      .setLabel('➕ Add')
      .setStyle(mode === 'add' ? ButtonStyle.Success : ButtonStyle.Secondary)
      .setDisabled(mode === 'add');

    const removeBtn = new ButtonBuilder()
      .setCustomId(`gr_mode_remove_${interaction.id}`)
      .setLabel('➖ Remove')
      .setStyle(mode === 'remove' ? ButtonStyle.Danger : ButtonStyle.Secondary)
      .setDisabled(mode === 'remove');

    const prevBtn = new ButtonBuilder()
      .setCustomId(`gr_prev_${interaction.id}`)
      .setLabel('◀')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page === 0);

    const pageBtn = new ButtonBuilder()
      .setCustomId(`gr_page_${interaction.id}`)
      .setLabel(`${page + 1} / ${totalPages}`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true);

    const nextBtn = new ButtonBuilder()
      .setCustomId(`gr_next_${interaction.id}`)
      .setLabel('▶')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page === totalPages - 1);

    rows.push(new ActionRowBuilder().addComponents(addBtn, removeBtn, prevBtn, pageBtn, nextBtn));

    return rows;
  }

  const reply = await interaction.editReply({
    embeds: [buildEmbed(0)],
    components: buildComponents(0),
    fetchReply: true
  });

  const collector = reply.createMessageComponentCollector({
    filter: i => i.user.id === interaction.user.id,
    time: 120000
  });

  collector.on('collect', async i => {
    if (i.customId === `gr_prev_${interaction.id}`) {
      currentPage = Math.max(0, currentPage - 1);
      await i.update({ embeds: [buildEmbed(currentPage)], components: buildComponents(currentPage) });

    } else if (i.customId === `gr_next_${interaction.id}`) {
      const totalPages = Math.ceil(allRoles.length / PAGE_SIZE);
      currentPage = Math.min(totalPages - 1, currentPage + 1);
      await i.update({ embeds: [buildEmbed(currentPage)], components: buildComponents(currentPage) });

    } else if (i.customId === `gr_mode_add_${interaction.id}`) {
      mode = 'add';
      await i.update({ embeds: [buildEmbed(currentPage)], components: buildComponents(currentPage) });

    } else if (i.customId === `gr_mode_remove_${interaction.id}`) {
      mode = 'remove';
      await i.update({ embeds: [buildEmbed(currentPage)], components: buildComponents(currentPage) });

    } else if (i.customId === `gr_select_${interaction.id}`) {
      const selectedIds = i.values;
      const succeeded = [];
      const skipped = [];
      const failed = [];

      for (const roleId of selectedIds) {
        const role = interaction.guild.roles.cache.get(roleId);
        const roleName = role ? `\`${role.name}\`` : `\`${roleId}\``;

        if (!role || !canManage(role)) {
          failed.push(`${roleName} *(unmanageable)*`);
          continue;
        }

        if (mode === 'add') {
          if (targetMember.roles.cache.has(roleId)) {
            skipped.push(`${roleName} *(already has)*`);
            continue;
          }
          try {
            await targetMember.roles.add(roleId, `Added by ${interaction.user.tag} via /give-roles`);
            succeeded.push(roleName);
          } catch (err) {
            console.error(`Failed to add role ${roleId}:`, err);
            failed.push(`${roleName} *(error)*`);
          }
        } else {
          if (!targetMember.roles.cache.has(roleId)) {
            skipped.push(`${roleName} *(doesn't have)*`);
            continue;
          }
          try {
            await targetMember.roles.remove(roleId, `Removed by ${interaction.user.tag} via /give-roles`);
            succeeded.push(roleName);
          } catch (err) {
            console.error(`Failed to remove role ${roleId}:`, err);
            failed.push(`${roleName} *(error)*`);
          }
        }
      }

      try { await targetMember.fetch(); } catch (_) {}

      const actionWord = mode === 'add' ? 'Added' : 'Removed';
      const lines = [];
      if (succeeded.length) lines.push(`✅ **${actionWord}:** ${succeeded.join(', ')}`);
      if (skipped.length) lines.push(`ℹ️ **Skipped:** ${skipped.join(', ')}`);
      if (failed.length) lines.push(`❌ **Failed:** ${failed.join(', ')}`);

      const updatedRoles = getMemberRoles();
      const updatedRoleList = updatedRoles.size > 0
        ? [...updatedRoles.values()].map(r => `<@&${r.id}>`).join(' ')
        : '*No roles*';

      const confirmEmbed = new EmbedBuilder()
        .setTitle(`Roles Updated — ${targetMember.displayName}`)
        .setThumbnail(targetMember.user.displayAvatarURL({ dynamic: true }))
        .setDescription(lines.join('\n'))
        .addFields({ name: 'Current Roles', value: updatedRoleList })
        .setColor(succeeded.length ? (mode === 'add' ? 0x57F287 : 0xFF6B6B) : 0x99AAB5)
        .setTimestamp();

      await i.update({ embeds: [confirmEmbed, buildEmbed(currentPage)], components: buildComponents(currentPage) });
    }
  });

  collector.on('end', (_, reason) => {
    if (reason === 'time') {
      interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle('Session Expired')
            .setDescription(`Role management session for <@${targetMember.id}> ended after 2 minutes of inactivity.`)
            .setColor(0x99AAB5)
            .setTimestamp()
        ],
        components: []
      }).catch(() => {});
    }
  });
}

async function handleTimeoutCommand(interaction) {
  if (!isDeveloper(interaction.user.id) && !interaction.member?.permissions.has(PermissionFlagsBits.Administrator)) {
    return interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle('Access Denied')
          .setDescription('You need **Administrator** permissions or must be a bot developer to use this command.')
          .setColor(0xFF6B6B)
          .setTimestamp()
      ],
      ephemeral: true
    });
  }

  const target = interaction.options.getMember('user');
  const durationMinutes = interaction.options.getInteger('duration');
  const reason = interaction.options.getString('reason') || 'No reason provided';

  if (!target) {
    return interaction.reply({ content: 'That user was not found in this server.', ephemeral: true });
  }
  if (target.id === interaction.user.id) {
    return interaction.reply({ content: 'You cannot timeout yourself.', ephemeral: true });
  }
  if (target.id === interaction.client.user.id) {
    return interaction.reply({ content: 'I cannot timeout myself.', ephemeral: true });
  }
  if (!target.moderatable) {
    return interaction.reply({ content: 'I cannot timeout this user — they may have higher permissions than me.', ephemeral: true });
  }

  const durationMs = durationMinutes * 60 * 1000;

  let durationLabel;
  if (durationMinutes < 60) {
    durationLabel = `${durationMinutes} minute(s)`;
  } else if (durationMinutes < 1440) {
    durationLabel = `${Math.round(durationMinutes / 60 * 10) / 10} hour(s)`;
  } else {
    durationLabel = `${Math.round(durationMinutes / 1440 * 10) / 10} day(s)`;
  }

  await target.timeout(durationMs, reason);

  const embed = new EmbedBuilder()
    .setTitle('Member Timed Out')
    .setDescription(`<@${target.id}> has been timed out.`)
    .addFields(
      { name: 'Duration', value: durationLabel, inline: true },
      { name: 'Moderator', value: `<@${interaction.user.id}>`, inline: true },
      { name: 'Reason', value: reason }
    )
    .setColor(0xFFA500)
    .setTimestamp();

  await interaction.reply({ embeds: [embed] });
}

async function handleKickCommand(interaction) {
  if (!isDeveloper(interaction.user.id) && !interaction.member?.permissions.has(PermissionFlagsBits.Administrator)) {
    return interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle('Access Denied')
          .setDescription('You need **Administrator** permissions or must be a bot developer to use this command.')
          .setColor(0xFF6B6B)
          .setTimestamp()
      ],
      ephemeral: true
    });
  }

  const target = interaction.options.getMember('user');
  const reason = interaction.options.getString('reason') || 'No reason provided';

  if (!target) {
    return interaction.reply({ content: 'That user was not found in this server.', ephemeral: true });
  }
  if (target.id === interaction.user.id) {
    return interaction.reply({ content: 'You cannot kick yourself.', ephemeral: true });
  }
  if (target.id === interaction.client.user.id) {
    return interaction.reply({ content: 'I cannot kick myself.', ephemeral: true });
  }
  if (!target.kickable) {
    return interaction.reply({ content: 'I cannot kick this user — they may have higher permissions than me.', ephemeral: true });
  }

  await target.kick(reason);

  const embed = new EmbedBuilder()
    .setTitle('Member Kicked')
    .setDescription(`<@${target.id}> has been kicked from the server.`)
    .addFields(
      { name: 'Moderator', value: `<@${interaction.user.id}>`, inline: true },
      { name: 'Reason', value: reason }
    )
    .setColor(0xFF6B6B)
    .setTimestamp();

  await interaction.reply({ embeds: [embed] });
}

async function handleBanCommand(interaction) {
  if (!isDeveloper(interaction.user.id) && !interaction.member?.permissions.has(PermissionFlagsBits.Administrator)) {
    return interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle('Access Denied')
          .setDescription('You need **Administrator** permissions or must be a bot developer to use this command.')
          .setColor(0xFF6B6B)
          .setTimestamp()
      ],
      ephemeral: true
    });
  }

  const target = interaction.options.getMember('user');
  const durationHours = interaction.options.getInteger('duration') ?? 0;
  const deleteMessages = interaction.options.getInteger('delete_messages') ?? 0;
  const reason = interaction.options.getString('reason') || 'No reason provided';

  if (!target) {
    return interaction.reply({ content: 'That user was not found in this server.', ephemeral: true });
  }
  if (target.id === interaction.user.id) {
    return interaction.reply({ content: 'You cannot ban yourself.', ephemeral: true });
  }
  if (target.id === interaction.client.user.id) {
    return interaction.reply({ content: 'I cannot ban myself.', ephemeral: true });
  }
  if (!target.bannable) {
    return interaction.reply({ content: 'I cannot ban this user — they may have higher permissions than me.', ephemeral: true });
  }

  const durationLabel = durationHours === 0 ? 'Permanent' : `${durationHours} hour(s)`;
  const targetId = target.id;
  const guild = interaction.guild;

  await target.ban({ deleteMessageSeconds: deleteMessages * 86400, reason });

  const embed = new EmbedBuilder()
    .setTitle('Member Banned')
    .setDescription(`<@${targetId}> has been banned from the server.`)
    .addFields(
      { name: 'Duration', value: durationLabel, inline: true },
      { name: 'Moderator', value: `<@${interaction.user.id}>`, inline: true },
      { name: 'Messages Deleted', value: `${deleteMessages} day(s)`, inline: true },
      { name: 'Reason', value: reason }
    )
    .setColor(0x8B0000)
    .setTimestamp();

  await interaction.reply({ embeds: [embed] });

  if (durationHours > 0) {
    setTimeout(async () => {
      try {
        await guild.members.unban(targetId, 'Temporary ban expired');
        console.log(`Auto-unbanned user ${targetId} from ${guild.name} after ${durationHours} hour(s).`);
      } catch (err) {
        console.error(`Failed to auto-unban user ${targetId}:`, err);
      }
    }, durationHours * 60 * 60 * 1000);
  }
}

async function handleSetPrefixCommand(interaction) {
  if (!isDeveloper(interaction.user.id) && !interaction.member?.permissions.has(PermissionFlagsBits.Administrator)) {
    return await interaction.reply({
      embeds: [new EmbedBuilder()
        .setTitle('Access Denied')
        .setDescription('You need **Administrator** permissions or must be a bot developer to use this command.')
        .setColor(0xFF6B6B)
        .setTimestamp()],
      ephemeral: true
    });
  }
  if (!interaction.guildId) {
    return await interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
  }

  const currentPrefix = await getGuildPrefix(interaction.guildId);

  const input = new TextInputBuilder()
    .setCustomId('setprefix_input')
    .setLabel('New prefix (1-5 chars, no spaces)')
    .setPlaceholder('e.g.  !   $   fb!')
    .setStyle(TextInputStyle.Short)
    .setMinLength(1)
    .setMaxLength(5)
    .setRequired(true);

  if (currentPrefix) input.setValue(currentPrefix);

  const modal = new ModalBuilder()
    .setCustomId('setprefix_modal')
    .setTitle('Set Server Prefix')
    .addComponents(new ActionRowBuilder().addComponents(input));

  await interaction.showModal(modal);
}

async function handleSetPrefixModal(interaction) {
  if (!isDeveloper(interaction.user.id) && !interaction.member?.permissions.has(PermissionFlagsBits.Administrator)) {
    return await interaction.reply({ content: 'You no longer have permission to set the prefix.', ephemeral: true });
  }
  if (!interaction.guildId) {
    return await interaction.reply({ content: 'This can only be used in a server.', ephemeral: true });
  }

  const raw = interaction.fields.getTextInputValue('setprefix_input');
  const validation = validatePrefix(raw);
  if (!validation.ok) {
    return await interaction.reply({
      embeds: [new EmbedBuilder()
        .setTitle('Invalid Prefix')
        .setDescription(validation.reason)
        .setColor(0xFF6B6B)
        .setTimestamp()],
      ephemeral: true
    });
  }

  try {
    await setGuildPrefix(interaction.guildId, validation.prefix);
  } catch (err) {
    console.error('Failed to save guild prefix:', err);
    return await interaction.reply({ content: 'Failed to save the prefix. Please try again later.', ephemeral: true });
  }

  return await interaction.reply({
    embeds: [new EmbedBuilder()
      .setTitle('Prefix Updated')
      .setDescription(`The text-command prefix for this server is now: \`${validation.prefix}\``)
      .addFields({
        name: 'Try it',
        value: `\`${validation.prefix}inventory\`, \`${validation.prefix}labor\`, \`${validation.prefix}bank all\`, \`${validation.prefix}store\`, \`${validation.prefix}scavenge\``
      })
      .setColor(0x51CF66)
      .setTimestamp()]
  });
}

class MessageInteractionAdapter {
  constructor(message, args, commandName) {
    this.message = message;
    this.user = message.author;
    this.member = message.member;
    this.guild = message.guild;
    this.guildId = message.guildId;
    this.channel = message.channel;
    this.channelId = message.channelId;
    this.commandName = commandName;
    this.replied = false;
    this.deferred = false;
    this._reply = null;
    this.options = {
      _args: args,
      getInteger: (_name) => {
        const raw = args[0];
        if (raw === undefined || raw === null) return null;
        const n = parseInt(String(raw).replace(/[, $_]/g, ''), 10);
        return isNaN(n) ? null : n;
      },
      getString: (_name) => (args[0] !== undefined ? String(args[0]) : null),
      getUser: (_name) => message.mentions.users.first() || null,
      getBoolean: (_name) => null,
    };
  }

  isRepliable() { return true; }
  isAutocomplete() { return false; }
  isChatInputCommand() { return false; }

  _normalizePayload(payload) {
    if (typeof payload === 'string') return { content: payload };
    const out = {};
    if (payload.embeds) out.embeds = payload.embeds;
    if (payload.content) out.content = payload.content;
    if (payload.components) out.components = payload.components;
    if (payload.files) out.files = payload.files;
    if (!out.content && !out.embeds && !out.components && !out.files) {
      out.content = '\u200b';
    }
    return out;
  }

  async deferReply(_opts = {}) {
    if (this.deferred || this.replied) return this._reply;
    try {
      this._reply = await this.message.channel.send({ content: 'Working on it…' });
    } catch (err) {
      console.error('deferReply send failed:', err);
    }
    this.deferred = true;
    return this._reply;
  }

  async reply(payload) {
    if (this.replied || this.deferred) {
      return await this.editReply(payload);
    }
    const sendPayload = this._normalizePayload(payload);
    try {
      this._reply = await this.message.reply(sendPayload);
    } catch (err) {
      try {
        this._reply = await this.message.channel.send(sendPayload);
      } catch (err2) {
        console.error('reply failed entirely:', err2);
      }
    }
    this.replied = true;
    return this._reply;
  }

  async editReply(payload) {
    const sendPayload = this._normalizePayload(payload);
    if (this._reply) {
      try {
        return await this._reply.edit(sendPayload);
      } catch (err) {
        try {
          return await this.message.channel.send(sendPayload);
        } catch (err2) {
          console.error('editReply fallback failed:', err2);
        }
      }
    }
    try {
      this._reply = await this.message.channel.send(sendPayload);
    } catch (err) {
      console.error('editReply send failed:', err);
    }
    this.replied = true;
    return this._reply;
  }

  async followUp(payload) {
    const sendPayload = this._normalizePayload(payload);
    try {
      return await this.message.channel.send(sendPayload);
    } catch (err) {
      console.error('followUp send failed:', err);
    }
  }

  async showModal(_modal) {
    try {
      await this.message.reply('This action requires using the slash-command version.');
    } catch (_) {}
  }
}

async function dispatchPrefixCommand(message, tokens) {
  const cmd = tokens[0].toLowerCase();
  const args = tokens.slice(1);

  let handler = null;
  let commandName = null;
  let parsedArgs = args;

  switch (cmd) {
    case 'labor':
    case 'work':
      handler = (ix) => handleLaborCommand(ix, message.author.id);
      commandName = 'labor';
      break;

    case 'inventory':
    case 'inv':
      handler = (ix) => handleInventoryCommand(ix, message.author.id);
      commandName = 'inventory';
      break;

    case 'scavenge':
    case 'scav':
      handler = (ix) => handleScavengeCommand(ix, message.author.id);
      commandName = 'scavenge';
      break;

    case 'quests':
    case 'quest':
      handler = (ix) => handleQuestsCommand(ix, message.author.id);
      commandName = 'quests';
      break;

    case 'store':
    case 'shop':
      handler = async (ix) => {
        await ix.deferReply();
        await handleStoreCommand(ix);
      };
      commandName = 'store';
      break;

    case 'leaderboard':
    case 'lb':
      handler = (ix) => handleLeaderboardCommand(ix);
      commandName = 'leaderboard';
      break;

    case 'mining-status':
    case 'mining':
    case 'event':
      handler = (ix) => handleMiningStatusCommand(ix);
      commandName = 'mining-status';
      break;

    case 'collection':
    case 'col':
      handler = (ix) => handleCollectionCommand(ix, message.author.id);
      commandName = 'collection';
      break;

    case 'bank':
      if ((args[0] || '').toLowerCase() === 'all') {
        handler = (ix) => handleBankAllCommand(ix, message.author.id);
        commandName = 'bank-all';
      } else if (args[0]) {
        const amount = parseInt(String(args[0]).replace(/[, $_]/g, ''), 10);
        if (isNaN(amount) || amount <= 0) {
          try { await message.reply('Usage: `bank <amount>` or `bank all`'); } catch (_) {}
          return true;
        }
        parsedArgs = [String(amount)];
        handler = (ix) => handleBankCommand(ix, message.author.id);
        commandName = 'bank';
      } else {
        try { await message.reply('Usage: `bank <amount>` or `bank all`'); } catch (_) {}
        return true;
      }
      break;

    case 'withdraw':
    case 'wd':
      if (args[0]) {
        const amount = parseInt(String(args[0]).replace(/[, $_]/g, ''), 10);
        if (isNaN(amount) || amount <= 0) {
          try { await message.reply('Usage: `withdraw <amount>`'); } catch (_) {}
          return true;
        }
        parsedArgs = [String(amount)];
        handler = (ix) => handleWithdrawCommand(ix, message.author.id);
        commandName = 'withdraw';
      } else {
        try { await message.reply('Usage: `withdraw <amount>`'); } catch (_) {}
        return true;
      }
      break;

    default:
      return false;
  }

  try {
    const userId = message.author.id;
    await getUser(userId);
    if (!userData[userId].commandCount) userData[userId].commandCount = 0;
    userData[userId].commandCount++;
    if (!userData[userId].joinedDate) userData[userId].joinedDate = Date.now();

    const adapter = new MessageInteractionAdapter(message, parsedArgs, commandName);
    await handler(adapter);
  } catch (err) {
    console.error(`Prefix command "${cmd}" failed:`, err);
    try {
      await message.reply('Something went wrong while running that command. Please try again.');
    } catch (_) {}
  }
  return true;
}


async function handleSetAnnouncementsCommand(interaction) {
  if (!isDeveloper(interaction.user.id) && !interaction.member?.permissions.has(PermissionFlagsBits.Administrator)) {
    return await interaction.reply({
      embeds: [new EmbedBuilder()
        .setTitle('Access Denied')
        .setDescription('You need **Administrator** permissions or must be a bot developer to use this command.')
        .setColor(0xFF6B6B)
        .setTimestamp()],
      ephemeral: true
    });
  }
  if (!interaction.guildId) {
    return await interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
  }

  const channel = interaction.options.getChannel('channel');

  if (!channel) {
    await setAnnouncementChannelId(interaction.guildId, null);
    return await interaction.reply({
      embeds: [new EmbedBuilder()
        .setTitle('Announcements Disabled')
        .setDescription('Market event announcements will no longer be posted in this server. Run `/setannouncements channel:#some-channel` to enable them again.')
        .setColor(0x95A5A6)
        .setTimestamp()],
      ephemeral: true
    });
  }

  try {
    const me = interaction.guild.members.me;
    const perms = channel.permissionsFor(me);
    if (!perms || !perms.has(PermissionFlagsBits.SendMessages) || !perms.has(PermissionFlagsBits.ViewChannel) || !perms.has(PermissionFlagsBits.EmbedLinks)) {
      return await interaction.reply({
        embeds: [new EmbedBuilder()
          .setTitle('Permission Problem')
          .setDescription(`I don't have permission to send embedded messages in <#${channel.id}>. Please give me **View Channel**, **Send Messages**, and **Embed Links** there, then try again.`)
          .setColor(0xFF6B6B)
          .setTimestamp()],
        ephemeral: true
      });
    }
  } catch (err) {
    console.error('Permission check failed:', err);
  }

  await setAnnouncementChannelId(interaction.guildId, channel.id);

  return await interaction.reply({
    embeds: [new EmbedBuilder()
      .setTitle('Announcements Enabled')
      .setDescription(`Market events (weekly crashes and bubbles) will now be posted in <#${channel.id}>.`)
      .addFields({ name: 'Disable', value: 'Run `/setannouncements` with no channel to turn this off.', inline: false })
      .setColor(0x2ECC71)
      .setTimestamp()],
    ephemeral: true
  });
}

async function handleMarketCommand(interaction) {
  try {
    const now = Date.now();
    const elapsed = now - (MARKET_CACHE.lastRefresh || now);
    const untilNext = Math.max(0, MARKET_REFRESH_INTERVAL - elapsed);

    const fmtDuration = (ms) => {
      const totalMin = Math.floor(ms / 60000);
      const h = Math.floor(totalMin / 60);
      const m = totalMin % 60;
      if (h > 0) return `${h}h ${m}m`;
      return `${m}m`;
    };

    const rows = [];
    for (const r of rarities) {
      for (const item of r.items) {
        const cur = MARKET_CACHE.multipliers[item] ?? 1.0;
        const prev = MARKET_CACHE.previousMultipliers[item] ?? cur;
        const changePct = prev > 0 ? ((cur - prev) / prev) * 100 : 0;
        rows.push({ name: item, rarity: r.name, mult: cur, changePct });
      }
    }

    const sortedByMult = [...rows].sort((a, b) => b.mult - a.mult);
    const gainers = sortedByMult.slice(0, 5);
    const losers = [...sortedByMult].reverse().slice(0, 5);
    const movers = [...rows]
      .filter(r => Math.abs(r.changePct) >= 0.01)
      .sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct))
      .slice(0, 5);

    const fmtRow = (r) => {
      const arrow = r.mult > 1.001 ? '▲' : (r.mult < 0.999 ? '▼' : '•');
      const pct = ((r.mult - 1) * 100).toFixed(1);
      const sign = r.mult >= 1 ? '+' : '';
      return `${arrow} **${r.name}** (${r.rarity}) — ${sign}${pct}% from base`;
    };

    const fmtMover = (r) => {
      const arrow = r.changePct > 0 ? '▲' : '▼';
      const sign = r.changePct > 0 ? '+' : '';
      return `${arrow} **${r.name}** (${r.rarity}) — ${sign}${r.changePct.toFixed(1)}% this refresh`;
    };

    const embed = new EmbedBuilder()
      .setTitle('Global Market')
      .setDescription(
        `Prices fluctuate every **6 hours**. Higher-rarity items swing harder.\n` +
        `Last refresh: ${MARKET_CACHE.lastRefresh ? `<t:${Math.floor(MARKET_CACHE.lastRefresh / 1000)}:R>` : 'never'}\n` +
        `Next refresh in: **${fmtDuration(untilNext)}**` +
        ((MARKET_CACHE.crashoutHistory && MARKET_CACHE.crashoutHistory.length)
          ? `\nLast weekly event: **${MARKET_CACHE.crashoutHistory[0].type === 'bubble' ? 'Bubble +15%' : 'Crash -10%'} on ${MARKET_CACHE.crashoutHistory[0].rarity}** <t:${Math.floor(MARKET_CACHE.crashoutHistory[0].timestamp / 1000)}:R>`
          : '')
      )
      .addFields(
        { name: 'Top Gainers (vs base)', value: gainers.map(fmtRow).join('\n') || 'No data', inline: false },
        { name: 'Top Losers (vs base)',  value: losers.map(fmtRow).join('\n')  || 'No data', inline: false },
        { name: 'Biggest Movers (last refresh)', value: movers.length ? movers.map(fmtMover).join('\n') : 'Quiet refresh — no major moves.', inline: false }
      )
      .setColor(0xF1C40F)
      .setFooter({ text: `Market refresh #${MARKET_CACHE.refreshCount}` })
      .setTimestamp();

    await interaction.reply({ embeds: [embed] });
  } catch (err) {
    console.error('❌ Market command error:', err);
    const errorEmbed = new EmbedBuilder()
      .setTitle('Market Error')
      .setDescription('Could not load the market right now. Please try again.')
      .setColor(0xFF6B6B)
      .setTimestamp();
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ embeds: [errorEmbed] });
    } else {
      await interaction.reply({ embeds: [errorEmbed] });
    }
  }
}

async function handleInfoCommand(interaction) {
  const guildPrefix = interaction.guildId ? await getGuildPrefix(interaction.guildId) : null;
  const prefixNote = guildPrefix
    ? `**Text-command prefix for this server:** \`${guildPrefix}\`\nMost common commands also work as e.g. \`${guildPrefix}inventory\`, \`${guildPrefix}labor\`, \`${guildPrefix}bank all\`.`
    : 'No text-command prefix set yet — admins can set one with `/setprefix`, then players can use commands like `!inventory` instead of slash.';

  const infoEmbed = new EmbedBuilder()
    .setTitle('Fortune Bot — Build Your Empire')
    .setDescription(
      '**Welcome to Fortune Bot!** Earn cash, scavenge for rare artefacts, time the market, ' +
      'complete sets for bonuses, trade with players, and climb the leaderboards.\n\n' + prefixNote
    )
    .setColor(0x2F3136)
    .addFields(
      {
        name: 'Earning & Inventory',
        value: [
          '`/scavenge` — Search for rare artefacts (cooldown applies)',
          '`/labor` — Work to earn cash (cooldown applies)',
          '`/inventory` — View your cash, bank balance, and artefact collection',
          '`/collection` — Browse your full field guide (now with a **Sets** page!)',
          '`/convert` — Convert XP into cash (1 XP = $2)'
        ].join('\n'),
        inline: false
      },
      {
        name: 'Banking',
        value: [
          '`/bank <amount>` — Deposit cash into your bank',
          '`/bank-all` — Deposit all your cash at once',
          '`/withdraw <amount>` — Withdraw cash from your bank',
          'Use `/store` then `/buy Bank Expansion Ticket` to grow your bank capacity (+25% per ticket).'
        ].join('\n'),
        inline: false
      },
      {
        name: 'Trading & Selling',
        value: [
          '`/mass-sell` — Queue and sell many artefacts at once. **Sell a complete set together to earn the Collector\'s Premium (+20%)**.',
          '`/trade <user>` — Start an interactive trade with another player',
          '`/store` — View global and server-specific items for sale',
          '`/buy <item>` — Purchase an item from the store'
        ].join('\n'),
        inline: false
      },
      {
        name: 'Player Interaction',
        value: [
          '`/steal <user> <amount>` — Steal cash on hand from a player (bank balances are protected)',
          '`/marble-game` — Multiplayer marble guessing game',
          '`/marble-duel <opponent>` — 1v1 marble duel for stakes',
          '`/leaderboard` — View server wealth rankings',
          '`/observe <player>` — View another player\'s inventory (with their permission)',
          '`/configure-observation` — Toggle whether others can observe you'
        ].join('\n'),
        inline: false
      },
      {
        name: 'The Market',
        value: [
          '`/market` — See current top gainers, top losers, biggest movers, and the next refresh countdown',
          'Artefact prices **fluctuate every 6 hours**. Higher rarities swing harder — 1-Star rarely moves, 5-Star can swing up to ±15% per refresh.',
          'Every price you see (in inventory, sell, collection, scavenge results) reflects the live market — buy low, sell high.'
        ].join('\n'),
        inline: false
      },
      {
        name: 'Artefact Sets & Collector\'s Premium',
        value: [
          'There are **8 curated sets** spanning multiple rarities (e.g. The Volcanic Set, The Royal Regalia Set, The Stellar Set).',
          'Selling a **complete set** in a single `/mass-sell` transaction grants a **+20% Collector\'s Premium** on those items\' value.',
          'Check your progress on the new **Sets** page (page 6) of `/collection`. Trade aggressively for that one missing piece — it\'s often worth overpaying.'
        ].join('\n'),
        inline: false
      },
      {
        name: 'Events',
        value: [
          '**Weekly Market Events:** Once a week a random star-rarity is hit by either a **Market Crash** (-10%) or a **Speculative Bubble** (+15%). Announced in your server\'s announcement channel if one is set.',
          '**Mining Crises:** Periodic 24-hour events where one artefact becomes unscavengeable while another doubles in find rate.',
          'Use `/mining-status` to check the current Mining Crisis.'
        ].join('\n'),
        inline: false
      },
      {
        name: 'Server Admins',
        value: [
          '`/setprefix` — Set the text-command prefix for this server',
          '`/setannouncements [channel]` — Choose where weekly market events get posted (omit to disable)',
          '`/add-item`, `/remove-item`, `/view-items` — Manage server-specific store items',
          '`/give-roles`, `/timeout`, `/kick`, `/ban` — Moderation tools'
        ].join('\n'),
        inline: false
      },
      {
        name: 'Artefact Rarity & Tier Scaling',
        value: [
          '**⭐ 1-Star** (65%) · **⭐⭐ 2-Star** (20%) · **⭐⭐⭐ 3-Star** (10%) · **⭐⭐⭐⭐ 4-Star** (4%) · **⭐⭐⭐⭐⭐ 5-Star** (1%)',
          'Each artefact has a tier (T1–T5) that scales its sell value: T1=65%  T2=75%  T3=100%  T4=125%  T5=135%.',
          'Shiny variants (✨) sell for 5× the base tier value — and they count toward set completion.'
        ].join('\n'),
        inline: false
      }
    )
    .setFooter({ text: 'Tip: Start with /scavenge to find your first artefact, then /market to see what\'s hot!' })
    .setTimestamp();

  await interaction.reply({ embeds: [infoEmbed] });
}

async function handleBankCommand(interaction, userId) {
  const amount = interaction.options.getInteger('amount');

  const currentBank = userData[userId].bankBalance || 0;
  const bankCapacity = await calculateBankCapacity(userId);
  const maxDeposit = bankCapacity - currentBank;

  if (amount > maxDeposit) {
    const expansions = userData[userId].bankExpansions || 0;
    const capacityEmbed = new EmbedBuilder()
      .setTitle('Bank Capacity Exceeded')
      .setDescription('Your deposit would exceed the maximum bank capacity.')
      .addFields(
        { name: 'Maximum Deposit Available', value: `$${maxDeposit.toLocaleString()}`, inline: true },
        { name: 'Current Bank Balance', value: `$${currentBank.toLocaleString()}`, inline: true },
        { name: 'Bank Capacity', value: `$${bankCapacity.toLocaleString()}`, inline: true },
        { name: 'Bank Usage', value: `${((currentBank / bankCapacity) * 100).toFixed(1)}%`, inline: true },
        { name: 'Expansions Purchased', value: `${expansions}`, inline: true },
        { name: 'Upgrade Available', value: 'Use `/store` to buy Bank Expansion Tickets', inline: true }
      )
      .setColor(0xFF9F43)
      .setTimestamp();

    return await interaction.reply({ embeds: [capacityEmbed] });
  }

  if (userData[userId].cash < amount) {
    const insufficientEmbed = new EmbedBuilder()
      .setTitle('Insufficient Cash')
      .setDescription('You do not have enough cash on hand for this deposit.')
      .addFields(
        { name: 'Available Cash', value: `$${userData[userId].cash.toLocaleString()}`, inline: true },
        { name: 'Attempted Deposit', value: `$${amount.toLocaleString()}`, inline: true },
        { name: 'Shortfall', value: `$${(amount - userData[userId].cash).toLocaleString()}`, inline: true }
      )
      .setColor(0xFF6B6B)
      .setTimestamp();

    return await interaction.reply({ embeds: [insufficientEmbed] });
  }

  userData[userId].cash -= amount;
  userData[userId].bankBalance = currentBank + amount;
  await saveUserData();
  await updateQuestProgress(userId, interaction.guildId, 'bankDeposit', 1);

  const finalCapacity = await calculateBankCapacity(userId);
  const expansions = userData[userId].bankExpansions || 0;
  const successEmbed = new EmbedBuilder()
    .setTitle('Bank Deposit Completed')
    .setDescription(`Successfully deposited $${amount.toLocaleString()} into your secure bank account.`)
    .addFields(
      { name: 'Transaction Amount', value: `$${amount.toLocaleString()}`, inline: true },
      { name: 'Remaining Cash', value: `$${userData[userId].cash.toLocaleString()}`, inline: true },
      { name: 'New Bank Balance', value: `$${userData[userId].bankBalance.toLocaleString()}`, inline: true },
      { name: 'Bank Capacity Used', value: `${((userData[userId].bankBalance / finalCapacity) * 100).toFixed(1)}%`, inline: true },
      { name: 'Available Space', value: `$${(finalCapacity - userData[userId].bankBalance).toLocaleString()}`, inline: true },
      { name: 'Expansions Owned', value: `${expansions}`, inline: true }
    )
    .setColor(0x00FF7F)
    .setFooter({ text: 'Your banked money is safe from theft attempts' })
    .setTimestamp();

  await interaction.reply({ embeds: [successEmbed] });
}

async function handleBankAllCommand(interaction, userId) {
  const cash = userData[userId].cash || 0;

  if (cash <= 0) {
    const noFundsEmbed = new EmbedBuilder()
      .setTitle('No Cash to Deposit')
      .setDescription('You have no cash on hand to deposit.')
      .addFields(
        { name: 'Cash on Hand', value: `$0`, inline: true },
        { name: 'Bank Balance', value: `$${(userData[userId].bankBalance || 0).toLocaleString()}`, inline: true }
      )
      .setColor(0xFF6B6B)
      .setTimestamp();

    return await interaction.reply({ embeds: [noFundsEmbed] });
  }

  const currentBank = userData[userId].bankBalance || 0;
  const bankCapacity = await calculateBankCapacity(userId);
  const availableSpace = bankCapacity - currentBank;

  if (availableSpace <= 0) {
    const fullEmbed = new EmbedBuilder()
      .setTitle('Bank Full')
      .setDescription('Your bank is at capacity. Purchase a Bank Expansion Ticket from `/store` to make room.')
      .addFields(
        { name: 'Cash on Hand', value: `$${cash.toLocaleString()}`, inline: true },
        { name: 'Bank Balance', value: `$${currentBank.toLocaleString()}`, inline: true },
        { name: 'Bank Capacity', value: `$${bankCapacity.toLocaleString()}`, inline: true }
      )
      .setColor(0xFF9F43)
      .setTimestamp();

    return await interaction.reply({ embeds: [fullEmbed] });
  }

  const amount = Math.min(cash, availableSpace);
  const partialDeposit = amount < cash;

  userData[userId].cash -= amount;
  userData[userId].bankBalance = currentBank + amount;
  await saveUserData();

  const expansions = userData[userId].bankExpansions || 0;
  const newBank = userData[userId].bankBalance;
  const successEmbed = new EmbedBuilder()
    .setTitle('Bank Deposit Completed')
    .setDescription(
      partialDeposit
        ? `Your bank could only hold $${amount.toLocaleString()} of your cash. The remainder stays on hand.`
        : `All $${amount.toLocaleString()} of your cash has been deposited.`
    )
    .addFields(
      { name: 'Deposited', value: `$${amount.toLocaleString()}`, inline: true },
      { name: 'Remaining Cash', value: `$${userData[userId].cash.toLocaleString()}`, inline: true },
      { name: 'New Bank Balance', value: `$${newBank.toLocaleString()}`, inline: true },
      { name: 'Bank Capacity Used', value: `${((newBank / bankCapacity) * 100).toFixed(1)}%`, inline: true },
      { name: 'Available Space', value: `$${(bankCapacity - newBank).toLocaleString()}`, inline: true },
      { name: 'Expansions Owned', value: `${expansions}`, inline: true }
    )
    .setColor(0x00FF7F)
    .setFooter({ text: 'Your banked money is safe from theft attempts' })
    .setTimestamp();

  await interaction.reply({ embeds: [successEmbed] });
}

async function handleWithdrawCommand(interaction, userId) {
  const amount = interaction.options.getInteger('amount');
  const currentBank = userData[userId].bankBalance || 0;

  if (amount > currentBank) {
    const insufficientEmbed = new EmbedBuilder()
      .setTitle('Insufficient Bank Funds')
      .setDescription('You do not have enough money in your bank account for this withdrawal.')
      .addFields(
        { name: 'Available Bank Funds', value: `$${currentBank.toLocaleString()}`, inline: true },
        { name: 'Attempted Withdrawal', value: `$${amount.toLocaleString()}`, inline: true },
        { name: 'Shortfall', value: `$${(amount - currentBank).toLocaleString()}`, inline: true }
      )
      .setColor(0xFF6B6B)
      .setTimestamp();

    return await interaction.reply({ embeds: [insufficientEmbed] });
  }

  userData[userId].bankBalance = currentBank - amount;
  userData[userId].cash += amount;
  await saveUserData();

  const finalCapacity = await calculateBankCapacity(userId);
  const expansions = userData[userId].bankExpansions || 0;
  const successEmbed = new EmbedBuilder()
    .setTitle('Bank Withdrawal Completed')
    .setDescription(`Successfully withdrew $${amount.toLocaleString()} from your bank account.`)
    .addFields(
      { name: 'Transaction Amount', value: `$${amount.toLocaleString()}`, inline: true },
      { name: 'New Cash Balance', value: `$${userData[userId].cash.toLocaleString()}`, inline: true },
      { name: 'Remaining Bank Funds', value: `$${userData[userId].bankBalance.toLocaleString()}`, inline: true },
      { name: 'Bank Capacity Used', value: `${((userData[userId].bankBalance / finalCapacity) * 100).toFixed(1)}%`, inline: true },
      { name: 'Available Space', value: `$${(finalCapacity - userData[userId].bankBalance).toLocaleString()}`, inline: true },
      { name: 'Expansions Owned', value: `${expansions}`, inline: true }
    )
    .setColor(0x339AF0)
    .setFooter({ text: 'Warning: Cash on hand can be stolen by other players' })
    .setTimestamp();

  await interaction.reply({ embeds: [successEmbed] });
}

async function handleStealCommand(interaction, userId) {
  const STEAL_COOLDOWN = 30 * 60 * 1000; // 30 minutes
  const now = Date.now();

  if (cooldowns.steal[userId] && (now - cooldowns.steal[userId]) < STEAL_COOLDOWN) {
    const timeLeft = STEAL_COOLDOWN - (now - cooldowns.steal[userId]);
    const minutes = Math.floor(timeLeft / (60 * 1000));
    const seconds = Math.floor((timeLeft % (60 * 1000)) / 1000);

    const cooldownEmbed = new EmbedBuilder()
      .setTitle('Steal Cooldown Active')
      .setDescription('You must wait before attempting another theft.')
      .addFields(
        { name: 'Time Remaining', value: `${minutes}m ${seconds}s`, inline: true },
        { name: 'Cooldown Duration', value: '30 minutes', inline: true }
      )
      .setColor(0xFF9F43)
      .setTimestamp();

    return await interaction.reply({ embeds: [cooldownEmbed] });
  }

  const target = interaction.options.getUser('target');
  const amount = interaction.options.getInteger('amount');

  if (target.id === userId) {
    const selfEmbed = new EmbedBuilder()
      .setTitle('Invalid Target')
      .setDescription('You cannot steal from yourself.')
      .setColor(0xFF6B6B)
      .setTimestamp();

    return await interaction.reply({ embeds: [selfEmbed] });
  }

  const targetId = target.id;
  if (!userData[targetId]) userData[targetId] = { cash: 0, artefacts: [], bankBalance: 0 };

  const availableCash = userData[targetId].cash;

  if (amount > availableCash) {
    const unavailableEmbed = new EmbedBuilder()
      .setTitle('Insufficient Target Funds')
      .setDescription(`${target.username} does not have enough cash available for this theft attempt.`)
      .addFields(
        { name: 'Target Available Cash', value: `$${availableCash.toLocaleString()}`, inline: true },
        { name: 'Attempted Theft', value: `$${amount.toLocaleString()}`, inline: true },
        { name: 'Protected Funds', value: 'Bank money cannot be stolen', inline: false }
      )
      .setColor(0xFF9F43)
      .setTimestamp();

    return await interaction.reply({ embeds: [unavailableEmbed] });
  }

  let successRate = Math.max(10, 80 - (amount / 20));
  successRate = Math.min(80, successRate);

  const randomRoll = Math.random() * 100;
  const isSuccess = randomRoll <= successRate;

  if (isSuccess) {
    userData[targetId].cash -= amount;
    userData[userId].cash += amount;
    cooldowns.steal[userId] = now;
    await saveUserData();
    await saveCooldowns();
    await updateQuestProgress(userId, interaction.guildId, 'stealSuccess', 1);

    const successEmbed = new EmbedBuilder()
      .setTitle('Theft Successful')
      .setDescription(`You successfully stole $${amount.toLocaleString()} from ${target.username}.`)
      .addFields(
        { name: 'Stolen Amount', value: `$${amount.toLocaleString()}`, inline: true },
        { name: 'Success Probability', value: `${successRate.toFixed(1)}%`, inline: true },
        { name: 'Your Roll', value: `${randomRoll.toFixed(1)}%`, inline: true },
        { name: 'Your New Cash Total', value: `$${userData[userId].cash.toLocaleString()}`, inline: true },
        { name: 'Risk vs Reward', value: 'Higher amounts = Lower success rate', inline: false }
      )
      .setColor(0x51CF66)
      .setFooter({ text: 'The victim has been notified of this theft' })
      .setTimestamp();

    await interaction.reply({ embeds: [successEmbed] });

    const victimEmbed = new EmbedBuilder()
      .setTitle('Theft Alert')
      .setDescription(`${interaction.user.username} has stolen $${amount.toLocaleString()} from your cash reserves.`)
      .addFields(
        { name: 'Amount Stolen', value: `$${amount.toLocaleString()}`, inline: true },
        { name: 'Remaining Cash', value: `$${userData[targetId].cash.toLocaleString()}`, inline: true },
        { name: 'Bank Balance', value: `$${userData[targetId].bankBalance || 0}`, inline: true },
        { name: 'Protection Tip', value: 'Keep funds in your bank account to prevent future thefts', inline: false }
      )
      .setColor(0xFF6B6B)
      .setTimestamp();

    try {
      await target.send({ embeds: [victimEmbed] });
    } catch (error) {
    }

  } else {
    cooldowns.steal[userId] = now;
    await saveCooldowns();

    const failureEmbed = new EmbedBuilder()
      .setTitle('Theft Failed')
      .setDescription(`Your theft attempt on ${target.username} was unsuccessful.`)
      .addFields(
        { name: 'Attempted Amount', value: `$${amount.toLocaleString()}`, inline: true },
        { name: 'Success Probability', value: `${successRate.toFixed(1)}%`, inline: true },
        { name: 'Your Roll', value: `${randomRoll.toFixed(1)}%`, inline: true },
        { name: 'Outcome', value: 'Mission Failed', inline: true },
        { name: 'Strategy Tip', value: 'Smaller amounts have higher success rates', inline: false }
      )
      .setColor(0xFF6B6B)
      .setTimestamp();

    await interaction.reply({ embeds: [failureEmbed] });
  }
}

async function handleScavengeCommand(interaction, userId) {
  await interaction.deferReply();
  const now = Date.now();
  const SCAVENGE_COOLDOWN = 2 * 60 * 60 * 1000; // 2 hours

  if (cooldowns.scavenge[userId] && (now - cooldowns.scavenge[userId]) < SCAVENGE_COOLDOWN) {
    const timeLeft = SCAVENGE_COOLDOWN - (now - cooldowns.scavenge[userId]);
    const hours = Math.floor(timeLeft / (60 * 60 * 1000));
    const minutes = Math.floor((timeLeft % (60 * 60 * 1000)) / (60 * 1000));

    const cooldownEmbed = new EmbedBuilder()
      .setTitle('Scavenge Cooldown Active')
      .setDescription('You must wait before scavenging again.')
      .addFields(
        { name: 'Time Remaining', value: `${hours}h ${minutes}m`, inline: true },
        { name: 'Cooldown Duration', value: '2 hours', inline: true }
      )
      .setColor(0xFF9F43)
      .setTimestamp();

    return await interaction.editReply({ embeds: [cooldownEmbed] });
  }

  await checkAndHandleEvents();

  const currentRarities = await getModifiedArtefactChances();
  const totalChance = currentRarities.reduce((sum, rarity) => sum + rarity.chance, 0);

  const random = Math.random() * totalChance;
  let selectedRarity = null;
  let cumulative = 0;

  for (const rarity of currentRarities) {
    cumulative += rarity.chance;
    if (random <= cumulative) {
      selectedRarity = rarity;
      break;
    }
  }

  if (!selectedRarity || selectedRarity.items.length === 0) {
    selectedRarity = rarities[0];
  }

  const artefact = selectedRarity.items[Math.floor(Math.random() * selectedRarity.items.length)];

  const isShiny = Math.random() < 0.005;
  const finalArtefactName = isShiny ? `✨ SHINY ${artefact} ✨` : artefact;

  userData[userId].artefacts.push(finalArtefactName);
  if (!userData[userId].discoveredArtefacts) userData[userId].discoveredArtefacts = [];
  if (!userData[userId].discoveredArtefacts.includes(artefact)) {
    userData[userId].discoveredArtefacts.push(artefact);
  }
  cooldowns.scavenge[userId] = now;

  await saveUserData();
  await saveCooldowns();

  await updateQuestProgress(userId, interaction.guildId, 'scavenge', 1);
  if (['3-Star', '4-Star', '5-Star'].includes(selectedRarity.name)) {
    await updateQuestProgress(userId, interaction.guildId, 'find3StarPlus', 1);
  }
  if (isShiny) {
    await updateQuestProgress(userId, interaction.guildId, 'findShiny', 1);
  }

  const eventData = await getEventSystem();
  const event = eventData ? eventData.currentEvent : null;
  let eventText = '';
  let scavengeColor = isShiny ? 0xFFFFFF : selectedRarity.color;

  if (isShiny) {
    eventText = '✨ **AMAZING LUCK!** You discovered a super rare shiny version! ✨';
  } else if (event && artefact === event.positiveArtefact) {
    eventText = `⚡ **EVENT BONUS:** Found in the expanded ${event.positiveArtefact} mine!`;
    scavengeColor = 0xFFD700; // Gold color for event bonus
  }

  const scavengeEmbed = new EmbedBuilder()
    .setTitle(isShiny ? '✨ SHINY ARTEFACT DISCOVERED! ✨' : (event && artefact === event.positiveArtefact ? '🌟 Enhanced Scavenge Complete!' : 'Scavenge Complete'))
    .setDescription(isShiny ? 
      `Holy cow! You found a **SHINY ${artefact}**! This is incredibly rare and worth 20 times more!` :
      (event && artefact === event.positiveArtefact ? 
      'You discovered a valuable artefact in the expanded mine sector!' : 
      'You discovered a valuable artefact during your search!'))
    .addFields(
      { name: 'Artefact Found', value: `${finalArtefactName}`, inline: true },
      { name: 'Rarity', value: `${getRarityEmoji(selectedRarity.name)} ${selectedRarity.name}`, inline: true },
      { name: 'Tier', value: `T${getArtefactTier(artefact)}`, inline: true },
      { name: 'Estimated Value', value: `$${(isShiny ? calcArtefactSellValue(finalArtefactName, selectedRarity) * 5 : calcArtefactSellValue(finalArtefactName, selectedRarity)).toLocaleString()}`, inline: true },
      { name: 'Next Scavenge', value: 'Available in 2 hours', inline: false }
    )
    .setColor(scavengeColor)
    .setTimestamp();

  if (eventText) {
    scavengeEmbed.addFields({ name: 'Mining Event', value: eventText, inline: false });
  }

  await interaction.editReply({ embeds: [scavengeEmbed] });

  if (Math.random() < 0.20) {
    const inviteEmbed = new EmbedBuilder()
      .setTitle('✨ Join the Fortune Bot Community! ✨')
      .setDescription('We really appreciate your support! It would be even better if you joined our official server. Come hang out, get updates, and meet other players!')
      .setColor(0x5865F2)
      .setFooter({ text: 'Thank you for playing Fortune Bot!' })
      .setThumbnail(client.user.displayAvatarURL())
      .setTimestamp();

    await interaction.followUp({ content: 'https://discord.gg/NZtnJbj4QA', embeds: [inviteEmbed], ephemeral: false });
  }
}

async function handleLaborCommand(interaction, userId) {
  await interaction.deferReply();
  const now = Date.now();
  const LABOR_COOLDOWN = 40 * 60 * 1000; // 40 minutes

  if (cooldowns.labor[userId] && (now - cooldowns.labor[userId]) < LABOR_COOLDOWN) {
    const timeLeft = LABOR_COOLDOWN - (now - cooldowns.labor[userId]);
    const minutes = Math.floor(timeLeft / (60 * 1000));

    const cooldownEmbed = new EmbedBuilder()
      .setTitle('Labor Cooldown Active')
      .setDescription('You must rest before working again.')
      .addFields(
        { name: 'Time Remaining', value: `${minutes} minutes`, inline: true },
        { name: 'Cooldown Duration', value: '40 minutes', inline: true }
      )
      .setColor(0xFF9F43)
      .setTimestamp();

    return await interaction.editReply({ embeds: [cooldownEmbed] });
  }

  const earnings = Math.floor(Math.random() * 500) + 100; // $100-600
  userData[userId].cash += earnings;
  cooldowns.labor[userId] = now;

  await saveUserData();
  await updateQuestProgress(userId, interaction.guildId, 'labor', 1);
  await saveCooldowns();

  const laborEmbed = new EmbedBuilder()
    .setTitle('Work Complete')
    .setDescription('You completed a day of honest work.')
    .addFields(
      { name: 'Earnings', value: `$${earnings.toLocaleString()}`, inline: true },
      { name: 'New Cash Total', value: `$${userData[userId].cash.toLocaleString()}`, inline: true },
      { name: 'Next Work', value: 'Available in 40 minutes', inline: false }
    )
    .setColor(0x51CF66)
    .setTimestamp();

  await interaction.editReply({ embeds: [laborEmbed] });

  if (Math.random() < 0.20) {
    const inviteEmbed = new EmbedBuilder()
      .setTitle('✨ Join the Fortune Bot Community! ✨')
      .setDescription('We really appreciate your support! It would be even better if you joined our official server. Come hang out, get updates, and meet other players!')
      .setColor(0x5865F2)
      .setFooter({ text: 'Thank you for playing Fortune Bot!' })
      .setThumbnail(client.user.displayAvatarURL())
      .setTimestamp();

    await interaction.followUp({ content: 'https://discord.gg/NZtnJbj4QA', embeds: [inviteEmbed], ephemeral: false });
  }
}


const INVENTORY_PAGE_SIZE = 12;

function getRarityEmoji(rarityName) {
  switch (rarityName) {
    case '1-Star': return '⭐';
    case '2-Star': return '⭐⭐';
    case '3-Star': return '⭐⭐⭐';
    case '4-Star': return '⭐⭐⭐⭐';
    case '5-Star': return '⭐⭐⭐⭐⭐';
    default:       return '❓';
  }
}

function getArtefactRarityRank(name) {
  if (name.startsWith('✨ SHINY ') && name.endsWith(' ✨')) return 0;
  const rarity = getRarityByArtefact(name);
  if (!rarity) return 5;
  switch (rarity.name) {
    case '4-Star': return 1;
    case '3-Star': return 2;
    case '2-Star': return 3;
    case '1-Star': return 4;
    default:       return 5;
  }
}

function buildInventoryPayload(user, userXpData, bankCapacity, page) {
  const isShinyName = n => n.startsWith('✨ SHINY ') && n.endsWith(' ✨');

  const counts = {};
  for (const name of user.artefacts) counts[name] = (counts[name] || 0) + 1;

  const uniqueNames = Object.keys(counts).sort((a, b) => {
    const diff = getArtefactRarityRank(a) - getArtefactRarityRank(b);
    return diff !== 0 ? diff : a.localeCompare(b);
  });

  const totalPages = Math.max(1, Math.ceil(uniqueNames.length / INVENTORY_PAGE_SIZE));
  const safePage = Math.max(0, Math.min(page, totalPages - 1));
  const pageNames = uniqueNames.slice(safePage * INVENTORY_PAGE_SIZE, (safePage + 1) * INVENTORY_PAGE_SIZE);

  const lines = [];
  let lastRank = null;
  for (const name of pageNames) {
    const rank = getArtefactRarityRank(name);
    if (lastRank !== null && rank !== lastRank) lines.push('\u200b');
    lastRank = rank;
    const count = counts[name];
    const rarity = getRarityByArtefact(name);
    const sell = calcArtefactSellValue(name, rarity);
    const value = isShinyName(name) ? sell * 5 : sell;
    const emoji = `${getRarityEmoji(rarity ? rarity.name : '')} `;
    lines.push(`**${count}x** ${emoji}${name} (~$${value.toLocaleString()})`);
  }

  const artefactText = lines.length > 0
    ? lines.join('\n')
    : (user.artefacts.length === 0 ? '*No artefacts yet — go scavenge!*' : '\u200b');

  const totalValue = user.artefacts.reduce((sum, name) => {
    const rarity = getRarityByArtefact(name);
    const sell = calcArtefactSellValue(name, rarity);
    return sum + (isShinyName(name) ? sell * 5 : sell);
  }, 0);

  const itemsCount = {};
  (user.items || []).forEach(item => { itemsCount[item] = (itemsCount[item] || 0) + 1; });
  const itemsList = (Object.entries(itemsCount)
    .map(([name, count]) => `${name}${count > 1 ? ` ×${count}` : ''}`)
    .join(', ') || 'No items').substring(0, 1024);

  const collectionHeader = uniqueNames.length > 0
    ? `Artefacts — Page ${safePage + 1} of ${totalPages}`
    : 'Artefact Collection';

  const embed = new EmbedBuilder()
    .setTitle('📦 Inventory')
    .setDescription('Your financial status and artefact collection.')
    .addFields(
      { name: 'Cash on Hand',      value: `$${user.cash.toLocaleString()}`,                        inline: true },
      { name: 'Bank Balance',      value: `$${(user.bankBalance || 0).toLocaleString()}`,            inline: true },
      { name: 'Total Wealth',      value: `$${(user.cash + (user.bankBalance || 0)).toLocaleString()}`, inline: true },
      { name: 'Experience Points', value: `${userXpData.xp.toLocaleString()} XP`,                  inline: true },
      { name: 'XP Cash Value',     value: `$${(userXpData.xp * 2).toLocaleString()}`,               inline: true },
      { name: 'Messages Sent',     value: userXpData.messageCount.toLocaleString(),                 inline: true },
      { name: 'Artefacts Owned',   value: user.artefacts.length.toString(),                         inline: true },
      { name: 'Collection Value',  value: `$${totalValue.toLocaleString()}`,                        inline: true },
      { name: 'Bank Capacity',     value: `${(((user.bankBalance || 0) / bankCapacity) * 100).toFixed(1)}%`, inline: true },
      { name: collectionHeader,    value: artefactText || '\u200b',                                 inline: false },
      { name: 'Purchased Items',   value: itemsList,                                                inline: false }
    )
    .setColor(0x339AF0)
    .setFooter({ text: `⭐ 1-Star  ⭐⭐ 2-Star  ⭐⭐⭐ 3-Star  ⭐⭐⭐⭐ 4-Star  ⭐⭐⭐⭐⭐ 5-Star  ✨ Shiny  •  /convert: 1 XP = $2` })
    .setTimestamp();

  const components = totalPages > 1 ? [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`inv_prev_${user._id}_${safePage}`)
        .setLabel('◀ Prev')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(safePage === 0),
      new ButtonBuilder()
        .setCustomId(`inv_page_info_${safePage}`)
        .setLabel(`Page ${safePage + 1} / ${totalPages}`)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true),
      new ButtonBuilder()
        .setCustomId(`inv_next_${user._id}_${safePage}`)
        .setLabel('Next ▶')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(safePage >= totalPages - 1)
    )
  ] : [];

  return { embed, components, safePage, totalPages };
}

async function handleInventoryCommand(interaction, userId) {
  await interaction.deferReply();
  const [user, userXpData, bankCapacity] = await Promise.all([
    getUser(userId),
    getXpData(userId),
    calculateBankCapacity(userId)
  ]);

  const { embed, components } = buildInventoryPayload(user, userXpData, bankCapacity, 0);
  await interaction.editReply({ embeds: [embed], components });
}


async function handleTradeCommand(interaction, userId) {
  const targetUser = interaction.options.getUser('user');

  if (targetUser.id === userId) {
    const selfEmbed = new EmbedBuilder()
      .setTitle('Invalid Trade Target')
      .setDescription('You cannot trade with yourself.')
      .setColor(0xFF6B6B)
      .setTimestamp();

    return await interaction.reply({ embeds: [selfEmbed] });
  }

  if (targetUser.bot) {
    const botEmbed = new EmbedBuilder()
      .setTitle('Invalid Trade Target')
      .setDescription('You cannot trade with bots.')
      .setColor(0xFF6B6B)
      .setTimestamp();

    return await interaction.reply({ embeds: [botEmbed] });
  }

  const existingTrade = Object.values(global.activeTrades).find(trade => 
    trade.initiator === userId || trade.recipient === targetUser.id ||
    trade.initiator === targetUser.id || trade.recipient === userId
  );

  if (existingTrade) {
    const busyEmbed = new EmbedBuilder()
      .setTitle('Trade Already Active')
      .setDescription('You or the target user is already in an active trade.')
      .setColor(0xFF9F43)
      .setTimestamp();

    return await interaction.reply({ embeds: [busyEmbed] });
  }

  if (!userData[targetUser.id]) userData[targetUser.id] = { cash: 0, artefacts: [], bankBalance: 0 };

  const acceptButton = new ButtonBuilder()
    .setCustomId(`trade_accept_${userId}_${targetUser.id}`)
    .setLabel('Accept Trade')
    .setStyle(ButtonStyle.Success);

  const declineButton = new ButtonBuilder()
    .setCustomId(`trade_decline_${userId}_${targetUser.id}`)
    .setLabel('Decline Trade')
    .setStyle(ButtonStyle.Danger);

  const row = new ActionRowBuilder().addComponents(acceptButton, declineButton);

  const tradeRequestEmbed = new EmbedBuilder()
    .setTitle('Trade Request')
    .setDescription(`**${interaction.user.displayName}** wants to trade with you.`)
    .addFields(
      { name: 'Initiator', value: `<@${userId}>`, inline: true },
      { name: 'Recipient', value: `<@${targetUser.id}>`, inline: true },
      { name: 'Status', value: 'Waiting for response...', inline: false },
      { name: 'Action Required', value: 'Choose **Accept** or **Decline** below.', inline: false }
    )
    .setColor(0x5865F2)
    .setFooter({ text: 'This request will expire after 2 minutes' })
    .setTimestamp();

  const requestMsg = await interaction.reply({
    content: `<@${targetUser.id}>`,
    embeds: [tradeRequestEmbed],
    components: [row],
    fetchReply: true
  });

  setTimeout(async () => {
    const tradeId = `${userId}-${targetUser.id}`;
    if (global.activeTrades[tradeId]) return;
    try {
      const expiredEmbed = EmbedBuilder.from(tradeRequestEmbed)
        .setColor(0x95A5A6)
        .spliceFields(2, 1, { name: 'Status', value: 'Expired (no response).', inline: false })
        .spliceFields(3, 1, { name: 'Action Required', value: 'Run `/trade` again to start a new request.', inline: false });
      await requestMsg.edit({ embeds: [expiredEmbed], components: [] });
    } catch (e) {
    }
  }, 120000); // 2 minutes
}

async function handleLeaderboardCommand(interaction) {
  const allDocs = await usersCollection.find({}, { projection: { cash: 1, bankBalance: 1 } }).toArray();

  const entries = allDocs.map(doc => {
    const live = userData[doc._id];
    const cash = live !== undefined ? live.cash : (doc.cash || 0);
    const bank = live !== undefined ? (live.bankBalance || 0) : (doc.bankBalance || 0);
    return { id: doc._id, total: cash + bank };
  });

  entries.sort((a, b) => b.total - a.total);
  const top10 = entries.filter(e => e.total > 0).slice(0, 10);

  if (!top10.length) {
    const emptyEmbed = new EmbedBuilder()
      .setTitle('Leaderboard')
      .setDescription('No players have earned money yet.')
      .setColor(0x339AF0)
      .setTimestamp();

    return await interaction.reply({ embeds: [emptyEmbed] });
  }

  const medals = ['1st', '2nd', '3rd'];
  const leaderboardEmbed = new EmbedBuilder()
    .setTitle('Top Fortune Holders')
    .setDescription(top10.map((entry, i) => {
      const place = medals[i] || `${i + 1}th`;
      return `**${place}** <@${entry.id}> — $${entry.total.toLocaleString()}`;
    }).join('\n'))
    .setColor(0xFFD700)
    .setFooter({ text: 'Rankings based on total wealth (cash + bank balance)' })
    .setTimestamp();

  await interaction.reply({ embeds: [leaderboardEmbed] });
}

function buildStoreNavRow(activeTab, raidActive = false) {
  const btns = [
    new ButtonBuilder()
      .setCustomId('store_tab_economy')
      .setLabel('Economy')
      .setStyle(activeTab === 'economy' ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('store_tab_minigame')
      .setLabel('Minigame Supplies')
      .setStyle(activeTab === 'minigame' ? ButtonStyle.Primary : ButtonStyle.Secondary)
  ];
  if (raidActive) {
    btns.push(new ButtonBuilder()
      .setCustomId('store_tab_raid_open')
      .setLabel('[ RAID SEASON ]')
      .setStyle(activeTab === 'raid' ? ButtonStyle.Danger : ButtonStyle.Secondary));
  }
  return new ActionRowBuilder().addComponents(...btns);
}

async function buildStorePayload(tab, userId, guildId, globalItems, guildItems, raidSeason = null, raidSubTab = 'military', raidPage = 0) {
  const raidActive = !!(raidSeason && raidSeason.active);
  const navRow = buildStoreNavRow(tab, raidActive);
  const embeds = [];

  if (tab === 'economy') {
    const economyItems = Object.entries(globalItems).filter(([, item]) => item.type === 'bank_expansion');

    const itemBlocks = [];
    for (const [name, item] of economyItems) {
      const [currentPrice, currentCapacity] = await Promise.all([
        calculateExpansionPrice(userId),
        calculateBankCapacity(userId)
      ]);
      const currentExpansions = userData[userId]?.bankExpansions || 0;
      const nextCapacity = Math.floor(50000 * Math.pow(1.25, currentExpansions + 1));
      itemBlocks.push(
        `**${name}**\n` +
        `Price: $${currentPrice.toLocaleString()}\n` +
        `${item.description}\n` +
        `Your Bank: $${currentCapacity.toLocaleString()} (${currentExpansions} expansion${currentExpansions !== 1 ? 's' : ''})\n` +
        `Next Tier: $${nextCapacity.toLocaleString()} capacity`
      );
    }

    const serverBlocks = Object.entries(guildItems).map(([name, data]) =>
      `**${name}**\nPrice: $${data.price.toLocaleString()}\n${data.description || 'No description'}`
    );

    const allBlocks = [...itemBlocks, ...serverBlocks];
    const chunks = chunkTextBlocks(allBlocks);

    const fields = chunks.length > 0
      ? chunks.map((chunk, i) => ({ name: i === 0 ? 'Available Items' : '\u200b', value: chunk, inline: false }))
      : [{ name: 'Available Items', value: 'No economy items are currently available.', inline: false }];

    const serverNote = Object.keys(guildItems).length === 0
      ? '\n\nThis server has no custom items yet. Admins can add them with `/add-item`.'
      : '';

    embeds.push(
      new EmbedBuilder()
        .setTitle('Store — Economy')
        .setDescription(`**Bank expansions & server-specific items**${serverNote}`)
        .addFields(...fields, { name: 'How to Buy', value: 'Use `/buy <item name>` to purchase any item here.', inline: false })
        .setColor(0xFFD700)
        .setFooter({ text: 'Economy tab • Switch tabs using the buttons below' })
        .setTimestamp()
    );

  } else if (tab === 'raid' && raidActive) {
    const { embeds: raidEmbeds, additionalComponents } = await buildRaidStoreSection(raidSubTab, raidPage, userId);
    return { embeds: raidEmbeds, components: [navRow, ...additionalComponents] };

  } else {
    const baitBlocks = Object.values(BAIT_CATALOG).map(bait => {
      const userItems = userData[userId]?.items || [];
      const owned = userItems.filter(i => i === bait.name).length;
      const tierLabel = ['', 'Basic', 'Standard', 'Premium', 'Elite'][bait.tier] || 'Unknown';
      return (
        `${bait.emoji} **${bait.name}** — $${bait.basePrice.toLocaleString()} *(${tierLabel})*\n` +
        `${bait.description}\n` +
        `You own: **${owned}**`
      );
    });

    const chunks = chunkTextBlocks(baitBlocks);
    const fields = chunks.map((chunk, i) => ({ name: i === 0 ? 'Fishing Bait' : '\u200b', value: chunk, inline: false }));

    embeds.push(
      new EmbedBuilder()
        .setTitle('Store — Minigame Supplies')
        .setDescription('**Bait for `/fish`** — better bait means rarer catches and bigger rewards.')
        .addFields(
          ...fields,
          { name: 'Bait Odds (worst → best)', value: '🪱 Earthworm → 🦗 Cricket → 🎣 Salted Lure → 🪝 Gilded Hook', inline: false },
          { name: 'How to Buy', value: 'Use `/buy <bait name>` — you can stack as many as you like.', inline: false }
        )
        .setColor(0x0099FF)
        .setFooter({ text: 'Minigame Supplies tab • Use /fish once you have bait' })
        .setTimestamp()
    );
  }

  return { embeds, components: [navRow] };
}

function chunkTextBlocks(blocks) {
  const chunks = [];
  let current = '';
  for (const block of blocks) {
    const safe = block.length > 1024 ? block.slice(0, 1021) + '...' : block;
    const addition = current ? '\n\n' + safe : safe;
    if (current.length + addition.length > 1024) {
      chunks.push(current);
      current = safe;
    } else {
      current += addition;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

async function handleStoreCommand(interaction) {
  const guildId = interaction.guildId;
  if (!guildId) {
    return await interaction.editReply({ embeds: [
      new EmbedBuilder().setTitle('Server Required').setDescription('This command requires a server context.').setColor(0xFF6B6B)
    ]});
  }

  try {
    const userId = interaction.user.id;
    const [, globalItems, guildItemsDoc, raidSeason] = await Promise.all([
      getUser(userId),
      getGlobalItems(),
      guildItemsCollection.findOne({ _id: guildId }),
      getRaidSeason()
    ]);
    const guildItems = guildItemsDoc?.items || {};

    const payload = await buildStorePayload('economy', userId, guildId, globalItems, guildItems, raidSeason);
    await interaction.editReply(payload);
  } catch (error) {
    console.error('❌ Store command error:', error);
    await interaction.editReply({ embeds: [
      new EmbedBuilder().setTitle('Store Error').setDescription('An error occurred while loading the store. Please try again.').setColor(0xFF6B6B)
    ]});
  }
}

async function handleBuyCommand(interaction, userId) {
  try {
    const itemName = interaction.options.getString('item').trim();
    const guildId = interaction.guildId;
    const user = await getUser(userId);

    const [globalItems, guildItemsDoc] = await Promise.all([
      getGlobalItems(),
      guildId ? guildItemsCollection.findOne({ _id: guildId }) : null
    ]);

    const guildItems = guildItemsDoc ? guildItemsDoc.items : {};

    let item = null;
    let itemType = null;
    let itemPrice = 0;

    if (globalItems[itemName]) {
      item = globalItems[itemName];
      itemType = 'global';

      if (item.type === 'bank_expansion') {
        itemPrice = await calculateExpansionPrice(userId);
      } else {
        itemPrice = item.basePrice || item.price || 0;
      }
    } else if (guildItems[itemName]) {
      item = guildItems[itemName];
      itemType = 'server';
      itemPrice = item.price;
    }

    if (!item) {
      const availableItems = [...Object.keys(globalItems), ...Object.keys(guildItems)];
      const notFoundEmbed = new EmbedBuilder()
        .setTitle('Item Not Found')
        .setDescription(`"${itemName}" is not available in any store.`)
        .addFields({
          name: 'Available Items',
          value: availableItems.length > 0 ? availableItems.join(', ') : 'No items available',
          inline: false
        })
        .setColor(0xFF6B6B)
        .setTimestamp();

      return await interaction.editReply({ embeds: [notFoundEmbed] });
    }

    if (user.cash < itemPrice) {
      const insufficientEmbed = new EmbedBuilder()
        .setTitle('Insufficient Funds')
        .setDescription(`You don't have enough cash to purchase ${itemName}.`)
        .addFields(
          { name: 'Required Cash', value: `$${itemPrice.toLocaleString()}`, inline: true },
          { name: 'Your Cash', value: `$${user.cash.toLocaleString()}`, inline: true },
          { name: 'Shortfall', value: `$${(itemPrice - user.cash).toLocaleString()}`, inline: true }
        )
        .setColor(0xFF6B6B)
        .setTimestamp();

      return await interaction.editReply({ embeds: [insufficientEmbed] });
    }

    if (itemType === 'global' && item.type === 'bank_expansion') {
      const result = await purchaseBankExpansion(userId);

      if (!result.success) {
        const errorEmbed = new EmbedBuilder()
          .setTitle('Purchase Failed')
          .setDescription('An error occurred while processing your purchase.')
          .setColor(0xFF6B6B)
          .setTimestamp();

        return await interaction.editReply({ embeds: [errorEmbed] });
      }

      const successEmbed = new EmbedBuilder()
        .setTitle('Bank Expansion Purchased')
        .setDescription(`Successfully purchased ${itemName} for $${result.price.toLocaleString()}!`)
        .addFields(
          { name: 'Bank Capacity Increased', value: `$${result.newCapacity.toLocaleString()}`, inline: true },
          { name: 'Total Expansions', value: `${result.newExpansions}`, inline: true },
          { name: 'Remaining Cash', value: `$${user.cash.toLocaleString()}`, inline: true },
          { name: 'Next Expansion Price', value: `$${(await calculateExpansionPrice(userId)).toLocaleString()}`, inline: true },
          { name: 'Capacity Increase', value: '+25%', inline: true },
          { name: 'Investment Status', value: 'Permanent Upgrade', inline: true }
        )
        .setColor(0x00FF7F)
        .setFooter({ text: 'Bank expansion permanently increases your storage capacity' })
        .setTimestamp();

      await interaction.editReply({ embeds: [successEmbed] });
    } else {
      user.cash -= itemPrice;

      if (!user.items) user.items = [];
      user.items.push(itemName);

      await saveUser(userId);

      const successEmbed = new EmbedBuilder()
        .setTitle('Purchase Successful')
        .setDescription(`Successfully purchased **${itemName}** for $${itemPrice.toLocaleString()}!`)
        .addFields(
          { name: 'Item', value: itemName, inline: true },
          { name: 'Price Paid', value: `$${itemPrice.toLocaleString()}`, inline: true },
          { name: 'Remaining Cash', value: `$${user.cash.toLocaleString()}`, inline: true },
          { name: 'Description', value: item.description || 'No description', inline: false },
          { name: 'Added to Inventory', value: 'View your items with `/inventory`', inline: false }
        )
        .setColor(0x00FF7F)
        .setTimestamp();

      await interaction.editReply({ embeds: [successEmbed] });
    }
  } catch (error) {
    console.error('❌ Buy command error:', error);

    const errorEmbed = new EmbedBuilder()
      .setTitle('Purchase Error')
      .setDescription('An error occurred while processing your purchase. Please try again.')
      .setColor(0xFF6B6B)
      .setTimestamp();

    await interaction.editReply({ embeds: [errorEmbed] });
  }
}


function getMassSellValue(name) {
  const isShiny = name.startsWith('✨ SHINY ') && name.endsWith(' ✨');
  const rarity = getRarityByArtefact(name);
  const tier = getArtefactTier(name);
  const tierSell = calcArtefactSellValue(name, rarity);
  return { isShiny, rarity, tier, finalValue: isShiny ? tierSell * 5 : tierSell };
}

function massSellMatchesQuery(name, query) {
  if (!query) return true;
  const clean = (name.startsWith('✨ SHINY ') && name.endsWith(' ✨'))
    ? name.replace('✨ SHINY ', '').replace(' ✨', '')
    : name;
  const q = query.toLowerCase();
  return clean.toLowerCase().includes(q) || name.toLowerCase().includes(q);
}

function buildMassSellEmbed(session, userArtefacts) {
  const queueText = session.queue.length
    ? session.queue.map(e => {
        const { rarity, tier, finalValue } = getMassSellValue(e.name);
        return `${e.name} x${e.amount} — ${rarity ? rarity.name : 'Unknown'} T${tier} (${(finalValue * e.amount).toLocaleString()} total)`;
      }).join('\n')
    : 'Nothing queued yet — select an artefact and add it below.';

  const totalValue = session.queue.reduce((sum, e) => {
    const { finalValue } = getMassSellValue(e.name);
    return sum + finalValue * e.amount;
  }, 0);

  const totalItems = session.queue.reduce((s, e) => s + e.amount, 0);

  const fields = [
    { name: 'Currently Selected', value: session.selectedArtefact || 'None — pick from the dropdown below', inline: false },
    { name: `Queue (${totalItems} artefact${totalItems !== 1 ? 's' : ''})`, value: queueText, inline: false },
    { name: 'Total Sell Value', value: `${totalValue.toLocaleString()}`, inline: true },
    { name: 'Artefacts in Inventory', value: userArtefacts.length.toString(), inline: true }
  ];

  const query = (session.searchQuery || '').trim();
  if (query) {
    const ownedCounts = {};
    userArtefacts.forEach(n => { ownedCounts[n] = (ownedCounts[n] || 0) + 1; });
    session.queue.forEach(e => { if (ownedCounts[e.name]) ownedCounts[e.name] -= e.amount; });
    const matchCount = Object.entries(ownedCounts).filter(([n, c]) => c > 0 && massSellMatchesQuery(n, query)).length;
    fields.splice(1, 0, {
      name: '🔍 Search Filter',
      value: `\`${query}\` — **${matchCount}** match${matchCount !== 1 ? 'es' : ''}. Click **Clear Search** to see everything again.`,
      inline: false
    });
  }

  return new EmbedBuilder()
    .setTitle('Mass Sell Artefacts')
    .setDescription('Select an artefact from the dropdown, then queue it for sale. Confirm when your list is ready.')
    .addFields(...fields)
    .setColor(session.queue.length > 0 ? 0x51CF66 : 0x339AF0)
    .setFooter({ text: 'Session expires in 5 minutes' })
    .setTimestamp();
}

function buildMassSellComponents(sessionId, session, userArtefacts) {
  const ownedCounts = {};
  userArtefacts.forEach(name => { ownedCounts[name] = (ownedCounts[name] || 0) + 1; });

  const availableCounts = { ...ownedCounts };
  session.queue.forEach(e => {
    if (availableCounts[e.name]) availableCounts[e.name] -= e.amount;
  });

  const allAvailable = Object.entries(availableCounts).filter(([, c]) => c > 0);

  const query = (session.searchQuery || '').trim();
  const filtered = query ? allAvailable.filter(([name]) => massSellMatchesQuery(name, query)) : allAvailable;

  const PAGE_SIZE = 25;
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  if (typeof session.page !== 'number' || session.page < 0) session.page = 0;
  if (session.page >= totalPages) session.page = totalPages - 1;
  const pageStart = session.page * PAGE_SIZE;
  const pageEntries = filtered.slice(pageStart, pageStart + PAGE_SIZE);

  const rows = [];

  if (pageEntries.length > 0) {
    const selectOptions = pageEntries.map(([name, count]) => {
      const { rarity, tier, finalValue } = getMassSellValue(name);
      return {
        label: name.length > 100 ? name.slice(0, 97) + '...' : name,
        description: `${rarity ? rarity.name : 'Unknown'} T${tier} — ${finalValue.toLocaleString()} each (${count} available)`,
        value: name,
        default: session.selectedArtefact === name
      };
    });

    const placeholder = totalPages > 1
      ? `Select an artefact (page ${session.page + 1} of ${totalPages})`
      : 'Select an artefact to queue for sale';

    rows.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`ms_select_${sessionId}`)
        .setPlaceholder(placeholder)
        .addOptions(selectOptions)
    ));
  }

  const hasSelection = !!session.selectedArtefact && (availableCounts[session.selectedArtefact] || 0) > 0;
  const hasQueue = session.queue.length > 0;
  const totalItems = session.queue.reduce((s, e) => s + e.amount, 0);

  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`ms_add_one_${sessionId}`)
      .setLabel('Add x1')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(!hasSelection),
    new ButtonBuilder()
      .setCustomId(`ms_add_custom_${sessionId}`)
      .setLabel('Add Custom Amount')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!hasSelection),
    new ButtonBuilder()
      .setCustomId(`ms_clear_${sessionId}`)
      .setLabel('Clear Queue')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!hasQueue),
    new ButtonBuilder()
      .setCustomId(`ms_confirm_${sessionId}`)
      .setLabel(`Confirm Sale (${totalItems})`)
      .setStyle(ButtonStyle.Success)
      .setDisabled(!hasQueue),
    new ButtonBuilder()
      .setCustomId(`ms_cancel_${sessionId}`)
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Danger)
  ));

  const showSearchRow = allAvailable.length > 0 && (allAvailable.length > PAGE_SIZE || query.length > 0);
  if (showSearchRow) {
    const searchLabel = query
      ? `🔍 Search: "${query.length > 18 ? query.slice(0, 15) + '...' : query}"`
      : '🔍 Search';
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`ms_search_${sessionId}`)
        .setLabel(searchLabel)
        .setStyle(query ? ButtonStyle.Success : ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`ms_clear_search_${sessionId}`)
        .setLabel('Clear Search')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(!query),
      new ButtonBuilder()
        .setCustomId(`ms_prev_page_${sessionId}`)
        .setLabel('◀ Prev')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(totalPages <= 1 || session.page === 0),
      new ButtonBuilder()
        .setCustomId(`ms_next_page_${sessionId}`)
        .setLabel('Next ▶')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(totalPages <= 1 || session.page >= totalPages - 1)
    ));
  }

  return rows;
}

async function handleMassSellCommand(interaction, userId) {
  const user = await getUser(userId);

  if (!user.artefacts || !user.artefacts.length) {
    return await interaction.reply({
      embeds: [new EmbedBuilder()
        .setTitle('No Artefacts to Sell')
        .setDescription('You need to find some artefacts first before you can sell them.')
        .setColor(0xFF6B6B)
        .setTimestamp()
      ]
    });
  }

  const sessionId = `${userId}_${Date.now()}`;
  const session = {
    userId,
    selectedArtefact: null,
    queue: [],
    searchQuery: '',
    page: 0,
    message: null
  };

  global.massSellSessions[sessionId] = session;

  const reply = await interaction.reply({
    embeds: [buildMassSellEmbed(session, user.artefacts)],
    components: buildMassSellComponents(sessionId, session, user.artefacts),
    fetchReply: true
  });

  session.message = reply;

  const collector = reply.createMessageComponentCollector({
    filter: i => i.user.id === userId,
    time: 300000
  });

  collector.on('collect', async i => {
    if (i.customId === `ms_select_${sessionId}`) {
      session.selectedArtefact = i.values[0];
      await i.update({ embeds: [buildMassSellEmbed(session, user.artefacts)], components: buildMassSellComponents(sessionId, session, user.artefacts) });

    } else if (i.customId === `ms_add_one_${sessionId}`) {
      const ownedCount = user.artefacts.filter(a => a === session.selectedArtefact).length;
      const queued = session.queue.find(e => e.name === session.selectedArtefact)?.amount || 0;
      if (queued >= ownedCount) {
        return await i.reply({ content: `You have no more copies of ${session.selectedArtefact} available to queue.`, ephemeral: true });
      }
      const existing = session.queue.find(e => e.name === session.selectedArtefact);
      if (existing) {
        existing.amount++;
      } else {
        session.queue.push({ name: session.selectedArtefact, amount: 1 });
      }
      await i.update({ embeds: [buildMassSellEmbed(session, user.artefacts)], components: buildMassSellComponents(sessionId, session, user.artefacts) });

    } else if (i.customId === `ms_add_custom_${sessionId}`) {
      const modal = new ModalBuilder()
        .setCustomId(`ms_amount_modal_${sessionId}`)
        .setTitle(`Amount for ${session.selectedArtefact}`)
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('ms_amount_input')
              .setLabel(`How many ${session.selectedArtefact} to sell?`)
              .setStyle(TextInputStyle.Short)
              .setPlaceholder('Enter a number')
              .setMinLength(1)
              .setMaxLength(5)
              .setRequired(true)
          )
        );
      await i.showModal(modal);

    } else if (i.customId === `ms_clear_${sessionId}`) {
      session.queue = [];
      await i.update({ embeds: [buildMassSellEmbed(session, user.artefacts)], components: buildMassSellComponents(sessionId, session, user.artefacts) });

    } else if (i.customId === `ms_confirm_${sessionId}`) {
      let totalEarned = 0;
      const summaryLines = [];
      const soldItemsForPremium = []; // { name, sellValue } per individual unit

      for (const entry of session.queue) {
        let remaining = entry.amount;
        user.artefacts = user.artefacts.filter(name => {
          if (name === entry.name && remaining > 0) { remaining--; return false; }
          return true;
        });
        const { finalValue } = getMassSellValue(entry.name);
        totalEarned += finalValue * entry.amount;
        const { rarity } = getMassSellValue(entry.name);
        summaryLines.push(`${entry.name} x${entry.amount} (${rarity ? rarity.name : 'Unknown'}) — ${(finalValue * entry.amount).toLocaleString()}`);
        for (let k = 0; k < entry.amount; k++) {
          soldItemsForPremium.push({ name: entry.name, sellValue: finalValue });
        }
      }

      const premium = computeCollectorsPremium(soldItemsForPremium);
      const grandTotal = totalEarned + premium.totalBonus;

      user.cash += grandTotal;
      await saveUser(userId);
      await updateQuestProgress(userId, interaction.guildId, 'sellArtefact', 1);
      collector.stop('sold');
      delete global.massSellSessions[sessionId];

      const soldDisplay = summaryLines.slice(0, 20).join('\n')
        + (summaryLines.length > 20 ? `\n... and ${summaryLines.length - 20} more` : '');

      const completeEmbed = new EmbedBuilder()
        .setTitle('Sale Complete')
        .setDescription(
          premium.totalBonus > 0
            ? `Successfully sold artefacts for **${totalEarned.toLocaleString()}** plus a **${premium.totalBonus.toLocaleString()} Collector's Premium**!`
            : `Successfully sold artefacts for **${totalEarned.toLocaleString()}**!`
        )
        .addFields(
          { name: 'Items Sold', value: soldDisplay, inline: false }
        );

      if (premium.breakdown.length > 0) {
        const premiumLines = premium.breakdown.map(b =>
          `✨ **${b.setName}** × ${b.copies} — +${b.bonus.toLocaleString()}`
        ).join('\n');
        completeEmbed.addFields({
          name: `Collector's Premium (+${Math.round(COLLECTORS_PREMIUM * 100)}%)`,
          value: premiumLines,
          inline: false
        });
      }

      completeEmbed.addFields(
        { name: 'Total Earned', value: `${grandTotal.toLocaleString()}`, inline: true },
        { name: 'New Cash Balance', value: `${user.cash.toLocaleString()}`, inline: true }
      ).setColor(0x51CF66).setTimestamp();

      await i.update({
        embeds: [completeEmbed],
        components: []
      });

    } else if (i.customId === `ms_search_${sessionId}`) {
      const modal = new ModalBuilder()
        .setCustomId(`ms_search_modal_${sessionId}`)
        .setTitle('Search Your Artefacts')
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('ms_search_input')
              .setLabel('Type a name (or part of a name)')
              .setStyle(TextInputStyle.Short)
              .setPlaceholder('e.g. quartz, obsidian, crown')
              .setRequired(false)
              .setMaxLength(80)
              .setValue(session.searchQuery || '')
          )
        );
      await i.showModal(modal);

    } else if (i.customId === `ms_clear_search_${sessionId}`) {
      session.searchQuery = '';
      session.page = 0;
      await i.update({ embeds: [buildMassSellEmbed(session, user.artefacts)], components: buildMassSellComponents(sessionId, session, user.artefacts) });

    } else if (i.customId === `ms_prev_page_${sessionId}`) {
      session.page = Math.max(0, (session.page || 0) - 1);
      await i.update({ embeds: [buildMassSellEmbed(session, user.artefacts)], components: buildMassSellComponents(sessionId, session, user.artefacts) });

    } else if (i.customId === `ms_next_page_${sessionId}`) {
      session.page = (session.page || 0) + 1;
      await i.update({ embeds: [buildMassSellEmbed(session, user.artefacts)], components: buildMassSellComponents(sessionId, session, user.artefacts) });

    } else if (i.customId === `ms_cancel_${sessionId}`) {
      collector.stop('cancelled');
      delete global.massSellSessions[sessionId];
      await i.update({
        embeds: [new EmbedBuilder()
          .setTitle('Sale Cancelled')
          .setDescription('No artefacts were sold.')
          .setColor(0xFF6B6B)
          .setTimestamp()
        ],
        components: []
      });
    }
  });

  collector.on('end', async (collected, reason) => {
    if (reason === 'time') {
      delete global.massSellSessions[sessionId];
      try {
        await interaction.editReply({
          embeds: [new EmbedBuilder()
            .setTitle('Session Expired')
            .setDescription('The mass sell session timed out. No artefacts were sold.')
            .setColor(0xFF9F43)
            .setTimestamp()
          ],
          components: []
        });
      } catch (e) {}
    }
  });
}

async function handleAddItemCommand(interaction) {
  const guildId = interaction.guildId;

  if (!guildId) {
    const dmEmbed = new EmbedBuilder()
      .setTitle('Server Required')
      .setDescription('This command requires server context.')
      .setColor(0xFF6B6B)
      .setTimestamp();

    return await interaction.editReply({ embeds: [dmEmbed] });
  }

  if (interaction.user.id !== DEVELOPER_ID && !interaction.member?.permissions.has('Administrator')) {
    const noPermEmbed = new EmbedBuilder()
      .setTitle('Access Denied')
      .setDescription('Only administrators can add custom server items.')
      .setColor(0xFF6B6B)
      .setTimestamp();

    return await interaction.editReply({ embeds: [noPermEmbed] });
  }

  const itemName = interaction.options.getString('name');
  const itemPrice = interaction.options.getInteger('price');
  const itemDescription = interaction.options.getString('description') || 'Custom server item';

  const guildItemsDoc = await guildItemsCollection.findOne({ _id: guildId });
  const guildItems = guildItemsDoc ? guildItemsDoc.items : {};

  guildItems[itemName] = {
    price: itemPrice,
    description: itemDescription,
    addedBy: interaction.user.id,
    addedAt: Date.now()
  };

  await guildItemsCollection.replaceOne(
    { _id: guildId },
    { _id: guildId, items: guildItems },
    { upsert: true }
  );

  const addEmbed = new EmbedBuilder()
    .setTitle('Item Added Successfully')
    .setDescription(`**Added "${itemName}"** to the server store.`)
    .addFields(
      { name: 'Item Name', value: `**${itemName}**`, inline: true },
      { name: 'Price', value: `**$${itemPrice.toLocaleString()}**`, inline: true },
      { name: 'Description', value: itemDescription, inline: false }
    )
    .setColor(0x00FF7F)
    .setTimestamp();

  await interaction.editReply({ embeds: [addEmbed] });
}

async function handleRemoveItemCommand(interaction) {
  if (interaction.user.id !== DEVELOPER_ID && !interaction.member.permissions.has('Administrator')) {
    const noPermEmbed = new EmbedBuilder()
      .setTitle('Access Denied')
      .setDescription('Only administrators can remove custom server items.')
      .setColor(0xFF6B6B)
      .setTimestamp();

    return await interaction.reply({ embeds: [noPermEmbed] });
  }

  const itemName = interaction.options.getString('name');
  const guildId = interaction.guild.id;

  const guildItemsDoc = await guildItemsCollection.findOne({ _id: guildId });
  const guildItems = guildItemsDoc ? guildItemsDoc.items : {};

  if (!guildItems[itemName]) {
    const notFoundEmbed = new EmbedBuilder()
      .setTitle('Item Not Found')
      .setDescription(`No custom item named "${itemName}" exists in this server.`)
      .setColor(0xFF6B6B)
      .setTimestamp();

    return await interaction.reply({ embeds: [notFoundEmbed] });
  }

  delete guildItems[itemName];
  await guildItemsCollection.replaceOne(
    { _id: guildId },
    { _id: guildId, items: guildItems },
    { upsert: true }
  );

  const removeEmbed = new EmbedBuilder()
    .setTitle('Item Removed')
    .setDescription(`Successfully removed "${itemName}" from the server store.`)
    .setColor(0x51CF66)
    .setTimestamp();

  await interaction.reply({ embeds: [removeEmbed] });
}

async function handleViewItemsCommand(interaction) {
  if (interaction.user.id !== DEVELOPER_ID && !interaction.member.permissions.has('Administrator')) {
    const noPermEmbed = new EmbedBuilder()
      .setTitle('Access Denied')
      .setDescription('Only administrators can view the custom items management panel.')
      .setColor(0xFF6B6B)
      .setTimestamp();

    return await interaction.reply({ embeds: [noPermEmbed] });
  }

  const guildId = interaction.guild.id;
  const guildItemsDoc = await guildItemsCollection.findOne({ _id: guildId });
  const guildItems = guildItemsDoc ? guildItemsDoc.items : {};

  if (Object.keys(guildItems).length === 0) {
    const noItemsEmbed = new EmbedBuilder()
      .setTitle('No Custom Items')
      .setDescription('This server has no custom items yet.')
      .addFields({ name: 'Add Items', value: 'Use `/add-item` to create custom server items', inline: false })
      .setColor(0xFF9F43)
      .setTimestamp();

    return await interaction.reply({ embeds: [noItemsEmbed] });
  }

  const itemList = Object.entries(guildItems).map(([name, data]) => 
    `**${name}** - $${data.price.toLocaleString()}\n${data.description}`
  ).join('\n\n');

  const viewEmbed = new EmbedBuilder()
    .setTitle('Custom Server Items')
    .setDescription(`This server has ${Object.keys(guildItems).length} custom item(s).`)
    .addFields({ name: 'Items', value: itemList, inline: false })
    .setColor(0x339AF0)
    .setTimestamp();

  await interaction.reply({ embeds: [viewEmbed] });
}

async function handleComponentInteraction(interaction) {
  const { customId } = interaction;

  try {

  if (customId.startsWith('trade_accept_')) {
    const parts = customId.split('_');
    const initiatorId = parts[2];
    const intendedRecipientId = parts[3];

    if (interaction.user.id !== intendedRecipientId) {
      return await interaction.reply({
        content: `❌ Only <@${intendedRecipientId}> can respond to this trade request.`,
        ephemeral: true
      });
    }

    const recipientId = intendedRecipientId;

    if (!userData[recipientId]) userData[recipientId] = { cash: 0, artefacts: [], bankBalance: 0 };
    if (!userData[initiatorId]) userData[initiatorId] = { cash: 0, artefacts: [], bankBalance: 0 };

    const tradeId = `${initiatorId}-${recipientId}`;
    global.activeTrades[tradeId] = {
      initiator: initiatorId,
      recipient: recipientId,
      initiatorOffer: { cash: 0, artefacts: [] },
      recipientOffer: { cash: 0, artefacts: [] },
      initiatorReady: false,
      recipientReady: false,
      pickers: {},      // { [userId]: { message, mode, query, page } }
      message: null,    // public trade UI message — set in startInteractiveTrade
      status: 'active'
    };

    await startInteractiveTrade(interaction, initiatorId, recipientId, tradeId);

  } else if (customId.startsWith('trade_decline_')) {
    const parts = customId.split('_');
    const initiatorId = parts[2];
    const intendedRecipientId = parts[3];

    if (interaction.user.id !== intendedRecipientId) {
      return await interaction.reply({
        content: `❌ Only <@${intendedRecipientId}> can respond to this trade request.`,
        ephemeral: true
      });
    }

    const declineEmbed = new EmbedBuilder()
      .setTitle('Trade Declined')
      .setDescription(`<@${interaction.user.id}> has declined the trade request from <@${initiatorId}>.`)
      .setColor(0xFF6B6B)
      .setTimestamp();

    await interaction.update({ embeds: [declineEmbed], components: [] });

  } else if (customId.startsWith('marble_accept_')) {
    const gameId = customId.replace('marble_accept_', '');
    const game = global.activeMarbleGames[gameId];

    if (!game) {
      return await interaction.reply({ 
        content: '❌ **Error:** This game is no longer active!', 
        ephemeral: true 
      });
    }

    const userId = interaction.user.id;

    if (!game.invited.some(p => p.id === userId)) {
      return await interaction.reply({ 
        content: '❌ **Error:** You were not invited to this game!', 
        ephemeral: true 
      });
    }

    if (game.accepted.includes(userId) || game.declined.includes(userId)) {
      return await interaction.reply({ 
        content: '❌ **Error:** You have already responded to this invitation!', 
        ephemeral: true 
      });
    }

    game.accepted.push(userId);

    if (game.accepted.length === 3) {
      await startBettingPhase(interaction, gameId);
    } else {
      const updatedEmbed = createInvitationEmbed(game);
      await interaction.update({ embeds: [updatedEmbed], components: [createInvitationButtons(gameId)] });
    }

  } else if (customId.startsWith('marble_decline_')) {
    const gameId = customId.replace('marble_decline_', '');
    const game = global.activeMarbleGames[gameId];

    if (!game) {
      return await interaction.reply({ 
        content: '❌ **Error:** This game is no longer active!', 
        ephemeral: true 
      });
    }

    const userId = interaction.user.id;
    const declinedUser = game.invited.find(p => p.id === userId);

    if (!declinedUser) {
      return await interaction.reply({ 
        content: '❌ **Error:** You were not invited to this game!', 
        ephemeral: true 
      });
    }

    const declineEmbed = new EmbedBuilder()
      .setTitle('Marble Game Cancelled')
      .setDescription(`**${declinedUser.displayName}** has declined the invitation. The marble game has been cancelled.`)
      .setColor(0xFF6B6B)
      .setTimestamp();

    await interaction.update({ embeds: [declineEmbed], components: [] });

    delete global.activeMarbleGames[gameId];


  } else if (customId.startsWith('duel_accept_')) {
    const gameId = customId.replace('duel_accept_', '');
    const game = global.activeDuelGames[gameId];

    if (!game) {
      return interaction.reply({ content: '❌ This duel is no longer active.', ephemeral: true });
    }
    if (interaction.user.id !== game.players[1].id) {
      return interaction.reply({ content: '❌ You were not invited to this duel.', ephemeral: true });
    }
    if (game.accepted) {
      return interaction.reply({ content: '❌ You already responded to this invitation.', ephemeral: true });
    }

    game.accepted = true;
    await startDuelBettingPhase(interaction, gameId);

  } else if (customId.startsWith('duel_decline_')) {
    const gameId = customId.replace('duel_decline_', '');
    const game = global.activeDuelGames[gameId];

    if (!game) {
      return interaction.reply({ content: '❌ This duel is no longer active.', ephemeral: true });
    }
    if (interaction.user.id !== game.players[1].id) {
      return interaction.reply({ content: '❌ You were not invited to this duel.', ephemeral: true });
    }

    delete global.activeDuelGames[gameId];

    await interaction.update({
      embeds: [
        new EmbedBuilder()
          .setTitle('Marble Duel Declined')
          .setDescription(`**${interaction.user.displayName}** has declined the challenge. Duel cancelled.`)
          .setColor(0xFF6B6B)
          .setTimestamp()
      ],
      components: []
    });

  } else if (customId.startsWith('cduel_accept_')) {
    const gameId = customId.replace('cduel_accept_', '');
    await handleCardDuelAccept(interaction, gameId);

  } else if (customId.startsWith('cduel_decline_')) {
    const gameId = customId.replace('cduel_decline_', '');
    await handleCardDuelDecline(interaction, gameId);

  } else if (customId.startsWith('cduel_pick_')) {
    const gameId = customId.replace('cduel_pick_', '');
    await handleCardDuelPickButton(interaction, gameId);

  } else if (customId.startsWith('cduel_play_')) {
    const withoutPrefix = customId.replace('cduel_play_', '');
    const lastUnder = withoutPrefix.lastIndexOf('_');
    const gameId = withoutPrefix.substring(0, lastUnder);
    const cardIndex = parseInt(withoutPrefix.substring(lastUnder + 1));
    await handleCardDuelPlay(interaction, gameId, cardIndex);

  } else if (customId.startsWith('place_duel_bet_')) {
    const gameId = customId.replace('place_duel_bet_', '');
    const game = global.activeDuelGames[gameId];
    if (!game) return;
    if (!game.players.some(p => p.id === interaction.user.id)) {
      return interaction.reply({ content: '❌ You are not part of this duel.', ephemeral: true });
    }

    const modal = new ModalBuilder()
      .setCustomId(`duel_bet_modal_${gameId}`)
      .setTitle('Place Your Bet')
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('bet_amount_input')
            .setLabel('Bet Amount (min $50)')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('e.g. 1000')
            .setRequired(true)
            .setMinLength(1)
            .setMaxLength(10)
        )
      );
    await interaction.showModal(modal);

  } else if (customId.startsWith('duel_pick_')) {
    const gameId = customId.replace('duel_pick_', '');
    await handleDuelPick(interaction, gameId);

  } else if (customId.startsWith('select_number_')) {
    const gameId = customId.replace('select_number_', '');
    await handleNumberSelection(interaction, gameId);

  } else if (customId.startsWith('place_bet_')) {
    const gameId = customId.replace('place_bet_', '');
    const game = global.activeMarbleGames[gameId];
    if (!game) return;

    const userId = interaction.user.id;
    const modal = new ModalBuilder()
      .setCustomId(`bet_modal_${gameId}`)
      .setTitle('Place Your Bet')
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('bet_amount_input')
            .setLabel('Bet Amount')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder(`Enter your bet (e.g., 1000)`)
            .setRequired(true)
            .setMinLength(1)
            .setMaxLength(10)
        )
      );

    await interaction.showModal(modal);

  } else if (customId.startsWith('trade_add_cash_')) {
    await handleTradeAddCash(interaction, customId);

  } else if (customId.startsWith('trade_add_artefact_') && !customId.startsWith('trade_add_artefact_select_')) {
    await handleTradeAddArtefact(interaction, customId);

  } else if (customId.startsWith('trade_remove_cash_')) {
    await handleTradeRemoveCash(interaction, customId);

  } else if (customId.startsWith('trade_remove_artefact_') && !customId.startsWith('trade_remove_artefact_select_')) {
    await handleTradeRemoveArtefact(interaction, customId);

  } else if (customId.startsWith('trade_ready_')) {
    await handleTradeReady(interaction, customId);

  } else if (customId.startsWith('trade_cancel_')) {
    await handleTradeCancel(interaction, customId);

  } else if (customId.startsWith('trade_artefact_select_')) {
    const tradeId = customId.replace('trade_artefact_select_', '');
    const trade = global.activeTrades[tradeId];
    if (!trade) {
      return await interaction.reply({ content: 'Trade session not found.', ephemeral: true });
    }

    const userId = interaction.user.id;
    if (userId !== trade.initiator && userId !== trade.recipient) {
      return await interaction.reply({ content: 'You are not part of this trade.', ephemeral: true });
    }

    const artefact = interaction.values[0];
    const isInitiator = trade.initiator === userId;
    const offer = isInitiator ? trade.initiatorOffer : trade.recipientOffer;
    const userArtefacts = (userData[userId] && userData[userId].artefacts) || [];

    const owned = userArtefacts.filter(a => a === artefact).length;
    const alreadyOffered = offer.artefacts.filter(a => a === artefact).length;
    const available = owned - alreadyOffered;
    if (available <= 0) {
      return await interaction.update(buildTradePickerPayload(trade, userId));
    }

    if (available === 1) {
      offer.artefacts.push(artefact);
      if (isInitiator) trade.initiatorReady = false;
      else trade.recipientReady = false;
      await interaction.update(buildTradePickerPayload(trade, userId));
      await refreshTradeMessage(trade);
    } else {
      if (!trade.pickers) trade.pickers = {};
      if (!trade.pickers[userId]) trade.pickers[userId] = { mode: 'add', query: '', page: 0, message: null };
      trade.pickers[userId].pendingAdd = artefact;
      const qtyModal = new ModalBuilder()
        .setCustomId(`trade_artefact_qty_modal_${tradeId}`)
        .setTitle('How many to add?');
      const qtyInput = new TextInputBuilder()
        .setCustomId('artefact_qty')
        .setLabel(`How many "${artefact.length > 30 ? artefact.slice(0, 27) + '...' : artefact}" to add?`)
        .setStyle(TextInputStyle.Short)
        .setPlaceholder(`1 – ${available} available`)
        .setValue('1')
        .setRequired(true)
        .setMaxLength(4);
      qtyModal.addComponents(new ActionRowBuilder().addComponents(qtyInput));
      await interaction.showModal(qtyModal);
    }

  } else if (customId.startsWith('trade_remove_artefact_select_')) {
    const tradeId = customId.replace('trade_remove_artefact_select_', '');
    const trade = global.activeTrades[tradeId];
    if (!trade) {
      return await interaction.reply({ content: 'Trade session not found.', ephemeral: true });
    }

    const userId = interaction.user.id;
    if (userId !== trade.initiator && userId !== trade.recipient) {
      return await interaction.reply({ content: 'You are not part of this trade.', ephemeral: true });
    }

    const artefact = interaction.values[0];
    const isInitiator = trade.initiator === userId;
    const offer = isInitiator ? trade.initiatorOffer : trade.recipientOffer;

    const countInOffer = offer.artefacts.filter(a => a === artefact).length;
    if (countInOffer === 0) {
      return await interaction.update(buildTradePickerPayload(trade, userId));
    }

    if (countInOffer === 1) {
      offer.artefacts.splice(offer.artefacts.indexOf(artefact), 1);
      if (isInitiator) trade.initiatorReady = false;
      else trade.recipientReady = false;
      await interaction.update(buildTradePickerPayload(trade, userId));
      await refreshTradeMessage(trade);
    } else {
      if (!trade.pickers) trade.pickers = {};
      if (!trade.pickers[userId]) trade.pickers[userId] = { mode: 'remove', query: '', page: 0, message: null };
      trade.pickers[userId].pendingRemove = artefact;
      const removeModal = new ModalBuilder()
        .setCustomId(`trade_remove_artefact_qty_modal_${tradeId}`)
        .setTitle('How many to remove?');
      const removeInput = new TextInputBuilder()
        .setCustomId('remove_qty')
        .setLabel(`Remove how many "${artefact.length > 28 ? artefact.slice(0, 25) + '...' : artefact}"?`)
        .setStyle(TextInputStyle.Short)
        .setPlaceholder(`1 – ${countInOffer} in your offer`)
        .setValue('1')
        .setRequired(true)
        .setMaxLength(4);
      removeModal.addComponents(new ActionRowBuilder().addComponents(removeInput));
      await interaction.showModal(removeModal);
    }

  } else if (customId.startsWith('trade_picker_search_')) {
    const tradeId = customId.replace('trade_picker_search_', '');
    const trade = global.activeTrades[tradeId];
    if (!trade) {
      return await interaction.reply({ content: 'Trade session not found.', ephemeral: true });
    }
    const userId = interaction.user.id;
    const picker = trade.pickers && trade.pickers[userId];
    if (!picker) {
      return await interaction.reply({ content: 'Picker session expired — close this and click Add/Remove Artefact again.', ephemeral: true });
    }
    const modal = new ModalBuilder()
      .setCustomId(`trade_picker_search_modal_${tradeId}`)
      .setTitle('Search Artefacts')
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('trade_picker_search_input')
            .setLabel('Type a name (or part of a name)')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('e.g. quartz, obsidian, crown')
            .setRequired(false)
            .setMaxLength(80)
            .setValue(picker.query || '')
        )
      );
    await interaction.showModal(modal);

  } else if (customId.startsWith('trade_picker_clear_')) {
    const tradeId = customId.replace('trade_picker_clear_', '');
    const trade = global.activeTrades[tradeId];
    const userId = interaction.user.id;
    const picker = trade && trade.pickers && trade.pickers[userId];
    if (!picker) return await interaction.deferUpdate();
    picker.query = '';
    picker.page = 0;
    await interaction.update(buildTradePickerPayload(trade, userId));

  } else if (customId.startsWith('trade_picker_prev_')) {
    const tradeId = customId.replace('trade_picker_prev_', '');
    const trade = global.activeTrades[tradeId];
    const userId = interaction.user.id;
    const picker = trade && trade.pickers && trade.pickers[userId];
    if (!picker) return await interaction.deferUpdate();
    picker.page = Math.max(0, (picker.page || 0) - 1);
    await interaction.update(buildTradePickerPayload(trade, userId));

  } else if (customId.startsWith('trade_picker_next_')) {
    const tradeId = customId.replace('trade_picker_next_', '');
    const trade = global.activeTrades[tradeId];
    const userId = interaction.user.id;
    const picker = trade && trade.pickers && trade.pickers[userId];
    if (!picker) return await interaction.deferUpdate();
    picker.page = (picker.page || 0) + 1;
    await interaction.update(buildTradePickerPayload(trade, userId));

  } else if (customId.startsWith('convert_accept_')) {
    const userId = customId.replace('convert_accept_', '');

    if (interaction.user.id !== userId) {
      return await interaction.reply({ 
        content: '❌ This conversion is not for you!', 
        ephemeral: true 
      });
    }

    const userXpData = userData[userId].xpData;
    if (!userXpData || userXpData.xp === 0) {
      return await interaction.reply({ 
        content: '❌ You have no XP to convert!', 
        ephemeral: true 
      });
    }

    const xpToConvert = userXpData.xp;
    const cashEarned = xpToConvert * 2;

    userData[userId].cash += cashEarned;
    userData[userId].xpData.xp = 0;
    await saveUserData();
    await updateQuestProgress(userId, interaction.guildId, 'convertXp', 1);

    const successEmbed = new EmbedBuilder()
      .setTitle('XP Conversion Successful')
      .setDescription('Your XP has been successfully converted to cash!')
      .addFields(
        { name: 'XP Converted', value: `${xpToConvert.toLocaleString()} XP`, inline: true },
        { name: 'Cash Earned', value: `$${cashEarned.toLocaleString()}`, inline: true },
        { name: 'New Cash Total', value: `$${userData[userId].cash.toLocaleString()}`, inline: true }
      )
      .setColor(0x00FF7F)
      .setTimestamp();

    await interaction.update({ embeds: [successEmbed], components: [] });

  } else if (customId.startsWith('convert_decline_')) {
    const userId = customId.replace('convert_decline_', '');

    if (interaction.user.id !== userId) {
      return await interaction.reply({ 
        content: '❌ This conversion is not for you!', 
        ephemeral: true 
      });
    }

    const declineEmbed = new EmbedBuilder()
      .setTitle('XP Conversion Cancelled')
      .setDescription('You have chosen to keep your XP. You can convert it later using `/convert`.')
      .setColor(0xFF9F43)
      .setTimestamp();

    await interaction.update({ embeds: [declineEmbed], components: [] });

  } else if (customId.startsWith('collection_prev_') || customId.startsWith('collection_next_')) {
    const isPrev = customId.startsWith('collection_prev_');
    const parts = customId.split('_');
    const ownerId = parts[2];
    const currentPage = parseInt(parts[3]);

    if (interaction.user.id !== ownerId) {
      return await interaction.reply({
        content: '❌ This is not your field guide!',
        ephemeral: true
      });
    }

    const newPage = isPrev ? currentPage - 1 : currentPage + 1;
    const user = await getUser(ownerId);
    const embed = buildCollectionPage(user, newPage);
    const components = buildCollectionButtons(ownerId, newPage);
    await interaction.update({ embeds: [embed], components });

  } else if (customId === 'store_tab_economy' || customId === 'store_tab_minigame') {
    const tab = customId === 'store_tab_economy' ? 'economy' : 'minigame';
    const guildId = interaction.guildId;
    const userId = interaction.user.id;
    if (!guildId) return await interaction.deferUpdate();
    const [globalItems, guildItemsDoc, raidSeason] = await Promise.all([
      getGlobalItems(),
      guildItemsCollection.findOne({ _id: guildId }),
      getRaidSeason()
    ]);
    const guildItems = guildItemsDoc?.items || {};
    const payload = await buildStorePayload(tab, userId, guildId, globalItems, guildItems, raidSeason);
    await interaction.update(payload);

  } else if (customId.startsWith('store_tab_raid_')) {
    let raidSubTab = 'military';
    let raidPage   = 0;
    if (customId !== 'store_tab_raid_open') {
      const stripped = customId.replace(/_prev$/, '').replace(/_next$/, '');
      const inner    = stripped.replace('store_tab_raid_', '');
      const lastUnd  = inner.lastIndexOf('_');
      raidSubTab     = inner.slice(0, lastUnd);   // 'military' | 'training' | 'mercenaries'
      raidPage       = parseInt(inner.slice(lastUnd + 1), 10) || 0;
    }
    const guildId    = interaction.guildId;
    const userId     = interaction.user.id;
    if (!guildId) return await interaction.deferUpdate();
    const [globalItems, guildItemsDoc, raidSeason] = await Promise.all([
      getGlobalItems(),
      guildItemsCollection.findOne({ _id: guildId }),
      getRaidSeason()
    ]);
    if (!raidSeason || !raidSeason.active) {
      return await interaction.reply({ content: 'The Raid Season is not currently active.', ephemeral: true });
    }
    const guildItems = guildItemsDoc?.items || {};
    const payload = await buildStorePayload('raid', userId, guildId, globalItems, guildItems, raidSeason, raidSubTab, raidPage);
    await interaction.update(payload);

  } else if (customId.startsWith('inv_prev_') || customId.startsWith('inv_next_')) {
    const isPrev = customId.startsWith('inv_prev_');
    const rest = isPrev ? customId.replace('inv_prev_', '') : customId.replace('inv_next_', '');
    const lastUnderscore = rest.lastIndexOf('_');
    const targetUserId = rest.slice(0, lastUnderscore);
    const currentPage = parseInt(rest.slice(lastUnderscore + 1), 10);
    const newPage = isPrev ? currentPage - 1 : currentPage + 1;
    const [invUser, invXpData, invBankCap] = await Promise.all([
      getUser(targetUserId),
      getXpData(targetUserId),
      calculateBankCapacity(targetUserId)
    ]);
    const { embed, components } = buildInventoryPayload(invUser, invXpData, invBankCap, newPage);
    await interaction.update({ embeds: [embed], components });

  } else if (customId.startsWith('fish_reel_')) {
    const sessionId = customId.replace('fish_reel_', '');
    await handleReelIn(interaction, sessionId);

  } else if (customId.startsWith('raid_buy_')) {
    await handleRaidBuyUnit(interaction);

  } else if (customId.startsWith('raid_train_')) {
    await handleRaidTrainUnit(interaction);

  } else if (customId.startsWith('raid_hire_merc_')) {
    await handleRaidHireMerc(interaction);

  } else if (customId.startsWith('raid_attack_merc_')) {
    const targetId = customId.replace('raid_attack_merc_', '');
    await handleRaidConfirmAttack(interaction, targetId, true);

  } else if (customId.startsWith('raid_attack_')) {
    const targetId = customId.replace('raid_attack_', '');
    await handleRaidConfirmAttack(interaction, targetId, false);

  } else if (customId.startsWith('raid_select_target_')) {
    const sessionId = customId.replace('raid_select_target_', '');
    const session   = global.activeRaidBrowseSessions[sessionId];
    if (!session || interaction.user.id !== session.userId) return await interaction.reply({ content: 'This raid panel is not yours.', ephemeral: true });
    session.selectedTargetId = interaction.values[0];
    await interaction.update(await buildRaidBrowsePayload(session, sessionId));

  } else if (customId.startsWith('raid_tutorial_')) {
    await handleRaidTutorialButton(interaction);

  } else if (customId.startsWith('raid_page_')) {
    const inner     = customId.replace('raid_page_', '');
    const lastUnd   = inner.lastIndexOf('_');
    const sessionId = inner.slice(0, lastUnd);
    const page      = parseInt(inner.slice(lastUnd + 1), 10) || 0;
    const session   = global.activeRaidBrowseSessions[sessionId];
    if (!session || interaction.user.id !== session.userId) return await interaction.reply({ content: 'This raid panel is not yours.', ephemeral: true });
    session.page = page;
    session.selectedTargetId = null;
    await interaction.update(await buildRaidBrowsePayload(session, sessionId));

  } else if (customId.startsWith('quest_claim_community_')) {
    const guildId = customId.replace('quest_claim_community_', '');
    const claimerId = interaction.user.id;
    const community = await ensureCommunityQuest(guildId);

    if (!community || !community.completed) {
      return await interaction.reply({ content: '❌ This community quest is not complete yet.', ephemeral: true });
    }
    if (!community.contributors.includes(claimerId)) {
      return await interaction.reply({ content: '❌ You did not contribute to this community quest.', ephemeral: true });
    }
    if (community.claimedBy.includes(claimerId)) {
      return await interaction.reply({ content: '✅ You already claimed this reward.', ephemeral: true });
    }

    const claimerUser = await getUser(claimerId);
    claimerUser.cash += community.cashReward;
    if (!claimerUser.xpData) claimerUser.xpData = { xp: 0, messageCount: 0, lastMessage: 0 };
    claimerUser.xpData.xp += community.xpReward;
    await saveUser(claimerId);

    community.claimedBy.push(claimerId);
    await guildSettingsCollection.updateOne({ _id: guildId }, { $set: { communityQuest: community } });

    await interaction.reply({
      content: `🎁 You claimed **$${community.cashReward.toLocaleString()} + ${community.xpReward} XP** from the community quest!`,
      ephemeral: true
    });

  } else if (customId.startsWith('quest_claim_full_')) {
    const ownerId = customId.replace('quest_claim_full_', '');
    if (interaction.user.id !== ownerId) {
      return await interaction.reply({ content: '❌ These are not your quests to claim.', ephemeral: true });
    }
    const user = await getUser(ownerId);
    const dq = ensureDailyQuests(user);

    if (dq.fullClearBonus) {
      return await interaction.reply({ content: '✅ You already claimed the full-clear bonus.', ephemeral: true });
    }
    if (!dq.quests.every(q => q.claimed)) {
      return await interaction.reply({ content: '❌ Claim all 9 quest rewards first!', ephemeral: true });
    }

    dq.fullClearBonus = true;
    user.cash += QUEST_FULL_CLEAR_BONUS_CASH;
    if (!user.xpData) user.xpData = { xp: 0, messageCount: 0, lastMessage: 0 };
    user.xpData.xp += QUEST_FULL_CLEAR_BONUS_XP;
    await saveUser(ownerId);

    const guildIdForCommunity = interaction.guildId;
    const community = guildIdForCommunity ? await ensureCommunityQuest(guildIdForCommunity) : null;
    if (community) community._guildId = guildIdForCommunity;
    const { embed, components } = buildQuestsPayload(user, dq, community, ownerId);
    await interaction.update({ embeds: [embed], components });

  } else if (customId.startsWith('quest_claim_section_')) {
    const rest = customId.replace('quest_claim_section_', '');
    const [section, ownerId] = rest.split('|');
    if (interaction.user.id !== ownerId) {
      return await interaction.reply({ content: '❌ These are not your quests to claim.', ephemeral: true });
    }
    const user = await getUser(ownerId);
    const dq = ensureDailyQuests(user);

    if (dq.sectionBonuses[section]) {
      return await interaction.reply({ content: '✅ You already claimed this section bonus.', ephemeral: true });
    }
    const sectionQuests = dq.quests.filter(q => q.section === section);
    if (!sectionQuests.every(q => q.claimed)) {
      return await interaction.reply({ content: '❌ Claim all quests in this section first!', ephemeral: true });
    }

    dq.sectionBonuses[section] = true;
    user.cash += QUEST_SECTION_BONUS_CASH;
    if (!user.xpData) user.xpData = { xp: 0, messageCount: 0, lastMessage: 0 };
    user.xpData.xp += QUEST_SECTION_BONUS_XP;
    await saveUser(ownerId);

    const guildIdForCommunity = interaction.guildId;
    const community = guildIdForCommunity ? await ensureCommunityQuest(guildIdForCommunity) : null;
    if (community) community._guildId = guildIdForCommunity;
    const { embed, components } = buildQuestsPayload(user, dq, community, ownerId);
    await interaction.update({ embeds: [embed], components });

  } else if (customId.startsWith('quest_claim_')) {
    const rest = customId.replace('quest_claim_', '');
    const [ownerId, questId] = rest.split('|');
    if (interaction.user.id !== ownerId) {
      return await interaction.reply({ content: '❌ These are not your quests to claim.', ephemeral: true });
    }
    const user = await getUser(ownerId);
    const dq = ensureDailyQuests(user);
    const quest = dq.quests.find(q => q.id === questId);

    if (!quest) {
      return await interaction.reply({ content: '❌ This quest could not be found (it may have reset).', ephemeral: true });
    }
    if (quest.claimed) {
      return await interaction.reply({ content: '✅ You already claimed this reward.', ephemeral: true });
    }
    if (!quest.completed) {
      return await interaction.reply({ content: '❌ This quest is not complete yet.', ephemeral: true });
    }

    quest.claimed = true;
    user.cash += quest.cashReward;
    if (!user.xpData) user.xpData = { xp: 0, messageCount: 0, lastMessage: 0 };
    user.xpData.xp += quest.xpReward;
    await saveUser(ownerId);

    const guildIdForCommunity = interaction.guildId;
    const community = guildIdForCommunity ? await ensureCommunityQuest(guildIdForCommunity) : null;
    if (community) community._guildId = guildIdForCommunity;
    const { embed, components } = buildQuestsPayload(user, dq, community, ownerId);
    await interaction.update({ embeds: [embed], components });

  }

  } catch (error) {
    console.error('Component interaction error:', error);

    try {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ 
          content: '❌ An error occurred while processing your request. Please try again.', 
          ephemeral: true 
        });
      } else if (interaction.deferred) {
        await interaction.followUp({
          content: '❌ An error occurred while processing your request. Please try again.',
          ephemeral: true
        });
      }
    } catch (replyError) {
      console.error('Failed to send error response:', replyError);
    }
  }
}

async function startInteractiveTrade(interaction, initiatorId, recipientId, tradeId) {
  const trade = global.activeTrades[tradeId];
  if (!trade) return;

  const tradeEmbed = createTradeEmbed(trade, initiatorId, recipientId);
  const components = createTradeComponents(tradeId);

  await interaction.update({ embeds: [tradeEmbed], components });
  trade.message = interaction.message;
}

async function refreshTradeMessage(trade) {
  if (!trade.message) return;
  try {
    await trade.message.edit({
      embeds: [createTradeEmbed(trade, trade.initiator, trade.recipient)],
      components: createTradeComponents(`${trade.initiator}-${trade.recipient}`)
    });
  } catch (e) {
    console.error('Failed to refresh trade message:', e.message);
  }
}

function parseCashInput(raw) {
  const s = (raw || '').replace(/[$,\s]/g, '').toLowerCase();
  if (!s) return 0;
  if (s.endsWith('m')) {
    const n = parseFloat(s);
    return isNaN(n) ? NaN : Math.floor(n * 1_000_000);
  }
  if (s.endsWith('k')) {
    const n = parseFloat(s);
    return isNaN(n) ? NaN : Math.floor(n * 1_000);
  }
  return parseInt(s, 10);
}

function tradeMatchesQuery(name, query) {
  if (!query) return true;
  const clean = (name.startsWith('✨ SHINY ') && name.endsWith(' ✨'))
    ? name.replace('✨ SHINY ', '').replace(' ✨', '')
    : name;
  const q = query.toLowerCase();
  return clean.toLowerCase().includes(q) || name.toLowerCase().includes(q);
}

function buildTradePickerComponents(tradeId, picker, entries, valueKey) {
  const PAGE_SIZE = 25;
  const query = (picker.query || '').trim();
  const filtered = query ? entries.filter(([name]) => tradeMatchesQuery(name, query)) : entries;
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  if (typeof picker.page !== 'number' || picker.page < 0) picker.page = 0;
  if (picker.page >= totalPages) picker.page = totalPages - 1;
  const pageStart = picker.page * PAGE_SIZE;
  const pageEntries = filtered.slice(pageStart, pageStart + PAGE_SIZE);
  const rows = [];

  if (pageEntries.length > 0) {
    const options = pageEntries.map(([name, count]) => {
      const rarity = getRarityByArtefact(name);
      const tier = getArtefactTier(name);
      const val = calcArtefactTradeValue(name, rarity);
      const isShiny = name.startsWith('✨ SHINY ') && name.endsWith(' ✨');
      const safeValue = name.length > 100 ? name.slice(0, 100) : name;
      return {
        label: name.length > 100 ? name.slice(0, 97) + '...' : name,
        description: `${rarity ? rarity.name : 'Unknown'} T${tier}${isShiny ? ' ✨5×' : ''} — ~$${val.toLocaleString()} (${count} ${picker.mode === 'add' ? 'available' : 'in offer'})`,
        value: safeValue
      };
    });
    const selectId = picker.mode === 'add'
      ? `trade_artefact_select_${tradeId}`
      : `trade_remove_artefact_select_${tradeId}`;
    const placeholder = totalPages > 1
      ? `${picker.mode === 'add' ? 'Choose an artefact' : 'Choose to remove'} (page ${picker.page + 1} of ${totalPages})`
      : (picker.mode === 'add' ? 'Choose an artefact to add' : 'Choose an artefact to remove');
    rows.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(selectId)
        .setPlaceholder(placeholder)
        .addOptions(options)
    ));
  }

  const showSearchRow = entries.length > 0 && (entries.length > PAGE_SIZE || query.length > 0);
  if (showSearchRow) {
    const searchLabel = query
      ? `🔍 Search: "${query.length > 18 ? query.slice(0, 15) + '...' : query}"`
      : '🔍 Search';
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`trade_picker_search_${tradeId}`)
        .setLabel(searchLabel)
        .setStyle(query ? ButtonStyle.Success : ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`trade_picker_clear_${tradeId}`)
        .setLabel('Clear Search')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(!query),
      new ButtonBuilder()
        .setCustomId(`trade_picker_prev_${tradeId}`)
        .setLabel('◀ Prev')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(totalPages <= 1 || picker.page === 0),
      new ButtonBuilder()
        .setCustomId(`trade_picker_next_${tradeId}`)
        .setLabel('Next ▶')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(totalPages <= 1 || picker.page >= totalPages - 1)
    ));
  }

  return { rows, totalPages, filteredCount: filtered.length };
}

function buildTradePickerEmbed(picker, filteredCount, totalEntries) {
  const query = (picker.query || '').trim();
  const title = picker.mode === 'add' ? 'Add Artefact to Trade' : 'Remove Artefact from Offer';
  const desc = picker.mode === 'add'
    ? 'Pick an artefact from your inventory to add to your trade offer. You can stack multiples — pick the same name again to add another copy.'
    : 'Pick an artefact currently in your trade offer to remove it.';
  const fields = [];
  if (query) {
    fields.push({
      name: '🔍 Search Filter',
      value: `\`${query}\` — **${filteredCount}** match${filteredCount !== 1 ? 'es' : ''} (of ${totalEntries} total)`,
      inline: false
    });
  }
  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(desc)
    .addFields(...fields)
    .setColor(0x5865F2)
    .setFooter({ text: 'This menu only you can see. Pick as many times as you want.' });
}

function computeTradePickerEntries(trade, userId, picker) {
  if (picker.mode === 'add') {
    const userArtefacts = userData[userId] && userData[userId].artefacts ? userData[userId].artefacts : [];
    const offer = trade.initiator === userId ? trade.initiatorOffer : trade.recipientOffer;
    const ownedCounts = {};
    userArtefacts.forEach(n => { ownedCounts[n] = (ownedCounts[n] || 0) + 1; });
    offer.artefacts.forEach(n => { if (ownedCounts[n]) ownedCounts[n] -= 1; });
    return Object.entries(ownedCounts).filter(([, c]) => c > 0);
  }
  const offer = trade.initiator === userId ? trade.initiatorOffer : trade.recipientOffer;
  const offerCounts = {};
  offer.artefacts.forEach(n => { offerCounts[n] = (offerCounts[n] || 0) + 1; });
  return Object.entries(offerCounts);
}

function buildTradePickerPayload(trade, userId) {
  const picker = trade.pickers && trade.pickers[userId];
  if (!picker) return { embeds: [], components: [] };
  const entries = computeTradePickerEntries(trade, userId, picker);
  const tradeId = `${trade.initiator}-${trade.recipient}`;
  const { rows, filteredCount } = buildTradePickerComponents(tradeId, picker, entries, 'name');
  return {
    embeds: [buildTradePickerEmbed(picker, filteredCount, entries.length)],
    components: rows
  };
}

async function refreshTradePicker(trade, userId) {
  const picker = trade.pickers && trade.pickers[userId];
  if (!picker || !picker.message) return;
  try {
    await picker.message.edit(buildTradePickerPayload(trade, userId));
  } catch (e) {
  }
}

function calcOfferValue(offer) {
  let total = offer.cash;
  for (const name of offer.artefacts) {
    const rarity = getRarityByArtefact(name);
    total += calcArtefactTradeValue(name, rarity);
  }
  return total;
}

function formatOfferDetailed(offer) {
  const lines = [];
  if (offer.cash > 0) lines.push(`💰 **Cash** — $${offer.cash.toLocaleString()}`);

  const counts = {};
  const order = [];
  for (const name of offer.artefacts) {
    if (!counts[name]) { counts[name] = 0; order.push(name); }
    counts[name]++;
  }

  for (const name of order) {
    const count = counts[name];
    const rarity = getRarityByArtefact(name);
    const tier = getArtefactTier(name);
    const val = calcArtefactTradeValue(name, rarity);
    const rarityName = rarity ? rarity.name : 'Unknown';
    const isShiny = name.startsWith('✨ SHINY ') && name.endsWith(' ✨');
    const shinyTag = isShiny ? ' ✨5×' : '';
    if (count > 1) {
      const totalVal = val * count;
      lines.push(`${name}${shinyTag} ×${count} (${rarityName}, T${tier}, ~$${val.toLocaleString()} ea / ~$${totalVal.toLocaleString()} total)`);
    } else {
      lines.push(`${name}${shinyTag} (${rarityName}, T${tier}, ~$${val.toLocaleString()})`);
    }
  }

  if (lines.length === 0) return '*Nothing offered yet*';
  const joined = lines.join('\n');
  if (joined.length <= 1024) return joined;
  const truncated = [];
  let len = 0;
  for (const line of lines) {
    if (len + line.length + 1 > 980) { truncated.push(`… and ${lines.length - truncated.length} more`); break; }
    truncated.push(line);
    len += line.length + 1;
  }
  return truncated.join('\n');
}

function formatOffer(offer) {
  const parts = [];
  if (offer.cash > 0) parts.push(`$${offer.cash.toLocaleString()}`);
  if (offer.artefacts.length > 0) parts.push(offer.artefacts.join(', '));
  return parts.join('\n') || 'Nothing';
}

function createTradeEmbed(trade, initiatorId, recipientId) {
  const initiatorOfferText = formatOfferDetailed(trade.initiatorOffer);
  const recipientOfferText = formatOfferDetailed(trade.recipientOffer);
  const initiatorValue = calcOfferValue(trade.initiatorOffer);
  const recipientValue = calcOfferValue(trade.recipientOffer);

  const initiatorStatus = trade.initiatorReady ? '✅ **Ready**' : '⏳ Preparing';
  const recipientStatus = trade.recipientReady ? '✅ **Ready**' : '⏳ Preparing';

  let balanceText = '';
  if (initiatorValue > 0 || recipientValue > 0) {
    const diff = initiatorValue - recipientValue;
    if (Math.abs(diff) < 100) {
      balanceText = '\n⚖️ *Offers are roughly equal in value.*';
    } else if (diff > 0) {
      balanceText = `\n⚖️ *Initiator's offer is ~$${Math.abs(diff).toLocaleString()} higher in value.*`;
    } else {
      balanceText = `\n⚖️ *Recipient's offer is ~$${Math.abs(diff).toLocaleString()} higher in value.*`;
    }
  }

  return new EmbedBuilder()
    .setTitle('🔄 Trade Session')
    .setDescription(`Both players may add artefacts and cash. Once **both** mark Ready, the trade executes automatically.${balanceText}`)
    .addFields(
      {
        name: `<@${initiatorId}>'s Offer  —  est. $${initiatorValue.toLocaleString()}`,
        value: initiatorOfferText,
        inline: true
      },
      {
        name: `<@${recipientId}>'s Offer  —  est. $${recipientValue.toLocaleString()}`,
        value: recipientOfferText,
        inline: true
      },
      {
        name: 'Status',
        value: `<@${initiatorId}>  —  ${initiatorStatus}\n<@${recipientId}>  —  ${recipientStatus}`,
        inline: false
      }
    )
    .setColor(trade.initiatorReady && trade.recipientReady ? 0x00FF7F : 0x1a3a5c)
    .setFooter({ text: 'Trade expires after 10 minutes of inactivity' })
    .setTimestamp();
}

function getTradeStatus(trade) {
  if (trade.initiatorReady && trade.recipientReady) return '**Both players ready** — Trade will complete automatically';
  if (trade.initiatorReady) return 'Initiator ready, waiting for recipient';
  if (trade.recipientReady) return 'Recipient ready, waiting for initiator';
  return 'Setting up offers...';
}

function createTradeComponents(tradeId) {
  const trade = global.activeTrades[tradeId];
  if (!trade) return [];

  const bothReady = trade.initiatorReady && trade.recipientReady;

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`trade_add_cash_${tradeId}`)
      .setLabel('Add Cash')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(bothReady),
    new ButtonBuilder()
      .setCustomId(`trade_add_artefact_${tradeId}`)
      .setLabel('Add Artefact')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(bothReady),
    new ButtonBuilder()
      .setCustomId(`trade_remove_cash_${tradeId}`)
      .setLabel('Remove Cash')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(bothReady),
    new ButtonBuilder()
      .setCustomId(`trade_remove_artefact_${tradeId}`)
      .setLabel('Remove Artefact')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(bothReady)
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`trade_ready_${tradeId}`)
      .setLabel('Mark Ready')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(bothReady),
    new ButtonBuilder()
      .setCustomId(`trade_cancel_${tradeId}`)
      .setLabel('Cancel Trade')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(bothReady)
  );

  return [row1, row2];
}

async function handleTradeAddCash(interaction, customId) {
  const tradeId = customId.replace('trade_add_cash_', '');
  const trade = global.activeTrades[tradeId];
  if (!trade) {
    return await interaction.reply({ content: 'Trade session not found.', ephemeral: true });
  }

  const userId = interaction.user.id;
  if (userId !== trade.initiator && userId !== trade.recipient) {
    return await interaction.reply({ content: 'You are not part of this trade.', ephemeral: true });
  }

  const isInitiator = trade.initiator === userId;

  if ((isInitiator && trade.initiatorReady) || (!isInitiator && trade.recipientReady)) {
    return await interaction.reply({ content: 'You cannot modify your offer after marking ready!', ephemeral: true });
  }

  const offer = isInitiator ? trade.initiatorOffer : trade.recipientOffer;
  const userBalance = (userData[userId] && userData[userId].cash) || 0;
  const currentCash = offer.cash || 0;

  const modal = new ModalBuilder()
    .setCustomId(`trade_cash_modal_${tradeId}`)
    .setTitle('Set Cash Offer');

  const cashInput = new TextInputBuilder()
    .setCustomId('cash_amount')
    .setLabel(`Balance: $${userBalance.toLocaleString()} — enter 0 to clear`)
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('e.g. 500, 1.5k, 2m')
    .setRequired(false)
    .setMaxLength(15)
    .setValue(currentCash > 0 ? String(currentCash) : '');

  const row = new ActionRowBuilder().addComponents(cashInput);
  modal.addComponents(row);

  await interaction.showModal(modal);
}

async function handleTradeAddArtefact(interaction, customId) {
  const tradeId = customId.replace('trade_add_artefact_', '');
  const trade = global.activeTrades[tradeId];
  if (!trade) {
    return await interaction.reply({ content: 'Trade session not found.', ephemeral: true });
  }

  const userId = interaction.user.id;
  if (userId !== trade.initiator && userId !== trade.recipient) {
    return await interaction.reply({ content: 'You are not part of this trade.', ephemeral: true });
  }

  const userArtefacts = (userData[userId] && userData[userId].artefacts) || [];
  if (userArtefacts.length === 0) {
    return await interaction.reply({ content: 'You have no artefacts to trade!', ephemeral: true });
  }

  const offer = trade.initiator === userId ? trade.initiatorOffer : trade.recipientOffer;
  const ownedCounts = {};
  userArtefacts.forEach(n => { ownedCounts[n] = (ownedCounts[n] || 0) + 1; });
  offer.artefacts.forEach(n => { if (ownedCounts[n]) ownedCounts[n] -= 1; });
  const entries = Object.entries(ownedCounts).filter(([, c]) => c > 0);

  if (entries.length === 0) {
    return await interaction.reply({ content: 'All your artefacts are already in this offer!', ephemeral: true });
  }

  if (!trade.pickers) trade.pickers = {};
  const picker = { mode: 'add', query: '', page: 0, message: null };
  trade.pickers[userId] = picker;

  const { rows, filteredCount } = buildTradePickerComponents(tradeId, picker, entries, 'name');

  const reply = await interaction.reply({
    embeds: [buildTradePickerEmbed(picker, filteredCount, entries.length)],
    components: rows,
    ephemeral: true,
    fetchReply: true
  });
  picker.message = reply;
}

async function handleTradeRemoveCash(interaction, customId) {
  const tradeId = customId.replace('trade_remove_cash_', '');
  const trade = global.activeTrades[tradeId];
  if (!trade) {
    return await interaction.reply({ content: 'Trade session not found.', ephemeral: true });
  }

  const userId = interaction.user.id;
  if (userId !== trade.initiator && userId !== trade.recipient) {
    return await interaction.reply({ content: 'You are not part of this trade.', ephemeral: true });
  }

  const isInitiator = trade.initiator === userId;

  if ((isInitiator && trade.initiatorReady) || (!isInitiator && trade.recipientReady)) {
    return await interaction.reply({ content: 'You cannot modify your offer after marking ready!', ephemeral: true });
  }

  if (isInitiator) {
    trade.initiatorOffer.cash = 0;
    trade.initiatorReady = false;
  } else {
    trade.recipientOffer.cash = 0;
    trade.recipientReady = false;
  }

  const tradeEmbed = createTradeEmbed(trade, trade.initiator, trade.recipient);
  const components = createTradeComponents(tradeId);

  await interaction.update({ embeds: [tradeEmbed], components });
}

async function handleTradeRemoveArtefact(interaction, customId) {
  const tradeId = customId.replace('trade_remove_artefact_', '');
  const trade = global.activeTrades[tradeId];
  if (!trade) {
    return await interaction.reply({ content: 'Trade session not found.', ephemeral: true });
  }

  const userId = interaction.user.id;
  if (userId !== trade.initiator && userId !== trade.recipient) {
    return await interaction.reply({ content: 'You are not part of this trade.', ephemeral: true });
  }

  const userOffer = trade.initiator === userId ? trade.initiatorOffer : trade.recipientOffer;
  if (userOffer.artefacts.length === 0) {
    return await interaction.reply({ content: 'You have no artefacts in your offer to remove!', ephemeral: true });
  }

  const offerCounts = {};
  userOffer.artefacts.forEach(n => { offerCounts[n] = (offerCounts[n] || 0) + 1; });
  const entries = Object.entries(offerCounts);

  if (!trade.pickers) trade.pickers = {};
  const picker = { mode: 'remove', query: '', page: 0, message: null };
  trade.pickers[userId] = picker;

  const { rows, filteredCount } = buildTradePickerComponents(tradeId, picker, entries, 'name');

  const reply = await interaction.reply({
    embeds: [buildTradePickerEmbed(picker, filteredCount, entries.length)],
    components: rows,
    ephemeral: true,
    fetchReply: true
  });
  picker.message = reply;
}

async function handleTradeReady(interaction, customId) {
  const tradeId = customId.replace('trade_ready_', '');
  const trade = global.activeTrades[tradeId];
  if (!trade) {
    return await interaction.reply({ content: 'Trade session not found.', ephemeral: true });
  }

  const userId = interaction.user.id;
  if (userId !== trade.initiator && userId !== trade.recipient) {
    return await interaction.reply({ content: 'You are not part of this trade.', ephemeral: true });
  }

  const isInitiator = trade.initiator === userId;

  if ((isInitiator && trade.initiatorReady) || (!isInitiator && trade.recipientReady)) {
    return await interaction.reply({ content: 'You are already marked ready.', ephemeral: true });
  }

  const userOffer = isInitiator ? trade.initiatorOffer : trade.recipientOffer;
  const userRecord = userData[userId] || { cash: 0, artefacts: [] };

  if (userOffer.cash > (userRecord.cash || 0)) {
    return await interaction.reply({
      content: `❌ You don't have enough cash! You're offering $${userOffer.cash.toLocaleString()} but only have $${(userRecord.cash || 0).toLocaleString()}`,
      ephemeral: true
    });
  }

  const _offerCounts = {};
  userOffer.artefacts.forEach(a => { _offerCounts[a] = (_offerCounts[a] || 0) + 1; });
  const _invCounts = {};
  (userRecord.artefacts || []).forEach(a => { _invCounts[a] = (_invCounts[a] || 0) + 1; });
  for (const [name, want] of Object.entries(_offerCounts)) {
    const have = _invCounts[name] || 0;
    if (have < want) {
      return await interaction.reply({
        content: `You're offering ${want}× **${name}** but only have ${have} in your inventory.`,
        ephemeral: true
      });
    }
  }

  if (isInitiator) {
    trade.initiatorReady = true;
  } else {
    trade.recipientReady = true;
  }

  if (trade.initiatorReady && trade.recipientReady) {
    await executeTrade(interaction, trade, tradeId);
  } else {
    const tradeEmbed = createTradeEmbed(trade, trade.initiator, trade.recipient);
    const components = createTradeComponents(tradeId);
    await interaction.update({ embeds: [tradeEmbed], components });
  }
}

async function executeTrade(interaction, trade, tradeId) {
  const initiator = userData[trade.initiator];
  const recipient = userData[trade.recipient];

  try {
    if (trade.initiatorOffer.cash > initiator.cash) {
      throw new Error(`Initiator doesn't have enough cash`);
    }
    if (trade.recipientOffer.cash > recipient.cash) {
      throw new Error(`Recipient doesn't have enough cash`);
    }

    const _validateCounts = (offer, inventory, who) => {
      const need = {};
      offer.artefacts.forEach(a => { need[a] = (need[a] || 0) + 1; });
      const have = {};
      inventory.forEach(a => { have[a] = (have[a] || 0) + 1; });
      for (const [name, want] of Object.entries(need)) {
        if ((have[name] || 0) < want) {
          throw new Error(`${who} only has ${have[name] || 0}× ${name} but offered ${want}`);
        }
      }
    };
    _validateCounts(trade.initiatorOffer, initiator.artefacts || [], 'Initiator');
    _validateCounts(trade.recipientOffer, recipient.artefacts || [], 'Recipient');

    initiator.cash -= trade.initiatorOffer.cash;
    initiator.cash += trade.recipientOffer.cash;
    recipient.cash -= trade.recipientOffer.cash;
    recipient.cash += trade.initiatorOffer.cash;

    trade.initiatorOffer.artefacts.forEach(artefact => {
      const index = initiator.artefacts.indexOf(artefact);
      if (index > -1) {
        initiator.artefacts.splice(index, 1);
        recipient.artefacts.push(artefact);
      }
    });

    trade.recipientOffer.artefacts.forEach(artefact => {
      const index = recipient.artefacts.indexOf(artefact);
      if (index > -1) {
        recipient.artefacts.splice(index, 1);
        initiator.artefacts.push(artefact);
      }
    });

    await saveUser(trade.initiator);
    await saveUser(trade.recipient);
    delete global.activeTrades[tradeId];

    const successEmbed = new EmbedBuilder()
      .setTitle('Trade Complete')
      .setDescription('All items have been exchanged successfully.')
      .addFields(
        { name: 'Initiator Received', value: formatOffer(trade.recipientOffer) || '*Nothing*', inline: true },
        { name: 'Recipient Received', value: formatOffer(trade.initiatorOffer) || '*Nothing*', inline: true }
      )
      .setColor(0x00FF7F)
      .setTimestamp();

    await interaction.update({ embeds: [successEmbed], components: [] });

    await updateQuestProgress(trade.initiator, interaction.guildId, 'tradeComplete', 1);
    await updateQuestProgress(trade.recipient, interaction.guildId, 'tradeComplete', 1);

    await closeTradePickers(trade, 'Trade Complete', 'This trade has been completed.', 0x00FF7F);

  } catch (error) {
    console.error('Trade execution error:', error);

    const errorEmbed = new EmbedBuilder()
      .setTitle('❌ Trade Failed')
      .setDescription('The trade could not be completed due to validation errors.')
      .addFields(
        { name: 'Error', value: error.message, inline: false },
        { name: 'Action Required', value: 'Please restart the trade with updated offers', inline: false }
      )
      .setColor(0xFF6B6B)
      .setTimestamp();

    await interaction.update({ embeds: [errorEmbed], components: [] });
    delete global.activeTrades[tradeId];

    await closeTradePickers(trade, 'Trade Failed', 'This trade was cancelled due to a validation error.', 0xFF6B6B);
  }
}

async function closeTradePickers(trade, title, description, color) {
  if (!trade || !trade.pickers) return;
  for (const pickerUserId of Object.keys(trade.pickers)) {
    const picker = trade.pickers[pickerUserId];
    if (!picker || !picker.message) continue;
    try {
      await picker.message.edit({
        embeds: [new EmbedBuilder().setTitle(title).setDescription(description).setColor(color)],
        components: []
      });
    } catch (e) {
    }
  }
}

async function handleTradeCancel(interaction, customId) {
  const tradeId = customId.replace('trade_cancel_', '');
  const trade = global.activeTrades[tradeId];

  if (!trade) {
    return await interaction.reply({ content: 'Trade session not found.', ephemeral: true });
  }

  const userId = interaction.user.id;
  if (userId !== trade.initiator && userId !== trade.recipient) {
    return await interaction.reply({ content: 'Only trade participants can cancel this trade.', ephemeral: true });
  }

  delete global.activeTrades[tradeId];

  const cancelEmbed = new EmbedBuilder()
    .setTitle('Trade Cancelled')
    .setDescription(`Cancelled by <@${interaction.user.id}>. No items were exchanged.`)
    .setColor(0xFF9F43)
    .setTimestamp();

  await interaction.update({ embeds: [cancelEmbed], components: [] });

  await closeTradePickers(trade, 'Trade Cancelled', 'This trade was cancelled.', 0xFF9F43);
}


async function handleFishCommand(interaction, userId) {
  await getUser(userId);
  const now = Date.now();

  if (!cooldowns.fish) cooldowns.fish = {};
  if (cooldowns.fish[userId] && (now - cooldowns.fish[userId]) < FISH_COOLDOWN) {
    const timeLeft = FISH_COOLDOWN - (now - cooldowns.fish[userId]);
    const minutes = Math.floor(timeLeft / 60000);
    const seconds = Math.floor((timeLeft % 60000) / 1000);
    return await interaction.editReply({ embeds: [
      new EmbedBuilder()
        .setTitle('🎣 Fishing Cooldown')
        .setDescription('You need to let the fish recover before casting again.')
        .addFields(
          { name: 'Time Remaining', value: `${minutes}m ${seconds}s`, inline: true },
          { name: 'Cooldown', value: '20 minutes', inline: true }
        )
        .setColor(0xFF9F43)
        .setTimestamp()
    ]});
  }

  const userItems = userData[userId].items || [];
  const baitOrder = ['Gilded Hook', 'Salted Lure', 'Cricket', 'Earthworm'];
  let baitUsed = null;

  const chosenBait = (interaction.options.getString('bait') || '').trim();
  if (chosenBait) {
    const matchedBait = Object.keys(BAIT_CATALOG).find(b => b.toLowerCase() === chosenBait.toLowerCase());
    if (!matchedBait) {
      return await interaction.editReply({ embeds: [
        new EmbedBuilder()
          .setTitle('Unknown Bait')
          .setDescription(`"${chosenBait}" isn't a recognised bait type.`)
          .addFields({ name: 'Available Baits', value: Object.values(BAIT_CATALOG).map(b => `${b.emoji} ${b.name}`).join('\n'), inline: false })
          .setColor(0xFF6B6B)
      ]});
    }
    if (!userItems.includes(matchedBait)) {
      return await interaction.editReply({ embeds: [
        new EmbedBuilder()
          .setTitle(`You don't have any ${matchedBait}`)
          .setDescription(`Buy bait from the **Minigame Supplies** tab in \`/store\`, then come back.`)
          .setColor(0xFF6B6B)
      ]});
    }
    baitUsed = matchedBait;
  } else {
    for (const b of baitOrder) {
      if (userItems.includes(b)) { baitUsed = b; break; }
    }
  }

  if (!baitUsed) {
    return await interaction.editReply({ embeds: [
      new EmbedBuilder()
        .setTitle('🎣 No Bait!')
        .setDescription('You need bait to go fishing.\n\nHead to `/store` → **Minigame Supplies** to pick some up.')
        .addFields({ name: 'Bait Options', value: Object.values(BAIT_CATALOG).map(b => `${b.emoji} **${b.name}** — $${b.basePrice.toLocaleString()}`).join('\n'), inline: false })
        .setColor(0xFF9F43)
        .setTimestamp()
    ]});
  }

  const baitIdx = userData[userId].items.indexOf(baitUsed);
  userData[userId].items.splice(baitIdx, 1);

  const tier = rollFishTier(baitUsed);
  const fish = pickFish(tier);
  const cashValue = rollFishValue(fish);

  const artefactChances = { junk: 0, common: 0, uncommon: 0.10, rare: 0.40, legendary: 1.0 };
  let artefactDrop = null;
  if (Math.random() < (artefactChances[tier] || 0)) {
    const currentRarities = await getModifiedArtefactChances();
    const totalChance = currentRarities.reduce((sum, r) => sum + r.chance, 0);
    let r = Math.random() * totalChance;
    let selectedRarity = currentRarities[0];
    for (const rarity of currentRarities) {
      r -= rarity.chance;
      if (r <= 0) { selectedRarity = rarity; break; }
    }
    if (selectedRarity && selectedRarity.items.length > 0) {
      artefactDrop = selectedRarity.items[Math.floor(Math.random() * selectedRarity.items.length)];
    }
  }

  const sessionId = `${userId}-${now}`;
  global.activeFishSessions[sessionId] = { userId, tier, fish, cashValue, baitUsed, artefactDrop, expiresAt: now + 90000 };

  cooldowns.fish[userId] = now;
  await saveUserData();
  await saveCooldowns();

  const tierFlavors = {
    junk:      { text: 'The line goes slack almost immediately... something\'s down there, but it feels wrong.', hint: 'Whatever is on the hook feels oddly light.', color: 0x95A5A6 },
    common:    { text: 'A small tug. Something is nibbling at the hook.',                                       hint: 'Feels light — probably a smaller one.',     color: 0x74B9FF },
    uncommon:  { text: 'A firm, steady pull! Something is fighting back!',                                      hint: 'This one has some weight to it.',            color: 0x6C5CE7 },
    rare:      { text: 'WHOA — the rod bends hard! This is a massive catch!',                                   hint: 'Something very powerful is down there.',    color: 0xFDCB6E },
    legendary: { text: 'THE ROD SNAPS TAUT — THE WATER ERUPTS — SOMETHING ENORMOUS IS ON THE LINE!',            hint: '...You\'ve never felt a pull like this.',   color: 0xFF7675 }
  };
  const flavor = tierFlavors[tier];
  const baitInfo = BAIT_CATALOG[baitUsed];

  const castEmbed = new EmbedBuilder()
    .setTitle('🎣 Line Cast...')
    .setDescription(`You lower a **${baitInfo.emoji} ${baitUsed}** into the murky water.\n\n*${flavor.text}*`)
    .addFields({ name: 'What You Feel', value: flavor.hint, inline: false })
    .setColor(flavor.color)
    .setFooter({ text: `Session expires in 90 seconds • Bait used: ${baitUsed}` })
    .setTimestamp();

  const reelRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`fish_reel_${sessionId}`)
      .setLabel('🎣 Reel In!')
      .setStyle(ButtonStyle.Primary)
  );

  await interaction.editReply({ embeds: [castEmbed], components: [reelRow] });

  setTimeout(async () => {
    if (!global.activeFishSessions[sessionId]) return;
    delete global.activeFishSessions[sessionId];
    try {
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle('🎣 The Fish Got Away...')
            .setDescription('You waited too long to reel in — the fish shook the hook and escaped.')
            .setColor(0x95A5A6)
            .setTimestamp()
        ],
        components: []
      });
    } catch (e) {}
  }, 90000);
}

async function handleReelIn(interaction, sessionId) {
  const session = global.activeFishSessions[sessionId];

  if (!session) {
    return await interaction.update({
      embeds: [
        new EmbedBuilder()
          .setTitle('Session Expired')
          .setDescription('This fishing session has already ended. Cast your line again with `/fish`!')
          .setColor(0x95A5A6)
          .setTimestamp()
      ],
      components: []
    });
  }

  if (interaction.user.id !== session.userId) {
    return await interaction.reply({ content: 'That\'s not your fishing line!', ephemeral: true });
  }

  delete global.activeFishSessions[sessionId];

  const { tier, fish, cashValue, baitUsed, artefactDrop, userId } = session;

  userData[userId].cash += cashValue;
  if (artefactDrop) {
    if (!userData[userId].artefacts) userData[userId].artefacts = [];
    if (!userData[userId].discoveredArtefacts) userData[userId].discoveredArtefacts = [];
    userData[userId].artefacts.push(artefactDrop);
    if (!userData[userId].discoveredArtefacts.includes(artefactDrop)) {
      userData[userId].discoveredArtefacts.push(artefactDrop);
    }
  }

  await updateQuestProgress(userId, interaction.guildId, 'fish', 1);
  if (artefactDrop) {
    const dropIsShiny = artefactDrop.startsWith('✨ SHINY ') && artefactDrop.endsWith(' ✨');
    const dropRarity = getRarityByArtefact(artefactDrop);
    if (dropRarity && ['3-Star', '4-Star', '5-Star'].includes(dropRarity.name)) {
      await updateQuestProgress(userId, interaction.guildId, 'find3StarPlus', 1);
    }
    if (dropIsShiny) {
      await updateQuestProgress(userId, interaction.guildId, 'findShiny', 1);
    }
  }
  await saveUserData();

  const tierColors  = { junk: 0x95A5A6, common: 0x74B9FF, uncommon: 0x6C5CE7, rare: 0xFDCB6E, legendary: 0xFF7675 };
  const tierLabels  = { junk: 'Junk', common: 'Common', uncommon: 'Uncommon', rare: 'Rare', legendary: '✨ LEGENDARY' };
  const tierTitles  = {
    junk:      `You pulled out ${fish.emoji} ${fish.name}...`,
    common:    `Caught a ${fish.emoji} ${fish.name}!`,
    uncommon:  `Nice catch! ${fish.emoji} ${fish.name}!`,
    rare:      `Incredible! ${fish.emoji} ${fish.name}!`,
    legendary: `🌊 LEGENDARY CATCH! 🌊\n${fish.emoji} ${fish.name}`
  };

  const baitInfo = BAIT_CATALOG[baitUsed];
  const fields = [
    { name: 'Rarity',    value: tierLabels[tier],                                        inline: true },
    { name: 'Bait Used', value: `${baitInfo?.emoji || ''} ${baitUsed}`,                  inline: true }
  ];
  if (cashValue > 0) {
    fields.push({ name: 'Cash Earned', value: `$${cashValue.toLocaleString()}`, inline: true });
  } else {
    fields.push({ name: 'Cash Earned', value: 'Nothing — classic junk.', inline: true });
  }
  if (artefactDrop) {
    fields.push({ name: '🏺 Bonus Find!', value: `Embedded in the catch: **${artefactDrop}**\nAdded to your artefact collection!`, inline: false });
  }

  const revealEmbed = new EmbedBuilder()
    .setTitle(tierTitles[tier])
    .setDescription(`*${fish.description}*`)
    .addFields(...fields)
    .setColor(tierColors[tier])
    .setFooter({ text: 'Fishing cooldown: 20 min • /store → Minigame Supplies for more bait' })
    .setTimestamp();

  await interaction.update({ embeds: [revealEmbed], components: [] });
}


async function handleMarbleGame(interaction) {
  const userId = interaction.user.id;
  const player2 = interaction.options.getUser('player2');
  const player3 = interaction.options.getUser('player3');
  const player4 = interaction.options.getUser('player4');

  const players = [interaction.user, player2, player3, player4];
  const uniquePlayerIds = new Set(players.map(p => p.id));

  if (uniquePlayerIds.size !== 4) {
    return await interaction.reply({ content: '❌ All four players must be different users!', ephemeral: true });
  }
  if (players.some(p => p.bot)) {
    return await interaction.reply({ content: '❌ Bots cannot participate in marble games!', ephemeral: true });
  }

  const existingGame = Object.values(global.activeMarbleGames).find(game =>
    game.players.some(p => players.some(player => player.id === p.id))
  );
  if (existingGame) {
    return await interaction.reply({ content: '❌ One or more players are already in an active marble game!', ephemeral: true });
  }

  const gameId = `${userId}_${Date.now()}`;
  global.activeMarbleGames[gameId] = {
    gameId,
    initiator: interaction.user,
    players,
    invited: [player2, player3, player4],
    accepted: [],
    declined: [],
    pendingBets: {},
    betAmount: 0,
    totalPot: 0,
    betsCollected: false,
    phase: 'invitation',
    round: 0,
    createdAt: Date.now(),
    gameMessage: null,
    roundHistory: []
  };

  const invitationEmbed = createInvitationEmbed(global.activeMarbleGames[gameId]);
  const buttons = createInvitationButtons(gameId);

  await interaction.reply({ embeds: [invitationEmbed], components: [buttons] });

  setTimeout(() => {
    const game = global.activeMarbleGames[gameId];
    if (game && game.phase === 'invitation') {
      delete global.activeMarbleGames[gameId];
      interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle('⏰ Marble Game Expired')
            .setDescription('The invitation was not accepted by all players in time.')
            .setColor(0x99AAB5)
            .setTimestamp()
        ],
        components: []
      }).catch(() => {});
    }
  }, 120000);
}

function marbleBar(count, max = 10) {
  const filled = Math.round((count / max) * 10);
  const empty = 10 - filled;
  return '🟣'.repeat(Math.max(0, filled)) + '⬛'.repeat(Math.max(0, empty)) + ` **${count}**`;
}

function createInvitationEmbed(game) {
  const pending = game.invited.filter(p =>
    !game.accepted.includes(p.id) && !game.declined.includes(p.id)
  );
  const accepted = game.accepted;

  return new EmbedBuilder()
    .setTitle('🎲 Marble Game — Challenge Issued')
    .setDescription(
      `**${game.initiator.displayName}** has challenged three players to a marble gambling match!\n\n` +
      `All invited players must accept within **2 minutes** to begin.`
    )
    .addFields(
      {
        name: '👑 Host',
        value: `<@${game.initiator.id}>`,
        inline: true
      },
      {
        name: '✅ Accepted',
        value: accepted.length > 0 ? accepted.map(id => `<@${id}>`).join('\n') : '*None yet*',
        inline: true
      },
      {
        name: '⏳ Waiting On',
        value: pending.length > 0 ? pending.map(p => `<@${p.id}>`).join('\n') : '*All responded!*',
        inline: true
      },
      {
        name: '📖 How It Works',
        value:
          '> • 4 players split into **2 teams of 2**\n' +
          '> • Each team starts with **5 marbles** (10 total)\n' +
          '> • Each round, both teams pick secret numbers **(1–20)**\n' +
          '> • A random number is drawn — whoever guessed it **steals a marble** from the other team\n' +
          '> • First team to collect **all 10** (or drain the other to 0) wins the pot\n' +
          '> • Matching guesses are a tie — no transfer that round',
        inline: false
      }
    )
    .setColor(0xFF6B35)
    .setFooter({ text: '⏰ Invitation expires in 2 minutes' })
    .setTimestamp();
}

function createInvitationButtons(gameId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`marble_accept_${gameId}`)
      .setLabel('✅ Accept Challenge')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`marble_decline_${gameId}`)
      .setLabel('❌ Decline')
      .setStyle(ButtonStyle.Danger)
  );
}

async function startBettingPhase(interaction, gameId) {
  const game = global.activeMarbleGames[gameId];
  if (!game) return;

  game.phase = 'betting';

  const bettingEmbed = new EmbedBuilder()
    .setTitle('💰 Betting Phase')
    .setDescription(
      'All **4 players** must place their bets.\n' +
      'Every player must bet the **same amount** — if bets mismatch, they reset and you try again.'
    )
    .addFields(
      {
        name: '🎮 Players',
        value: game.players.map(p => `<@${p.id}>`).join('\n'),
        inline: true
      },
      {
        name: '🎯 Bets Placed',
        value: '*None yet*',
        inline: true
      },
      {
        name: '📋 Rules',
        value: '• Minimum bet: **$50**\n• All bets must match\n• Winning team splits the **full pot**',
        inline: false
      }
    )
    .setColor(0xFFD700)
    .setTimestamp();

  const betButton = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`place_bet_${gameId}`)
      .setLabel('💸 Place Bet')
      .setStyle(ButtonStyle.Primary)
  );

  await interaction.update({ embeds: [bettingEmbed], components: [betButton] });
}

async function handleBetModalSubmit(interaction, gameId) {
  const game = global.activeMarbleGames[gameId];
  if (!game) {
    return interaction.reply({ content: '❌ This game is no longer active.', ephemeral: true });
  }

  const userId = interaction.user.id;

  if (!game.players.some(p => p.id === userId)) {
    return interaction.reply({ content: '❌ You are not part of this game.', ephemeral: true });
  }

  if (game.pendingBets[userId] !== undefined) {
    return interaction.reply({ content: '❌ You have already placed your bet for this round.', ephemeral: true });
  }

  const betAmount = parseInt(interaction.fields.getTextInputValue('bet_amount_input'));

  if (isNaN(betAmount) || betAmount < 50) {
    return interaction.reply({ content: '❌ Minimum bet is **$50**. Please try again.', ephemeral: true });
  }

  await getUser(userId);
  if (userData[userId].cash < betAmount) {
    return interaction.reply({
      content: `❌ You only have **$${userData[userId].cash.toLocaleString()}** — not enough to bet $${betAmount.toLocaleString()}.`,
      ephemeral: true
    });
  }

  game.pendingBets[userId] = betAmount;

  const betsPlaced = Object.entries(game.pendingBets)
    .map(([id, bet]) => `<@${id}> → **$${bet.toLocaleString()}**`)
    .join('\n');
  const waiting = game.players.filter(p => game.pendingBets[p.id] === undefined);

  const updatedEmbed = new EmbedBuilder()
    .setTitle('💰 Betting Phase')
    .setDescription(
      Object.keys(game.pendingBets).length === game.players.length
        ? '✅ All bets received! Checking if they match...'
        : `Waiting for **${waiting.length}** more player(s) to bet...`
    )
    .addFields(
      {
        name: '✅ Bets Placed',
        value: betsPlaced,
        inline: true
      },
      {
        name: '⏳ Still Waiting',
        value: waiting.length > 0 ? waiting.map(p => `<@${p.id}>`).join('\n') : '*All in!*',
        inline: true
      }
    )
    .setColor(0xFFD700)
    .setTimestamp();

  await interaction.deferUpdate();
  await interaction.message.edit({ embeds: [updatedEmbed] });

  if (Object.keys(game.pendingBets).length === game.players.length) {
    const allBets = Object.values(game.pendingBets);
    const firstBet = allBets[0];

    if (allBets.every(b => b === firstBet)) {
      game.betAmount = firstBet;
      game.totalPot = firstBet * game.players.length;
      await collectBets(game);

      setTimeout(() => startMarbleGame(interaction, gameId), 1500);
    } else {
      game.pendingBets = {};
      const mismatchEmbed = new EmbedBuilder()
        .setTitle('💸 Bets Mismatch!')
        .setDescription(
          `Bets were not equal — all bets have been **reset**.\n` +
          `Everyone must bet the **same amount**. Click **Place Bet** to try again.`
        )
        .addFields({ name: 'Previous Bets', value: betsPlaced })
        .setColor(0xFF6B6B)
        .setTimestamp();

      const betButton = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`place_bet_${gameId}`)
          .setLabel('💸 Place Bet')
          .setStyle(ButtonStyle.Primary)
      );

      await interaction.message.edit({ embeds: [mismatchEmbed], components: [betButton] });
    }
  }
}

async function collectBets(game) {
  if (game.betsCollected) return;
  for (const player of game.players) {
    if (userData[player.id]) userData[player.id].cash -= game.betAmount;
  }
  game.betsCollected = true;
  await saveUserData();
}

async function startMarbleGame(interaction, gameId) {
  const game = global.activeMarbleGames[gameId];
  if (!game) return;

  const shuffledPlayers = [...game.players].sort(() => Math.random() - 0.5);
  game.teamA = shuffledPlayers.slice(0, 2);
  game.teamB = shuffledPlayers.slice(2, 4);
  game.teamAMarbles = 5;
  game.teamBMarbles = 5;
  game.phase = 'game';
  game.round = 1;
  game.playerGuesses = {};
  game.roundHistory = [];

  const coinFlip = Math.random() < 0.5 ? 'heads' : 'tails';
  game.currentTeam = coinFlip === 'heads' ? 'A' : 'B';
  game.firstTeam = game.currentTeam; // track which team voted first this round
  game.currentPlayerIndex = 0;
  game.channel = interaction.channel;

  const gameStartEmbed = createGameEmbed(game, coinFlip);
  const numberButton = createNumberSelectionButton(gameId);

  const msg = await game.channel.send({ embeds: [gameStartEmbed], components: [numberButton] });
  game.gameMessage = msg;
}

async function refreshGameMessage(game, embeds, components) {
  if (game.gameMessage) {
    try { await game.gameMessage.delete(); } catch (_) {}
    game.gameMessage = null;
  }
  if (game.channel) {
    game.gameMessage = await game.channel.send({ embeds, components: components ?? [] });
  }
}

function createGameEmbed(game, coinFlip = null) {
  const currentTeamArr = game.currentTeam === 'A' ? game.teamA : game.teamB;
  const currentPlayer = currentTeamArr[game.currentPlayerIndex];

  const guessedA = game.teamA.filter(p => game.playerGuesses[p.id] !== undefined).length;
  const guessedB = game.teamB.filter(p => game.playerGuesses[p.id] !== undefined).length;

  let description = `**Round ${game.round}**`;
  if (coinFlip) {
    description += `\n\n🪙 Coin flip: **${coinFlip.toUpperCase()}** — Team ${game.currentTeam} goes first!`;
  }
  description += `\n\n🔴 Team A guessed: **${guessedA}/2** | 🔵 Team B guessed: **${guessedB}/2**`;

  return new EmbedBuilder()
    .setTitle('🎲 Marble Game — In Progress')
    .setDescription(description)
    .addFields(
      {
        name: '🔴 Team A',
        value: `${game.teamA.map(p => `<@${p.id}>`).join(' & ')}\n${marbleBar(game.teamAMarbles)}`,
        inline: true
      },
      {
        name: '🔵 Team B',
        value: `${game.teamB.map(p => `<@${p.id}>`).join(' & ')}\n${marbleBar(game.teamBMarbles)}`,
        inline: true
      },
      {
        name: `🎯 It's ${currentPlayer.displayName}'s Turn (Team ${game.currentTeam})`,
        value: 'Click the button below to secretly choose your number **(1–20)**.',
        inline: false
      }
    )
    .setColor(game.currentTeam === 'A' ? 0xFF4444 : 0x4466FF)
    .setFooter({ text: `Round ${game.round} • Pot: $${game.totalPot.toLocaleString()} • ${game.roundHistory.length} rounds played` })
    .setTimestamp();
}

function createNumberSelectionButton(gameId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`select_number_${gameId}`)
      .setLabel('🎯 Choose Your Number (1–20)')
      .setStyle(ButtonStyle.Primary)
  );
}

async function handleNumberSelection(interaction, gameId) {
  const game = global.activeMarbleGames[gameId];
  if (!game || game.phase !== 'game') return;

  const currentTeamArr = game.currentTeam === 'A' ? game.teamA : game.teamB;
  const currentPlayer = currentTeamArr[game.currentPlayerIndex];

  if (interaction.user.id !== currentPlayer.id) {
    return interaction.reply({ content: `❌ It's not your turn! Waiting for **${currentPlayer.displayName}**.`, ephemeral: true });
  }

  const modal = new ModalBuilder()
    .setCustomId(`number_modal_${gameId}`)
    .setTitle(`Round ${game.round} — Pick Your Number`)
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('number_input')
          .setLabel('Enter a number from 1 to 20')
          .setStyle(TextInputStyle.Short)
          .setMinLength(1)
          .setMaxLength(2)
          .setRequired(true)
          .setPlaceholder('e.g. 7')
      )
    );

  await interaction.showModal(modal);
}

async function processNumberGuess(interaction, gameId) {
  const game = global.activeMarbleGames[gameId];
  if (!game || game.phase !== 'game') return;

  const number = parseInt(interaction.fields.getTextInputValue('number_input'));

  if (isNaN(number) || number < 1 || number > 20) {
    return interaction.reply({ content: '❌ Invalid number — must be between **1 and 20**.', ephemeral: true });
  }

  const playerId = interaction.user.id;

  const currentTeamArr = game.currentTeam === 'A' ? game.teamA : game.teamB;
  const currentPlayer = currentTeamArr[game.currentPlayerIndex];
  if (playerId !== currentPlayer.id) {
    return interaction.reply({ content: `❌ It's not your turn right now. Waiting for **${currentPlayer.displayName}**.`, ephemeral: true });
  }

  game.playerGuesses[playerId] = number;

  await interaction.reply({ content: `✅ You locked in **${number}**. Keep it secret!`, ephemeral: true });

  game.currentPlayerIndex++;

  if (game.currentPlayerIndex >= currentTeamArr.length) {
    const otherTeam = game.currentTeam === 'A' ? 'B' : 'A';

    if (game.currentTeam === game.firstTeam) {
      game.currentTeam = otherTeam;
      game.currentPlayerIndex = 0;
    } else {
      await runRandomizer(gameId);
      return;
    }
  }

  const updatedEmbed = createGameEmbed(game);
  const numberButton = createNumberSelectionButton(gameId);
  await refreshGameMessage(game, [updatedEmbed], [numberButton]);
}

async function runRandomizer(gameId) {
  const game = global.activeMarbleGames[gameId];
  if (!game) return;

  const guesses = game.playerGuesses;
  const allGuessedNumbers = Object.values(guesses);
  const uniqueGuesses = [...new Set(allGuessedNumbers)];

  if (game.gameMessage) {
    try { await game.gameMessage.delete(); } catch (_) {}
    game.gameMessage = null;
  }

  let drawnNumber;
  let rollLog = [];
  let attempts = 0;

  if (game.channel) {
    const initialEmbed = new EmbedBuilder()
      .setTitle('🎲 Drawing Numbers...')
      .setDescription('All players have cast their votes!\n\nRolling...')
      .setColor(0xFFA500)
      .setTimestamp();
    game.gameMessage = await game.channel.send({ embeds: [initialEmbed], components: [] });
  }

  do {
    drawnNumber = Math.floor(Math.random() * 20) + 1;
    attempts++;

    if (!uniqueGuesses.includes(drawnNumber)) {
      rollLog.push(`~~${drawnNumber}~~`);

      if (game.gameMessage) {
        const rollingEmbed = new EmbedBuilder()
          .setTitle('🎲 Drawing Numbers...')
          .setDescription(
            `Rolled: ${rollLog.join('  ')}\n\n` +
            `**${drawnNumber}** — no match! Re-rolling...`
          )
          .setColor(0xFFA500)
          .setTimestamp();
        await game.gameMessage.edit({ embeds: [rollingEmbed], components: [] });
        await new Promise(r => setTimeout(r, 1100));
      }
    }

    if (attempts >= 80) {
      drawnNumber = uniqueGuesses[Math.floor(Math.random() * uniqueGuesses.length)];
      break;
    }
  } while (!uniqueGuesses.includes(drawnNumber));

  const winnerIds = Object.keys(guesses).filter(id => guesses[id] === drawnNumber);

  const teamAWinners = winnerIds.filter(id => game.teamA.some(p => p.id === id));
  const teamBWinners = winnerIds.filter(id => game.teamB.some(p => p.id === id));
  const isTie = teamAWinners.length > 0 && teamBWinners.length > 0;

  if (isTie) {
    game.roundHistory.push({ round: game.round, drawn: drawnNumber, result: 'tie' });

    const missedLog = rollLog.length > 0 ? `\nMisses: ${rollLog.join('  ')}` : '';
    const tieEmbed = new EmbedBuilder()
      .setTitle('🤝 Tie Round!')
      .setDescription(
        `The draw landed on **${drawnNumber}** — but **both teams** had someone guess it!\n` +
        `No marbles are transferred.${missedLog}`
      )
      .addFields(buildScoreField(game), buildGuessField(game, guesses))
      .setColor(0xFFD700)
      .setTimestamp();

    if (game.gameMessage) await game.gameMessage.edit({ embeds: [tieEmbed], components: [] });
    setTimeout(() => nextRound(gameId), 4000);
    return;
  }

  if (winnerIds.length === 0) {
    game.roundHistory.push({ round: game.round, drawn: drawnNumber, result: 'no_match' });
    setTimeout(() => nextRound(gameId), 4000);
    return;
  }

  const winnerId = winnerIds[0];
  const winnerUser = game.players.find(p => p.id === winnerId);
  const winnerTeam = teamAWinners.length > 0 ? 'A' : 'B';

  if (winnerTeam === 'A') {
    game.teamAMarbles++;
    game.teamBMarbles--;
  } else {
    game.teamBMarbles++;
    game.teamAMarbles--;
  }

  game.roundHistory.push({ round: game.round, drawn: drawnNumber, winner: winnerUser.displayName, team: winnerTeam });

  const missedLog = rollLog.length > 0 ? `\nMisses: ${rollLog.join('  ')}` : '';
  const resultEmbed = new EmbedBuilder()
    .setTitle(`🎯 Round ${game.round} — Result`)
    .setDescription(
      `The draw landed on **${drawnNumber}**!${missedLog}\n\n` +
      `**${winnerUser.displayName}** (Team ${winnerTeam}) wins the round and steals a marble! 🪙`
    )
    .addFields(buildScoreField(game), buildGuessField(game, guesses))
    .setColor(winnerTeam === 'A' ? 0xFF4444 : 0x4466FF)
    .setTimestamp();

  if (game.gameMessage) await game.gameMessage.edit({ embeds: [resultEmbed], components: [] });

  const isOver = game.teamAMarbles <= 0 || game.teamBMarbles <= 0 || game.teamAMarbles >= 10 || game.teamBMarbles >= 10;
  if (isOver) {
    setTimeout(() => endGame(gameId), 4000);
  } else {
    setTimeout(() => nextRound(gameId), 5000);
  }
}

function buildScoreField(game) {
  return {
    name: '📊 Current Scores',
    value: `🔴 Team A: ${marbleBar(game.teamAMarbles)}\n🔵 Team B: ${marbleBar(game.teamBMarbles)}`,
    inline: false
  };
}

function buildGuessField(game, guesses) {
  const lines = [...game.teamA, ...game.teamB].map(p => {
    const g = guesses[p.id];
    return `<@${p.id}> → **${g !== undefined ? g : '?'}**`;
  });
  return { name: '🔢 All Guesses This Round', value: lines.join('\n'), inline: false };
}

async function nextRound(gameId) {
  const game = global.activeMarbleGames[gameId];
  if (!game) return;

  game.round++;
  game.playerGuesses = {};

  const coinFlip = Math.random() < 0.5 ? 'heads' : 'tails';
  game.currentTeam = coinFlip === 'heads' ? 'A' : 'B';
  game.firstTeam = game.currentTeam; // reset first team for this round
  game.currentPlayerIndex = 0;

  const nextRoundEmbed = createGameEmbed(game, coinFlip);
  const numberButton = createNumberSelectionButton(game.gameId);

  await refreshGameMessage(game, [nextRoundEmbed], [numberButton]);
}

async function endGame(gameId) {
  const game = global.activeMarbleGames[gameId];
  if (!game) return;

  const winningTeam = (game.teamAMarbles >= 10 || game.teamBMarbles <= 0) ? 'A' : 'B';
  const losingTeam = winningTeam === 'A' ? 'B' : 'A';
  const winningPlayers = winningTeam === 'A' ? game.teamA : game.teamB;
  const losingPlayers = losingTeam === 'A' ? game.teamA : game.teamB;
  const finalScoreA = game.teamAMarbles;
  const finalScoreB = game.teamBMarbles;

  const winningsPerPlayer = game.totalPot / 2;
  for (const player of winningPlayers) {
    if (userData[player.id]) userData[player.id].cash += winningsPerPlayer;
  }
  await saveUserData();

  const duration = Math.max(1, Math.round((Date.now() - game.createdAt) / 60000));

  const gameEndEmbed = new EmbedBuilder()
    .setTitle(`🏆 Team ${winningTeam} Wins the Marble Game!`)
    .setDescription(
      `After **${game.round} rounds**, Team ${winningTeam} dominated!\n\n` +
      `🏅 **Winners:** ${winningPlayers.map(p => `<@${p.id}>`).join(' & ')}\n` +
      `💀 **Eliminated:** ${losingPlayers.map(p => `<@${p.id}>`).join(' & ')}`
    )
    .addFields(
      {
        name: '📊 Final Score',
        value: `🔴 Team A: ${marbleBar(finalScoreA)}\n🔵 Team B: ${marbleBar(finalScoreB)}`,
        inline: false
      },
      {
        name: '💰 Prize',
        value: `Each winner receives **$${winningsPerPlayer.toLocaleString()}**\nTotal pot: **$${game.totalPot.toLocaleString()}**`,
        inline: true
      },
      {
        name: '📈 Game Stats',
        value: `Rounds played: **${game.round}**\nDuration: **${duration} min**`,
        inline: true
      }
    )
    .setColor(0xFFD700)
    .setFooter({ text: 'Winnings distributed! Thanks for playing.' })
    .setTimestamp();

  await refreshGameMessage(game, [gameEndEmbed], []);

  delete global.activeMarbleGames[gameId];
}


async function handleMarbleDuel(interaction) {
  const userId = interaction.user.id;
  const opponent = interaction.options.getUser('opponent');

  if (opponent.id === userId) {
    return interaction.reply({ content: '❌ You cannot challenge yourself to a duel!', ephemeral: true });
  }
  if (opponent.bot) {
    return interaction.reply({ content: '❌ Bots cannot participate in marble duels!', ephemeral: true });
  }

  const allPlayers = [interaction.user, opponent];
  const alreadyInGame = allPlayers.some(u =>
    Object.values(global.activeMarbleGames).some(g => g.players.some(p => p.id === u.id)) ||
    Object.values(global.activeDuelGames).some(g => g.players.some(p => p.id === u.id))
  );
  if (alreadyInGame) {
    return interaction.reply({ content: '❌ One or more players are already in an active marble game!', ephemeral: true });
  }

  const gameId = `duel_${userId}_${Date.now()}`;
  global.activeDuelGames[gameId] = {
    gameId,
    guildId: interaction.guildId || null,
    players: [interaction.user, opponent], // [0]=P1 initiator, [1]=P2 opponent
    pendingBets: {},
    betAmount: 0,
    totalPot: 0,
    betsCollected: false,
    phase: 'invitation',
    round: 0,
    createdAt: Date.now(),
    gameMessage: null,
    channel: null,
    p1Marbles: 5,
    p2Marbles: 5,
    currentPlayerIndex: 0,
    firstPlayerIndex: 0,
    votedCount: 0,
    playerGuesses: {},
    roundHistory: []
  };

  const embed = createDuelInvitationEmbed(global.activeDuelGames[gameId]);
  const buttons = createDuelInvitationButtons(gameId);
  await interaction.reply({ embeds: [embed], components: [buttons] });

  setTimeout(() => {
    const game = global.activeDuelGames[gameId];
    if (game && game.phase === 'invitation') {
      delete global.activeDuelGames[gameId];
      interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle('⏰ Marble Duel Expired')
            .setDescription('The duel invitation was not accepted in time.')
            .setColor(0x99AAB5)
            .setTimestamp()
        ],
        components: []
      }).catch(() => {});
    }
  }, 120000);
}

function createDuelInvitationEmbed(game) {
  const [p1, p2] = game.players;
  return new EmbedBuilder()
    .setTitle('⚔️ Marble Duel — Challenge Issued')
    .setDescription(
      `**${p1.displayName}** has challenged **${p2.displayName}** to a 1v1 marble duel!\n\n` +
      `**${p2.displayName}** must accept within **2 minutes** to begin.`
    )
    .addFields(
      {
        name: '⚔️ Challenger',
        value: `<@${p1.id}>`,
        inline: true
      },
      {
        name: '🎯 Opponent',
        value: `<@${p2.id}>`,
        inline: true
      },
      {
        name: '📖 How It Works',
        value:
          '> • 2 players go head-to-head, each starting with **5 marbles** (10 total)\n' +
          '> • Each round, both players secretly pick a number **(1–20)**\n' +
          '> • A random number is drawn — whoever guessed it **steals a marble** from the other\n' +
          '> • First to collect **all 10** (or drain your opponent to 0) wins the pot\n' +
          '> • Both pick the same drawn number — it\'s a tie, no transfer',
        inline: false
      }
    )
    .setColor(0xA855F7)
    .setFooter({ text: '⏰ Invitation expires in 2 minutes' })
    .setTimestamp();
}

function createDuelInvitationButtons(gameId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`duel_accept_${gameId}`)
      .setLabel('✅ Accept Duel')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`duel_decline_${gameId}`)
      .setLabel('❌ Decline')
      .setStyle(ButtonStyle.Danger)
  );
}

async function startDuelBettingPhase(interaction, gameId) {
  const game = global.activeDuelGames[gameId];
  if (!game) return;

  game.phase = 'betting';
  const [p1, p2] = game.players;

  const embed = new EmbedBuilder()
    .setTitle('💰 Duel Betting Phase')
    .setDescription(
      'Both players must place a bet.\n' +
      'Bets must **match exactly** — if they don\'t, they reset and you try again.'
    )
    .addFields(
      {
        name: '⚔️ Challenger',
        value: `<@${p1.id}>`,
        inline: true
      },
      {
        name: '🎯 Opponent',
        value: `<@${p2.id}>`,
        inline: true
      },
      {
        name: '🎯 Bets Placed',
        value: '*None yet*',
        inline: false
      },
      {
        name: '📋 Rules',
        value: '• Minimum bet: **$50**\n• Both bets must match\n• Winner takes **the full pot**',
        inline: false
      }
    )
    .setColor(0xFFD700)
    .setTimestamp();

  const betButton = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`place_duel_bet_${gameId}`)
      .setLabel('💸 Place Bet')
      .setStyle(ButtonStyle.Primary)
  );

  await interaction.update({ embeds: [embed], components: [betButton] });
}

async function handleDuelBetModal(interaction, gameId) {
  const game = global.activeDuelGames[gameId];
  if (!game) {
    return interaction.reply({ content: '❌ This duel is no longer active.', ephemeral: true });
  }

  const userId = interaction.user.id;
  if (!game.players.some(p => p.id === userId)) {
    return interaction.reply({ content: '❌ You are not part of this duel.', ephemeral: true });
  }
  if (game.pendingBets[userId] !== undefined) {
    return interaction.reply({ content: '❌ You have already placed your bet.', ephemeral: true });
  }

  const betAmount = parseInt(interaction.fields.getTextInputValue('bet_amount_input'));
  if (isNaN(betAmount) || betAmount < 50) {
    return interaction.reply({ content: '❌ Minimum bet is **$50**. Please try again.', ephemeral: true });
  }

  await getUser(userId);
  if (userData[userId].cash < betAmount) {
    return interaction.reply({
      content: `❌ You only have **$${userData[userId].cash.toLocaleString()}** — not enough to bet $${betAmount.toLocaleString()}.`,
      ephemeral: true
    });
  }

  game.pendingBets[userId] = betAmount;

  const [p1, p2] = game.players;
  const betsPlaced = Object.entries(game.pendingBets)
    .map(([id, b]) => `<@${id}> → **$${b.toLocaleString()}**`)
    .join('\n');
  const waiting = game.players.filter(p => game.pendingBets[p.id] === undefined);

  const updatedEmbed = new EmbedBuilder()
    .setTitle('💰 Duel Betting Phase')
    .setDescription(
      Object.keys(game.pendingBets).length === 2
        ? '✅ Both bets received! Checking if they match...'
        : `Waiting for **${waiting.map(p => p.displayName).join(', ')}** to bet...`
    )
    .addFields(
      { name: '✅ Bets Placed', value: betsPlaced, inline: true },
      {
        name: '⏳ Still Waiting',
        value: waiting.length > 0 ? waiting.map(p => `<@${p.id}>`).join('\n') : '*All in!*',
        inline: true
      }
    )
    .setColor(0xFFD700)
    .setTimestamp();

  await interaction.deferUpdate();
  await interaction.message.edit({ embeds: [updatedEmbed] });

  if (Object.keys(game.pendingBets).length === 2) {
    const [bet1, bet2] = game.players.map(p => game.pendingBets[p.id]);

    if (bet1 === bet2) {
      game.betAmount = bet1;
      game.totalPot = bet1 * 2;
      await collectDuelBets(game);
      setTimeout(() => startDuelGame(interaction, gameId), 1500);
    } else {
      game.pendingBets = {};
      const mismatchEmbed = new EmbedBuilder()
        .setTitle('💸 Bets Mismatch!')
        .setDescription(
          `Bets didn't match — **reset**.\nBoth players must bet the same amount. Click **Place Bet** to try again.`
        )
        .addFields({ name: 'Previous Bets', value: betsPlaced })
        .setColor(0xFF6B6B)
        .setTimestamp();

      const betButton = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`place_duel_bet_${gameId}`)
          .setLabel('💸 Place Bet')
          .setStyle(ButtonStyle.Primary)
      );
      await interaction.message.edit({ embeds: [mismatchEmbed], components: [betButton] });
    }
  }
}

async function collectDuelBets(game) {
  if (game.betsCollected) return;
  for (const player of game.players) {
    if (userData[player.id]) userData[player.id].cash -= game.betAmount;
  }
  game.betsCollected = true;
  await saveUserData();
}

async function startDuelGame(interaction, gameId) {
  const game = global.activeDuelGames[gameId];
  if (!game) return;

  game.p1Marbles = 5;
  game.p2Marbles = 5;
  game.phase = 'game';
  game.round = 1;
  game.playerGuesses = {};
  game.roundHistory = [];
  game.channel = interaction.channel;

  const coinFlip = Math.random() < 0.5 ? 'heads' : 'tails';
  game.currentPlayerIndex = coinFlip === 'heads' ? 0 : 1;
  game.firstPlayerIndex = game.currentPlayerIndex;
  game.votedCount = 0;

  const embed = createDuelGameEmbed(game, coinFlip);
  const pickButton = createDuelPickButton(gameId);

  const msg = await game.channel.send({ embeds: [embed], components: [pickButton] });
  game.gameMessage = msg;
}

function createDuelGameEmbed(game, coinFlip = null) {
  const [p1, p2] = game.players;
  const currentPlayer = game.players[game.currentPlayerIndex];
  const voted1 = game.playerGuesses[p1.id] !== undefined;
  const voted2 = game.playerGuesses[p2.id] !== undefined;

  let description = `**Round ${game.round}**`;
  if (coinFlip) {
    description += `\n\n🪙 Coin flip: **${coinFlip.toUpperCase()}** — **${currentPlayer.displayName}** goes first!`;
  }
  description += `\n\n${voted1 ? '✅' : '⏳'} **${p1.displayName}** | ${voted2 ? '✅' : '⏳'} **${p2.displayName}**`;

  return new EmbedBuilder()
    .setTitle('⚔️ Marble Duel — In Progress')
    .setDescription(description)
    .addFields(
      {
        name: `⚔️ ${p1.displayName}`,
        value: marbleBar(game.p1Marbles),
        inline: true
      },
      {
        name: `🎯 ${p2.displayName}`,
        value: marbleBar(game.p2Marbles),
        inline: true
      },
      {
        name: `🎯 It's ${currentPlayer.displayName}'s Turn`,
        value: 'Click the button below to secretly pick your number **(1–20)**.',
        inline: false
      }
    )
    .setColor(game.currentPlayerIndex === 0 ? 0xA855F7 : 0x22D3EE)
    .setFooter({ text: `Round ${game.round} • Pot: $${game.totalPot.toLocaleString()} • ${game.roundHistory.length} rounds played` })
    .setTimestamp();
}

function createDuelPickButton(gameId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`duel_pick_${gameId}`)
      .setLabel('🎯 Pick Your Number (1–20)')
      .setStyle(ButtonStyle.Primary)
  );
}

async function handleDuelPick(interaction, gameId) {
  const game = global.activeDuelGames[gameId];
  if (!game || game.phase !== 'game') return;

  const currentPlayer = game.players[game.currentPlayerIndex];
  if (interaction.user.id !== currentPlayer.id) {
    return interaction.reply({
      content: `❌ It's not your turn! Waiting for **${currentPlayer.displayName}** to pick.`,
      ephemeral: true
    });
  }

  const modal = new ModalBuilder()
    .setCustomId(`duel_number_modal_${gameId}`)
    .setTitle(`Round ${game.round} — Pick Your Number`)
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('number_input')
          .setLabel('Your number (1–20)')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('Enter a number between 1 and 20')
          .setRequired(true)
          .setMinLength(1)
          .setMaxLength(2)
      )
    );

  await interaction.showModal(modal);
}

async function processDuelGuess(interaction, gameId) {
  const game = global.activeDuelGames[gameId];
  if (!game || game.phase !== 'game') return;

  const number = parseInt(interaction.fields.getTextInputValue('number_input'));
  if (isNaN(number) || number < 1 || number > 20) {
    return interaction.reply({ content: '❌ Invalid number — must be between **1 and 20**.', ephemeral: true });
  }

  const playerId = interaction.user.id;
  const currentPlayer = game.players[game.currentPlayerIndex];
  if (playerId !== currentPlayer.id) {
    return interaction.reply({
      content: `❌ It's not your turn! Waiting for **${currentPlayer.displayName}**.`,
      ephemeral: true
    });
  }
  if (game.playerGuesses[playerId] !== undefined) {
    return interaction.reply({ content: '❌ You have already locked in your number this round.', ephemeral: true });
  }

  game.playerGuesses[playerId] = number;
  game.votedCount++;
  await interaction.reply({ content: `✅ You locked in **${number}**. Keep it secret!`, ephemeral: true });

  if (game.votedCount >= 2) {
    await runDuelRandomizer(gameId);
    return;
  }

  game.currentPlayerIndex = game.currentPlayerIndex === 0 ? 1 : 0;

  const embed = createDuelGameEmbed(game);
  const pickButton = createDuelPickButton(gameId);
  await refreshDuelMessage(game, [embed], [pickButton]);
}

async function runDuelRandomizer(gameId) {
  const game = global.activeDuelGames[gameId];
  if (!game) return;

  const [p1, p2] = game.players;
  const guesses = game.playerGuesses;
  const uniqueGuesses = [...new Set(Object.values(guesses))];

  if (game.gameMessage) {
    try { await game.gameMessage.delete(); } catch (_) {}
    game.gameMessage = null;
  }

  let drawnNumber;
  let rollLog = [];
  let attempts = 0;

  if (game.channel) {
    const initialEmbed = new EmbedBuilder()
      .setTitle('🎲 Drawing Numbers...')
      .setDescription(`Both players have locked in! Rolling...\n\n**${p1.displayName}** vs **${p2.displayName}**`)
      .setColor(0xFFA500)
      .setTimestamp();
    game.gameMessage = await game.channel.send({ embeds: [initialEmbed], components: [] });
  }

  do {
    drawnNumber = Math.floor(Math.random() * 20) + 1;
    attempts++;

    if (!uniqueGuesses.includes(drawnNumber)) {
      rollLog.push(`~~${drawnNumber}~~`);

      if (game.gameMessage) {
        const rollingEmbed = new EmbedBuilder()
          .setTitle('🎲 Drawing Numbers...')
          .setDescription(
            `Rolled: ${rollLog.join('  ')}\n\n` +
            `**${drawnNumber}** — no match! Re-rolling...`
          )
          .setColor(0xFFA500)
          .setTimestamp();
        await game.gameMessage.edit({ embeds: [rollingEmbed], components: [] });
        await new Promise(r => setTimeout(r, 1100));
      }
    }

    if (attempts >= 80) {
      drawnNumber = uniqueGuesses[Math.floor(Math.random() * uniqueGuesses.length)];
      break;
    }
  } while (!uniqueGuesses.includes(drawnNumber));

  const p1Guess = guesses[p1.id];
  const p2Guess = guesses[p2.id];
  const missedLog = rollLog.length > 0 ? `\nMisses: ${rollLog.join('  ')}` : '';

  if (p1Guess === drawnNumber && p2Guess === drawnNumber) {
    game.roundHistory.push({ round: game.round, drawn: drawnNumber, result: 'tie' });

    const tieEmbed = new EmbedBuilder()
      .setTitle('🤝 Tie Round!')
      .setDescription(
        `The draw landed on **${drawnNumber}** — and **both players** picked it!\n` +
        `No marbles transferred this round.${missedLog}`
      )
      .addFields(buildDuelScoreField(game), buildDuelGuessField(game, guesses))
      .setColor(0xFFD700)
      .setTimestamp();

    if (game.gameMessage) await game.gameMessage.edit({ embeds: [tieEmbed], components: [] });
    setTimeout(() => nextDuelRound(gameId), 4000);
    return;
  }

  const p1Won = p1Guess === drawnNumber;
  const p2Won = p2Guess === drawnNumber;

  if (!p1Won && !p2Won) {
    game.roundHistory.push({ round: game.round, drawn: drawnNumber, result: 'no_match' });
    setTimeout(() => nextDuelRound(gameId), 4000);
    return;
  }

  const winner = p1Won ? p1 : p2;
  const loser = p1Won ? p2 : p1;

  if (p1Won) {
    game.p1Marbles++;
    game.p2Marbles--;
  } else {
    game.p2Marbles++;
    game.p1Marbles--;
  }

  game.roundHistory.push({ round: game.round, drawn: drawnNumber, winner: winner.displayName });

  const resultEmbed = new EmbedBuilder()
    .setTitle(`🎯 Round ${game.round} — Result`)
    .setDescription(
      `The draw landed on **${drawnNumber}**!${missedLog}\n\n` +
      `**${winner.displayName}** guessed it and steals a marble from **${loser.displayName}**! 🪙`
    )
    .addFields(buildDuelScoreField(game), buildDuelGuessField(game, guesses))
    .setColor(p1Won ? 0xA855F7 : 0x22D3EE)
    .setTimestamp();

  if (game.gameMessage) await game.gameMessage.edit({ embeds: [resultEmbed], components: [] });

  const isOver = game.p1Marbles <= 0 || game.p2Marbles <= 0 || game.p1Marbles >= 10 || game.p2Marbles >= 10;
  if (isOver) {
    setTimeout(() => endDuelGame(gameId), 4000);
  } else {
    setTimeout(() => nextDuelRound(gameId), 5000);
  }
}

function buildDuelScoreField(game) {
  const [p1, p2] = game.players;
  return {
    name: '📊 Marble Count',
    value: `⚔️ **${p1.displayName}**: ${marbleBar(game.p1Marbles)}\n🎯 **${p2.displayName}**: ${marbleBar(game.p2Marbles)}`,
    inline: false
  };
}

function buildDuelGuessField(game, guesses) {
  const [p1, p2] = game.players;
  const lines = [p1, p2].map(p => {
    const g = guesses[p.id];
    return `<@${p.id}> → **${g !== undefined ? g : '?'}**`;
  });
  return { name: '🔢 Guesses This Round', value: lines.join('\n'), inline: false };
}

async function nextDuelRound(gameId) {
  const game = global.activeDuelGames[gameId];
  if (!game) return;

  game.round++;
  game.playerGuesses = {};
  game.votedCount = 0;

  const coinFlip = Math.random() < 0.5 ? 'heads' : 'tails';
  game.currentPlayerIndex = coinFlip === 'heads' ? 0 : 1;
  game.firstPlayerIndex = game.currentPlayerIndex;

  const embed = createDuelGameEmbed(game, coinFlip);
  const pickButton = createDuelPickButton(gameId);
  await refreshDuelMessage(game, [embed], [pickButton]);
}

async function endDuelGame(gameId) {
  const game = global.activeDuelGames[gameId];
  if (!game) return;

  const [p1, p2] = game.players;
  const p1Won = game.p1Marbles >= 10 || game.p2Marbles <= 0;
  const winner = p1Won ? p1 : p2;
  const loser = p1Won ? p2 : p1;
  const winnerMarbles = p1Won ? game.p1Marbles : game.p2Marbles;
  const loserMarbles = p1Won ? game.p2Marbles : game.p1Marbles;

  await getUser(winner.id);
  userData[winner.id].cash += game.totalPot;
  await saveUserData();
  await updateQuestProgress(winner.id, game.guildId, 'duelWin', 1);

  const duration = Math.max(1, Math.round((Date.now() - game.createdAt) / 60000));

  const gameEndEmbed = new EmbedBuilder()
    .setTitle(`🏆 ${winner.displayName} Wins the Duel!`)
    .setDescription(
      `After **${game.round} rounds**, **${winner.displayName}** drained **${loser.displayName}**'s marbles!\n\n` +
      `🏅 **Winner:** <@${winner.id}> — **$${game.totalPot.toLocaleString()}** claimed!\n` +
      `💀 **Defeated:** <@${loser.id}>`
    )
    .addFields(
      {
        name: '📊 Final Marble Count',
        value: `${winner.displayName}: ${marbleBar(winnerMarbles)}\n${loser.displayName}: ${marbleBar(loserMarbles)}`,
        inline: false
      },
      {
        name: '💰 Prize',
        value: `**$${game.totalPot.toLocaleString()}** (pot of $${game.betAmount.toLocaleString()} × 2)`,
        inline: true
      },
      {
        name: '📈 Stats',
        value: `Rounds: **${game.round}** • Duration: **${duration} min**`,
        inline: true
      }
    )
    .setColor(0xFFD700)
    .setFooter({ text: 'Winnings distributed! Thanks for dueling.' })
    .setTimestamp();

  await refreshDuelMessage(game, [gameEndEmbed], []);
  delete global.activeDuelGames[gameId];
}

async function refreshDuelMessage(game, embeds, components) {
  if (game.gameMessage) {
    try { await game.gameMessage.delete(); } catch (_) {}
    game.gameMessage = null;
  }
  if (game.channel) {
    game.gameMessage = await game.channel.send({ embeds, components: components ?? [] });
  }
}




async function handleConvertCommand(interaction, userId) {
  if (!userData[userId].xpData) {
    userData[userId].xpData = { xp: 0, messageCount: 0, lastMessage: 0 };
  }

  const userXpData = userData[userId].xpData;

  if (userXpData.xp === 0) {
    const noXpEmbed = new EmbedBuilder()
      .setTitle('No XP Available')
      .setDescription('You don\'t have any XP to convert yet.')
      .addFields(
        { name: 'Current XP', value: '0 XP', inline: true },
        { name: 'How to Earn XP', value: 'Participate in conversations! You earn 1 XP for every 2 messages sent during active conversations.', inline: false },
        { name: 'Anti-Spam Protection', value: 'XP is only awarded when you\'re actively conversing with other users in the same channel.', inline: false }
      )
      .setColor(0xFF9F43)
      .setTimestamp();

    return await interaction.reply({ embeds: [noXpEmbed] });
  }

  const cashValue = userXpData.xp * 2;

  const convertEmbed = new EmbedBuilder()
    .setTitle('XP Conversion Available')
    .setDescription('Would you like to convert your XP into cash?')
    .addFields(
      { name: 'Available XP', value: `${userXpData.xp.toLocaleString()} XP`, inline: true },
      { name: 'Conversion Rate', value: '1 XP = $2', inline: true },
      { name: 'Cash Value', value: `$${cashValue.toLocaleString()}`, inline: true },
      { name: 'Current Cash', value: `$${userData[userId].cash.toLocaleString()}`, inline: true },
      { name: 'Cash After Conversion', value: `$${(userData[userId].cash + cashValue).toLocaleString()}`, inline: true },
      { name: 'Note', value: 'Converted cash goes directly to your wallet (not bank)', inline: false }
    )
    .setColor(0x5865F2)
    .setFooter({ text: 'This action cannot be undone' })
    .setTimestamp();

  const acceptButton = new ButtonBuilder()
    .setCustomId(`convert_accept_${userId}`)
    .setLabel('Accept Conversion')
    .setStyle(ButtonStyle.Success);

  const declineButton = new ButtonBuilder()
    .setCustomId(`convert_decline_${userId}`)
    .setLabel('Keep XP')
    .setStyle(ButtonStyle.Secondary);

  const row = new ActionRowBuilder().addComponents(acceptButton, declineButton);

  await interaction.reply({ embeds: [convertEmbed], components: [row] });
}

async function handleMiningStatusCommand(interaction) {
  await checkAndHandleEvents(); // Ensure events are up to date

  const eventData = await getEventSystem();
  const event = eventData.currentEvent;
  const nextEventTime = eventData.nextEventTime;
  const now = Date.now();

  if (event) {
    const timeLeft = event.endTime - now;
    const hoursLeft = Math.floor(timeLeft / (60 * 60 * 1000));
    const minutesLeft = Math.floor((timeLeft % (60 * 60 * 1000)) / (60 * 1000));

    const eventEmbed = new EmbedBuilder()
      .setTitle('ACTIVE MINING EVENT')
      .setDescription('**A mining crisis is currently affecting exploration operations!**')
      .addFields(
        { 
          name: 'Collapsed Mine', 
          value: `**${event.negativeArtefact}** mine is currently **CLOSED** due to structural collapse`, 
          inline: false 
        },
        { 
          name: 'Expanded Mine', 
          value: `**${event.positiveArtefact}** mine has **DOUBLED** discovery rates due to geological expansion`, 
          inline: false 
        },
        { 
          name: 'Time Remaining', 
          value: `**${hoursLeft}h ${minutesLeft}m** until mines return to normal`, 
          inline: true 
        },
        { 
          name: 'Scavenging Impact', 
          value: `• **${event.negativeArtefact}**: Cannot be found\n• **${event.positiveArtefact}**: 2x discovery chance\n• All other artefacts: Normal rates`, 
          inline: false 
        }
      )
      .setColor(0xFF4500)
      .setFooter({ text: 'Take advantage of the expanded mine while you can!' })
      .setTimestamp();

    await interaction.reply({ embeds: [eventEmbed] });

  } else {
    const timeUntilNext = nextEventTime - now;
    const daysUntilNext = Math.floor(timeUntilNext / (24 * 60 * 60 * 1000));
    const hoursUntilNext = Math.floor((timeUntilNext % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));

    const statusEmbed = new EmbedBuilder()
      .setTitle('MINING OPERATIONS STATUS')
      .setDescription('**All mining sectors are operating under normal conditions**')
      .addFields(
        { 
          name: 'Mine Status', 
          value: 'All artefact mines are **OPERATIONAL** and accessible for exploration', 
          inline: false 
        },
        { 
          name: 'Discovery Rates', 
          value: 'Standard scavenging probabilities are in effect across all sectors', 
          inline: false 
        },
        { 
          name: 'Next Event', 
          value: `Expected mining event in **${daysUntilNext}d ${hoursUntilNext}h**`, 
          inline: true 
        },
        { 
          name: 'Current Scavenging', 
          value: 'All artefacts available at normal discovery rates', 
          inline: false 
        }
      )
      .setColor(0x00FF7F)
      .setFooter({ text: 'Fortune Bot Mining Authority • Real-time status monitoring' })
      .setTimestamp();

    await interaction.reply({ embeds: [statusEmbed] });
  }
}


function buildGiveArtefactEmbed(session) {
  const queueText = session.queue.length
    ? session.queue.map(e => {
        const rarity = getRarityByArtefact(e.name);
        const tier = getArtefactTier(e.name);
        const tierSell = calcArtefactSellValue(e.name, rarity);
        return `${e.name} x${e.amount} — ${rarity ? rarity.name : 'Unknown'} T${tier} ($${(tierSell * e.amount).toLocaleString()} total)`;
      }).join('\n')
    : 'Nothing queued yet — pick a rarity, select an artefact, then add it below.';

  const totalItems = session.queue.reduce((s, e) => s + e.amount, 0);

  return new EmbedBuilder()
    .setTitle(`Give Artefacts to ${session.targetDisplayName}`)
    .setDescription('**Step 1:** Choose a rarity tier.\n**Step 2:** Pick an artefact from that tier.\n**Step 3:** Add to queue and confirm.')
    .addFields(
      { name: 'Selected Rarity', value: session.selectedRarity || 'None — pick a rarity below', inline: true },
      { name: 'Selected Artefact', value: session.selectedArtefact || 'None — pick an artefact below', inline: true },
      { name: `Queue (${totalItems} artefact${totalItems !== 1 ? 's' : ''})`, value: queueText, inline: false }
    )
    .setColor(session.queue.length > 0 ? 0x51CF66 : 0x339AF0)
    .setFooter({ text: 'Session expires in 5 minutes' })
    .setTimestamp();
}

function buildGiveArtefactComponents(sessionId, session) {
  const rarityOptions = rarities.map(r => ({
    label: r.name,
    description: `${r.items.length} artefacts — base sell $${r.sell.toLocaleString()}`,
    value: r.name,
    default: session.selectedRarity === r.name
  }));

  const rarityRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`ga_rarity_${sessionId}`)
      .setPlaceholder('Step 1 — Select a rarity tier')
      .addOptions(rarityOptions)
  );

  const selectedRarityData = rarities.find(r => r.name === session.selectedRarity);
  const artefactRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`ga_select_${sessionId}`)
      .setPlaceholder(session.selectedRarity ? `Step 2 — Select a ${session.selectedRarity} artefact` : 'Step 2 — Pick a rarity first')
      .setDisabled(!selectedRarityData)
      .addOptions(selectedRarityData
        ? selectedRarityData.items.map(item => {
            const tier = getArtefactTier(item);
            const tierSell = calcArtefactSellValue(item, selectedRarityData);
            return {
              label: item,
              description: `T${tier} — $${tierSell.toLocaleString()} sell value`,
              value: item,
              default: session.selectedArtefact === item
            };
          })
        : [{ label: 'No rarity selected', value: '_placeholder', default: false }]
      )
  );

  const hasSelection = !!session.selectedArtefact;
  const hasQueue = session.queue.length > 0;
  const totalItems = session.queue.reduce((s, e) => s + e.amount, 0);

  const buttonRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`ga_add_one_${sessionId}`)
      .setLabel('Add x1')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(!hasSelection),
    new ButtonBuilder()
      .setCustomId(`ga_add_custom_${sessionId}`)
      .setLabel('Add Custom Amount')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!hasSelection),
    new ButtonBuilder()
      .setCustomId(`ga_clear_queue_${sessionId}`)
      .setLabel('Clear Queue')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!hasQueue),
    new ButtonBuilder()
      .setCustomId(`ga_confirm_${sessionId}`)
      .setLabel(`Confirm Give (${totalItems})`)
      .setStyle(ButtonStyle.Success)
      .setDisabled(!hasQueue),
    new ButtonBuilder()
      .setCustomId(`ga_cancel_${sessionId}`)
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Danger)
  );

  return [rarityRow, artefactRow, buttonRow];
}

async function handleGiveArtefactCommand(interaction) {
  if (!isDeveloper(interaction.user.id)) {
    return await interaction.reply({
      embeds: [new EmbedBuilder().setTitle('Access Denied').setDescription('This command is restricted to developers only.').setColor(0xFF6B6B).setTimestamp()],
      ephemeral: true
    });
  }

  const targetUser = interaction.options.getUser('user');
  const targetId = targetUser.id;

  await getUser(targetId);

  const sessionId = `${interaction.user.id}_${Date.now()}`;
  const session = {
    userId: interaction.user.id,
    targetId,
    targetDisplayName: targetUser.displayName,
    selectedRarity: null,
    selectedArtefact: null,
    queue: [],
    message: null
  };

  global.giveArtefactSessions[sessionId] = session;

  const reply = await interaction.reply({
    embeds: [buildGiveArtefactEmbed(session)],
    components: buildGiveArtefactComponents(sessionId, session),
    fetchReply: true
  });

  session.message = reply;

  const collector = reply.createMessageComponentCollector({
    filter: i => i.user.id === interaction.user.id,
    time: 300000
  });

  collector.on('collect', async i => {
    if (i.customId === `ga_rarity_${sessionId}`) {
      session.selectedRarity = i.values[0];
      session.selectedArtefact = null; // reset artefact when rarity changes
      await i.update({ embeds: [buildGiveArtefactEmbed(session)], components: buildGiveArtefactComponents(sessionId, session) });

    } else if (i.customId === `ga_select_${sessionId}`) {
      session.selectedArtefact = i.values[0];
      await i.update({ embeds: [buildGiveArtefactEmbed(session)], components: buildGiveArtefactComponents(sessionId, session) });

    } else if (i.customId === `ga_add_one_${sessionId}`) {
      const existing = session.queue.find(e => e.name === session.selectedArtefact);
      if (existing) {
        existing.amount++;
      } else {
        session.queue.push({ name: session.selectedArtefact, amount: 1 });
      }
      await i.update({ embeds: [buildGiveArtefactEmbed(session)], components: buildGiveArtefactComponents(sessionId, session) });

    } else if (i.customId === `ga_add_custom_${sessionId}`) {
      const modal = new ModalBuilder()
        .setCustomId(`ga_amount_modal_${sessionId}`)
        .setTitle(`Amount for ${session.selectedArtefact}`)
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('ga_amount_input')
              .setLabel(`How many ${session.selectedArtefact} to give?`)
              .setStyle(TextInputStyle.Short)
              .setPlaceholder('Enter a number (1–1000)')
              .setMinLength(1)
              .setMaxLength(4)
              .setRequired(true)
          )
        );
      await i.showModal(modal);

    } else if (i.customId === `ga_clear_queue_${sessionId}`) {
      session.queue = [];
      await i.update({ embeds: [buildGiveArtefactEmbed(session)], components: buildGiveArtefactComponents(sessionId, session) });

    } else if (i.customId === `ga_confirm_${sessionId}`) {
      const target = await getUser(targetId);
      let totalGiven = 0;
      const summaryLines = [];

      for (const entry of session.queue) {
        for (let j = 0; j < entry.amount; j++) {
          target.artefacts.push(entry.name);
        }
        totalGiven += entry.amount;
        const rarity = getRarityByArtefact(entry.name);
        summaryLines.push(`${entry.name} x${entry.amount} (${rarity ? rarity.name : 'Unknown'})`);
      }

      await saveUser(targetId);
      collector.stop('confirmed');
      delete global.giveArtefactSessions[sessionId];

      const successEmbed = new EmbedBuilder()
        .setTitle('Artefacts Given')
        .setDescription(`Successfully gave **${totalGiven}** artefact(s) to <@${targetId}>!`)
        .addFields(
          { name: 'Items Given', value: summaryLines.join('\n'), inline: false },
          { name: 'Recipient', value: `<@${targetId}>`, inline: true },
          { name: 'Given By', value: `<@${interaction.user.id}>`, inline: true }
        )
        .setColor(0x51CF66)
        .setFooter({ text: 'Developer Command Executed' })
        .setTimestamp();

      await i.update({ embeds: [successEmbed], components: [] });

    } else if (i.customId === `ga_cancel_${sessionId}`) {
      collector.stop('cancelled');
      delete global.giveArtefactSessions[sessionId];
      await i.update({
        embeds: [new EmbedBuilder().setTitle('Cancelled').setDescription('No artefacts were given.').setColor(0xFF6B6B).setTimestamp()],
        components: []
      });
    }
  });

  collector.on('end', async (collected, reason) => {
    if (reason === 'time') {
      delete global.giveArtefactSessions[sessionId];
      try {
        await interaction.editReply({
          embeds: [new EmbedBuilder().setTitle('Session Expired').setDescription('No artefacts were given.').setColor(0xFF9F43).setTimestamp()],
          components: []
        });
      } catch (e) {}
    }
  });
}

async function handleGiveCashCommand(interaction) {
  if (!isDeveloper(interaction.user.id)) {
    const accessDeniedEmbed = new EmbedBuilder()
      .setTitle('Access Denied')
      .setDescription('This command is restricted to developers only.')
      .setColor(0xFF6B6B)
      .setTimestamp();

    return await interaction.reply({ embeds: [accessDeniedEmbed], ephemeral: true });
  }

  const targetUser = interaction.options.getUser('user');
  const amount = interaction.options.getInteger('amount');
  const targetId = targetUser.id;

  if (!userData[targetId]) userData[targetId] = { cash: 0, artefacts: [], bankBalance: 0 };

  userData[targetId].cash += amount;
  await saveUserData();

  const successEmbed = new EmbedBuilder()
    .setTitle('Cash Given')
    .setDescription(`Successfully gave **$${amount.toLocaleString()}** to ${targetUser.displayName}!`)
    .addFields(
      { name: 'Recipient', value: `<@${targetId}>`, inline: true },
      { name: 'Amount Given', value: `$${amount.toLocaleString()}`, inline: true },
      { name: 'New Cash Total', value: `$${userData[targetId].cash.toLocaleString()}`, inline: true },
      { name: 'Developer', value: `<@${interaction.user.id}>`, inline: true }
    )
    .setColor(0x00FF7F)
    .setFooter({ text: 'Developer Command Executed' })
    .setTimestamp();

  await interaction.reply({ embeds: [successEmbed] });
}

async function handleAddMoneyCommand(interaction) {
  if (!isDeveloper(interaction.user.id)) {
    return await interaction.reply({
      embeds: [new EmbedBuilder().setTitle('Access Denied').setDescription('This command is restricted to developers only.').setColor(0xFF6B6B).setTimestamp()],
      ephemeral: true
    });
  }

  const targetUser = interaction.options.getUser('user');
  const amount = interaction.options.getInteger('amount');
  const targetId = targetUser.id;

  if (!userData[targetId]) userData[targetId] = { cash: 0, artefacts: [], bankBalance: 0 };

  userData[targetId].cash += amount;
  await saveUserData();

  const successEmbed = new EmbedBuilder()
    .setTitle('Cash Added')
    .setDescription(`Successfully added **$${amount.toLocaleString()}** to ${targetUser.displayName}!`)
    .addFields(
      { name: 'Recipient', value: `<@${targetId}>`, inline: true },
      { name: 'Amount Added', value: `$${amount.toLocaleString()}`, inline: true },
      { name: 'New Cash Total', value: `$${userData[targetId].cash.toLocaleString()}`, inline: true },
      { name: 'Developer', value: `<@${interaction.user.id}>`, inline: true }
    )
    .setColor(0x00FF7F)
    .setFooter({ text: 'Developer Command Executed' })
    .setTimestamp();

  await interaction.reply({ embeds: [successEmbed] });
}

async function handleSetEventCommand(interaction) {
  if (!isDeveloper(interaction.user.id)) {
    const accessDeniedEmbed = new EmbedBuilder()
      .setTitle('Access Denied')
      .setDescription('This command is restricted to developers only.')
      .setColor(0xFF6B6B)
      .setTimestamp();

    return await interaction.reply({ embeds: [accessDeniedEmbed], ephemeral: true });
  }

  const positiveArtefact = interaction.options.getString('positive_artefact');
  const negativeArtefact = interaction.options.getString('negative_artefact');

  const positiveRarity = getRarityByArtefact(positiveArtefact);
  const negativeRarity = getRarityByArtefact(negativeArtefact);

  if (!positiveRarity || !negativeRarity) {
    const invalidEmbed = new EmbedBuilder()
      .setTitle('Invalid Artefact Names')
      .setDescription('One or both artefact names are invalid.')
      .addFields({
        name: 'Valid Artefacts',
        value: rarities.map(r => r.items.join(', ')).join('\n'),
        inline: false
      })
      .setColor(0xFF6B6B)
      .setTimestamp();

    return await interaction.reply({ embeds: [invalidEmbed], ephemeral: true });
  }

  if (positiveArtefact === negativeArtefact) {
    const sameArtefactEmbed = new EmbedBuilder()
      .setTitle('Invalid Event Configuration')
      .setDescription('Positive and negative artefacts must be different.')
      .setColor(0xFF6B6B)
      .setTimestamp();

    return await interaction.reply({ embeds: [sameArtefactEmbed], ephemeral: true });
  }

  const eventData = await getEventSystem();
  if (eventData && eventData.currentEvent) {
    await endCurrentEvent();
  }

  const now = Date.now();
  const newEvent = {
    id: `dev_event_${now}`,
    startTime: now,
    endTime: now + (24 * 60 * 60 * 1000), // 24 hours
    negativeArtefact,
    positiveArtefact,
    type: 'developer_triggered'
  };

  const updatedEventData = {
    currentEvent: newEvent,
    lastEventStart: now,
    nextEventTime: now + (4 * 24 * 60 * 60 * 1000), // Next event in 4 days
    eventHistory: [newEvent, ...(eventData?.eventHistory || [])].slice(0, 10)
  };

  await saveEventSystem(updatedEventData);

  const eventEmbed = new EmbedBuilder()
    .setTitle('Developer Event Triggered')
    .setDescription(`**Mining event manually initiated by ${interaction.user.displayName}!**`)
    .addFields(
      { 
        name: 'Mine Collapse', 
        value: `**${negativeArtefact}** mine has been forcibly closed`, 
        inline: false 
      },
      { 
        name: 'Mine Expansion', 
        value: `**${positiveArtefact}** mine has been expanded (2x discovery rate)`, 
        inline: false 
      },
      { 
        name: 'Event Duration', 
        value: '24 hours', 
        inline: true 
      },
      { 
        name: 'Effect', 
        value: `• **${negativeArtefact}**: Cannot be found\n• **${positiveArtefact}**: 2x discovery chance`, 
        inline: false 
      },
      { 
        name: 'Developer', 
        value: `<@${interaction.user.id}>`, 
        inline: true 
      }
    )
    .setColor(0x9932CC)
    .setFooter({ text: 'Developer Command Executed • Event Active for 24 hours' })
    .setTimestamp();

  await interaction.reply({ embeds: [eventEmbed] });

  await broadcastEventStart(newEvent);
}

async function handleRemoveArtefactCommand(interaction) {
  if (!isDeveloper(interaction.user.id)) {
    const accessDeniedEmbed = new EmbedBuilder()
      .setTitle('Access Denied')
      .setDescription('This command is restricted to developers only.')
      .setColor(0xFF6B6B)
      .setTimestamp();

    return await interaction.reply({ embeds: [accessDeniedEmbed], ephemeral: true });
  }

  const targetUser = interaction.options.getUser('user');
  const artefactName = interaction.options.getString('artefact');
  const targetId = targetUser.id;

  if (!userData[targetId]) userData[targetId] = { cash: 0, artefacts: [], bankBalance: 0 };

  const artefactIndex = userData[targetId].artefacts.findIndex(item => item === artefactName);
  if (artefactIndex === -1) {
    const notFoundEmbed = new EmbedBuilder()
      .setTitle('Artefact Not Found')
      .setDescription(`${targetUser.displayName} does not have an artefact named "${artefactName}".`)
      .setColor(0xFF6B6B)
      .setTimestamp();

    return await interaction.reply({ embeds: [notFoundEmbed], ephemeral: true });
  }

  const rarity = getRarityByArtefact(artefactName);

  userData[targetId].artefacts.splice(artefactIndex, 1);
  await saveUserData();

  const successEmbed = new EmbedBuilder()
    .setTitle('Artefact Removed')
    .setDescription(`Successfully removed **${artefactName}** from ${targetUser.displayName}!`)
    .addFields(
      { name: 'Target User', value: `<@${targetId}>`, inline: true },
      { name: 'Artefact', value: artefactName, inline: true },
      { name: 'Rarity', value: rarity ? rarity.name : 'Unknown', inline: true },
      { name: 'Tier', value: `T${getArtefactTier(artefactName)}`, inline: true },
      { name: 'Value', value: rarity ? `$${calcArtefactSellValue(artefactName, rarity).toLocaleString()}` : 'Unknown', inline: true },
      { name: 'Developer', value: `<@${interaction.user.id}>`, inline: true }
    )
    .setColor(0xFF6B6B)
    .setFooter({ text: 'Developer Command Executed' })
    .setTimestamp();

  await interaction.reply({ embeds: [successEmbed] });
}

async function handleRemoveCashCommand(interaction) {
  if (!isDeveloper(interaction.user.id)) {
    const accessDeniedEmbed = new EmbedBuilder()
      .setTitle('Access Denied')
      .setDescription('This command is restricted to developers only.')
      .setColor(0xFF6B6B)
      .setTimestamp();

    return await interaction.reply({ embeds: [accessDeniedEmbed], ephemeral: true });
  }

  const targetUser = interaction.options.getUser('user');
  const amount = interaction.options.getInteger('amount');
  const targetId = targetUser.id;

  if (!userData[targetId]) userData[targetId] = { cash: 0, artefacts: [], bankBalance: 0 };

  const totalWealth = userData[targetId].cash + (userData[targetId].bankBalance || 0);

  if (totalWealth < amount) {
    const insufficientEmbed = new EmbedBuilder()
      .setTitle('Insufficient Funds')
      .setDescription(`${targetUser.displayName} only has $${totalWealth.toLocaleString()} total wealth, cannot remove $${amount.toLocaleString()}.`)
      .addFields(
        { name: 'Available Cash', value: `$${userData[targetId].cash.toLocaleString()}`, inline: true },
        { name: 'Bank Balance', value: `$${(userData[targetId].bankBalance || 0).toLocaleString()}`, inline: true },
        { name: 'Total Wealth', value: `$${totalWealth.toLocaleString()}`, inline: true }
      )
      .setColor(0xFF6B6B)
      .setTimestamp();

    return await interaction.reply({ embeds: [insufficientEmbed], ephemeral: true });
  }

  let remainingToRemove = amount;
  let removedFromCash = 0;
  let removedFromBank = 0;

  if (userData[targetId].cash > 0) {
    removedFromCash = Math.min(userData[targetId].cash, remainingToRemove);
    userData[targetId].cash -= removedFromCash;
    remainingToRemove -= removedFromCash;
  }

  if (remainingToRemove > 0 && userData[targetId].bankBalance > 0) {
    removedFromBank = Math.min(userData[targetId].bankBalance, remainingToRemove);
    userData[targetId].bankBalance -= removedFromBank;
    remainingToRemove -= removedFromBank;
  }

  await saveUserData();

  const successEmbed = new EmbedBuilder()
    .setTitle('Cash Removed (Bypassed Bank)')
    .setDescription(`Successfully removed **$${amount.toLocaleString()}** from ${targetUser.displayName}!`)
    .addFields(
      { name: 'Target User', value: `<@${targetId}>`, inline: true },
      { name: 'Amount Removed', value: `$${amount.toLocaleString()}`, inline: true },
      { name: 'Removed from Cash', value: `$${removedFromCash.toLocaleString()}`, inline: true },
      { name: 'Removed from Bank', value: `$${removedFromBank.toLocaleString()}`, inline: true },
      { name: 'New Cash Total', value: `$${userData[targetId].cash.toLocaleString()}`, inline: true },
      { name: 'New Bank Balance', value: `$${(userData[targetId].bankBalance || 0).toLocaleString()}`, inline: true },
      { name: 'Developer', value: `<@${interaction.user.id}>`, inline: false }
    )
    .setColor(0xFF6B6B)
    .setFooter({ text: 'Developer Command Executed • Bank Protection Bypassed' })
    .setTimestamp();

  await interaction.reply({ embeds: [successEmbed] });
}

async function handleResetCooldownsCommand(interaction) {
  if (!isDeveloper(interaction.user.id)) {
    const accessDeniedEmbed = new EmbedBuilder()
      .setTitle('Access Denied')
      .setDescription('This command is restricted to developers only.')
      .setColor(0xFF6B6B)
      .setTimestamp();

    return await interaction.editReply({ embeds: [accessDeniedEmbed] });
  }

  const targetUser = interaction.options.getUser('user');

  if (targetUser) {
    const userId = targetUser.id;

    if (cooldowns.scavenge && cooldowns.scavenge[userId]) delete cooldowns.scavenge[userId];
    if (cooldowns.labor && cooldowns.labor[userId]) delete cooldowns.labor[userId];
    if (cooldowns.steal && cooldowns.steal[userId]) delete cooldowns.steal[userId];
    if (cooldowns.fish && cooldowns.fish[userId]) delete cooldowns.fish[userId];

    await saveCooldowns();

    const successEmbed = new EmbedBuilder()
      .setTitle('Cooldowns Reset')
      .setDescription(`Successfully reset all cooldowns for ${targetUser.displayName}!`)
      .addFields(
        { name: 'Target User', value: `<@${userId}>`, inline: true },
        { name: 'Cooldowns Reset', value: 'Scavenge, Labor, Steal, Fish', inline: true },
        { name: 'Developer', value: `<@${interaction.user.id}>`, inline: true }
      )
      .setColor(0x51CF66)
      .setFooter({ text: 'Developer Command Executed' })
      .setTimestamp();

    await interaction.editReply({ embeds: [successEmbed] });
  } else {
    cooldowns.scavenge = {};
    cooldowns.labor = {};
    cooldowns.steal = {};
    cooldowns.fish = {};

    await saveCooldowns();

    const successEmbed = new EmbedBuilder()
      .setTitle('Global Cooldown Reset')
      .setDescription('Successfully reset ALL cooldowns for ALL users globally!')
      .addFields(
        { name: 'Scope', value: 'All Users Worldwide', inline: true },
        { name: 'Cooldowns Reset', value: 'Scavenge, Labor, Steal, Fish', inline: true },
        { name: 'Developer', value: `<@${interaction.user.id}>`, inline: true }
      )
      .setColor(0x51CF66)
      .setFooter({ text: 'Developer Command Executed' })
      .setTimestamp();

    await interaction.editReply({ embeds: [successEmbed] });
  }
}

async function handleDevlogCommand(interaction) {
  if (!isDeveloper(interaction.user.id)) {
    return interaction.reply({
      embeds: [new EmbedBuilder().setTitle('Access Denied').setDescription('This command is restricted to developers only.').setColor(0xFF6B6B).setTimestamp()],
      ephemeral: true
    });
  }

  await interaction.deferReply({ ephemeral: true });

  const title = interaction.options.getString('title');
  const message = interaction.options.getString('message');
  const version = interaction.options.getString('version');

  const embed = new EmbedBuilder()
    .setTitle(`📋 Developer Update${version ? ` — ${version}` : ''}`)
    .setDescription(`**${title}**\n\n${message}`)
    .setColor(0x5865F2)
    .setFooter({ text: `Posted by ${interaction.user.username} • Fortune Bot Development` })
    .setTimestamp();

  let delivered = 0;
  let failed = 0;
  const guilds = client.guilds.cache;

  for (const [guildId, guild] of guilds) {
    try {
      const announcementChannelId = await getAnnouncementChannelId(guildId);
      let channel = null;

      if (announcementChannelId) {
        channel = await client.channels.fetch(announcementChannelId).catch(() => null);
        if (channel && (!channel.isTextBased || !channel.isTextBased())) channel = null;
      }

      if (!channel) {
        const textChannels = guild.channels.cache
          .filter(c => c.isTextBased() && c.permissionsFor(guild.members.me)?.has('SendMessages'))
          .sort((a, b) => a.position - b.position);
        channel = textChannels.first() || null;
      }

      if (!channel) { failed++; continue; }

      await channel.send({ embeds: [embed] });
      delivered++;
    } catch (err) {
      failed++;
      console.error(`Devlog send failed for guild ${guildId}:`, err.message);
    }
  }

  const resultEmbed = new EmbedBuilder()
    .setTitle('Devlog Broadcast Complete')
    .addFields(
      { name: 'Title', value: title, inline: false },
      { name: 'Version', value: version || 'None', inline: true },
      { name: 'Delivered', value: `${delivered} server(s)`, inline: true },
      { name: 'Failed', value: `${failed} server(s)`, inline: true },
      { name: 'Developer', value: `<@${interaction.user.id}>`, inline: false }
    )
    .setColor(delivered > 0 ? 0x51CF66 : 0xFF6B6B)
    .setFooter({ text: 'Developer Command Executed' })
    .setTimestamp();

  await interaction.editReply({ embeds: [resultEmbed] });
}

async function handleConfigureObservationCommand(interaction, userId) {
  const user = await getUser(userId);
  const current = user.observationPermission || 'prohibit';

  function buildConfigEmbed(setting) {
    const isAllow = setting === 'allow';
    return new EmbedBuilder()
      .setTitle('Observation Permissions')
      .setDescription(
        'Control whether other players can view your inventory, artefacts, stats and activity using `/observe`.\n\n' +
        'Your current setting is shown below. Click a button to change it.'
      )
      .addFields(
        {
          name: 'Current Setting',
          value: isAllow
            ? 'Allow — Anyone may view your profile with /observe.'
            : 'Prohibit — Your profile is hidden from /observe.',
          inline: false
        },
        {
          name: 'What "Allow" exposes',
          value: [
            'Cash on hand and bank balance',
            'Full artefact collection with rarity, tier, and value',
            'Purchased items',
            'XP, message count, and command count',
            'Date you started playing'
          ].join('\n'),
          inline: false
        }
      )
      .setColor(isAllow ? 0x51CF66 : 0xFF6B6B)
      .setFooter({ text: 'Changes are saved immediately when you click a button.' })
      .setTimestamp();
  }

  function buildConfigComponents(setting) {
    return [new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('obs_cfg_allow')
        .setLabel('Allow Observation')
        .setStyle(setting === 'allow' ? ButtonStyle.Success : ButtonStyle.Secondary)
        .setDisabled(setting === 'allow'),
      new ButtonBuilder()
        .setCustomId('obs_cfg_prohibit')
        .setLabel('Prohibit Observation')
        .setStyle(setting === 'prohibit' ? ButtonStyle.Danger : ButtonStyle.Secondary)
        .setDisabled(setting === 'prohibit')
    )];
  }

  const reply = await interaction.reply({
    embeds: [buildConfigEmbed(current)],
    components: buildConfigComponents(current),
    ephemeral: true,
    fetchReply: true
  });

  const collector = reply.createMessageComponentCollector({
    filter: i => i.user.id === userId,
    time: 120000
  });

  collector.on('collect', async i => {
    const newSetting = i.customId === 'obs_cfg_allow' ? 'allow' : 'prohibit';
    userData[userId].observationPermission = newSetting;
    await saveUser(userId);
    await i.update({
      embeds: [buildConfigEmbed(newSetting)],
      components: buildConfigComponents(newSetting)
    });
  });

  collector.on('end', async () => {
    try {
      await interaction.editReply({ components: [] });
    } catch (e) {}
  });
}

function buildProgressBar(current, total) {
  if (total === 0) return '[░░░░░░░░░░]';
  const filled = Math.round((current / total) * 10);
  const empty = 10 - filled;
  return `[${'█'.repeat(filled)}${'░'.repeat(empty)}]`;
}

function buildSetsPage(user) {
  const progress = computeSetProgress(user.artefacts || []);

  const fields = progress.map(p => {
    const lines = p.set.items.map(item => {
      const owned = p.itemCounts[item] || 0;
      const icon = owned > 0 ? '✅' : '❌';
      const countStr = owned > 1 ? `  *(×${owned})*` : '';
      return `${icon}  **${item}**${countStr}`;
    });
    const status = p.completeCopies > 0
      ? `**${p.completeCopies} complete copy${p.completeCopies === 1 ? '' : 'ies'}** ready to sell`
      : `${p.ownedDistinct} / ${p.total} pieces collected`;
    return {
      name: `${p.set.name}  ·  ${status}`,
      value: `*${p.set.description}*\n${lines.join('\n')}`,
      inline: false
    };
  });

  return new EmbedBuilder()
    .setTitle('Field Guide — Artefact Sets')
    .setDescription(
      `Selling a **complete set** in a single transaction grants a **${Math.round(COLLECTORS_PREMIUM * 100)}% Collector's Premium** on those items' value.\n` +
      `Mix and match across rarities — that one missing piece is worth trading for.`
    )
    .setColor(0xF1C40F)
    .addFields(fields)
    .setFooter({ text: `Sets page  ·  ${progress.length} sets total` })
    .setTimestamp();
}

function buildCollectionPage(user, pageIndex) {
  if (pageIndex === rarities.length) return buildSetsPage(user);
  const rarity = rarities[pageIndex];
  const items = rarity.items;

  if (!user.discoveredArtefacts) user.discoveredArtefacts = [];

  const discovered = new Set([
    ...user.discoveredArtefacts,
    ...(user.artefacts || []).map(a =>
      a.startsWith('✨ SHINY ') && a.endsWith(' ✨')
        ? a.replace('✨ SHINY ', '').replace(' ✨', '')
        : a
    )
  ]);

  const inventoryCounts = {};
  for (const a of (user.artefacts || [])) {
    const base = a.startsWith('✨ SHINY ') && a.endsWith(' ✨')
      ? a.replace('✨ SHINY ', '').replace(' ✨', '')
      : a;
    inventoryCounts[base] = (inventoryCounts[base] || 0) + 1;
  }

  const byTier = { 1: [], 2: [], 3: [], 4: [], 5: [] };
  for (const item of items) {
    const tier = artefactTiers[item] || 3;
    byTier[tier].push(item);
  }

  const collectedCount = items.filter(i => discovered.has(i)).length;
  const totalCount = items.length;
  const progressBar = buildProgressBar(collectedCount, totalCount);

  const rarityEmoji = { '1-Star': '⭐', '2-Star': '⭐⭐', '3-Star': '⭐⭐⭐', '4-Star': '⭐⭐⭐⭐', '5-Star': '⭐⭐⭐⭐⭐' };
  const tierLabel = { 1: 'Tier I  ·  ×0.65 value', 2: 'Tier II  ·  ×0.75 value', 3: 'Tier III  ·  ×1.0 value', 4: 'Tier IV  ·  ×1.25 value', 5: 'Tier V  ·  ×1.35 value' };

  const fields = [];
  for (const tier of [1, 2, 3, 4, 5]) {
    const tierItems = byTier[tier];
    if (!tierItems || tierItems.length === 0) continue;

    const lines = tierItems.map(item => {
      const isFound = discovered.has(item);
      const count = inventoryCounts[item] || 0;
      const sellValue = calcArtefactSellValue(item, rarity).toLocaleString();
      const countStr = count > 0 ? `  *(×${count} in vault)*` : '';
      const icon = isFound ? '✅' : '❌';
      const nameStr = isFound ? `**${item}**` : `~~${item}~~`;
      return `${icon}  ${nameStr}  ·  $${sellValue}${countStr}`;
    });

    fields.push({
      name: `▬▬▬  ${tierLabel[tier]}  ▬▬▬`,
      value: lines.join('\n'),
      inline: false
    });
  }

  const embedColor = rarity.color === 0x000000 ? 0x2B2D31 : rarity.color;

  return new EmbedBuilder()
    .setTitle(`${rarityEmoji[rarity.name] || '📋'}  Field Guide — ${rarity.name}`)
    .setDescription(
      `**${collectedCount} / ${totalCount} discovered**  ${progressBar}\n` +
      `*Drop chance: ${rarity.chance}%  ·  Base sell value: $${rarity.sell.toLocaleString()}*`
    )
    .setColor(embedColor)
    .addFields(fields)
    .setFooter({ text: `Page ${pageIndex + 1} / ${rarities.length}  ·  ✅ Discovered  ·  ❌ Not yet found` })
    .setTimestamp();
}

function buildCollectionButtons(userId, pageIndex) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`collection_prev_${userId}_${pageIndex}`)
      .setLabel('◀  Previous')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(pageIndex === 0),
    new ButtonBuilder()
      .setCustomId(`collection_next_${userId}_${pageIndex}`)
      .setLabel('Next  ▶')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(pageIndex === rarities.length)
  );
  return [row];
}

async function handleCollectionCommand(interaction, userId) {
  const user = await getUser(userId);
  if (!user.discoveredArtefacts) user.discoveredArtefacts = [];

  const pageIndex = 0;
  const embed = buildCollectionPage(user, pageIndex);
  const components = buildCollectionButtons(userId, pageIndex);
  await interaction.reply({ embeds: [embed], components });
}

function buildQuestsPayload(user, dq, community, userId) {
  const sectionEmojis = { action: '⚔️', economy: '💰', social: '💬' };
  const sections = ['action', 'economy', 'social'];
  const lines = [];

  for (const section of sections) {
    const sectionQuests = dq.quests.filter(q => q.section === section);
    const label = section.charAt(0).toUpperCase() + section.slice(1);
    lines.push(`**${sectionEmojis[section]} ${label}**${dq.sectionBonuses[section] ? ' 🏅 *(bonus claimed)*' : ''}`);
    for (const q of sectionQuests) {
      let check = '▫️';
      if (q.claimed) check = '💰';
      else if (q.completed) check = '✅';
      lines.push(`${check} ${q.label} — ${q.progress}/${q.target} (${q.desc}) · $${q.cashReward.toLocaleString()} + ${q.xpReward} XP`);
    }
    lines.push('\u200b');
  }

  const completedCount = dq.quests.filter(q => q.completed).length;
  const claimedCount = dq.quests.filter(q => q.claimed).length;

  const embed = new EmbedBuilder()
    .setTitle('📋 Daily Quests')
    .setDescription(lines.join('\n'))
    .addFields(
      { name: 'Progress', value: `${completedCount}/9 complete · ${claimedCount}/9 claimed${dq.fullClearBonus ? ' 🏆 **FULL CLEAR!**' : ''}`, inline: false }
    )
    .setColor(0x339AF0)
    .setFooter({ text: '✅ Ready  ·  💰 Claimed  ·  ▫️ In progress  ·  Personal quests reset daily' })
    .setTimestamp();

  if (community) {
    const commStatus = community.completed ? '✅ Completed!' : `${community.progress.toLocaleString()}/${community.target.toLocaleString()}`;
    const alreadyClaimed = community.claimedBy && community.claimedBy.includes(userId);
    embed.addFields({
      name: `🌍 Weekly Server Quest: ${community.label}`,
      value: `${community.desc}\nProgress: ${commStatus}\nReward per contributor: $${community.cashReward.toLocaleString()} + ${community.xpReward} XP` +
        (community.contributors.includes(userId) ? (alreadyClaimed ? '\n💰 *You already claimed your reward.*' : '\n*You have contributed this week!*') : ''),
      inline: false
    });
  }

  const components = [];
  for (const section of sections) {
    const sectionQuests = dq.quests.filter(q => q.section === section);
    const row = new ActionRowBuilder().addComponents(
      sectionQuests.map(q => {
        let style = ButtonStyle.Secondary;
        let label = `▫️ ${q.label}`;
        let disabled = true;
        if (q.claimed) {
          style = ButtonStyle.Secondary;
          label = `💰 Claimed`;
          disabled = true;
        } else if (q.completed) {
          style = ButtonStyle.Success;
          label = `✅ Claim: ${q.label}`;
          disabled = false;
        }
        return new ButtonBuilder()
          .setCustomId(`quest_claim_${userId}|${q.id}`)
          .setLabel(label.length > 80 ? label.slice(0, 77) + '...' : label)
          .setStyle(style)
          .setDisabled(disabled);
      })
    );
    components.push(row);
  }

  const bonusRow = new ActionRowBuilder().addComponents(
    sections.map(section => {
      const sectionQuests = dq.quests.filter(q => q.section === section);
      const allClaimed = sectionQuests.every(q => q.claimed);
      const claimedBonus = dq.sectionBonuses[section];
      return new ButtonBuilder()
        .setCustomId(`quest_claim_section_${section}|${userId}`)
        .setLabel(claimedBonus ? `🏅 ${section} bonus claimed` : `🎯 Claim ${section} bonus`)
        .setStyle(claimedBonus ? ButtonStyle.Secondary : ButtonStyle.Primary)
        .setDisabled(claimedBonus || !allClaimed);
    })
  );
  components.push(bonusRow);

  const finalRowButtons = [
    new ButtonBuilder()
      .setCustomId(`quest_claim_full_${userId}`)
      .setLabel(dq.fullClearBonus ? '🏆 Full Clear Bonus Claimed' : '🏆 Claim Full Clear Bonus')
      .setStyle(dq.fullClearBonus ? ButtonStyle.Secondary : ButtonStyle.Success)
      .setDisabled(dq.fullClearBonus || !dq.quests.every(q => q.claimed))
  ];

  if (community) {
    const alreadyClaimed = community.claimedBy && community.claimedBy.includes(userId);
    const canClaim = community.completed && community.contributors.includes(userId) && !alreadyClaimed;
    finalRowButtons.push(
      new ButtonBuilder()
        .setCustomId(`quest_claim_community_${community._guildId || ''}`)
        .setLabel(alreadyClaimed ? '🌍 Server Reward Claimed' : '🌍 Claim Server Reward')
        .setStyle(alreadyClaimed ? ButtonStyle.Secondary : ButtonStyle.Success)
        .setDisabled(!canClaim)
    );
  }

  components.push(new ActionRowBuilder().addComponents(finalRowButtons));

  return { embed, components };
}

async function handleQuestsCommand(interaction, userId) {
  await interaction.deferReply();

  const user = await getUser(userId);
  const dq = ensureDailyQuests(user);
  await saveUser(userId);

  const guildId = interaction.guildId;
  const community = guildId ? await ensureCommunityQuest(guildId) : null;
  if (community) community._guildId = guildId;

  const { embed, components } = buildQuestsPayload(user, dq, community, userId);
  await interaction.editReply({ embeds: [embed], components });
}

async function handleObserveCommand(interaction, observerId) {
  const targetDiscordUser = interaction.options.getUser('player');
  const targetId = targetDiscordUser.id;

  if (targetId === observerId) {
    return await interaction.reply({
      embeds: [new EmbedBuilder()
        .setTitle('Cannot Observe Yourself')
        .setDescription('Use `/inventory` to view your own stats and artefacts.')
        .setColor(0xFF9F43)
        .setTimestamp()
      ],
      ephemeral: true
    });
  }

  const target = await getUser(targetId);
  const permission = target.observationPermission || 'prohibit';

  if (permission !== 'allow') {
    return await interaction.reply({
      embeds: [new EmbedBuilder()
        .setTitle('Observation Denied')
        .setDescription(
          `The user you wish to observe has set their observation permissions to **Prohibit**.\n\n` +
          `If you would like to observe their inventory, ask them to give you access by running ` +
          `\`/configure-observation\` and selecting **Allow**.`
        )
        .addFields(
          { name: 'Requested Profile', value: `<@${targetId}>`, inline: true },
          { name: 'Permission Status', value: 'Prohibit', inline: true }
        )
        .setColor(0xFF6B6B)
        .setFooter({ text: 'Each player controls their own visibility settings.' })
        .setTimestamp()
      ]
    });
  }

  await updateQuestProgress(observerId, interaction.guildId, 'observeUsed', 1);
  const bankCapacity = await calculateBankCapacity(targetId);
  const totalWealth = target.cash + (target.bankBalance || 0);

  const collectionValue = (target.artefacts || []).reduce((sum, name) => {
    const isShiny = name.startsWith('✨ SHINY ') && name.endsWith(' ✨');
    const rarity = getRarityByArtefact(name);
    const tierSell = calcArtefactSellValue(name, rarity);
    return sum + (isShiny ? tierSell * 5 : tierSell);
  }, 0);

  const xp = target.xpData?.xp || 0;
  const messages = target.xpData?.messageCount || 0;
  const commands = target.commandCount || 0;
  const joinedDate = target.joinedDate
    ? `<t:${Math.floor(target.joinedDate / 1000)}:D>`
    : 'Before records began';

  const artefactCounts = {};
  (target.artefacts || []).forEach(name => {
    artefactCounts[name] = (artefactCounts[name] || 0) + 1;
  });

  const artefactLines = Object.entries(artefactCounts).map(([name, count]) => {
    const rarity = getRarityByArtefact(name);
    const tier = getArtefactTier(name);
    const tierSell = calcArtefactSellValue(name, rarity);
    const isShiny = name.startsWith('✨ SHINY ') && name.endsWith(' ✨');
    const sellDisplay = isShiny ? tierSell * 5 : tierSell;
    const countSuffix = count > 1 ? ` [${count}]` : '';
    const emoji = getRarityEmoji(rarity ? rarity.name : '');
    return `${emoji} ${name} (${rarity ? rarity.name : 'Unknown'} T${tier} — $${sellDisplay.toLocaleString()})${countSuffix}`;
  });

  const itemCounts = {};
  (target.items || []).forEach(item => { itemCounts[item] = (itemCounts[item] || 0) + 1; });
  const itemsDisplay = Object.entries(itemCounts)
    .map(([name, count]) => `${name}${count > 1 ? ` [${count}]` : ''}`)
    .join(', ') || 'No items purchased';

  const ARTS_PER_PAGE = 15;
  const artefactChunks = [];
  if (artefactLines.length === 0) {
    artefactChunks.push('No artefacts in inventory.');
  } else {
    for (let i = 0; i < artefactLines.length; i += ARTS_PER_PAGE) {
      artefactChunks.push(artefactLines.slice(i, i + ARTS_PER_PAGE).join('\n'));
    }
  }

  const totalPages = 2 + artefactChunks.length;
  let currentPage = 0;

  function buildPage(page) {
    const base = { color: 0x339AF0 };

    if (page === 0) {
      return new EmbedBuilder()
        .setTitle(`Observing ${targetDiscordUser.displayName}`)
        .setDescription(`Financial overview for <@${targetId}>`)
        .addFields(
          { name: 'Cash on Hand',      value: `$${target.cash.toLocaleString()}`,                inline: true },
          { name: 'Bank Balance',       value: `$${(target.bankBalance || 0).toLocaleString()}`,  inline: true },
          { name: 'Total Wealth',       value: `$${totalWealth.toLocaleString()}`,                inline: true },
          { name: 'Collection Value',   value: `$${collectionValue.toLocaleString()}`,            inline: true },
          { name: 'Bank Capacity',      value: `$${bankCapacity.toLocaleString()}`,               inline: true },
          { name: 'Bank Expansions',    value: `${target.bankExpansions || 0}`,                   inline: true },
          { name: 'Artefacts Owned',    value: `${(target.artefacts || []).length}`,              inline: true },
          { name: 'Purchased Items',    value: `${(target.items || []).length}`,                  inline: true },
          { name: 'Items',              value: itemsDisplay.length > 500 ? itemsDisplay.slice(0, 497) + '...' : itemsDisplay, inline: false }
        )
        .setColor(0x339AF0)
        .setFooter({ text: `Page 1 of ${totalPages} — Financial Overview` })
        .setTimestamp();

    } else if (page === totalPages - 1) {
      return new EmbedBuilder()
        .setTitle(`Observing ${targetDiscordUser.displayName}`)
        .setDescription(`Player profile for <@${targetId}>`)
        .addFields(
          { name: 'Experience Points', value: `${xp.toLocaleString()} XP`,          inline: true },
          { name: 'XP Cash Value',     value: `$${(xp * 2).toLocaleString()}`,       inline: true },
          { name: '\u200B',            value: '\u200B',                               inline: true },
          { name: 'Messages Sent',     value: messages.toLocaleString(),             inline: true },
          { name: 'Commands Used',     value: commands.toLocaleString(),             inline: true },
          { name: '\u200B',            value: '\u200B',                               inline: true },
          { name: 'Playing Since',     value: joinedDate,                            inline: false }
        )
        .setColor(0xFFD700)
        .setFooter({ text: `Page ${totalPages} of ${totalPages} — Player Profile` })
        .setTimestamp();

    } else {
      const chunkIndex = page - 1;
      const label = artefactChunks.length > 1
        ? `Artefacts (${chunkIndex + 1} of ${artefactChunks.length})`
        : 'Artefacts';
      return new EmbedBuilder()
        .setTitle(`Observing ${targetDiscordUser.displayName}`)
        .setDescription(
          `<@${targetId}> holds **${(target.artefacts || []).length}** artefact(s) ` +
          `valued at **$${collectionValue.toLocaleString()}** total.`
        )
        .addFields({ name: label, value: artefactChunks[chunkIndex], inline: false })
        .setColor(0x9B59B6)
        .setFooter({ text: `Page ${page + 1} of ${totalPages} — Artefact Collection` })
        .setTimestamp();
    }
  }

  function buildNavComponents(page) {
    return [new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('obs_prev')
        .setLabel('Previous')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page === 0),
      new ButtonBuilder()
        .setCustomId('obs_next')
        .setLabel('Next')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(page === totalPages - 1)
    )];
  }

  const reply = await interaction.reply({
    embeds: [buildPage(0)],
    components: buildNavComponents(0),
    fetchReply: true
  });

  const collector = reply.createMessageComponentCollector({
    filter: i => i.user.id === observerId,
    time: 300000
  });

  collector.on('collect', async i => {
    if (i.customId === 'obs_prev') currentPage = Math.max(0, currentPage - 1);
    if (i.customId === 'obs_next') currentPage = Math.min(totalPages - 1, currentPage + 1);
    await i.update({ embeds: [buildPage(currentPage)], components: buildNavComponents(currentPage) });
  });

  collector.on('end', async () => {
    try {
      await interaction.editReply({ components: [] });
    } catch (e) {}
  });
}


const CARD_RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const CARD_SUITS = ['♠','♥','♦','♣'];
const CARD_VALUES = {'2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13,'A':14};

function buildDeck() {
  const deck = [];
  for (const suit of CARD_SUITS)
    for (const rank of CARD_RANKS)
      deck.push({ rank, suit, value: CARD_VALUES[rank] });
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function renderCardLines(card) {
  const r = card.rank;
  const s = card.suit;
  return [
    '┌─────┐',
    `│${r.padEnd(5)}│`,
    `│  ${s}  │`,
    `│${r.padStart(5)}│`,
    '└─────┘'
  ];
}

function renderFaceDownLines() {
  return [
    '┌─────┐',
    '│░░░░░│',
    '│░░░░░│',
    '│░░░░░│',
    '└─────┘'
  ];
}

function renderHandBlock(cards) {
  if (!cards || cards.length === 0) return '*(empty)*';
  const lines = cards.map(c => renderCardLines(c));
  const rows = [];
  for (let i = 0; i < 5; i++)
    rows.push(lines.map(l => l[i]).join('  '));
  return '```\n' + rows.join('\n') + '\n```';
}

function cardLabel(card) {
  return `${card.rank}${card.suit}`;
}

function buildCardDuelGameEmbed(game) {
  const [p1, p2] = game.players;
  const p1Score = game.scores[p1.id] || 0;
  const p2Score = game.scores[p2.id] || 0;
  const p1Hand = game.hands[p1.id] || [];
  const p2Hand = game.hands[p2.id] || [];
  const p1Picked = game.picks[p1.id] !== undefined;
  const p2Picked = game.picks[p2.id] !== undefined;
  const historyStr = game.roundHistory.length
    ? game.roundHistory.map(r => r.summary).join('\n')
    : '*No rounds played yet*';

  return new EmbedBuilder()
    .setTitle(`🃏 Card Duel — Round ${game.round}`)
    .setDescription(
      `**${p1.displayName}** vs **${p2.displayName}**\n` +
      `💰 Pot: **$${game.totalPot.toLocaleString()}**`
    )
    .addFields(
      { name: '🏆 Score', value: `**${p1.displayName}** ${p1Score} — ${p2Score} **${p2.displayName}**`, inline: false },
      { name: `⚔️ ${p1.displayName}'s Hand`, value: renderHandBlock(p1Hand), inline: false },
      { name: `🎯 ${p2.displayName}'s Hand`, value: renderHandBlock(p2Hand), inline: false },
      { name: '📋 Status', value: `${p1Picked ? '✅' : '⏳'} **${p1.displayName}**  |  ${p2Picked ? '✅' : '⏳'} **${p2.displayName}**`, inline: false },
      { name: '📜 Round History', value: historyStr, inline: false }
    )
    .setColor(0xE74C3C)
    .setFooter({ text: `Round ${game.round} of 3 max • Both hands are visible — choose wisely` })
    .setTimestamp();
}

async function handleCardDuelCommand(interaction) {
  const userId = interaction.user.id;
  const opponent = interaction.options.getUser('opponent');
  const bet = interaction.options.getInteger('bet');

  if (opponent.id === userId)
    return interaction.reply({ content: '❌ You cannot challenge yourself!', ephemeral: true });
  if (opponent.bot)
    return interaction.reply({ content: '❌ Bots cannot play card duels!', ephemeral: true });

  const busyCheck = [userId, opponent.id].some(id =>
    Object.values(global.activeCardDuelGames).some(g => g.players.some(p => p.id === id)) ||
    Object.values(global.activeDuelGames).some(g => g.players.some(p => p.id === id)) ||
    Object.values(global.activeMarbleGames).some(g => g.players.some(p => p.id === id))
  );
  if (busyCheck)
    return interaction.reply({ content: '❌ One or more players are already in an active game!', ephemeral: true });

  const challenger = await getUser(userId);
  if (challenger.cash < bet)
    return interaction.reply({
      content: `❌ You only have **$${challenger.cash.toLocaleString()}** — not enough to bet **$${bet.toLocaleString()}**.`,
      ephemeral: true
    });

  const gameId = `cduel_${userId}_${Date.now()}`;
  global.activeCardDuelGames[gameId] = {
    gameId,
    guildId: interaction.guildId || null,
    players: [interaction.user, opponent],
    bet,
    totalPot: bet * 2,
    betsCollected: false,
    phase: 'invitation',
    hands: {},
    picks: {},
    round: 1,
    scores: { [userId]: 0, [opponent.id]: 0 },
    roundHistory: [],
    gameMessage: null,
    channel: null,
    createdAt: Date.now()
  };

  const embed = new EmbedBuilder()
    .setTitle('🃏 Card Duel — Challenge Issued')
    .setDescription(
      `**${interaction.user.displayName}** has challenged **${opponent.displayName}** to a Card Duel!\n\n` +
      `**${opponent.displayName}** must accept within **2 minutes** to begin.`
    )
    .addFields(
      { name: '⚔️ Challenger', value: `<@${userId}>`, inline: true },
      { name: '🎯 Opponent', value: `<@${opponent.id}>`, inline: true },
      { name: '💰 Bet', value: `$${bet.toLocaleString()} each — pot of **$${(bet * 2).toLocaleString()}**`, inline: false },
      {
        name: '📖 How It Works',
        value:
          '> • Each player is dealt **3 cards** — both hands are visible to everyone\n' +
          '> • Each round, both secretly pick one card — **highest value wins the round**\n' +
          '> • Card values: 2–10 face value, J=11, Q=12, K=13, A=14\n' +
          '> • First to win **2 rounds** takes the pot\n' +
          '> • Tied rounds score no points — if all 3 rounds tie, bets are refunded',
        inline: false
      }
    )
    .setColor(0xE74C3C)
    .setFooter({ text: '⏰ Invitation expires in 2 minutes' })
    .setTimestamp();

  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`cduel_accept_${gameId}`)
      .setLabel('✅ Accept Duel')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`cduel_decline_${gameId}`)
      .setLabel('❌ Decline')
      .setStyle(ButtonStyle.Danger)
  );

  await interaction.reply({ embeds: [embed], components: [buttons] });

  setTimeout(() => {
    const game = global.activeCardDuelGames[gameId];
    if (game && game.phase === 'invitation') {
      delete global.activeCardDuelGames[gameId];
      interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle('⏰ Card Duel Expired')
            .setDescription('The challenge was not accepted in time.')
            .setColor(0x99AAB5)
            .setTimestamp()
        ],
        components: []
      }).catch(() => {});
    }
  }, 120000);
}

async function handleCardDuelAccept(interaction, gameId) {
  const game = global.activeCardDuelGames[gameId];
  if (!game)
    return interaction.reply({ content: '❌ This duel is no longer active.', ephemeral: true });
  if (interaction.user.id !== game.players[1].id)
    return interaction.reply({ content: '❌ You were not invited to this duel.', ephemeral: true });
  if (game.phase !== 'invitation')
    return interaction.reply({ content: '❌ This duel has already started.', ephemeral: true });

  const opponentData = await getUser(interaction.user.id);
  if (opponentData.cash < game.bet) {
    delete global.activeCardDuelGames[gameId];
    return interaction.update({
      embeds: [
        new EmbedBuilder()
          .setTitle('❌ Card Duel Cancelled')
          .setDescription(
            `**${interaction.user.displayName}** doesn't have enough cash to match the bet of **$${game.bet.toLocaleString()}**.`
          )
          .setColor(0xFF6B6B)
          .setTimestamp()
      ],
      components: []
    });
  }

  game.phase = 'game';
  await startCardDuelGame(interaction, gameId);
}

async function handleCardDuelDecline(interaction, gameId) {
  const game = global.activeCardDuelGames[gameId];
  if (!game)
    return interaction.reply({ content: '❌ This duel is no longer active.', ephemeral: true });
  if (interaction.user.id !== game.players[1].id)
    return interaction.reply({ content: '❌ You were not invited to this duel.', ephemeral: true });

  delete global.activeCardDuelGames[gameId];
  await interaction.update({
    embeds: [
      new EmbedBuilder()
        .setTitle('🃏 Card Duel Declined')
        .setDescription(`**${interaction.user.displayName}** has declined the challenge.`)
        .setColor(0xFF6B6B)
        .setTimestamp()
    ],
    components: []
  });
}

async function startCardDuelGame(interaction, gameId) {
  const game = global.activeCardDuelGames[gameId];
  if (!game) return;

  const [p1, p2] = game.players;

  if (!game.betsCollected) {
    const u1 = await getUser(p1.id);
    const u2 = await getUser(p2.id);
    u1.cash -= game.bet;
    u2.cash -= game.bet;
    await saveUser(p1.id);
    await saveUser(p2.id);
    game.betsCollected = true;
  }

  const deck = buildDeck();
  game.hands[p1.id] = deck.slice(0, 3);
  game.hands[p2.id] = deck.slice(3, 6);
  game.picks = {};
  game.channel = interaction.channel;

  const embed = buildCardDuelGameEmbed(game);
  const button = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`cduel_pick_${gameId}`)
      .setLabel('🃏 Pick Your Card')
      .setStyle(ButtonStyle.Primary)
  );

  await interaction.update({ embeds: [embed], components: [button] });
  game.gameMessage = interaction.message;
}

async function handleCardDuelPickButton(interaction, gameId) {
  const game = global.activeCardDuelGames[gameId];
  if (!game)
    return interaction.reply({ content: '❌ This game is no longer active.', ephemeral: true });
  if (!game.players.some(p => p.id === interaction.user.id))
    return interaction.reply({ content: '❌ You are not part of this duel.', ephemeral: true });
  if (game.picks[interaction.user.id] !== undefined)
    return interaction.reply({ content: '✅ You have already picked your card this round!', ephemeral: true });

  const hand = game.hands[interaction.user.id] || [];
  if (hand.length === 0)
    return interaction.reply({ content: '❌ No cards left in your hand.', ephemeral: true });

  const handStr = renderHandBlock(hand);
  const buttons = new ActionRowBuilder().addComponents(
    hand.map((card, i) =>
      new ButtonBuilder()
        .setCustomId(`cduel_play_${gameId}_${i}`)
        .setLabel(`[${i + 1}] ${cardLabel(card)}`)
        .setStyle(ButtonStyle.Secondary)
    )
  );

  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setTitle('🃏 Pick a Card to Play')
        .setDescription(
          `Your hand this round:\n${handStr}\n` +
          `*Remember — your opponent can see your cards too. Play smart!*`
        )
        .setColor(0x3498DB)
        .setTimestamp()
    ],
    components: [buttons],
    ephemeral: true
  });
}

async function handleCardDuelPlay(interaction, gameId, cardIndex) {
  const game = global.activeCardDuelGames[gameId];
  if (!game)
    return interaction.update({ content: '❌ Game no longer active.', components: [], embeds: [] });

  const userId = interaction.user.id;
  if (!game.players.some(p => p.id === userId))
    return interaction.update({ content: '❌ You are not part of this duel.', components: [], embeds: [] });
  if (game.picks[userId] !== undefined)
    return interaction.update({ content: '✅ You already picked this round!', components: [], embeds: [] });

  const hand = game.hands[userId] || [];
  if (cardIndex < 0 || cardIndex >= hand.length)
    return interaction.update({ content: '❌ Invalid card selection.', components: [], embeds: [] });

  game.picks[userId] = cardIndex;
  const card = hand[cardIndex];

  await interaction.update({
    embeds: [
      new EmbedBuilder()
        .setTitle('🃏 Card Locked In!')
        .setDescription(`You played **${cardLabel(card)}** — waiting for your opponent...`)
        .setColor(0x2ECC71)
        .setTimestamp()
    ],
    components: []
  });

  if (game.gameMessage) {
    try {
      await game.gameMessage.edit({
        embeds: [buildCardDuelGameEmbed(game)],
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`cduel_pick_${gameId}`)
              .setLabel('🃏 Pick Your Card')
              .setStyle(ButtonStyle.Primary)
          )
        ]
      });
    } catch (e) {}
  }

  const [p1, p2] = game.players;
  if (game.picks[p1.id] !== undefined && game.picks[p2.id] !== undefined) {
    await resolveCardDuelRound(game);
  }
}

async function resolveCardDuelRound(game) {
  const [p1, p2] = game.players;
  const p1Idx = game.picks[p1.id];
  const p2Idx = game.picks[p2.id];
  const p1Card = game.hands[p1.id][p1Idx];
  const p2Card = game.hands[p2.id][p2Idx];

  game.hands[p1.id] = game.hands[p1.id].filter((_, i) => i !== p1Idx);
  game.hands[p2.id] = game.hands[p2.id].filter((_, i) => i !== p2Idx);

  let summaryLine = '';
  if (p1Card.value > p2Card.value) {
    game.scores[p1.id]++;
    summaryLine = `Round ${game.round}: **${p1.displayName}** wins — ${cardLabel(p1Card)} vs ${cardLabel(p2Card)}`;
  } else if (p2Card.value > p1Card.value) {
    game.scores[p2.id]++;
    summaryLine = `Round ${game.round}: **${p2.displayName}** wins — ${cardLabel(p2Card)} vs ${cardLabel(p1Card)}`;
  } else {
    summaryLine = `Round ${game.round}: 🤝 Tie — ${cardLabel(p1Card)} vs ${cardLabel(p2Card)} (no point)`;
  }

  game.roundHistory.push({ summary: summaryLine });
  game.picks = {};
  game.round++;

  const p1Score = game.scores[p1.id];
  const p2Score = game.scores[p2.id];
  const handsEmpty = game.hands[p1.id].length === 0;
  const hasWinner = p1Score >= 2 || p2Score >= 2;

  if (handsEmpty || hasWinner) {
    await endCardDuelGame(game);
  } else {
    if (game.gameMessage) {
      try {
        await game.gameMessage.edit({
          embeds: [buildCardDuelGameEmbed(game)],
          components: [
            new ActionRowBuilder().addComponents(
              new ButtonBuilder()
                .setCustomId(`cduel_pick_${game.gameId}`)
                .setLabel('🃏 Pick Your Card')
                .setStyle(ButtonStyle.Primary)
            )
          ]
        });
      } catch (e) {}
    }
  }
}

async function endCardDuelGame(game) {
  const [p1, p2] = game.players;
  const p1Score = game.scores[p1.id];
  const p2Score = game.scores[p2.id];
  game.phase = 'finished';

  let resultTitle = '';
  let resultDesc = '';
  let color = 0x99AAB5;

  if (p1Score > p2Score) {
    const winnerData = await getUser(p1.id);
    winnerData.cash += game.totalPot;
    await saveUser(p1.id);
    await updateQuestProgress(p1.id, game.guildId, 'duelWin', 1);
    resultTitle = `🏆 ${p1.displayName} Wins the Card Duel!`;
    resultDesc = `**${p1.displayName}** takes the pot of **$${game.totalPot.toLocaleString()}**!`;
    color = 0xFFD700;
  } else if (p2Score > p1Score) {
    const winnerData = await getUser(p2.id);
    winnerData.cash += game.totalPot;
    await saveUser(p2.id);
    await updateQuestProgress(p2.id, game.guildId, 'duelWin', 1);
    resultTitle = `🏆 ${p2.displayName} Wins the Card Duel!`;
    resultDesc = `**${p2.displayName}** takes the pot of **$${game.totalPot.toLocaleString()}**!`;
    color = 0xFFD700;
  } else {
    const u1 = await getUser(p1.id);
    const u2 = await getUser(p2.id);
    u1.cash += game.bet;
    u2.cash += game.bet;
    await saveUser(p1.id);
    await saveUser(p2.id);
    resultTitle = '🤝 Card Duel — Draw!';
    resultDesc = `All rounds tied — both players refunded **$${game.bet.toLocaleString()}**.`;
    color = 0x99AAB5;
  }

  const historyStr = game.roundHistory.map(r => r.summary).join('\n') || '*No rounds played*';

  const finalEmbed = new EmbedBuilder()
    .setTitle(resultTitle)
    .setDescription(resultDesc)
    .addFields(
      { name: '📊 Final Score', value: `**${p1.displayName}** ${p1Score} — ${p2Score} **${p2.displayName}**`, inline: false },
      { name: '📜 Round History', value: historyStr, inline: false }
    )
    .setColor(color)
    .setTimestamp();

  delete global.activeCardDuelGames[game.gameId];

  if (game.gameMessage) {
    try {
      await game.gameMessage.edit({ embeds: [finalEmbed], components: [] });
    } catch (e) {}
  }
}


async function buildRaidBrowsePayload(session, sessionId) {
  const PER_PAGE   = 5;
  const allPlayers = await getAllRaidPlayers();

  const eligible = allPlayers.filter(p =>
    p._id !== session.userId &&
    !(session.raidedAlready || []).includes(p._id) &&
    (p.raidsCompleted > 0 || Object.values(p.soldiers || {}).some(v => v > 0))
  );

  const totalPages  = Math.max(1, Math.ceil(eligible.length / PER_PAGE));
  const safePage    = Math.max(0, Math.min(session.page, totalPages - 1));
  session.page      = safePage;
  const pagePlayers = eligible.slice(safePage * PER_PAGE, (safePage + 1) * PER_PAGE);

  const userFetches = await Promise.all(pagePlayers.map(p => client.users.fetch(p._id).catch(() => null)));
  const nameMap = {};
  pagePlayers.forEach((p, i) => { nameMap[p._id] = userFetches[i] ? userFetches[i].username : p._id; });

  const fields = [];
  for (const p of pagePlayers) {
    const { relative } = calcRaidCP(p);
    const unitLines = RAID_UNITS
      .filter(u => (p.soldiers || {})[u.id] > 0)
      .map(u => {
        const arch = RAID_ARCHETYPES[u.archetype];
        return `  ${u.ascii.split('\n')[0].trim()}  x${p.soldiers[u.id]}  ${u.name}  [${arch.emoji} ${arch.name}]`;
      })
      .join('\n') || '  (no soldiers visible)';
    fields.push({
      name:  `${nameMap[p._id]}   |   Relative CP: ${relative.toLocaleString()}   |   Raids done: ${p.raidsCompleted}`,
      value: `\`\`\`\n${unitLines}\n\`\`\`Record: ${p.victories}W / ${p.losses}L   |   Training: [HIDDEN]`,
      inline: false
    });
  }

  if (fields.length === 0) {
    fields.push({ name: 'No Eligible Targets', value: 'All participants have either been raided by you already, or no empire has fielded any soldiers yet. Check back later.', inline: false });
  }

  const embed = new EmbedBuilder()
    .setTitle('RAID SEASON  --  Choose Your Target')
    .setDescription(
      `Survey the field. Each empire shows its Relative CP and known military — training is hidden.\n\n` +
      `Your Relative CP: **${session.myRelativeCP.toLocaleString()}**  |  Victories: **${session.myVictories}**  |  Defeats: **${session.myLosses}**\n` +
      (session.mercenariesOwned > 0 ? `Sellsword Captains on retainer: **${session.mercenariesOwned}**` : 'No mercenaries on retainer.')
    )
    .addFields(...fields)
    .setColor(0x8B0000)
    .setFooter({ text: `Page ${safePage + 1} of ${totalPages}  |  You cannot raid the same empire twice this season` })
    .setTimestamp();

  const components = [];

  if (pagePlayers.length > 0) {
    const selectOptions = pagePlayers.map(p => {
      const { relative } = calcRaidCP(p);
      return { label: nameMap[p._id], value: p._id, description: `Relative CP: ${relative.toLocaleString()}  |  ${p.victories}W / ${p.losses}L`, default: p._id === session.selectedTargetId };
    });
    components.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`raid_select_target_${sessionId}`)
        .setPlaceholder('Select a target empire to raid')
        .addOptions(selectOptions)
    ));
  }

  const hasSelected = !!session.selectedTargetId;
  const hasMerc     = session.mercenariesOwned > 0;
  const attackBtns  = [
    new ButtonBuilder()
      .setCustomId(`raid_attack_${session.selectedTargetId || 'none'}`)
      .setLabel('Launch Raid')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(!hasSelected)
  ];
  if (hasMerc) {
    attackBtns.push(new ButtonBuilder()
      .setCustomId(`raid_attack_merc_${session.selectedTargetId || 'none'}`)
      .setLabel('Launch Raid  +  Deploy Captain')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(!hasSelected));
  }
  components.push(new ActionRowBuilder().addComponents(...attackBtns));

  if (totalPages > 1) {
    components.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`raid_page_${sessionId}_${safePage - 1}`).setLabel('< Prev').setStyle(ButtonStyle.Secondary).setDisabled(safePage === 0),
      new ButtonBuilder().setCustomId(`raid_page_${sessionId}_${safePage + 1}`).setLabel('Next >').setStyle(ButtonStyle.Secondary).setDisabled(safePage >= totalPages - 1)
    ));
  }

  return { embeds: [embed], components };
}

async function handleViewCPCommand(interaction) {
  const season = await getRaidSeason();
  if (!season.active) {
    return await interaction.reply({
      embeds: [new EmbedBuilder().setTitle('No Active Raid Season').setDescription('There is no Raid Season running right now.').setColor(0x8B0000).setTimestamp()],
      ephemeral: true
    });
  }

  const target = interaction.options.getUser('player');

  if (!target || target.id === interaction.user.id) {
    const raidData = await getRaidPlayer(interaction.user.id);
    const { relative, actual } = calcRaidCP(raidData);
    const unitLines = RAID_UNITS
      .filter(u => (raidData.soldiers || {})[u.id] > 0)
      .map(u => {
        const level     = (raidData.trainingLevels || {})[u.id] || 1;
        const actualEach = Math.floor(u.baseCP * (TRAINING_MULTIPLIERS[level] || 1.0));
        return `${u.ascii.split('\n')[0].trim()}  x${raidData.soldiers[u.id]}  ${u.name}  [Lv.${level} -- ${actualEach} Actual CP each]`;
      }).join('\n') || '  (no soldiers recruited)';

    await interaction.reply({
      embeds: [new EmbedBuilder()
        .setTitle(`Empire of ${interaction.user.username}  --  Full Report`)
        .setDescription('This report is private. Only you can see your Actual CP and training levels.')
        .addFields(
          { name: 'Relative CP (public)',  value: relative.toLocaleString(), inline: true },
          { name: 'Actual CP (private)',   value: actual.toLocaleString(),   inline: true },
          { name: 'Sellsword Captains',    value: `${raidData.mercenariesOwned || 0} on retainer  (+${RAID_MERCENARY.cp} Actual CP each if deployed)`, inline: false },
          { name: 'Military Breakdown',    value: `\`\`\`\n${unitLines}\n\`\`\``, inline: false },
          { name: 'Season Record',         value: `${raidData.victories} Victories  |  ${raidData.losses} Defeats  |  ${raidData.raidsCompleted} Raids launched`, inline: false }
        )
        .setColor(0x8B0000)
        .setFooter({ text: 'Actual CP and training levels are hidden from all other players' })
        .setTimestamp()],
      ephemeral: true
    });
  } else {
    const raidData = await getRaidPlayer(target.id);
    const { relative } = calcRaidCP(raidData);
    const unitLines = RAID_UNITS
      .filter(u => (raidData.soldiers || {})[u.id] > 0)
      .map(u => `${u.ascii.split('\n')[0].trim()}  x${raidData.soldiers[u.id]}  ${u.name}`)
      .join('\n') || '  (no soldiers visible)';

    await interaction.reply({
      embeds: [new EmbedBuilder()
        .setTitle(`Empire of ${target.username}  --  Field Intelligence`)
        .setDescription('You are viewing public information only. Training levels and Actual CP are classified.')
        .addFields(
          { name: 'Relative CP',  value: `${relative.toLocaleString()}  (training: hidden)`, inline: true },
          { name: 'Season Record', value: `${raidData.victories} Victories  |  ${raidData.losses} Defeats`, inline: true },
          { name: 'Military',      value: `\`\`\`\n${unitLines}\n\`\`\``, inline: false }
        )
        .setColor(0x8B0000)
        .setFooter({ text: 'Actual CP and training levels are classified' })
        .setTimestamp()],
      ephemeral: true
    });
  }
}

async function handleRaidCommand(interaction) {
  const season = await getRaidSeason();
  if (!season.active) {
    return await interaction.reply({
      embeds: [new EmbedBuilder().setTitle('No Active Raid Season').setDescription('There is no Raid Season running right now. Check back when one begins.').setColor(0x8B0000).setTimestamp()],
      ephemeral: true
    });
  }

  const userId   = interaction.user.id;
  const raidData = await getRaidPlayer(userId);
  const { relative } = calcRaidCP(raidData);
  const sessionId = `${userId}_${Date.now()}`;

  global.activeRaidBrowseSessions[sessionId] = {
    userId,
    page:            0,
    selectedTargetId: null,
    raidedAlready:   raidData.raidsInitiated || [],
    myRelativeCP:    relative,
    myVictories:     raidData.victories,
    myLosses:        raidData.losses,
    mercenariesOwned: raidData.mercenariesOwned || 0
  };

  const payload = await buildRaidBrowsePayload(global.activeRaidBrowseSessions[sessionId], sessionId);
  await interaction.reply(payload);

  setTimeout(() => { delete global.activeRaidBrowseSessions[sessionId]; }, 600000);
}

async function handleRaidBuyUnit(interaction) {
  const season = await getRaidSeason();
  if (!season.active) return await interaction.reply({ content: 'No active Raid Season.', ephemeral: true });

  const withoutPrefix = interaction.customId.replace('raid_buy_', '');
  const pageMatch     = withoutPrefix.match(/_p(\d+)$/);
  const raidPage      = pageMatch ? parseInt(pageMatch[1], 10) : 0;
  const inner         = withoutPrefix.replace(/_p\d+$/, '').split('_');
  const qty           = parseInt(inner.pop(), 10);
  const unitId        = inner.join('_');
  const unit          = RAID_UNITS.find(u => u.id === unitId);
  if (!unit) return await interaction.reply({ content: 'Unknown unit type.', ephemeral: true });

  const userId    = interaction.user.id;
  const totalCost = unit.cost * qty;
  await getUser(userId);

  if ((userData[userId].cash || 0) < totalCost) {
    return await interaction.reply({ content: `You need **$${totalCost.toLocaleString()}** but only have **$${(userData[userId].cash || 0).toLocaleString()}**.`, ephemeral: true });
  }

  userData[userId].cash -= totalCost;
  await saveUserData();

  const raidData = await getRaidPlayer(userId);
  raidData.soldiers[unit.id] = (raidData.soldiers[unit.id] || 0) + qty;
  await saveRaidPlayer(raidData);

  await interaction.reply({ content: `Recruited **x${qty} ${unit.name}** for **$${totalCost.toLocaleString()}**.`, ephemeral: true });

  try {
    const [globalItems, guildItemsDoc, updatedSeason] = await Promise.all([getGlobalItems(), guildItemsCollection.findOne({ _id: interaction.guildId }), getRaidSeason()]);
    const payload = await buildStorePayload('raid', userId, interaction.guildId, globalItems, guildItemsDoc?.items || {}, updatedSeason, 'military', raidPage);
    await interaction.message.edit(payload);
  } catch (e) {}
}

async function handleRaidTrainUnit(interaction) {
  const season = await getRaidSeason();
  if (!season.active) return await interaction.reply({ content: 'No active Raid Season.', ephemeral: true });

  const withoutPrefix = interaction.customId.replace('raid_train_', '');
  const pageMatch     = withoutPrefix.match(/_p(\d+)$/);
  const raidPage      = pageMatch ? parseInt(pageMatch[1], 10) : 0;
  const unitId        = withoutPrefix.replace(/_p\d+$/, '');
  const unit          = RAID_UNITS.find(u => u.id === unitId);
  if (!unit) return await interaction.reply({ content: 'Unknown unit type.', ephemeral: true });

  const userId   = interaction.user.id;
  const raidData = await getRaidPlayer(userId);
  const curLevel = (raidData.trainingLevels || {})[unit.id] || 1;
  if (curLevel >= 5) return await interaction.reply({ content: `${unit.name} is already at maximum training level.`, ephemeral: true });

  const nextLevel = curLevel + 1;
  const cost      = TRAINING_COSTS[nextLevel];
  await getUser(userId);

  if ((userData[userId].cash || 0) < cost) {
    return await interaction.reply({ content: `You need **$${cost.toLocaleString()}** to train ${unit.name} to Lv.${nextLevel}.`, ephemeral: true });
  }

  userData[userId].cash -= cost;
  await saveUserData();

  raidData.trainingLevels[unit.id] = nextLevel;
  await saveRaidPlayer(raidData);

  await interaction.reply({ content: `**${unit.name}** trained to **Lv.${nextLevel}** (${TRAINING_LABELS[nextLevel]}). Cost: **$${cost.toLocaleString()}**.`, ephemeral: true });

  try {
    const [globalItems, guildItemsDoc, updatedSeason] = await Promise.all([getGlobalItems(), guildItemsCollection.findOne({ _id: interaction.guildId }), getRaidSeason()]);
    const payload = await buildStorePayload('raid', userId, interaction.guildId, globalItems, guildItemsDoc?.items || {}, updatedSeason, 'training', raidPage);
    await interaction.message.edit(payload);
  } catch (e) {}
}

async function handleRaidHireMerc(interaction) {
  const season = await getRaidSeason();
  if (!season.active) return await interaction.reply({ content: 'No active Raid Season.', ephemeral: true });

  const qty       = parseInt(interaction.customId.replace('raid_hire_merc_', ''), 10) || 1;
  const totalCost = RAID_MERCENARY.cost * qty;
  const userId    = interaction.user.id;
  await getUser(userId);

  if ((userData[userId].cash || 0) < totalCost) {
    return await interaction.reply({ content: `You need **$${totalCost.toLocaleString()}** but only have **$${(userData[userId].cash || 0).toLocaleString()}**.`, ephemeral: true });
  }

  userData[userId].cash -= totalCost;
  await saveUserData();

  const raidData = await getRaidPlayer(userId);
  raidData.mercenariesOwned = (raidData.mercenariesOwned || 0) + qty;
  await saveRaidPlayer(raidData);

  await interaction.reply({ content: `Hired **x${qty} ${RAID_MERCENARY.name}** for **$${totalCost.toLocaleString()}**. Captains on retainer: **${raidData.mercenariesOwned}**.`, ephemeral: true });

  try {
    const [globalItems, guildItemsDoc, updatedSeason] = await Promise.all([getGlobalItems(), guildItemsCollection.findOne({ _id: interaction.guildId }), getRaidSeason()]);
    const payload = await buildStorePayload('raid', userId, interaction.guildId, globalItems, guildItemsDoc?.items || {}, updatedSeason, 'mercenaries', 0);
    await interaction.message.edit(payload);
  } catch (e) {}
}

async function handleRaidConfirmAttack(interaction, targetId, deployMerc) {
  const season = await getRaidSeason();
  if (!season.active) return await interaction.reply({ content: 'No active Raid Season.', ephemeral: true });

  const attackerId = interaction.user.id;
  if (attackerId === targetId) return await interaction.reply({ content: 'You cannot raid your own empire.', ephemeral: true });

  const [attackerData, defenderData] = await Promise.all([getRaidPlayer(attackerId), getRaidPlayer(targetId)]);

  if ((attackerData.raidsInitiated || []).includes(targetId)) {
    return await interaction.reply({ content: 'You have already raided this empire this season. Choose a different target.', ephemeral: true });
  }
  if (deployMerc && (attackerData.mercenariesOwned || 0) < 1) {
    return await interaction.reply({ content: 'You have no Sellsword Captains to deploy.', ephemeral: true });
  }

  if (deployMerc) attackerData.mercenariesOwned = Math.max(0, (attackerData.mercenariesOwned || 0) - 1);

  attackerData.raidsInitiated = [...(attackerData.raidsInitiated || []), targetId];
  attackerData.raidsCompleted = (attackerData.raidsCompleted || 0) + 1;
  await saveRaidPlayer(attackerData);

  const session = Object.values(global.activeRaidBrowseSessions).find(s => s.userId === attackerId);
  if (session) { session.raidedAlready = attackerData.raidsInitiated; session.mercenariesOwned = attackerData.mercenariesOwned; }

  const [attackerUser, defenderUser] = await Promise.all([
    client.users.fetch(attackerId).catch(() => null),
    client.users.fetch(targetId).catch(() => null)
  ]);
  const attackerName = attackerUser ? attackerUser.username : attackerId;
  const defenderName = defenderUser ? defenderUser.username : targetId;

  const attackerCP = calcRaidCP(attackerData);
  const defenderCP = calcRaidCP(defenderData);
  const { attackerAdjusted, defenderAdjusted } = calcRaidCPWithMatchups(attackerData, defenderData, deployMerc);

  const delay = Math.floor(Math.random() * 11) + 10; // 10-20 seconds
  const scenes = generateBattleScenes(attackerData, defenderData, attackerName, defenderName, deployMerc);
  const stageCount  = scenes.length;
  const stageDelay  = Math.floor((delay * 1000) / (stageCount + 1));

  const openingLines = [
    '==========================================',
    `  ATTACKER                  DEFENDER`,
    `  ${attackerName.padEnd(24)}${defenderName}`,
    '==========================================',
    ...RAID_UNITS.filter(u => (attackerData.soldiers || {})[u.id] > 0 || (defenderData.soldiers || {})[u.id] > 0).map(u => {
      const aCount = (attackerData.soldiers || {})[u.id] || 0;
      const dCount = (defenderData.soldiers || {})[u.id] || 0;
      const arch   = RAID_ARCHETYPES[u.archetype];
      const art    = u.ascii.split('\n')[0].trim();
      const aStr   = aCount > 0 ? `${art} x${aCount} [${arch.name}]` : '';
      const dStr   = dCount > 0 ? `${art} x${dCount} [${arch.name}]` : '';
      return `  ${aStr.padEnd(28)}${dStr}`;
    }),
    '==========================================',
    `  Rel. CP: ${attackerCP.relative.toLocaleString().padEnd(16)} Rel. CP: ${defenderCP.relative.toLocaleString()}`,
    `  Actual CP: [HIDDEN]      Actual CP: [HIDDEN]`,
    (deployMerc ? `  + Sellsword Captain deployed` : ''),
    '==========================================',
    `  Armies engaged. The field is in motion...`,
    '=========================================='
  ].filter(l => l !== '').join('\n');

  const openingEmbed = new EmbedBuilder()
    .setTitle('THE FIELD OF BATTLE')
    .setDescription(`\`\`\`\n${openingLines}\n\`\`\``)
    .setColor(0x8B0000)
    .setFooter({ text: 'Archetype matchups are being resolved across the battlefield' })
    .setTimestamp();

  await interaction.update({ embeds: [openingEmbed], components: [] });

  for (let i = 0; i < stageCount; i++) {
    setTimeout(async () => {
      try {
        const sceneEmbed = new EmbedBuilder()
          .setTitle(`THE FIELD OF BATTLE  --  Scene ${i + 1} of ${stageCount}`)
          .setDescription(`\`\`\`\n${scenes[i]}\n\`\`\``)
          .setColor(0x8B0000)
          .setFooter({ text: 'Actual CP is concealed from both sides until the result is declared' })
          .setTimestamp();
        await interaction.editReply({ embeds: [sceneEmbed], components: [] });
      } catch (e) {}
    }, stageDelay * (i + 1));
  }

  setTimeout(async () => {
    try {
      const attackerWins = attackerAdjusted > defenderAdjusted;
      const winnerId     = attackerWins ? attackerId : targetId;
      const loserId      = attackerWins ? targetId   : attackerId;
      const winnerName   = attackerWins ? attackerName : defenderName;
      const loserName    = attackerWins ? defenderName : attackerName;
      const winnerCP     = attackerWins ? attackerAdjusted : defenderAdjusted;
      const loserCP      = attackerWins ? defenderAdjusted : attackerAdjusted;

      if (attackerWins) { attackerData.victories = (attackerData.victories || 0) + 1; defenderData.losses = (defenderData.losses || 0) + 1; }
      else              { defenderData.victories = (defenderData.victories || 0) + 1; }
      await Promise.all([saveRaidPlayer(attackerData), saveRaidPlayer(defenderData)]);

      const winnerRaidData = attackerWins ? attackerData : defenderData;
      const loserRaidData  = attackerWins ? defenderData : attackerData;
      const winnerPayout   = Math.min(winnerRaidData.raidsCompleted * RAID_PAYOUT_RATE, RAID_PAYOUT_CAP);
      const loserPenalty   = Math.min(loserRaidData.raidsCompleted  * RAID_PAYOUT_RATE, RAID_PAYOUT_CAP);

      const resultLines = [
        '==========================================',
        '  BATTLE RESOLVED',
        '==========================================',
        `  VICTOR:   ${winnerName}`,
        `  Adjusted CP: ${winnerCP.toLocaleString()}`,
        '',
        `  DEFEATED: ${loserName}`,
        `  Adjusted CP: ${loserCP.toLocaleString()}`,
        '==========================================',
        '  Records updated. Spoils await season end.',
        '=========================================='
      ].join('\n');

      const resultEmbed = new EmbedBuilder()
        .setTitle('THE BATTLE IS DECIDED')
        .setDescription(`\`\`\`\n${resultLines}\n\`\`\``)
        .addFields(
          { name: 'Victor',   value: `${winnerName}  --  ${winnerRaidData.victories} victory(s) this season`, inline: true },
          { name: attackerWins ? 'Defeated' : 'Repelled', value: attackerWins ? `${loserName}  --  ${loserRaidData.losses} defeat(s) this season` : `${loserName}  --  raid repelled, no loss recorded`, inline: true },
          { name: 'Payout Note', value: `Winnings and losses settle at season end. The more raids you complete, the higher the stakes per result.`, inline: false }
        )
        .setColor(attackerWins ? 0x51CF66 : 0xFF6B6B)
        .setTimestamp();

      try { await interaction.editReply({ embeds: [resultEmbed], components: [] }); } catch (e) {}

      const [winnerUser2, loserUser2] = await Promise.all([
        client.users.fetch(winnerId).catch(() => null),
        client.users.fetch(loserId).catch(() => null)
      ]);
      if (winnerUser2) winnerUser2.send({ embeds: [new EmbedBuilder()
        .setTitle('You won a raid.')
        .setDescription(`Your empire defeated **${loserName}** on the field of battle.`)
        .addFields(
          { name: 'Your Adjusted CP', value: winnerCP.toLocaleString(), inline: true },
          { name: 'Opponent',         value: loserName,                  inline: true },
          { name: 'Projected Payout', value: `+$${winnerPayout.toLocaleString()} at season end  (based on ${winnerRaidData.raidsCompleted} raids completed)`, inline: false }
        ).setColor(0x51CF66).setTimestamp()] }).catch(() => {});
      if (loserUser2) loserUser2.send({ embeds: [new EmbedBuilder()
        .setTitle(attackerWins ? 'Your empire was defeated.' : 'Your raid was repelled.')
        .setDescription(attackerWins
          ? `**${winnerName}** overwhelmed your forces. The defeat is recorded.`
          : `**${winnerName}** held their ground and drove your forces back. No loss has been recorded — but they now know your Adjusted CP.`)
        .addFields(
          { name: 'Your Adjusted CP', value: loserCP.toLocaleString(), inline: true },
          { name: attackerWins ? 'Attacker' : 'Defender', value: winnerName, inline: true },
          ...(attackerWins ? [{ name: 'Projected Penalty', value: `-$${loserPenalty.toLocaleString()} at season end  (based on ${loserRaidData.raidsCompleted} raids completed)`, inline: false }] : [])
        ).setColor(0xFF6B6B).setTimestamp()] }).catch(() => {});

    } catch (err) { console.error('Raid resolution error:', err); }
  }, delay * 1000);
}


const RAID_TUTORIAL_PAGES = [
  {
    title: 'Welcome to the Raid Season  --  Page 1 of 7',
    description:
      `A Raid Season is a **30-day global event** that runs across every server Fortune Bot lives in.\n\n` +
      `During this time, you can spend your cash to **build an empire** — recruiting soldiers, training them, and hiring mercenaries. ` +
      `When you feel ready, you can march on a rival and take the fight to them.\n\n` +
      `At the end of the 30 days, your wins and losses are tallied and **real money changes hands**. ` +
      `The more raids you complete over the season, the higher the stakes on every single one of them.\n\n` +
      `Victories pay out. Losses cost you — but only **defenders** accumulate losses. ` +
      `If you launch a raid and get repelled, no loss is recorded against you. You simply learn from it and move on.\n\n` +
      `Lose badly enough as a defender and it will cut into your bank. Lose catastrophically and you go into debt.\n\n` +
      `**This is not a casual event. Build well or do not build at all.**`,
    footer: 'Raid Season Tutorial  |  Use the buttons below to navigate'
  },
  {
    title: 'Relative CP vs Actual CP  --  Page 2 of 7',
    description:
      `CP stands for **Combat Power**. It decides who wins a raid. There are two kinds, and understanding the difference is the most important thing in this entire tutorial.\n\n` +
      `**Relative CP** is calculated from the raw number of soldiers you have multiplied by each unit's base CP value. ` +
      `It is visible to every other player. When someone uses \`/viewcp\` on you or browses \`/raid\`, this is the number they see.\n\n` +
      `**Actual CP** is calculated the same way — but also factors in your **training levels**. ` +
      `A well-trained army can have an Actual CP far higher than its Relative CP suggests. ` +
      `Only you can see your own Actual CP. Your rivals cannot.\n\n` +
      `When a raid resolves, **only Actual CP is used**. Relative CP is bait.\n\n` +
      `\`\`\`\n` +
      `Example:\n` +
      ` Player A -- Relative CP: 1,200  |  Actual CP: 1,980  (Lv.5 trained)\n` +
      ` Player B -- Relative CP: 1,500  |  Actual CP: 1,500  (untrained)\n` +
      ` Result: Player A wins despite appearing weaker on paper.\n` +
      `\`\`\``,
    footer: 'Raid Season Tutorial  |  Training is your hidden advantage'
  },
  {
    title: 'Building Your Military  --  Page 3 of 7',
    description:
      `Open \`/store\` during an active season and you will find a **[ RAID SEASON ]** tab.\n\n` +
      `Inside, the **Buy Military** sub-tab lists every unit type available to recruit. Each unit has a cost and a base CP value:\n\n` +
      `\`\`\`\n` +
      ` ( o )  Peasant Levy      $100   |  8 CP\n` +
      ` ( o )  Crossbowman       $350   |  18 CP\n` +
      ` ( o )  Spearman          $300   |  15 CP\n` +
      ` { o }  Man-at-Arms       $600   |  28 CP\n` +
      ` ( o )  Squire            $500   |  22 CP\n` +
      ` [_o_]  Sergeant          $900   |  40 CP\n` +
      ` [#o#]  Knight            $2,000 |  90 CP\n` +
      ` ( o )  Cavalry           $1,800 |  75 CP\n` +
      ` ( o )  Siege Engineer    $1,500 |  60 CP\n` +
      ` (***)  Battle Mage       $3,000 | 130 CP\n` +
      `\`\`\`\n\n` +
      `You can buy in quantities of 1, 5, or 10 at a time. Costs come directly from your cash on hand. ` +
      `More soldiers means more Relative CP — and more Actual CP once you start training.`,
    footer: 'Raid Season Tutorial  |  Quality beats quantity once training is involved'
  },
  {
    title: 'Training Your Units  --  Page 4 of 7',
    description:
      `The **Training** sub-tab in \`/store\` lets you level up each unit type from **Level 1 to Level 5**.\n\n` +
      `Training does not affect Relative CP at all — it only increases Actual CP. That is the point. ` +
      `Your rivals see your Relative CP and think they know what they're facing. They don't.\n\n` +
      `\`\`\`\n` +
      ` Level 1  -- x1.00  (base, no bonus)\n` +
      ` Level 2  -- x1.20  (+20% CP)   cost: $800\n` +
      ` Level 3  -- x1.40  (+40% CP)   cost: $2,500\n` +
      ` Level 4  -- x1.65  (+65% CP)   cost: $7,000\n` +
      ` Level 5  -- x2.00  (+100% CP)  cost: $18,000\n` +
      `\`\`\`\n\n` +
      `Training costs apply **per unit type**, not per soldier. So if you have 50 Knights and train them to Level 5, ` +
      `you pay $18,000 once and all 50 Knights benefit.\n\n` +
      `A fully trained Battle Mage has **260 Actual CP** each while showing only 130 Relative CP to enemies. ` +
      `Train the expensive units. It compounds fast.`,
    footer: 'Raid Season Tutorial  |  Training costs are one-time per unit type'
  },
  {
    title: 'Mercenaries  --  Page 5 of 7',
    description:
      `The **Mercenaries** sub-tab in \`/store\` lets you hire **Sellsword Captains**.\n\n` +
      `\`\`\`\n` +
      ` (XoX)\n` +
      ` /|\\/|     Sellsword Captain\n` +
      `  / \\      $5,000 per hire  |  +250 Actual CP\n` +
      `\`\`\`\n\n` +
      `A Sellsword Captain does not contribute to your standing Relative CP — they do not show up in \`/viewcp\` for other players. ` +
      `But when you launch a raid and choose to deploy one, they add **+250 Actual CP for that battle only**.\n\n` +
      `After the raid ends — win or lose — the captain is gone. You must hire again for the next one.\n\n` +
      `**When to use them:** Deploy a captain when you are raiding someone whose Actual CP you suspect is higher than their Relative CP suggests. ` +
      `A captain can turn a losing fight into a winning one. You can also hold them back and let opponents underestimate you — then deploy on a fight that matters.\n\n` +
      `You can hold multiple captains on retainer. Spend wisely.`,
    footer: 'Raid Season Tutorial  |  Captains are single-use — deploy with intention'
  },
  {
    title: 'Raiding  --  Page 6 of 7',
    description:
      `When your army is built, run \`/raid\`.\n\n` +
      `You will see a list of all active participants — their name, Relative CP, known military, and season record. ` +
      `Training levels and Actual CP are hidden from you. Choose wisely.\n\n` +
      `Select a target from the dropdown. You will see two buttons:\n` +
      `- **Launch Raid** — sends your army as-is\n` +
      `- **Launch Raid + Deploy Captain** — sends your army with a Sellsword Captain attached (costs one captain)\n\n` +
      `Once you confirm, a battle embed appears in the channel. After **10 to 20 seconds**, both Actual CPs are compared and the higher one wins. ` +
      `Both you and your target are sent a DM with the result and your projected payout.\n\n` +
      `**If your raid is repelled:**\n` +
      `No loss is recorded against you. You walk away clean — but the defender now knows your Actual CP from the resolution reveal. ` +
      `They can use that information to decide whether to counter-raid you.\n\n` +
      `**Rules:**\n` +
      `- You can only raid each player **once per season** — no farming the same target\n` +
      `- Offline players can be raided; they will be notified by DM\n` +
      `- Actual CP is revealed only at resolution — not before`,
    footer: 'Raid Season Tutorial  |  You cannot raid the same empire twice this season'
  },
  {
    title: 'Season-End Payouts  --  Page 7 of 7',
    description:
      `No money changes hands during the season. Wins and losses are **tracked**, not paid out immediately.\n\n` +
      `When the season ends, every player's results are settled at once using this formula:\n\n` +
      `\`\`\`\n` +
      ` Rate per win/loss = min(raids you completed x $500, $5,000)\n\n` +
      ` Net change = (your victories x rate) - (your losses x rate)\n` +
      `\`\`\`\n\n` +
      `The more raids you complete over the season, the more each individual win and loss is worth. ` +
      `Someone who raids twice risks $1,000 per result. Someone who raids ten times risks $5,000 per result — the maximum.\n\n` +
      `**Important:** only **losses taken as a defender** count against you. If you launched a raid and got repelled, ` +
      `that does not appear in your losses — it simply does not count in either direction.\n\n` +
      `**Consequences:**\n` +
      `- Positive net: cash added to your wallet\n` +
      `- Negative net: deducted from cash, then from your bank if cash runs out\n` +
      `- If your bank is also drained: you go into debt\n\n` +
      `All armies are disbanded when the season closes. Training is erased. The next season, everyone starts from nothing.\n\n` +
      `**You are ready. Open \`/store\` and start building.**`,
    footer: 'Raid Season Tutorial  |  All army data resets when the season ends'
  }
];

function buildRaidTutorialPayload(page) {
  const safePage = Math.max(0, Math.min(page, RAID_TUTORIAL_PAGES.length - 1));
  const data     = RAID_TUTORIAL_PAGES[safePage];
  const isFirst  = safePage === 0;
  const isLast   = safePage === RAID_TUTORIAL_PAGES.length - 1;

  const embed = new EmbedBuilder()
    .setTitle(data.title)
    .setDescription(data.description)
    .setColor(0x8B0000)
    .setFooter({ text: data.footer })
    .setTimestamp();

  const btns = [];
  if (!isFirst) {
    btns.push(new ButtonBuilder().setCustomId(`raid_tutorial_${safePage - 1}`).setLabel('< Back').setStyle(ButtonStyle.Secondary));
  }
  if (!isLast) {
    btns.push(new ButtonBuilder().setCustomId(`raid_tutorial_${safePage + 1}`).setLabel('Next >').setStyle(ButtonStyle.Primary));
  } else {
    btns.push(new ButtonBuilder().setCustomId('raid_tutorial_close').setLabel('Got it. Close this.').setStyle(ButtonStyle.Success));
  }

  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(...btns)], ephemeral: true };
}

async function handleRaidTutorialButton(interaction) {
  const customId = interaction.customId;

  if (customId === 'raid_tutorial_close') {
    return await interaction.update({
      embeds: [new EmbedBuilder()
        .setTitle('Good luck out there.')
        .setDescription('Open `/store` to start building your empire.\nUse `/viewcp` to check your CP.\nUse `/raid` when you are ready to march.')
        .setColor(0x8B0000)
        .setTimestamp()],
      components: []
    });
  }

  const page = parseInt(customId.replace('raid_tutorial_', ''), 10);
  if (isNaN(page)) return;

  const payload = buildRaidTutorialPayload(page);
  if (interaction.replied || interaction.deferred) {
    await interaction.update(payload);
  } else {
    await interaction.reply(payload);
  }
}

async function handleServerBlacklistCommand(interaction) {
  if (!isDeveloper(interaction.user.id)) {
    return await interaction.reply({ embeds: [new EmbedBuilder().setTitle('Access Denied').setDescription('Developer only.').setColor(0xFF6B6B)], ephemeral: true });
  }

  const serverId = interaction.options.getString('serverid').trim();
  const action   = interaction.options.getString('action'); // 'blacklist' | 'unblacklist'

  if (!/^\d{17,20}$/.test(serverId)) {
    return await interaction.reply({ embeds: [new EmbedBuilder().setTitle('Invalid Server ID').setDescription(`\`${serverId}\` does not look like a valid Discord server ID.`).setColor(0xFF6B6B)], ephemeral: true });
  }

  const isCurrentlyBlacklisted = await isServerBlacklisted(serverId);

  if (action === 'blacklist') {
    if (isCurrentlyBlacklisted) {
      return await interaction.reply({ embeds: [new EmbedBuilder().setTitle('Already Blacklisted').setDescription(`Server \`${serverId}\` is already on the blacklist.`).setColor(0xFF9F43)], ephemeral: true });
    }
    await setServerBlacklist(serverId, true);

    const guild = client.guilds.cache.get(serverId);
    const serverName = guild ? `**${guild.name}** (\`${serverId}\`)` : `\`${serverId}\``;

    return await interaction.reply({ embeds: [new EmbedBuilder()
      .setTitle('Server Blacklisted')
      .setDescription(`${serverName} has been blacklisted. All interactions and messages from that server will be silently dropped.`)
      .setColor(0xFF6B6B)
      .setTimestamp()], ephemeral: true });
  }

  if (action === 'unblacklist') {
    if (!isCurrentlyBlacklisted) {
      return await interaction.reply({ embeds: [new EmbedBuilder().setTitle('Not Blacklisted').setDescription(`Server \`${serverId}\` is not currently on the blacklist.`).setColor(0xFF9F43)], ephemeral: true });
    }
    await setServerBlacklist(serverId, false);

    const guild = client.guilds.cache.get(serverId);
    const serverName = guild ? `**${guild.name}** (\`${serverId}\`)` : `\`${serverId}\``;

    return await interaction.reply({ embeds: [new EmbedBuilder()
      .setTitle('Server Unblacklisted')
      .setDescription(`${serverName} has been removed from the blacklist and can use the bot again.`)
      .setColor(0x51CF66)
      .setTimestamp()], ephemeral: true });
  }
}

async function handleStartRaidCommand(interaction) {
  if (!isDeveloper(interaction.user.id)) {
    return await interaction.reply({ embeds: [new EmbedBuilder().setTitle('Access Denied').setDescription('Developer only.').setColor(0xFF6B6B)], ephemeral: true });
  }
  const existing = await getRaidSeason();
  if (existing.active) {
    return await interaction.reply({ embeds: [new EmbedBuilder().setTitle('Season Already Active').setDescription('A Raid Season is already running. Use /end-raid to close it first.').setColor(0xFF9F43)], ephemeral: true });
  }

  const now      = Date.now();
  const seasonId = (existing.seasonId || 0) + 1;
  await saveRaidSeason({ active: true, startedAt: now, endsAt: now + 30 * 24 * 60 * 60 * 1000, seasonId });
  await interaction.reply({ embeds: [new EmbedBuilder().setTitle('Raid Season Started').setDescription(`Season ${seasonId} is now active. Broadcasting to all servers.`).setColor(0x8B0000)], ephemeral: true });

  const announcementEmbed = new EmbedBuilder()
    .setTitle('THE RAIDING SEASON IS UPON US')
    .setDescription(
      `The borders between empires grow thin. Rulers sharpen their steel, commanders marshal their forces, and coin flows toward those bold enough to seize it.\n\n` +
      `**A new Raid Season has begun.**\n\n` +
      `Spend your wealth to build a military. Conscript levies, hire crossbowmen, field knights, deploy battle mages. ` +
      `Every soldier recruits adds to your **Relative CP** — visible to all. But your true strength, your **Actual CP**, sharpened by training your rivals cannot see, remains yours alone to know.\n\n` +
      `When you are ready, march on your rivals with \`/raid\`. The battlefield does not care for your reputation. Only Actual CP decides who walks away.\n\n` +
      `For those who prefer to fight dirty: hire **Sellsword Captains** from the Mercenaries tab in \`/store\`. They fight once and vanish — but they hit hard enough to turn the tide.\n\n` +
      `At season end, every victory and every defeat is tallied. Victors claim their spoils. The defeated pay their debts — even if it cuts into their reserves. Even if it leaves them in ruin.\n\n` +
      `**The season lasts 30 days.**\n\n` +
      `Open \`/store\` to build your empire. Use \`/viewcp\` to inspect yourself or your rivals. Use \`/raid\` to declare war.\n\n` +
      `Build well. Strike first. Leave nothing on the table.`
    )
    .setColor(0x8B0000)
    .setFooter({ text: `Raid Season ${seasonId}  |  Runs for 30 days` })
    .setTimestamp();

  let broadcast = 0;
  for (const guild of client.guilds.cache.values()) {
    try {
      const channelId = await getAnnouncementChannelId(guild.id);
      let channel = channelId ? await client.channels.fetch(channelId).catch(() => null) : null;
      if (!channel) channel = guild.channels.cache.filter(c => c.isTextBased() && c.permissionsFor(guild.members.me)?.has('SendMessages')).sort((a, b) => a.rawPosition - b.rawPosition).first();
      const participateRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('raid_tutorial_0')
          .setLabel('Start Here -- New to Raiding?')
          .setStyle(ButtonStyle.Danger)
      );
      if (channel) { await channel.send({ embeds: [announcementEmbed], components: [participateRow] }); broadcast++; }
    } catch (e) {}
  }
  console.log(`Raid Season ${seasonId} started — broadcast to ${broadcast} server(s).`);
}

async function handleEndRaidCommand(interaction) {
  if (!isDeveloper(interaction.user.id)) {
    return await interaction.reply({ embeds: [new EmbedBuilder().setTitle('Access Denied').setDescription('Developer only.').setColor(0xFF6B6B)], ephemeral: true });
  }
  const season = await getRaidSeason();
  if (!season.active) {
    return await interaction.reply({ embeds: [new EmbedBuilder().setTitle('No Active Season').setDescription('There is no Raid Season running.').setColor(0xFF9F43)], ephemeral: true });
  }

  await interaction.reply({ embeds: [new EmbedBuilder().setTitle('Ending Raid Season...').setDescription('Calculating payouts and wiping all army data. This may take a moment.').setColor(0x8B0000)], ephemeral: true });

  const allPlayers = await getAllRaidPlayers();
  const results    = [];

  for (const p of allPlayers) {
    if (!p.raidsCompleted && !p.victories && !p.losses) continue;
    const rate      = Math.min((p.raidsCompleted || 0) * RAID_PAYOUT_RATE, RAID_PAYOUT_CAP);
    const netChange = ((p.victories || 0) * rate) - ((p.losses || 0) * rate);

    await getUser(p._id);
    const user = userData[p._id];
    if (!user) continue;

    user.cash = (user.cash || 0) + netChange;
    if (user.cash < 0) {
      const shortfall  = Math.abs(user.cash);
      user.cash        = 0;
      user.bankBalance = (user.bankBalance || 0) - shortfall;
    }

    results.push({ userId: p._id, victories: p.victories || 0, losses: p.losses || 0, rate, netChange });
  }

  await saveUserData();
  if (raidPlayersCollection) await raidPlayersCollection.deleteMany({});
  await saveRaidSeason({ active: false, startedAt: season.startedAt, endsAt: Date.now(), seasonId: season.seasonId });

  for (const r of results) {
    try {
      const u = await client.users.fetch(r.userId).catch(() => null);
      if (!u) continue;
      const sign = r.netChange >= 0 ? '+' : '';
      await u.send({ embeds: [new EmbedBuilder()
        .setTitle('Raid Season Results')
        .setDescription(`Season ${season.seasonId} has concluded. Your account has been settled.`)
        .addFields(
          { name: 'Final Record', value: `${r.victories} Victories  |  ${r.losses} Defeats  |  Rate: $${r.rate.toLocaleString()} per result`, inline: false },
          { name: 'Net Change',   value: `${sign}$${r.netChange.toLocaleString()}`, inline: true }
        )
        .setColor(r.netChange >= 0 ? 0x51CF66 : 0xFF6B6B).setTimestamp()] }).catch(() => {});
    } catch (e) {}
  }

  const topLines = results.sort((a, b) => b.netChange - a.netChange).slice(0, 10)
    .map(r => `  ${r.netChange >= 0 ? '+' : ''}$${r.netChange.toLocaleString().padStart(10)}  |  ${r.victories}W/${r.losses}L  |  <@${r.userId}>`)
    .join('\n') || '  (no active participants)';

  const closingEmbed = new EmbedBuilder()
    .setTitle('THE RAIDING SEASON HAS ENDED')
    .setDescription(
      `The dust settles. The ledgers are balanced. Every empire has been paid — or made to pay.\n\n` +
      `Winnings have been deposited. Losses have been deducted. Those who overextended may find their reserves, or even their bank, cut into.\n\n` +
      `All armies have been disbanded. All training has been erased. When the next season rises, every ruler begins from nothing.\n\n` +
      `**Season ${season.seasonId}  --  Final Standings (Top 10)**\n\`\`\`\n${topLines}\n\`\`\``
    )
    .setColor(0x8B0000)
    .setFooter({ text: `Raid Season ${season.seasonId} closed` })
    .setTimestamp();

  for (const guild of client.guilds.cache.values()) {
    try {
      const channelId = await getAnnouncementChannelId(guild.id);
      let channel = channelId ? await client.channels.fetch(channelId).catch(() => null) : null;
      if (!channel) channel = guild.channels.cache.filter(c => c.isTextBased() && c.permissionsFor(guild.members.me)?.has('SendMessages')).sort((a, b) => a.rawPosition - b.rawPosition).first();
      if (channel) await channel.send({ embeds: [closingEmbed] });
    } catch (e) {}
  }
  console.log(`Raid Season ${season.seasonId} ended. ${results.length} player(s) settled.`);
}

client.login(token);[]
