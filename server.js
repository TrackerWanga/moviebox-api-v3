const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================
// CONFIGURATION
// ============================================
const CONFIG = {
  // Primary API
  H5_API: 'https://h5-api.aoneroom.com',
  
  // Fallback APIs discovered from APK
  APIS: [
    'https://h5-api.aoneroom.com',
    'https://api.paynicorn.com',
    'https://api6.aoneroom.com',
    'https://v.aoneroom.com',
    'https://i-api.aoneroom.com',
    'https://open-api.hakunaymatata.com',
  ],
  
  // Stream domains
  NETFILM_DOMAIN: 'https://netfilm.world',
  FALLBACK_DOMAIN: 'https://123movienow.cc',
  
  // Base URL for scraping
  BASE_URL: 'https://moviebox.ph',
  
  // Headers that work (matching exactly what the APK sends)
  HEADERS: {
    'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'cross-site',
  },
  
  // Cookie that the app uses
  COOKIE: 'uuid=d8c3539e-2e46-4000-af20-7046a856e30a',
};

// ============================================
// SESSION MANAGEMENT (like Gemini client)
// ============================================
class MovieBoxSession {
  constructor() {
    this.token = null;
    this.userId = null;
    this.expiry = 0;
    this.workingAPI = CONFIG.H5_API;
  }

  async init() {
    // Try to get a fresh session from the API
    for (const api of CONFIG.APIS) {
      try {
        const response = await axios.get(`${api}/wefeed-h5api-bff/home?host=moviebox.ph`, {
          headers: CONFIG.HEADERS,
          timeout: 10000,
          httpsAgent: new https.Agent({ rejectUnauthorized: false })
        });

        // Extract token from response headers
        const setCookie = response.headers['set-cookie'];
        if (setCookie) {
          const tokenMatch = Array.isArray(setCookie) 
            ? setCookie.join(';').match(/token=([^;]+)/)
            : setCookie.match(/token=([^;]+)/);
          
          if (tokenMatch) {
            this.token = tokenMatch[1];
          }
        }

        // Extract user info from response
        const xUser = response.headers['x-user'];
        if (xUser) {
          try {
            const userData = JSON.parse(xUser);
            this.userId = userData.userId;
          } catch(e) {}
        }

        // If we got data, this API works
        if (response.data?.code === 0) {
          this.workingAPI = api;
          this.expiry = Date.now() + 3600000; // 1 hour
          console.log(`Session established with ${api}`);
          return true;
        }
      } catch (error) {
        console.log(`API ${api} failed: ${error.message}`);
      }
    }
    return false;
  }

  async ensureSession() {
    if (!this.token || Date.now() > this.expiry) {
      await this.init();
    }
    return !!this.token;
  }

  getHeaders() {
    const headers = { ...CONFIG.HEADERS };
    if (this.token) {
      headers['Cookie'] = `token=${this.token}; ${CONFIG.COOKIE}`;
    }
    if (this.userId) {
      headers['X-User-Id'] = this.userId;
    }
    return headers;
  }
}

// ============================================
// API CLIENT (like your fastdl implementation)
// ============================================
class MovieBoxClient {
  constructor() {
    this.session = new MovieBoxSession();
    this.cache = new Map();
    this.cacheTTL = 5 * 60 * 1000;
  }

  async request(path, options = {}) {
    const cacheKey = `${options.method || 'GET'}:${path}`;
    const cached = this.cache.get(cacheKey);
    
    if (cached && Date.now() - cached.timestamp < this.cacheTTL) {
      return cached.data;
    }

    await this.session.ensureSession();

    const url = `${this.session.workingAPI}${path}`;
    console.log(`Requesting: ${url}`);

    try {
      const response = await axios({
        method: options.method || 'GET',
        url,
        headers: {
          ...this.session.getHeaders(),
          ...options.headers,
        },
        data: options.body,
        timeout: 15000,
        httpsAgent: new https.Agent({ rejectUnauthorized: false })
      });

      if (response.data?.code === 0) {
        this.cache.set(cacheKey, {
          data: response.data,
          timestamp: Date.now()
        });
        return response.data;
      }

      // If token expired, refresh and retry once
      if (response.data?.code === 401 || response.status === 429) {
        this.cache.clear();
        await this.session.init();
        
        const retryResponse = await axios({
          method: options.method || 'GET',
          url,
          headers: this.session.getHeaders(),
          data: options.body,
          timeout: 15000,
          httpsAgent: new https.Agent({ rejectUnauthorized: false })
        });

        if (retryResponse.data?.code === 0) {
          return retryResponse.data;
        }
      }

      throw new Error(`API error: ${response.data?.message || response.status}`);
    } catch (error) {
      // Try fallback APIs
      for (const api of CONFIG.APIS) {
        if (api === this.session.workingAPI) continue;
        
        try {
          const fallbackUrl = `${api}${path}`;
          console.log(`Trying fallback: ${fallbackUrl}`);
          
          const response = await axios({
            method: options.method || 'GET',
            url: fallbackUrl,
            headers: this.session.getHeaders(),
            data: options.body,
            timeout: 10000,
            httpsAgent: new https.Agent({ rejectUnauthorized: false })
          });

          if (response.data?.code === 0) {
            this.session.workingAPI = api;
            this.cache.set(cacheKey, {
              data: response.data,
              timestamp: Date.now()
            });
            return response.data;
          }
        } catch (e) {
          continue;
        }
      }

      throw error;
    }
  }
}

