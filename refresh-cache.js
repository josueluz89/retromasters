const channels = require('./channels');

channels.fetchAndCache()
  .then(data => {
    console.log(`[refresh-cache] OK: ${data.channels.length} channels cached`);
    process.exit(0);
  })
  .catch(e => {
    console.error('[refresh-cache] Failed:', e.message);
    process.exit(1);
  });
