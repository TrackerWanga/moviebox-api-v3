const express = require('express');
const https = require('https');
const http = require('http');
const app = express();
const PORT = process.env.PORT || 3000;

const H5_API = 'https://h5-api.aoneroom.com';
const UA = 'curl/7.81.0';

// CORS middleware
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Range');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Node.js native HTTPS request (works like curl)
function nativeFetch(url) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const options = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      headers: {
        'User-Agent': UA,
        'Accept': '*/*',
        'Host': parsedUrl.hostname,
      },
      rejectUnauthorized: false
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({
            status: res.statusCode,
            json: () => JSON.parse(data),
            text: data
          });
        } catch (e) {
          resolve({
            status: res.statusCode,
            json: () => { throw new Error('Invalid JSON'); },
            text: data
          });
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    req.end();
  });
}

// Cache
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

function getCached(key) {
  const item = cache.get(key);
  if (item && Date.now() - item.timestamp < CACHE_TTL) {
    return item.data;
  }
  return null;
}

function setCache(key, data) {
  cache.set(key, { data, timestamp: Date.now() });
}

async function fetchH5(path) {
  const cacheKey = path;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const url = `${H5_API}${path}`;
  console.log(`Fetching: ${url}`);
  
  const response = await nativeFetch(url);
  console.log(`Status: ${response.status}`);
  
  if (response.status === 200) {
    const data = response.json();
    if (data.code === 0) {
      setCache(cacheKey, data);
      return data;
    }
  }
  
  throw new Error(`H5 API returned ${response.status}`);
}

// Endpoints
app.get('/', (req, res) => {
  res.json({
    api: 'MovieBox API',
    version: '3.0.0',
    platform: 'Render',
    status: 'testing'
  });
});

app.get('/health', async (req, res) => {
  try {
    const data = await fetchH5('/wefeed-h5api-bff/home?host=moviebox.ph');
    res.json({ 
      status: 'healthy',
      h5_api: 'connected',
      data_sample: JSON.stringify(data).substring(0, 100)
    });
  } catch (error) {
    res.json({ status: 'error', message: error.message });
  }
});

app.get('/home', async (req, res) => {
  try {
    const data = await fetchH5('/wefeed-h5api-bff/home?host=moviebox.ph');
    const ops = data.data?.operatingList || [];
    
    const sections = [];
    for (const op of ops) {
      if (op.subjects?.length > 0) {
        sections.push({
          section: op.title || 'Untitled',
          count: op.subjects.length,
          movies: op.subjects.map(s => ({
            name: s.title || s.name,
            poster_url: s.cover?.url || null,
            slug: s.detailPath || null,
          }))
        });
      }
    }

    res.json({ success: true, total_sections: sections.length, sections });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`MovieBox API running on port ${PORT}`);
});
