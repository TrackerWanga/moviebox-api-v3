const express = require('express');
const axios = require('axios');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

const H5_API = 'https://h5-api.aoneroom.com';
const NETFILM = 'https://netfilm.world';
const UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36';

let token = null;
let tokenExpiry = 0;

async function getSession() {
  if (token && Date.now() < tokenExpiry) return token;
  
  const res = await axios.get(`${H5_API}/wefeed-h5api-bff/home?host=moviebox.ph`, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json' },
    httpsAgent: new https.Agent({ rejectUnauthorized: false })
  });
  
  const sc = res.headers['set-cookie'];
  if (sc) {
    const str = Array.isArray(sc) ? sc.join(';') : sc;
    const m = str.match(/token=([^;]+)/);
    if (m) token = m[1];
  }
  tokenExpiry = Date.now() + 3600000;
  return token;
}

async function h5get(path) {
  const tok = await getSession();
  const res = await axios.get(`${H5_API}${path}`, {
    headers: {
      'User-Agent': UA,
      'Accept': 'application/json',
      'Cookie': `token=${tok}`
    },
    httpsAgent: new https.Agent({ rejectUnauthorized: false })
  });
  if (res.data?.code === 0) return res.data;
  throw new Error(`API: ${res.data?.code}`);
}

async function h5post(path, body) {
  const tok = await getSession();
  const res = await axios.post(`${H5_API}${path}`, body, {
    headers: {
      'User-Agent': UA,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'Cookie': `token=${tok}`
    },
    httpsAgent: new https.Agent({ rejectUnauthorized: false })
  });
  if (res.data?.code === 0) return res.data;
  throw new Error(`API: ${res.data?.code}`);
}

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/', (req, res) => res.json({ api: 'MovieBox API', v: '6.0.0' }));

app.get('/api/health', async (req, res) => {
  try {
    await getSession();
    res.json({ status: 'healthy', token: !!token });
  } catch(e) { res.json({ status: 'down' }); }
});

app.get('/api/home', async (req, res) => {
  try {
    const data = await h5get('/wefeed-h5api-bff/home?host=moviebox.ph');
    const ops = data.data?.operatingList || [];
    const sections = ops.filter(o => o.subjects?.length).map(o => ({
      name: o.title, type: o.type, count: o.subjects.length,
      items: o.subjects.map(s => ({
        id: s.subjectId, title: s.title, poster: s.cover?.url,
        slug: s.detailPath, year: s.releaseDate?.split('-')[0],
        rating: s.imdbRatingValue, type: s.subjectType === 1 ? 'movie' : 'tv'
      }))
    }));
    res.json({ success: true, total: sections.length, sections });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/search', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.status(400).json({ error: 'q required' });
    
    const data = await h5post('/wefeed-h5api-bff/subject/search', {
      keyword: q,
      perPage: 30,
      page: 1
    });
    
    const items = data.data?.items || [];
    res.json({
      success: true, query: q, count: items.length,
      results: items.map(i => ({
        id: i.subjectId, title: i.title, poster: i.cover?.url,
        slug: i.detailPath, year: i.releaseDate?.split('-')[0],
        type: i.subjectType === 1 ? 'movie' : 'tv'
      }))
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/detail/:slug', async (req, res) => {
  try {
    const data = await h5get(`/wefeed-h5api-bff/detail?detailPath=${req.params.slug}`);
    const s = data.data?.subject || {};
    const stars = data.data?.stars || [];
    res.json({
      success: true, title: s.title, description: s.description,
      year: s.releaseDate?.split('-')[0], rating: s.imdbRatingValue,
      genres: s.genre?.split(',') || [], poster: s.cover?.url,
      cast: stars.map(x => ({ name: x.name, character: x.character })),
      seasons: data.data?.resource?.seasons || []
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/stream/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { detail_path, se = 0, ep = 0 } = req.query;
    if (!detail_path) return res.status(400).json({ error: 'detail_path required' });

    // Get domain
    const domainData = await h5get('/wefeed-h5api-bff/media-player/get-domain');
    const domain = (domainData.data || NETFILM).replace(/\/+$/, '');

    // Call play API on the domain directly with proper referer
    const playUrl = `${domain}/wefeed-h5api-bff/subject/play?subjectId=${id}&se=${se}&ep=${ep}&detailPath=${detail_path}`;
    const playRes = await axios.get(playUrl, {
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json',
        'Referer': `${domain}/spa/videoPlayPage/movies/${detail_path}`,
        'Cookie': `uuid=d8c3539e-2e46-4000-af20-7046a856e30a`
      },
      httpsAgent: new https.Agent({ rejectUnauthorized: false })
    });

    const streams = playRes.data?.data?.streams || [];
    res.json({
      success: true, count: streams.length,
      sources: streams.map(s => ({
        quality: `${s.resolutions}p`, format: s.format,
        url: s.url, size: s.size
      }))
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, '0.0.0.0', async () => {
  console.log(`Server on port ${PORT}`);
  await getSession();
  console.log('Session ready');
});
