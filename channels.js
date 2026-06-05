const axios = require('axios');
const fs = require('fs');
const path = require('path');

const M3U_URLS = {
  cr: 'https://raw.githubusercontent.com/iptv-org/iptv/master/streams/cr.m3u',
  mx: 'https://raw.githubusercontent.com/iptv-org/iptv/master/streams/mx.m3u',
};
const LOGOS_URL = 'https://iptv-org.github.io/api/logos.json';
const CACHE_FILE = path.join(__dirname, 'cache-channels.json');
const CACHE_TTL = 6 * 60 * 60 * 1000;

const QUALITY_RANK = { '2160p': 5, '1080p': 4, '1080i': 3, '720p': 2, '576p': 1, '480p': 1, '360p': 0, '240p': 0 };

let cachedData = null;

function parseM3u(content, country) {
  const lines = content.split('\n');
  const channels = [];
  let currentMeta = null;
  let currentReferrer = null;
  let currentUA = null;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith('#EXTINF:')) {
      const tvgIdMatch = trimmed.match(/tvg-id="([^"]*)"/);
      const nameMatch = trimmed.match(/,(.+)$/);
      const qualityMatch = trimmed.match(/\((\d+p|\d+i)\)/);
      const geoMatch = trimmed.includes('[Geo-blocked]');
      const not24hMatch = trimmed.includes('[Not 24/7]');

      currentMeta = {
        tvgId: tvgIdMatch ? tvgIdMatch[1] : '',
        name: nameMatch ? nameMatch[1].trim().replace(/\s*\(\d+p.*$/, '').replace(/\s*\[.*\]$/, '').trim() : 'Unknown',
        quality: qualityMatch ? qualityMatch[1] : 'SD',
        geoBlocked: geoMatch,
        not24h: not24hMatch,
        country,
        referrer: '',
        url: '',
      };
    } else if (trimmed.startsWith('#EXTVLCOPT:http-referrer=')) {
      currentReferrer = trimmed.split('=').slice(1).join('=');
    } else if (trimmed.startsWith('#EXTVLCOPT:http-user-agent=')) {
      currentUA = trimmed.split('=').slice(1).join('=');
    } else if (trimmed && !trimmed.startsWith('#')) {
      if (currentMeta) {
        currentMeta.url = trimmed;
        currentMeta.referrer = currentReferrer || '';
        currentMeta.ua = currentUA || '';
        channels.push(currentMeta);
      }
      currentMeta = null;
      currentReferrer = null;
      currentUA = null;
    }
  }

  return channels;
}

function deduplicate(channels) {
  const best = new Map();

  for (const ch of channels) {
    if (!ch.url) continue;
    const key = ch.tvgId || ch.name;
    if (!key) continue;

    const existing = best.get(key);
    if (!existing) {
      best.set(key, ch);
    } else {
      const existingRank = QUALITY_RANK[existing.quality] ?? -1;
      const newRank = QUALITY_RANK[ch.quality] ?? -1;
      if (newRank > existingRank && !existing.geoBlocked) {
        best.set(key, ch);
      } else if (newRank === existingRank && !existing.geoBlocked && !existing.not24h && (ch.not24h || ch.geoBlocked)) {
        // keep existing if current has issues
      } else if (newRank > existingRank) {
        best.set(key, ch);
      }
    }
  }

  return Array.from(best.values());
}

async function fetchLogos() {
  try {
    const resp = await axios.get(LOGOS_URL, { timeout: 30000 });
    const logos = resp.data;
    const map = new Map();

    for (const item of logos) {
      if (item.channel && item.url) {
        if (!map.has(item.channel) && item.in_use !== false) {
          map.set(item.channel, item.url);
        }
      }
    }

    return map;
  } catch (e) {
    console.error('[Channels] Failed to fetch logos:', e.message);
    return new Map();
  }
}

function getChannelId(tvgId) {
  if (!tvgId) return '';
  return tvgId.replace(/@\w+$/, '');
}

async function fetchAndCache() {
  try {
    const [crResp, mxResp] = await Promise.all([
      axios.get(M3U_URLS.cr, { timeout: 20000 }),
      axios.get(M3U_URLS.mx, { timeout: 20000 }),
    ]);

    const crChannels = parseM3u(crResp.data, 'CR');
    const mxChannels = parseM3u(mxResp.data, 'MX');
    let all = [...crChannels, ...mxChannels];

    all = deduplicate(all);

    const logoMap = await fetchLogos();

    for (const ch of all) {
      const channelId = getChannelId(ch.tvgId);
      ch.logo = logoMap.get(channelId) || '';
    }

    const data = { channels: all, fetchedAt: Date.now() };
    fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2));
    cachedData = data;

    console.log(`[Channels] Cached ${all.length} channels (${crChannels.length} CR, ${mxChannels.length} MX)`);
    return data;
  } catch (e) {
    console.error('[Channels] Fetch error:', e.message);
    if (cachedData) return cachedData;
    throw e;
  }
}

async function getChannels() {
  if (cachedData && Date.now() - cachedData.fetchedAt < CACHE_TTL) {
    return cachedData.channels;
  }

  try {
    if (fs.existsSync(CACHE_FILE)) {
      const raw = fs.readFileSync(CACHE_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      if (Date.now() - parsed.fetchedAt < CACHE_TTL) {
        cachedData = parsed;
        return parsed.channels;
      }
    }
  } catch (e) {
    console.error('[Channels] Cache read error:', e.message);
  }

  const fresh = await fetchAndCache();
  return fresh.channels;
}

async function init() {
  try {
    const data = await fetchAndCache();
    return data.channels;
  } catch (e) {
    console.error('[Channels] Init error:', e.message);
    return [];
  }
}

module.exports = { getChannels, init };
