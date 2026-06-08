const express = require('express');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const channels = require('./channels');
const xtream = require('./xtream');


const PORT = process.env.PORT || 3001;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

const manifest = {
  id: 'com.masterscr.crmx',
  version: '1.1.0',
  name: 'Canales CR+CO+ES+PL',
  description: 'Canales de Costa Rica, Colombia, España, Pluto TV LATAM y Plex TV en vivo',
  logo: 'https://i.imgur.com/H89x7GX.png',
  background: 'https://i.imgur.com/H89x7GX.png',
  resources: ['stream', 'catalog', 'meta'],
  types: ['tv'],
  catalogs: [
    { id: 'crmx_cr', name: 'Costa Rica', type: 'tv' },
    { id: 'crmx_co', name: 'Colombia', type: 'tv' },
    { id: 'crmx_es', name: 'España', type: 'tv' },
    { id: 'crmx_pluto', name: 'Pluto TV LATAM', type: 'tv' },
    { id: 'crmx_plex', name: 'Plex TV', type: 'tv' },
    { id: 'crmx_all', name: 'Todo', type: 'tv' },
  ],
};

const builder = new addonBuilder(manifest);

const FLAGS = { CR: '🇨🇷', CO: '🇨🇴', ES: '🇪🇸', PL: '📺', PLEX: '🎥' };

function channelToMeta(ch) {
  const logo = ch.logo || 'https://i.imgur.com/JyvBbs6.png';
  return {
    id: ch.tvgId || ch.name,
    name: ch.name,
    type: 'tv',
    poster: logo,
    posterShape: 'square',
    background: logo,
    description: `${FLAGS[ch.country] || '📺'} ${ch.name}${ch.quality ? ` (${ch.quality})` : ''}${ch.geoBlocked ? ' [Geo-blocked]' : ''}${ch.not24h ? ' [Not 24/7]' : ''}`,
  };
}

builder.defineCatalogHandler(async (args) => {
  try {
    const all = await channels.getChannels();
    let filtered;

    if (args.id === 'crmx_cr') {
      filtered = all.filter(ch => ch.country === 'CR');
    } else if (args.id === 'crmx_co') {
      filtered = all.filter(ch => ch.country === 'CO');
    } else if (args.id === 'crmx_es') {
      filtered = all.filter(ch => ch.country === 'ES');
    } else if (args.id === 'crmx_pluto') {
      filtered = all.filter(ch => ch.country === 'PL');
    } else if (args.id === 'crmx_plex') {
      filtered = all.filter(ch => ch.country === 'PLEX');
    } else {
      filtered = all;
    }

    const metas = filtered.map(channelToMeta);
    return { metas };
  } catch (e) {
    console.error('[Catalog] Error:', e.message);
    return { metas: [] };
  }
});

builder.defineMetaHandler(async (args) => {
  try {
    const all = await channels.getChannels();
    const ch = all.find(c => (c.tvgId || c.name) === args.id);
    if (!ch) return { meta: {} };
    return { meta: channelToMeta(ch) };
  } catch (e) {
    console.error('[Meta] Error:', e.message);
    return { meta: {} };
  }
});

builder.defineStreamHandler(async (args) => {
  try {
    const all = await channels.getChannels();
    const ch = all.find(c => (c.tvgId || c.name) === args.id);
    if (!ch) return { streams: [] };

    const streams = [];

    // Opción 1: Stream público estándar
    if (ch.url) {
      const stream = {
        url: ch.url,
        name: `${FLAGS[ch.country] || '📺'} ${ch.name}`,
      };

      if (ch.referrer) {
        stream.behaviorHints = { proxyHeaders: { request: { Referer: ch.referrer } } };
      }
      streams.push(stream);
    }

    // Opción 2: Rotador Xtream Premium (si hay portales activos)
    const activePortals = xtream.getPortals().filter(p => p.isVerifiedOnline);
    if (activePortals.length > 0) {
      streams.push({
        url: `${BASE_URL}/stream-redirect?name=${encodeURIComponent(ch.name)}`,
        name: `🔗 Xtream Premium (Rotativo) | ${ch.name}`,
      });
    }

    return { streams };
  } catch (e) {
    console.error('[Stream] Error:', e.message);
    return { streams: [] };
  }
});

const app = express();

// Redireccionador de streams para balanceo de carga
app.get('/stream-redirect', (req, res) => {
  const channelName = req.query.name;
  if (!channelName) {
    return res.status(400).send('Missing channel name');
  }
  const streamInfo = xtream.allocateStreamByName(channelName);
  if (streamInfo) {
    xtream.setupAutoRelease(streamInfo.portalIndex);
    return res.redirect(302, streamInfo.streamUrl);
  } else {
    return res.status(404).send('No active Xtream portals found with this channel or connection limit reached.');
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok', channels: 'CR+CO+ES+PL+PLEX', time: new Date().toISOString() }));

app.use(getRouter(builder.getInterface()));

// Iniciar el servidor escuchando en el puerto de inmediato para evitar que el VPS falle por timeout
app.listen(PORT, () => {
  console.log(`CR+CO+ES+PL+PLEX Addon running on port ${PORT}`);
  console.log(`Manifest: ${BASE_URL}/manifest.json`);

  // Inicialización en segundo plano de canales y portales Xtream
  channels.init().then(async () => {
    console.log('[Server] Channels successfully cached. Verifying portals...');
    await xtream.verifyAllPortals();
    
    // Si no hay portales activos después de cargar, correr el scraper de inmediato
    const activePortals = xtream.getPortals().filter(p => p.isVerifiedOnline);
    if (activePortals.length === 0) {
      console.log('[Server] No active portals found. Running scraper automatically...');
      const { runScraper } = require('./scraper');
      runScraper().catch(e => console.error('[Server] Startup scrape failed:', e.message));
    }
  }).catch(async (e) => {
    console.error('[Server] Failed to init channels:', e.message);
    await xtream.verifyAllPortals().catch(err => console.error('[Server] Failed to init portals:', err.message));
    
    // Correr scraper en caso de fallo en inicialización también
    const { runScraper } = require('./scraper');
    runScraper().catch(err => console.error('[Server] Fallback startup scrape failed:', err.message));
  });

  // Correr el scraper cada 12 horas en segundo plano
  setInterval(() => {
    console.log('[Server] Running scheduled scraper...');
    const { runScraper } = require('./scraper');
    runScraper().catch(e => console.error('[Server] Scheduled scrape failed:', e.message));
  }, 12 * 60 * 60 * 1000);
});
