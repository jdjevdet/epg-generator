const express = require('express');
const axios = require('axios');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;

// --- CREDENTIALS ---
const XTREAM_URL     = process.env.XTREAM_URL || '';
const XTREAM_USER    = process.env.XTREAM_USER || '';
const XTREAM_PASS    = process.env.XTREAM_PASS || '';
const EPG_SERVER_URL = process.env.EPG_SERVER_URL || '';
const AUTH_TOKEN     = process.env.AUTH_TOKEN || '';

app.use(express.json());

// --- TARGET CATEGORIES ---
const TARGET_CATEGORIES = [
  'Sports | Big Ten +'
];

// --- GENERATE EPG ID ---
function generateEpgId(channelName, categoryName) {
  const pipeIdx = channelName.indexOf('|');
  const colonIdx = channelName.indexOf(':');
  const prefixEnd = pipeIdx >= 0 ? pipeIdx : colonIdx >= 0 ? colonIdx : channelName.length;
  const prefix = channelName.substring(0, prefixEnd);
  const numMatch = prefix.match(/(\d+)/);
  if (!numMatch) return null;
  const num = parseInt(numMatch[1]);
  const cat = categoryName.toLowerCase();

  if (cat.includes('big ten')) return `BTN+ ${String(num).padStart(3, '0')}`;

  return null;
}