// ============================================
// INITIALIZE CLIENT
// ============================================
const client = new MovieBoxClient();

// ============================================
// MIDDLEWARE
// ============================================
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Range');
  res.header('Access-Control-Expose-Headers', 'Content-Length, Content-Range');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Rate limiting
const rateLimit = require('express-rate-limit');
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  message: { error: 'Too many requests' }
});
app.use('/api/', limiter);

// ============================================
// API ENDPOINTS
// ============================================

// Root
app.get('/', (req, res) => {
  res.json({
    api: 'MovieBox API Pro',
    version: '5.0.0',
    session: !!client.session.token,
    working_api: client.session.workingAPI,
    endpoints: {
      home: '/api/home',
      search: '/api/search?q=',
      detail: '/api/detail/:slug',
      stream: '/api/stream/:id?detail_path=',
      sections: '/api/sections',
      health: '/api/health'
    }
  });
});

// Health
app.get('/api/health', async (req, res) => {
  const healthy = await client.session.ensureSession();
  res.json({
    status: healthy ? 'healthy' : 'degraded',
    token: !!client.session.token,
    api: client.session.workingAPI,
    cache_size: client.cache.size
  });
});

// Homepage
app.get('/api/home', async (req, res) => {
  try {
    const data = await client.request('/wefeed-h5api-bff/home?host=moviebox.ph');
    const ops = data.data?.operatingList || [];
    
    const sections = ops
      .filter(op => op.subjects?.length > 0)
      .map(op => ({
        section: op.title || 'Untitled',
        type: op.type,
        count: op.subjects.length,
        movies: op.subjects.map(s => ({
          id: s.subjectId,
          title: s.title || s.name,
          poster: s.cover?.url || null,
          slug: s.detailPath,
          year: s.releaseDate?.split('-')[0],
          rating: s.imdbRatingValue,
          type: s.subjectType === 1 ? 'movie' : 'tv',
          hasResource: s.hasResource
        }))
      }));

    res.json({
      success: true,
      total_sections: sections.length,
      sections
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Sections list
app.get('/api/sections', async (req, res) => {
  try {
    const data = await client.request('/wefeed-h5api-bff/home?host=moviebox.ph');
    const ops = data.data?.operatingList || [];
    
    const sections = ops
      .filter(op => op.subjects?.length > 0)
      .map(op => ({
        name: op.title,
        type: op.type,
        count: op.subjects.length
      }));

    res.json({ success: true, sections });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Search
app.get('/api/search', async (req, res) => {
  try {
    const { q, type } = req.query;
    if (!q) return res.status(400).json({ error: 'Query parameter q required' });

    const data = await client.request('/wefeed-h5api-bff/subject/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: { keyword: q, perPage: 30, page: 1 }
    });

    let items = data.data?.items || [];
    
    if (type === 'movie') items = items.filter(i => i.subjectType === 1);
    else if (type === 'tv') items = items.filter(i => i.subjectType === 2);

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
        rating: item.imdbRatingValue,
        type: item.subjectType === 1 ? 'movie' : 'tv'
      }))
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Detail
app.get('/api/detail/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    const data = await client.request(`/wefeed-h5api-bff/detail?detailPath=${slug}`);
    
    const subject = data.data?.subject || {};
    const stars = data.data?.stars || [];
    const resource = data.data?.resource || {};

    res.json({
      success: true,
      id: subject.subjectId,
      title: subject.title,
      description: subject.description,
      year: subject.releaseDate?.split('-')[0],
      duration: subject.duration,
      rating: subject.imdbRatingValue,
      genres: subject.genre?.split(',') || [],
      country: subject.countryName,
      poster: subject.cover?.url,
      backdrop: subject.stills?.url,
      hasResource: subject.hasResource,
      cast: stars.map(s => ({
        name: s.name,
        character: s.character,
        avatar: s.avatarUrl
      })),
      seasons: resource.seasons || []
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Stream
app.get('/api/stream/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { detail_path, se = 0, ep = 0 } = req.query;
    
    if (!detail_path) return res.status(400).json({ error: 'detail_path required' });

    // Get stream domain
    const domainData = await client.request('/wefeed-h5api-bff/media-player/get-domain', {
      headers: { 'X-Client-Type': 'h5' }
    });
    
    const domain = domainData.data || CONFIG.NETFILM_DOMAIN;

    // Get streams
    const playUrl = `/wefeed-h5api-bff/subject/play?subjectId=${id}&se=${se}&ep=${ep}&detailPath=${detail_path}`;
    const playData = await client.request(playUrl);
    
    const streams = playData.data?.streams || [];

    res.json({
      success: true,
      subject_id: id,
      detail_path,
      season: parseInt(se),
      episode: parseInt(ep),
      domain,
      count: streams.length,
      sources: streams
        .map(s => ({
          resolution: `${s.resolutions}p`,
          format: s.format,
          url: s.url,
          size: s.size
        }))
        .sort((a, b) => parseInt(b.resolution) - parseInt(a.resolution))
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// START SERVER
// ============================================
app.listen(PORT, '0.0.0.0', async () => {
  console.log(`Server running on port ${PORT}`);
  console.log('Initializing session...');
  await client.session.ensureSession();
  console.log(`Session ready: ${!!client.session.token}`);
  console.log(`Working API: ${client.session.workingAPI}`);
});
