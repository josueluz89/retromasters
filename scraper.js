const axios = require('axios');
const fs = require('fs');
const path = require('path');
const xtream = require('./xtream');

const PORTALS_FILE = path.join(__dirname, 'xtream_portals.json');

// List of public proxies to bypass Cloudflare/Rate limit blocks
const PROXIES = [
  url => `https://corsproxy.io/?url=${encodeURIComponent(url)}`,
  url => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  url => `https://proxy.corsfix.com/?${encodeURIComponent(url)}`,
  url => `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(url)}`
];

// Robust HTTP request function with proxy fallback
async function fetchUrl(url, timeout = 12000) {
  const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36' };
  
  // Try direct first
  try {
    const resp = await axios.get(url, { headers, timeout });
    if (resp.status === 200 && resp.data) {
      return typeof resp.data === 'object' ? JSON.stringify(resp.data) : resp.data.toString();
    }
  } catch (err) {
    // Fail silently to try proxies
  }

  // Try proxies sequentially
  for (const proxyFn of PROXIES) {
    const proxiedUrl = proxyFn(url);
    try {
      const resp = await axios.get(proxiedUrl, { headers, timeout });
      if (resp.status === 200 && resp.data) {
        return typeof resp.data === 'object' ? JSON.stringify(resp.data) : resp.data.toString();
      }
    } catch (e) {
      // Keep trying other proxies
    }
  }

  throw new Error(`Failed to fetch URL: ${url}`);
}