// --- PARSE CHANNEL NAME ---
function parseChannelName(channelName) {
  let title = '';
  let timeInfo = null;

  // Format 1: "PREFIX | Title (ISO datetime)"
  const pipeISOMatch = channelName.match(/\|\s*(.+?)\s*\((\d{4}-\d{2}-\d{2}[\sT]\d{2}:\d{2}(?::\d{2})?)\)/);
  if (pipeISOMatch) {
    title = pipeISOMatch[1].trim();
    timeInfo = { type: 'iso', value: pipeISOMatch[2] };
    return { title, timeInfo };
  }

  // Format 2: "PREFIX: Title (3.25 7:00 PM ET)"
  const dotDateMatch = channelName.match(/[:|]\s*(.+?)\s*\((\d{1,2}\.\d{2})\s+(\d{1,2}:\d{2}\s*(?:AM|PM)\s*(?:ET|EST|EDT|PT|PST|PDT|CT|CST|CDT)?)\)/i);
  if (dotDateMatch) {
    title = dotDateMatch[1].trim();
    timeInfo = { type: 'dotdate', date: dotDateMatch[2], time: dotDateMatch[3].trim() };
    return { title, timeInfo };
  }

  // Format 3: "PREFIX: Title (03.25 2AM ET/11PM PT)"
  const espnPlusMatch = channelName.match(/[:|]\s*(.+?)\s*\((\d{2}\.\d{2})\s+(\d{1,2}(?::\d{2})?\s*(?:AM|PM)\s*(?:ET|EST|EDT)?)/i);
  if (espnPlusMatch) {
    title = espnPlusMatch[1].trim();
    timeInfo = { type: 'dotdate', date: espnPlusMatch[2], time: espnPlusMatch[3].trim() };
    return { title, timeInfo };
  }

  // Format 4: "PREFIX: Title @ Mon DD HH:MM AM/PM TZ"
  const atMonDayMatch = channelName.match(/[:|]\s*(.+?)\s*@\s*(\w{3}\s+\d{1,2})\s+(\d{1,2}:\d{2}\s*(?:AM|PM)\s*(?:ET|EST|EDT|PT|PST|PDT|CT|CST|CDT|MT|MST|MDT)?)/i);
  if (atMonDayMatch) {
    title = atMonDayMatch[1].trim();
    timeInfo = { type: 'monthday', date: atMonDayMatch[2].trim(), time: atMonDayMatch[3].trim() };
    return { title, timeInfo };
  }

  // Format 5: "PREFIX: Title @ DD Mon HH:MM AM/PM TZ"
  const atDayMonMatch = channelName.match(/[:|]\s*(.+?)\s*@\s*(\d{1,2}\s+\w{3})\s+(\d{1,2}:\d{2}\s*(?:AM|PM)\s*(?:ET|EST|EDT|PT|PST|PDT|CT|CST|CDT|MT|MST|MDT)?)/i);
  if (atDayMonMatch) {
    title = atDayMonMatch[1].trim();
    timeInfo = { type: 'daymonth', date: atDayMonMatch[2].trim(), time: atDayMonMatch[3].trim() };
    return { title, timeInfo };
  }

  // Format 6: "PREFIX: Title (03.25 HH:MM AM/PM TZ)"
  const secMatch = channelName.match(/[:|]\s*(.+?)\s*\((\d{2}\.\d{2})\s+(\d{1,2}:\d{2}\s*(?:AM|PM)\s*(?:ET|EST|EDT|PT|PST|PDT)?)\)/i);
  if (secMatch) {
    title = secMatch[1].trim();
    timeInfo = { type: 'dotdate', date: secMatch[2], time: secMatch[3].trim() };
    return { title, timeInfo };
  }

  return null;
}

// --- CONVERT TIME INFO TO UTC ---
function timeInfoToUTC(timeInfo, currentYear) {
  try {
    let dt;

    if (timeInfo.type === 'iso') {
      const isoStr = timeInfo.value.replace(' ', 'T');
      dt = new Date(`${isoStr}Z`);
      dt.setUTCHours(dt.getUTCHours() + 5);

    } else if (timeInfo.type === 'dotdate') {
      const parts = timeInfo.date.split('.');
      const month = parseInt(parts[0]) - 1;
      const day   = parseInt(parts[1]);
      const [hours, minutes] = normalizeTime(timeInfo.time);
      dt = new Date(Date.UTC(currentYear, month, day, hours, minutes, 0));
      dt = applyTimezoneOffset(dt, timeInfo.time);

    } else if (timeInfo.type === 'monthday') {
      const cleanTime = timeInfo.time.replace(/\s*(ET|EST|EDT|PT|PST|PDT|CT|CST|CDT|MT|MST|MDT)\s*/i, '').trim();
      dt = new Date(`${timeInfo.date} ${currentYear} ${cleanTime}`);
      if (isNaN(dt)) return null;
      dt = applyTimezoneOffset(dt, timeInfo.time);

    } else if (timeInfo.type === 'daymonth') {
      const parts = timeInfo.date.split(' ');
      const cleanTime = timeInfo.time.replace(/\s*(ET|EST|EDT|PT|PST|PDT|CT|CST|CDT|MT|MST|MDT)\s*/i, '').trim();
      dt = new Date(`${parts[1]} ${parts[0]} ${currentYear} ${cleanTime}`);
      if (isNaN(dt)) return null;
      dt = applyTimezoneOffset(dt, timeInfo.time);
    }

    if (!dt || isNaN(dt)) return null;
    return dt;

  } catch (err) {
    return null;
  }
}

function normalizeTime(timeStr) {
  const match = timeStr.match(/(\d{1,2})(?::(\d{2}))?\s*(AM|PM)/i);
  if (!match) return [0, 0];
  let hours = parseInt(match[1]);
  const minutes = parseInt(match[2] || '0');
  const period = match[3].toUpperCase();
  if (period === 'AM' && hours === 12) hours = 0;
  if (period === 'PM' && hours !== 12) hours += 12;
  return [hours, minutes];
}

function applyTimezoneOffset(dt, timeStr) {
  const isPT = /PT|PST|PDT/i.test(timeStr);
  const isCT = /CT|CST|CDT/i.test(timeStr);
  const isMT = /MT|MST|MDT/i.test(timeStr);
  let offset = 4;
  if (isPT) offset = 7;
  if (isCT) offset = 5;
  if (isMT) offset = 6;
  dt.setUTCHours(dt.getUTCHours() + offset);
  return dt;
}

// --- SMART DURATION DETECTION ---
function detectDuration(title) {
  const t = title.toLowerCase();
  if (/\bgolf\b/.test(t) || /\bnascar\b/.test(t) || /\bcycling\b/.test(t) || /\bmarathon\b/.test(t) || /\bindycar\b/.test(t) || /\bf1\b|formula 1/.test(t)) return 240;
  if (/\bnfl\b/.test(t) || /\bnba\b/.test(t) || /\bnhl\b/.test(t) || /\bmlb\b/.test(t) || /\bufc\b/.test(t) || /\bmma\b/.test(t) || /\bboxing\b/.test(t) || /\bwwe\b/.test(t) || /\bfight\b/.test(t)) return 180;
  if (/\bvs\.?\b/.test(t) || / @ /.test(t) || /\bfinal\b/.test(t) || /\bplayoff\b/.test(t) || /\bchampionship\b/.test(t) || /\bmatch\b/.test(t) || /\bgame\b/.test(t)) return 120;
  if (/\bhighlights\b/.test(t) || /\brecap\b/.test(t) || /\bnews\b/.test(t)) return 30;
  if (/\bshow\b/.test(t) || /\bdaily\b/.test(t) || /\bpress conference\b/.test(t) || /\bdraft\b/.test(t)) return 60;
  return 60;
}

// --- CALCULATE END TIME AT 6AM EST NEXT DAY ---
function getNextDay6amEST(eventEndDate) {
  const next = new Date(eventEndDate);
  next.setUTCDate(next.getUTCDate() + 1);
  next.setUTCHours(11, 0, 0, 0);
  return next;
}

// --- XMLTV HELPERS ---
function escapeXML(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function toXMLTVDate(dt) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${dt.getUTCFullYear()}` +
    `${pad(dt.getUTCMonth() + 1)}` +
    `${pad(dt.getUTCDate())}` +
    `${pad(dt.getUTCHours())}` +
    `${pad(dt.getUTCMinutes())}` +
    `${pad(dt.getUTCSeconds())}` +
    ` +0000`
  );
}

// --- FETCH CHANNELS FROM XTREAM API ---
async function fetchXtreamChannels() {
  console.log(`[${new Date().toISOString()}] Fetching channels from Xtream API...`);

  const url = `${XTREAM_URL}/player_api.php?username=${XTREAM_USER}&password=${XTREAM_PASS}&action=get_live_categories`;
  const catResponse = await axios.get(url);
  const categories = catResponse.data;

  const targetCats = categories.filter(cat =>
    TARGET_CATEGORIES.some(t =>
      cat.category_name.toLowerCase().trim() === t.toLowerCase().trim()
    )
  );

  console.log(`Found ${targetCats.length} matching categories`);

  let allChannels = [];

  for (const cat of targetCats) {
    const streamsUrl = `${XTREAM_URL}/player_api.php?username=${XTREAM_USER}&password=${XTREAM_PASS}&action=get_live_streams&category_id=${cat.category_id}`;
    const streamsResponse = await axios.get(streamsUrl);
    const streams = streamsResponse.data;
    allChannels = allChannels.concat(streams.map(s => ({
      name: s.name,
      category: cat.category_name
    })));
    console.log(`  ${cat.category_name}: ${streams.length} channels`);
  }

  console.log(`Fetched ${allChannels.length} total channels`);
  return allChannels;
}

// --- GENERATE AND PUSH EPG ---
async function generateAndPushEPG() {
  console.log(`[${new Date().toISOString()}] Starting EPG generation...`);

  const currentYear = new Date().getUTCFullYear();
  const channels = await fetchXtreamChannels();

  let allChannelBlocks = '';
  let allProgrammeBlocks = '';
  let totalEvents = 0;
  let skipped = 0;

  for (const ch of channels) {
    const epgId = generateEpgId(ch.name, ch.category);
    if (!epgId) { skipped++; continue; }

    const parsed = parseChannelName(ch.name);
    if (!parsed || !parsed.timeInfo) { skipped++; continue; }

    const { title, timeInfo } = parsed;
    if (!title || title.length < 2) { skipped++; continue; }

    const startDate = timeInfoToUTC(timeInfo, currentYear);
    if (!startDate || isNaN(startDate)) { skipped++; continue; }

    const duration  = detectDuration(title);
    const endDate   = new Date(startDate.getTime() + duration * 60 * 1000);
    const preStart  = new Date(startDate.getTime() - 720 * 60 * 1000);
    const postEnd   = getNextDay6amEST(endDate);

    const epgIdEsc    = escapeXML(epgId);
    const titleEsc    = escapeXML(title);
    const categoryEsc = escapeXML(ch.category);
    const dateStr     = startDate.toISOString().split('T')[0];

    const preStartXMLTV = toXMLTVDate(preStart);
    const startXMLTV    = toXMLTVDate(startDate);
    const endXMLTV      = toXMLTVDate(endDate);
    const postEndXMLTV  = toXMLTVDate(postEnd);

    // Channel block
    allChannelBlocks += `  <channel id="${epgIdEsc}">\n`;
    allChannelBlocks += `    <display-name lang="en">${epgIdEsc}</display-name>\n`;
    allChannelBlocks += `    <display-name lang="en">${titleEsc}</display-name>\n`;
    allChannelBlocks += `  </channel>\n`;

    // Block 1: Up Next
    allProgrammeBlocks += `  <programme start="${preStartXMLTV}" stop="${startXMLTV}" channel="${epgIdEsc}">\n`;
    allProgrammeBlocks += `    <title lang="en">Up Next: ${titleEsc}</title>\n`;
    allProgrammeBlocks += `    <desc lang="en">Coming up on ${categoryEsc}: ${titleEsc} | ${dateStr}</desc>\n`;
    allProgrammeBlocks += `    <category lang="en">${categoryEsc}</category>\n`;
    allProgrammeBlocks += `  </programme>\n\n`;

    // Block 2: Live Event
    allProgrammeBlocks += `  <programme start="${startXMLTV}" stop="${endXMLTV}" channel="${epgIdEsc}">\n`;
    allProgrammeBlocks += `    <title lang="en">${titleEsc}</title>\n`;
    allProgrammeBlocks += `    <desc lang="en">${categoryEsc} - ${titleEsc} | ${dateStr}</desc>\n`;
    allProgrammeBlocks += `    <category lang="en">${categoryEsc}</category>\n`;
    allProgrammeBlocks += `  </programme>\n\n`;

    // Block 3: Event Over
    allProgrammeBlocks += `  <programme start="${endXMLTV}" stop="${postEndXMLTV}" channel="${epgIdEsc}">\n`;
    allProgrammeBlocks += `    <title lang="en">EVENT OVER: ${titleEsc}</title>\n`;
    allProgrammeBlocks += `    <desc lang="en">${categoryEsc} - ${titleEsc} has ended. | ${dateStr}</desc>\n`;
    allProgrammeBlocks += `    <category lang="en">${categoryEsc}</category>\n`;
    allProgrammeBlocks += `  </programme>\n\n`;

    totalEvents++;
  }

  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<!DOCTYPE tv SYSTEM "xmltv.dtd">\n` +
    `<tv generator-info-name="EPG-Generator">\n\n` +
    allChannelBlocks + `\n` +
    allProgrammeBlocks +
    `</tv>`;

  await axios.post(EPG_SERVER_URL, xml, {
    headers: {
      'Content-Type': 'application/xml',
      'x-auth-token': AUTH_TOKEN
    }
  });

  console.log(`[${new Date().toISOString()}] EPG pushed — ${totalEvents} events generated, ${skipped} skipped.`);
}

// --- MANUAL TRIGGER ---
app.get('/run', async (req, res) => {
  res.json({ message: 'EPG generation started...' });
  try {
    await generateAndPushEPG();
  } catch (err) {
    console.error('Manual run failed:', err.message);
  }
});

app.get('/', (req, res) => {
  res.send('EPG Generator is running. Visit /run to trigger manually.');
});

// --- SCHEDULE: 8AM EST (13:00 UTC) ---
cron.schedule('0 13 * * *', () => {
  console.log('Running scheduled EPG generation...');
  generateAndPushEPG().catch(err => console.error('Scheduled run failed:', err.message));
});

// --- START ---
app.listen(PORT, () => {
  console.log(`EPG Generator running on port ${PORT}`);
  generateAndPushEPG().catch(err => console.error('Initial run failed:', err.message));
});