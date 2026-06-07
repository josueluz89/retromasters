const fs = require('fs');
const path = require('path');
const axios = require('axios');

const PORTALS_FILE = path.join(__dirname, 'xtream_portals.json');

// Memory cache for active channels list per portal to make lookups fast
// Format: { portalIndex: [ { id, name, category_id, ... } ] }
let portalChannelsCache = {};
let portals = [];

// Load portals from config file
function loadPortals() {
  try {
    if (fs.existsSync(PORTALS_FILE)) {
      const raw = fs.readFileSync(PORTALS_FILE, 'utf8');
      portals = JSON.parse(raw);
      // Initialize activeConnections if not set
      portals.forEach(p => {
        if (p.activeConnections === undefined) p.activeConnections = 0;
        if (p.connectionsLimit === undefined) p.connectionsLimit = 1;
        if (p.active === undefined) p.active = true;
      });
    } else {
      portals = [];
    }
  } catch (e) {
    console.error('[Xtream] Error loading portals file:', e.message);
    portals = [];
  }
}

// Save portals status (like active/inactive flag, not temporary connections)
function savePortals() {
  try {
    // Only save persistent flags
    const toSave = portals.map(p => ({
      host: p.host,
      username: p.username,
      password: p.password,
      connectionsLimit: p.connectionsLimit,
      active: p.active
    }));
    fs.writeFileSync(PORTALS_FILE, JSON.stringify(toSave, null, 2));
  } catch (e) {
    console.error('[Xtream] Error saving portals file:', e.message);
  }
}

// Verify a single portal and cache its channels
async function verifyPortal(portal, index) {
  if (!portal.active) return false;

  const url = `${portal.host}/player_api.php?username=${portal.username}&password=${portal.password}`;
  try {
    // Test auth first
    const authResp = await axios.get(url, { timeout: 8000 });
    if (!authResp.data || authResp.data.user_info?.status === 'Expired') {
      console.log(`[Xtream] Portal ${index} (${portal.host}) is expired or invalid auth.`);
      return false;
    }

    // Get live streams
    const streamsUrl = `${url}&action=get_live_streams`;
    const streamsResp = await axios.get(streamsUrl, { timeout: 15000 });
    
    if (Array.isArray(streamsResp.data)) {
      portalChannelsCache[index] = streamsResp.data.map(ch => ({
        stream_id: ch.stream_id,
        name: (ch.name || '').trim(),
        category_id: ch.category_id,
        stream_type: ch.stream_type
      }));
      console.log(`[Xtream] Portal ${index} (${portal.host}) active with ${streamsResp.data.length} channels.`);
      return true;
    } else {
      console.log(`[Xtream] Portal ${index} (${portal.host}) auth succeeded but returned no stream array.`);
      return false;
    }
  } catch (e) {
    console.error(`[Xtream] Failed to connect to Portal ${index} (${portal.host}):`, e.message);
    return false;
  }
}

// Verify all portals
async function verifyAllPortals() {
  loadPortals();
  console.log(`[Xtream] Verifying ${portals.length} portals...`);
  
  for (let i = 0; i < portals.length; i++) {
    const ok = await verifyPortal(portals[i], i);
    portals[i].isVerifiedOnline = ok;
  }
}

// Get all verified/loaded portals
function getPortals() {
  return portals;
}

// Get channels cache
function getPortalChannels(index) {
  return portalChannelsCache[index] || [];
}

/**
 * Finds all portals containing a channel matching a given name (case-insensitive)
 * and returns the best stream redirect URL.
 * Balances load by picking the portal with the lowest activeConnections.
 */
function allocateStreamByName(channelName) {
  const cleanName = channelName.toLowerCase().trim();
  let bestPortalIndex = -1;
  let bestStreamId = null;
  let minConnections = Infinity;

  for (let i = 0; i < portals.length; i++) {
    const portal = portals[i];
    if (!portal.isVerifiedOnline || !portal.active) continue;

    // Check if under limit
    if (portal.activeConnections >= portal.connectionsLimit) {
      console.log(`[Xtream] Portal ${i} reached connections limit (${portal.activeConnections}/${portal.connectionsLimit}). Skipping.`);
      continue;
    }

    // Look for matching channel name in cache
    const channels = portalChannelsCache[i] || [];
    const match = channels.find(ch => ch.name.toLowerCase().includes(cleanName));
    
    if (match) {
      if (portal.activeConnections < minConnections) {
        minConnections = portal.activeConnections;
        bestPortalIndex = i;
        bestStreamId = match.stream_id;
      }
    }
  }

  if (bestPortalIndex !== -1 && bestStreamId !== null) {
    const portal = portals[bestPortalIndex];
    portal.activeConnections++;
    console.log(`[Xtream] Allocated stream for "${channelName}" from Portal ${bestPortalIndex}. Active connections now: ${portal.activeConnections}/${portal.connectionsLimit}`);
    
    // Return the final stream URL for this portal and stream_id
    const streamUrl = `${portal.host}/live/${portal.username}/${portal.password}/${bestStreamId}.ts`;
    
    return {
      portalIndex: bestPortalIndex,
      streamUrl,
      release: () => {
        if (portal.activeConnections > 0) {
          portal.activeConnections--;
          console.log(`[Xtream] Released connection for Portal ${bestPortalIndex}. Active connections now: ${portal.activeConnections}/${portal.connectionsLimit}`);
        }
      }
    };
  }

  return null;
}

// Auto-release connections after a certain timeout (since player doesn't send close event in Stremio)
// Default to 3 hours
function setupAutoRelease(portalIndex, durationMs = 3 * 60 * 60 * 1000) {
  setTimeout(() => {
    if (portals[portalIndex] && portals[portalIndex].activeConnections > 0) {
      portals[portalIndex].activeConnections--;
      console.log(`[Xtream] Auto-released connection for Portal ${portalIndex} after timeout.`);
    }
  }, durationMs);
}

module.exports = {
  loadPortals,
  verifyAllPortals,
  getPortals,
  getPortalChannels,
  allocateStreamByName,
  setupAutoRelease,
  portalChannelsCache // Exposed for testing/mocking
};