// Regular expressions to extract credentials
const RE_URL_PARAM = /(https?:\/\/[^?\s"'<]+)\?(?:[^\s"'<]*?&)?(username|user)=([^&\s"'<]+)\s*&(password|pass)=([^&\s"'<]+)/gi;
const RE_LABEL = /(?:Portal|Host(?:\s*URL)?|Panel|URL|🔗|🌍|🌐)\W*?(https?:\/\/[^<\s"']+)[\s\S]{1,500}?(?:Username|Usuario|User|👤)\W*?([^\s|<"'\n]+)[\s\S]{1,200}?(?:Password|Contraseña|Pass|🔑)\W*?([^\s|<"'\n]+)/gi;

// Clean host URL
function cleanHostUrl(raw) {
  let c = raw.replace(/\s+/g, '');
  const q = c.indexOf('?'); if (q >= 0) c = c.slice(0, q);
  if (c.includes('@')) c = 'http://' + c.slice(c.lastIndexOf('@') + 1);
  c = c.replace(/\/(?:get|live|portal|c|index|playlist|player_api|xmltv|index\.php|portal\.php)\.php$/i, '');
  while (c.endsWith('/')) c = c.slice(0, -1);
  if (!/^https?:/i.test(c)) c = 'http://' + c;
  return c;
}

// Clean credentials strings
function cleanCred(raw) {
  let s = raw;
  while (s.startsWith('=')) s = s.slice(1);
  return (s.split(/[ \n&?]/)[0] || '').trim();
}

// Extract credentials from a text dump
function extractCredentials(text) {
  if (!text || text.length < 20) return [];
  const candidates = [];
  const seenKeys = new Set();

  // Try URL parameter match first
  for (const m of text.matchAll(RE_URL_PARAM)) {
    const host = cleanHostUrl(m[1]);
    const user = cleanCred(m[3]);
    const pass = cleanCred(m[5]);
    const key = `${host}|${user}|${pass}`;
    if (host && user.length >= 3 && pass.length >= 3 && !seenKeys.has(key)) {
      seenKeys.add(key);
      candidates.push({ host, username: user, password: pass });
    }
  }

  // Try label patterns (Host: ... Username: ... Password: ...)
  for (const m of text.matchAll(RE_LABEL)) {
    const host = cleanHostUrl(m[1]);
    const user = cleanCred(m[2]);
    const pass = cleanCred(m[3]);
    const key = `${host}|${user}|${pass}`;
    if (host && user.length >= 3 && pass.length >= 3 && !seenKeys.has(key)) {
      seenKeys.add(key);
      candidates.push({ host, username: user, password: pass });
    }
  }

  return candidates;
}

// Scrape Reddit r/IPTV_ZONENEW
async function scrapeReddit() {
  console.log('[Scraper] Fetching from Reddit...');
  try {
    const rawData = await fetchUrl('https://www.reddit.com/r/IPTV_ZONENEW/new/.json?limit=100');
    const root = JSON.parse(rawData);
    const posts = root?.data?.children || [];
    let candidates = [];
    
    posts.forEach(post => {
      const data = post.data || {};
      const body = `${data.title || ''} ${data.selftext || ''}`;
      candidates = candidates.concat(extractCredentials(body));
    });

    console.log(`[Scraper] Found ${candidates.length} candidates from Reddit.`);
    return candidates;
  } catch (e) {
    console.error('[Scraper] Reddit scrape failed:', e.message);
    return [];
  }
}

// Scrape GitHub world_repo dumps
async function scrapeGithub() {
  console.log('[Scraper] Fetching from GitHub...');
  let candidates = [];
  
  // Try fetching the directory contents first
  try {
    const apiRaw = await fetchUrl('https://api.github.com/repos/akeotaseo/world_repo/contents/Updater_Matrix/XML2');
    const files = JSON.parse(apiRaw);
    if (Array.isArray(files)) {
      const txtFiles = files.filter(f => f.name.endsWith('.txt') && f.download_url);
      console.log(`[Scraper] GitHub found ${txtFiles.length} dump files in repository.`);
      
      // Limit to first 15 files to keep it fast
      const batch = txtFiles.slice(0, 15);
      const promises = batch.map(async (file) => {
        try {
          const content = await fetchUrl(file.download_url);
          const found = extractCredentials(content);
          candidates = candidates.concat(found);
        } catch (err) {}
      });
      await Promise.all(promises);
      return candidates;
    }
  } catch (e) {
    console.log('[Scraper] GitHub folder API blocked/limited, falling back to direct sequence crawl...');
  }

  // Fallback: Direct sequence crawl on master/main branch
  const filesToTry = Array.from({ length: 15 }, (_, i) => `${i + 1}.txt`);
  const branches = ['main', 'master'];
  
  for (const branch of branches) {
    console.log(`[Scraper] Crawling GitHub files on branch: ${branch}`);
    let branchCandidates = [];
    const promises = filesToTry.map(async (fileName) => {
      const url = `https://raw.githubusercontent.com/akeotaseo/world_repo/${branch}/Updater_Matrix/XML2/${fileName}`;
      try {
        const content = await fetchUrl(url);
        const found = extractCredentials(content);
        branchCandidates = branchCandidates.concat(found);
      } catch (e) {}
    });
    await Promise.all(promises);
    if (branchCandidates.length > 0) {
      candidates = candidates.concat(branchCandidates);
      break;
    }
  }

  console.log(`[Scraper] Found ${candidates.length} candidates from GitHub.`);
  return candidates;
}

// Test a candidate credential
// Function to test if a specific stream is working and returning video/audio data
async function testStreamPlayback(host, username, password, streamId) {
  const streamUrl = `${host}/live/${username}/${password}/${streamId}.ts`;
  try {
    const resp = await axios.get(streamUrl, {
      timeout: 5000,
      headers: { 'User-Agent': 'Mozilla/5.0' },
      responseType: 'stream'
    });
    
    if (resp.status >= 200 && resp.status < 400) {
      // Stream is active! Destroy connection immediately to save bandwidth
      resp.data.destroy();
      return true;
    }
  } catch (err) {
    // Fail silently
  }
  return false;
}

// Test a candidate credential
async function verifyCandidate(c) {
  const url = `${c.host}/player_api.php?username=${encodeURIComponent(c.username)}&password=${encodeURIComponent(c.password)}`;
  try {
    // 1. Verify auth and credentials
    const resp = await axios.get(url, { timeout: 6000 });
    if (resp.data && resp.data.user_info) {
      const info = resp.data.user_info;
      const status = (info.status || '').toLowerCase();
      const maxConns = parseInt(info.max_connections || '1', 10);
      const expDate = info.exp_date ? parseInt(info.exp_date, 10) : null;

      // Ensure account is active and not expired
      const isNotExpired = !expDate || (expDate * 1000 > Date.now());
      if (status === 'active' && isNotExpired) {
        
        // FILTER: Only keep portals supporting multiple connections (>= 2) to ensure stability
        if (maxConns < 2) {
          return null; // Skip single connection accounts
        }

        // 2. Fetch streams to pick a test channel
        const streamsUrl = `${url}&action=get_live_streams`;
        const streamsResp = await axios.get(streamsUrl, { timeout: 8000 });
        
        if (Array.isArray(streamsResp.data) && streamsResp.data.length > 0) {
          // Pick the first available stream to test
          const sampleStreamId = streamsResp.data[0].stream_id;
          
          // 3. Test if the stream is actually playable (delivers video data)
          const isPlayable = await testStreamPlayback(c.host, c.username, c.password, sampleStreamId);
          if (isPlayable) {
            return {
              host: c.host,
              username: c.username,
              password: c.password,
              connectionsLimit: isNaN(maxConns) || maxConns <= 0 ? 1 : maxConns,
              activeConnections: 0,
              active: true
            };
          } else {
            console.log(`[Scraper] [DISCARDED] ${c.host} (${c.username}) - Auth succeeded but video stream failed playback test.`);
          }
        }
      }
    }
  } catch (e) {
    // Fail silently
  }
  return null;
}

// Main run function
async function runScraper() {
  console.log('[Scraper] Starting automatic scraper...');
  const redditCand = await scrapeReddit();
  const githubCand = await scrapeGithub();
  
  // Deduplicate candidates
  const allCand = [...redditCand, ...githubCand];
  const uniqueCand = [];
  const seen = new Set();
  
  for (const c of allCand) {
    const key = `${c.host}|${c.username}|${c.password}`;
    if (!seen.has(key)) {
      seen.add(key);
      uniqueCand.push(c);
    }
  }

  console.log(`[Scraper] Total unique candidates to verify: ${uniqueCand.length}`);

  // Shuffle candidates to verify a random subset each run for variety
  for (let i = uniqueCand.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [uniqueCand[i], uniqueCand[j]] = [uniqueCand[j], uniqueCand[i]];
  }

  // Verify in batches to avoid overwhelming connections
  const verifiedPortals = [];
  const batchSize = 10;
  for (let i = 0; i < uniqueCand.length; i += batchSize) {
    if (verifiedPortals.length >= 10) {
      console.log('[Scraper] Reached target threshold of 10 active portals. Stopping search.');
      break;
    }
    const batch = uniqueCand.slice(i, i + batchSize);
    console.log(`[Scraper] Verifying batch ${i / batchSize + 1}...`);
    const results = await Promise.all(batch.map(verifyCandidate));
    results.forEach(res => {
      if (res) {
        verifiedPortals.push(res);
        console.log(`[Scraper] [ONLINE] ${res.host} (${res.username}) - Limit: ${res.connectionsLimit}`);
      }
    });
  }

  console.log(`[Scraper] Found ${verifiedPortals.length} active/working portals.`);

  if (verifiedPortals.length > 0) {
    // Read existing portals
    let existingPortals = [];
    try {
      if (fs.existsSync(PORTALS_FILE)) {
        existingPortals = JSON.parse(fs.readFileSync(PORTALS_FILE, 'utf8'));
      }
    } catch (e) {}

    // Merge new active portals with existing ones (avoid duplicates)
    const finalPortals = [...existingPortals];
    const existingKeys = new Set(finalPortals.map(p => `${p.host}|${p.username}|${p.password}`));

    verifiedPortals.forEach(p => {
      const key = `${p.host}|${p.username}|${p.password}`;
      if (!existingKeys.has(key)) {
        finalPortals.push(p);
      }
    });

    // Save back to file
    fs.writeFileSync(PORTALS_FILE, JSON.stringify(finalPortals, null, 2));
    console.log(`[Scraper] Successfully updated ${PORTALS_FILE} with ${finalPortals.length} total portals.`);
  }

  // Reload portals in memory
  xtream.loadPortals();
}

// If run directly
if (require.main === module) {
  runScraper().then(() => console.log('[Scraper] Scraping complete.'));
}

module.exports = { runScraper };
