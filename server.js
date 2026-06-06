const express = require('express');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const channels = require('./channels');

const PORT = process.env.PORT || 3001;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

const manifest = {
  id: 'com.masterscr.crmx',
  version: '1.0.0',
  name: 'Canales CR+CO+ES+PL',
  description: 'Canales de Costa Rica, Colombia, España y Pluto TV LATAM en vivo',
  logo: 'https://i.imgur.com/H89x7GX.png',
  background: 'https://i.imgur.com/H89x7GX.png',
  resources: ['stream', 'catalog', 'meta'],
  types: ['tv'],
  catalogs: [
    { id: 'crmx_cr', name: 'Costa Rica', type: 'tv' },
    { id: 'crmx_co', name: 'Colombia', type: 'tv' },
    { id: 'crmx_es', name: 'España', type: 'tv' },
    { id: 'crmx_pluto', name: 'Pluto TV LATAM', type: 'tv' },
    { id: 'crmx_all', name: 'Todo', type: 'tv' },
  ],
};

const builder = new addonBuilder(manifest);

const FLAGS = { CR: '🇨🇷', CO: '🇨🇴', ES: '🇪🇸', PL: '📺' };

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
    if (!ch || !ch.url) return { streams: [] };

    const stream = {
      url: ch.url,
      name: `${FLAGS[ch.country] || '📺'} ${ch.name}`,
    };

    if (ch.referrer) {
      stream.behaviorHints = { proxyHeaders: { request: { Referer: ch.referrer } } };
    }

    return { streams: [stream] };
  } catch (e) {
    console.error('[Stream] Error:', e.message);
    return { streams: [] };
  }
});

const app = express();
app.use(getRouter(builder.getInterface()));

app.get('/health', (req, res) => res.json({ status: 'ok', channels: 'CR+CO+ES+PL', time: new Date().toISOString() }));

channels.init().then(() => {
  app.listen(PORT, () => {
    console.log(`CR+CO+ES+PL Addon running on port ${PORT}`);
    console.log(`Manifest: ${BASE_URL}/manifest.json`);
  });
}).catch(e => {
  console.error('Failed to init:', e.message);
  app.listen(PORT, () => {
    console.log(`CR+CO+ES+PL Addon running (no channels loaded yet) on port ${PORT}`);
  });
});
