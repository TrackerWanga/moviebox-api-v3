const express = require('express');
const axios = require('axios');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

const CONFIG = {
  H5_API: 'https://h5-api.aoneroom.com',
  NETFILM_DOMAIN: 'https://netfilm.world',
  HEADERS: {
    'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36',
    'Accept': 'application/json',
  },
  COOKIE: 'uuid=d8c3539e-2e46-4000-af20-7046a856e30a',
};

class MovieBoxSession {
  constructor() {
    this.token = null;
    this.expiry = 0;
  }

  async init() {
    try {
      const response = await axios.get(`${CONFIG.H5_API}/wefeed-h5api-bff/home?host=moviebox.ph`, {
        headers: CONFIG.HEADERS,
        httpsAgent: new https.Agent({ rejectUnauthorized: false })
      });

      const setCookie = response.headers['set-cookie'];
      if (setCookie) {
        const cookieStr = Array.isArray(setCookie) ? setCookie.join(';') : setCookie;
        const tokenMatch = cookieStr.match(/token=([^;]+)/);
        if (tokenMatch) this.token = tokenMatch[1];
      }

      this.expiry = Date.now() + 3600000;
      return true;
    } catch (e) {
      console.error('Session init failed:', e.message);
      return false;
    }
  }

  async ensure() {
    if (!this.token || Date.now() > this.expiry) {
      return await this.init();
    }
    return true;
  }

  getHeaders() {
    const headers = { ...CONFIG.HEADERS };
    if (this.token) headers['Cookie'] = `token=${this.token}; ${CONFIG.COOKIE}`;
    return headers;
  }
}

const session = new MovieBoxSession();
const cache = new Map();

async function fetchAPI(path, options = {}) {
  const cacheKey = `${options.method || 'GET'}:${path}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.t < 300000) return cached.data;

  await session.ensure();

  try {
    const response = await axios({
      method: options.method || 'GET',
      url: `${CONFIG.H5_API}${path}`,
      headers: { ...session.getHeaders(), ...options.headers },
      data: options.body,
      httpsAgent: new https.Agent({ rejectUnauthorized: false })
    });

    if (response.data?.code === 0) {
      cache.set(cacheKey, { data: response.data, t: Date.now() });
      return response.data;
    }
    throw new Error(`API error: ${response.data?.code}`);
  } catch (e) {
    console.error(`Request failed: ${path}`, e.message);
    throw e;
  }
}

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Root
app.get('/', (req, res) => {
  res.json({ api: 'MovieBox API Pro', version: '5.0.1', session: !!session.token });
});

// Health
app.get('/api/health', async (req, res) => {
  const healthy = await session.ensure();
  res.json({ status: healthy ? 'healthy' : 'degraded', token: !!session.token });
});

// Home
app.get('/api/home', async (req, res) => {
  try {
    const data = await fetchAPI('/wefeed-h5api-bff/home?host=moviebox.ph');
    const ops = data.data?.operatingList || [];
    const sections = ops
      .filter(op => op.subjects?.length > 0)
      .map(op => ({
        section: op.title,
        type: op.type,
        count: op.subjects.length,
        movies: op.subjects.map(s => ({
          id: s.subjectId,
          title: s.title || s.name,
          poster: s.cover?.url,
          slug: s.detailPath,
          year: s.releaseDate?.split('-')[0],
          rating: s.imdbRatingValue,
          type: s.subjectType === 1 ? 'movie' : 'tv'
        }))
      }));
    res.json({ success: true, total_sections: sections.length, sections });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Sections
app.get('/api/sections', async (req, res) => {
  try {
    const data = await fetchAPI('/wefeed-h5api-bff/home?host=moviebox.ph');
    const ops = data.data?.operatingList || [];
    const sections = ops
      .filter(op => op.subjects?.length > 0)
      .map(op => ({ name: op.title, type: op.type, count: op.subjects.length }));
    res.json({ success: true, sections });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Search - FIXED
app.get('/api/search', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.status(400).json({ error: 'Query required' });

    const data = await fetchAPI('/wefeed-h5api-bff/subject/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: { keyword: q, perPage: 30, page: 1 }
    });

    const items = data.data?.items || [];
    res.json({
      success: true,
      query: q,
      count: items.length,
      results: items.map(item => ({
        id: item.subjectId,
        title: item.title,
        poster: item.cover?.url,
        slug: item.detailPath,
        year: item.releaseDate?.split('-')[0],
        type: item.subjectType === 1 ? 'movie' : 'tv'
      }))
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Detail
app.get('/api/detail/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    const data = await fetchAPI(`/wefeed-h5api-bff/detail?detailPath=${slug}`);
    const subject = data.data?.subject || {};
    const stars = data.data?.stars || [];
    
    res.json({
      success: true,
      title: subject.title,
      description: subject.description,
      year: subject.releaseDate?.split('-')[0],
      rating: subject.imdbRatingValue,
      genres: subject.genre?.split(',') || [],
      poster: subject.cover?.url,
      cast: stars.map(s => ({ name: s.name, character: s.character })),
      seasons: data.data?.resource?.seasons || []
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Stream - FIXED
app.get('/api/stream/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { detail_path, se = 0, ep = 0 } = req.query;
    
    if (!detail_path) return res.status(400).json({ error: 'detail_path required' });

    // Get domain
    const domainData = await fetchAPI('/wefeed-h5api-bff/media-player/get-domain', {
      headers: { 'X-Client-Type': 'h5' }
    });
    const domain = (domainData.data || CONFIG.NETFILM_DOMAIN).replace(/\/+$/, '');

    // Get streams
    const playUrl = `/wefeed-h5api-bff/subject/play?subjectId=${id}&se=${se}&ep=${ep}&detailPath=${detail_path}`;
    const playData = await fetchAPI(playUrl);
    const streams = playData.data?.streams || [];

    res.json({
      success: true,
      count: streams.length,
      sources: streams.map(s => ({
        resolution: `${s.resolutions}p`,
        format: s.format,
        url: s.url,
        size: s.size
      })).sort((a, b) => parseInt(b.resolution) - parseInt(a.resolution))
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.listen(PORT, '0.0.0.0', async () => {
  console.log(`Server running on port ${PORT}`);
  await session.ensure();
  console.log(`Session ready: ${!!session.token}`);
});
