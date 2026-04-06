const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const crypto = require('crypto');
const querystring = require('querystring');

const PORT = process.env.PORT || 3000;

// Google Places API key - ユーザーが設定
// 環境変数 GOOGLE_PLACES_API_KEY またはここに直接設定
const API_KEY = process.env.GOOGLE_PLACES_API_KEY || '';

// Google Business Profile OAuth settings
const GBP_CLIENT_ID = process.env.GBP_CLIENT_ID || '';
const GBP_CLIENT_SECRET = process.env.GBP_CLIENT_SECRET || '';
const GBP_REDIRECT_URI = process.env.GBP_REDIRECT_URI || `http://localhost:${PORT}/auth/google/callback`;
const GBP_SCOPE = 'https://www.googleapis.com/auth/business.manage';

// Simple in-memory session store (for production, use a proper session store)
const sessions = new Map();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

function fetchJSON(apiUrl) {
  return new Promise((resolve, reject) => {
    https.get(apiUrl, (resp) => {
      let data = '';
      resp.on('data', chunk => data += chunk);
      resp.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// Follow redirects to resolve short URLs (maps.app.goo.gl, goo.gl, etc.)
function resolveRedirect(shortUrl) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(shortUrl);
    const mod = parsed.protocol === 'https:' ? https : http;
    const req = mod.get(shortUrl, (resp) => {
      if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location) {
        // Follow redirect
        resolve(resp.headers.location);
      } else {
        // No redirect, return original
        let body = '';
        resp.on('data', c => body += c);
        resp.on('end', () => {
          // Check for meta refresh or JS redirect in HTML
          const metaMatch = body.match(/content=["']0;\s*url=([^"']+)/i);
          if (metaMatch) resolve(metaMatch[1]);
          else resolve(shortUrl);
        });
      }
    });
    req.on('error', () => resolve(shortUrl));
    req.setTimeout(5000, () => { req.destroy(); resolve(shortUrl); });
  });
}

// Extract Place ID from various Google Maps URL formats
function extractPlaceInfo(inputUrl) {
  if (inputUrl.startsWith('place_id:')) {
    return { placeId: inputUrl.replace('place_id:', '') };
  }

  // Try ChIJ format (Place ID)
  const chiMatch = inputUrl.match(/(ChIJ[A-Za-z0-9_-]+)/);
  if (chiMatch) {
    return { placeId: chiMatch[1] };
  }

  // Try ftid format (used in some Google Maps URLs)
  const ftidMatch = inputUrl.match(/ftid=(0x[a-f0-9]+:0x[a-f0-9]+)/);
  if (ftidMatch) {
    return { ftid: ftidMatch[1] };
  }

  // Try to extract from data parameter !1s0x...:0x...
  const placeIdMatch = inputUrl.match(/!1s(0x[a-f0-9]+:0x[a-f0-9]+)/);
  if (placeIdMatch) {
    return { ftid: placeIdMatch[1] };
  }

  // Try cid= parameter
  const cidMatch = inputUrl.match(/[?&]cid=(\d+)/);
  if (cidMatch) {
    return { query: 'cid:' + cidMatch[1] };
  }

  // Extract place name from /place/NAME/ in URL
  const placeMatch = inputUrl.match(/\/place\/([^/@]+)/);
  if (placeMatch) {
    return { query: decodeURIComponent(placeMatch[1]).replace(/\+/g, ' ') };
  }

  // Extract from q= parameter
  const qMatch = inputUrl.match(/[?&]q=([^&]+)/);
  if (qMatch) {
    return { query: decodeURIComponent(qMatch[1]).replace(/\+/g, ' ') };
  }

  // Use the full input as a search query
  return { query: inputUrl };
}

async function handlePlaceSearch(query, res) {
  const cors = { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' };

  if (!API_KEY) {
    const demoPlace = generateDemoData(query);
    const demoReviews = (demoPlace.reviews || []).map(r => ({
      name: r.authorName || '匿名',
      rating: r.rating,
      text: r.text || '',
      date: r.time || '',
    }));
    res.writeHead(200, cors);
    res.end(JSON.stringify({
      status: 'OK',
      place: demoPlace,
      data: {
        store: { ...demoPlace, category: 'レストラン', status: '営業中' },
        reviews: demoReviews,
        _real: false,
      }
    }));
    return;
  }

  try {
    let resolvedUrl = query;

    // Step 1: Resolve short URLs (maps.app.goo.gl, goo.gl)
    if (query.match(/maps\.app\.goo\.gl|goo\.gl|g\.co/)) {
      console.log('[Place] Resolving short URL:', query);
      resolvedUrl = await resolveRedirect(query);
      console.log('[Place] Resolved to:', resolvedUrl);
      // Sometimes needs a second redirect
      if (resolvedUrl.match(/maps\.app\.goo\.gl|goo\.gl|consent\.google/)) {
        resolvedUrl = await resolveRedirect(resolvedUrl);
        console.log('[Place] Resolved (2nd):', resolvedUrl);
      }
    }

    const info = extractPlaceInfo(resolvedUrl);
    let placeId = info.placeId;
    console.log('[Place] Extracted info:', JSON.stringify(info));

    // If we have ftid, use it to search
    if (info.ftid && !placeId) {
      // Use textsearch with the ftid as a reference
      const searchUrl = `https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input=${encodeURIComponent(info.ftid)}&inputtype=textquery&fields=place_id&key=${API_KEY}`;
      const searchResult = await fetchJSON(searchUrl);
      if (searchResult.candidates && searchResult.candidates.length > 0) {
        placeId = searchResult.candidates[0].place_id;
      }
    }

    // If we have a query, do a text search
    if (info.query && !placeId) {
      const searchUrl = `https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input=${encodeURIComponent(info.query)}&inputtype=textquery&fields=place_id,name&key=${API_KEY}`;
      const searchResult = await fetchJSON(searchUrl);
      if (searchResult.candidates && searchResult.candidates.length > 0) {
        placeId = searchResult.candidates[0].place_id;
      }
    }

    // If still no placeId, try extracting place name from the resolved URL for a broader search
    if (!placeId && resolvedUrl !== query) {
      const placeNameMatch = resolvedUrl.match(/\/place\/([^/@]+)/);
      if (placeNameMatch) {
        const placeName = decodeURIComponent(placeNameMatch[1]).replace(/\+/g, ' ');
        const searchUrl = `https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input=${encodeURIComponent(placeName)}&inputtype=textquery&fields=place_id&key=${API_KEY}`;
        const searchResult = await fetchJSON(searchUrl);
        if (searchResult.candidates && searchResult.candidates.length > 0) {
          placeId = searchResult.candidates[0].place_id;
        }
      }
    }

    if (!placeId) {
      res.writeHead(200, cors);
      res.end(JSON.stringify({ status: 'NOT_FOUND', message: '店舗が見つかりませんでした。URLを確認して再度お試しください。' }));
      return;
    }

    console.log('[Place] Using place_id:', placeId);

    // Get place details - request all available fields
    const fields = 'name,rating,user_ratings_total,formatted_phone_number,website,opening_hours,photos,types,formatted_address,business_status,reviews,url,price_level';
    const detailUrl = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${placeId}&fields=${fields}&language=ja&reviews_sort=newest&key=${API_KEY}`;
    const detail = await fetchJSON(detailUrl);

    if (detail.status === 'OK') {
      const p = detail.result;

      // Map types to Japanese category names
      const typeMap = {
        restaurant: 'レストラン', cafe: 'カフェ', bar: 'バー',
        bakery: 'ベーカリー', hair_care: '美容室', beauty_salon: '美容サロン',
        spa: 'スパ', gym: 'ジム', dentist: '歯科', doctor: '病院',
        store: '店舗', shopping_mall: 'ショッピング', lodging: '宿泊施設',
        food: '飲食店', meal_takeaway: 'テイクアウト', meal_delivery: 'デリバリー',
      };
      const primaryType = (p.types || []).find(t => typeMap[t]) || (p.types || [])[0] || '';
      const categoryJa = typeMap[primaryType] || primaryType;

      const place = {
        name: p.name || '',
        rating: p.rating || 0,
        reviewCount: p.user_ratings_total || 0,
        phone: p.formatted_phone_number || '',
        website: p.website || '',
        address: p.formatted_address || '',
        hasHours: !!(p.opening_hours),
        isOpen: p.opening_hours ? p.opening_hours.open_now : null,
        // Note: Places API returns max 10 photo references, not the total count
        // user_ratings_total is accurate, photoCount from API is limited
        photoCount: p.photos ? p.photos.length : 0,
        types: p.types || [],
        businessStatus: p.business_status || '',
        category: categoryJa,
        status: p.business_status === 'OPERATIONAL' ? '営業中' : (p.business_status === 'CLOSED_TEMPORARILY' ? '一時休業' : '休業中'),
        url: p.url || '',
      };

      // Format reviews for dashboard (API returns up to 5 most relevant)
      const reviews = (p.reviews || []).slice(0, 5).map(r => ({
        name: r.author_name || '匿名',
        rating: r.rating,
        text: r.text ? r.text.substring(0, 200) : '',
        date: r.relative_time_description || '',
      }));

      // Estimate performance data based on review count and rating
      // These are estimated values since real performance data requires Business Profile API
      const rc = p.user_ratings_total || 0;
      const rt = p.rating || 0;
      const estimatedViews = Math.round(rc * 45 + rt * 800 + Math.random() * 500);
      const estimatedRoutes = Math.round(estimatedViews * (0.08 + Math.random() * 0.06));
      const estimatedCalls = Math.round(estimatedViews * (0.02 + Math.random() * 0.02));
      const estimatedWebsite = Math.round(estimatedViews * (0.05 + Math.random() * 0.04));
      const prevFactor = 0.85 + Math.random() * 0.1;

      res.writeHead(200, cors);
      res.end(JSON.stringify({
        status: 'OK',
        place,
        data: {
          store: place,
          reviews,
          kpiEstimated: true,
          kpi: {
            views: estimatedViews,
            viewsPrev: Math.round(estimatedViews * prevFactor),
            directions: estimatedRoutes,
            directionsPrev: Math.round(estimatedRoutes * prevFactor),
            calls: estimatedCalls,
            callsPrev: Math.round(estimatedCalls * prevFactor),
            website: estimatedWebsite,
            websitePrev: Math.round(estimatedWebsite * prevFactor),
          },
          _real: true,
        }
      }));
    } else {
      res.writeHead(200, cors);
      res.end(JSON.stringify({ status: detail.status, message: 'Place Details APIエラー: ' + detail.status }));
    }
  } catch (err) {
    console.error('[Place] Error:', err);
    res.writeHead(500, cors);
    res.end(JSON.stringify({ status: 'ERROR', message: err.message }));
  }
}

// Demo data when no API key is set
function generateDemoData(query) {
  const name = query.includes('/place/') ?
    decodeURIComponent(query.match(/\/place\/([^/@]+)/)?.[1] || 'あなたのお店').replace(/\+/g, ' ') :
    (query || 'あなたのお店');
  return {
    name: name,
    rating: 3.8,
    reviewCount: 42,
    phone: '03-1234-5678',
    website: '',
    address: '東京都渋谷区...',
    hasHours: true,
    isOpen: true,
    photoCount: 8,
    types: ['restaurant'],
    businessStatus: 'OPERATIONAL',
    url: '',
    reviews: [
      { rating: 5, text: '料理がとても美味しかったです。店内の雰囲気も良く、また行きたいと思います。', time: '1か月前', authorName: 'ユーザーA' },
      { rating: 4, text: 'ランチで利用しました。コスパが良いです。', time: '2か月前', authorName: 'ユーザーB' },
      { rating: 2, text: '待ち時間が長かったのが残念でした。', time: '3か月前', authorName: 'ユーザーC' },
    ],
    _demo: true,
  };
}

// ===== HTTPS fetch helper (POST) =====
function httpsRequest(options, postData) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (resp) => {
      let data = '';
      resp.on('data', chunk => data += chunk);
      resp.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { resolve(data); }
      });
    });
    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

// ===== GBP API fetch with auth =====
function gbpFetch(apiUrl, accessToken) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(apiUrl);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: { 'Authorization': `Bearer ${accessToken}` }
    };
    https.get(apiUrl, { headers: { 'Authorization': `Bearer ${accessToken}` } }, (resp) => {
      let data = '';
      resp.on('data', chunk => data += chunk);
      resp.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Invalid JSON: ' + data.substring(0, 200))); }
      });
    }).on('error', reject);
  });
}

// ===== Cookie helpers =====
function getSessionFromReq(req) {
  const cookie = req.headers.cookie || '';
  const match = cookie.match(/session_id=([^;]+)/);
  if (match) return sessions.get(match[1]);
  return null;
}

function createSession(res) {
  const sessionId = crypto.randomBytes(32).toString('hex');
  const session = { id: sessionId, created: Date.now() };
  sessions.set(sessionId, session);
  res.setHeader('Set-Cookie', `session_id=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`);
  return session;
}

// ===== OAuth Token Exchange =====
async function exchangeCodeForTokens(code) {
  const postData = querystring.stringify({
    code,
    client_id: GBP_CLIENT_ID,
    client_secret: GBP_CLIENT_SECRET,
    redirect_uri: GBP_REDIRECT_URI,
    grant_type: 'authorization_code'
  });
  const result = await httpsRequest({
    hostname: 'oauth2.googleapis.com',
    path: '/token',
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(postData)
    }
  }, postData);
  return result;
}

// ===== GBP data fetcher =====
async function fetchGBPDashboardData(accessToken) {
  const cors = { 'Content-Type': 'application/json; charset=utf-8' };

  // Step 1: List accounts
  const accountsRes = await gbpFetch('https://mybusinessaccountmanagement.googleapis.com/v1/accounts', accessToken);
  if (!accountsRes.accounts || accountsRes.accounts.length === 0) {
    return { error: 'No business accounts found' };
  }
  const account = accountsRes.accounts[0];
  const accountId = account.name; // "accounts/123456"

  // Step 2: List locations
  const locationsRes = await gbpFetch(
    `https://mybusinessbusinessinformation.googleapis.com/v1/${accountId}/locations?readMask=name,title,storefrontAddress,websiteUri,phoneNumbers,regularHours,metadata`, accessToken
  );
  if (!locationsRes.locations || locationsRes.locations.length === 0) {
    return { error: 'No locations found for this account' };
  }
  const location = locationsRes.locations[0];
  const locationId = location.name; // "locations/abc123"

  // Step 3: Fetch performance metrics (last 28 days)
  const endDate = new Date();
  endDate.setDate(endDate.getDate() - 3); // data has 3-day delay
  const startDate = new Date(endDate);
  startDate.setDate(startDate.getDate() - 28);

  const metricsToFetch = [
    'BUSINESS_IMPRESSIONS_DESKTOP_MAPS',
    'BUSINESS_IMPRESSIONS_MOBILE_MAPS',
    'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH',
    'BUSINESS_IMPRESSIONS_MOBILE_SEARCH',
    'BUSINESS_DIRECTION_REQUESTS',
    'CALL_CLICKS',
    'WEBSITE_CLICKS'
  ];
  const metricsParams = metricsToFetch.map(m => `dailyMetrics=${m}`).join('&');
  const perfUrl = `https://businessprofileperformance.googleapis.com/v1/${locationId}:fetchMultiDailyMetricsTimeSeries?${metricsParams}&dailyRange.startDate.year=${startDate.getFullYear()}&dailyRange.startDate.month=${startDate.getMonth()+1}&dailyRange.startDate.day=${startDate.getDate()}&dailyRange.endDate.year=${endDate.getFullYear()}&dailyRange.endDate.month=${endDate.getMonth()+1}&dailyRange.endDate.day=${endDate.getDate()}`;

  let perfData = {};
  try {
    perfData = await gbpFetch(perfUrl, accessToken);
  } catch(e) { perfData = { error: e.message }; }

  // Step 4: Fetch search keywords
  let keywordsData = {};
  try {
    keywordsData = await gbpFetch(
      `https://businessprofileperformance.googleapis.com/v1/${locationId}/searchkeywords/impressions/monthly`, accessToken
    );
  } catch(e) { keywordsData = { error: e.message }; }

  // Step 5: Fetch reviews (legacy endpoint - may need adjustment)
  let reviewsData = {};
  try {
    reviewsData = await gbpFetch(
      `https://mybusiness.googleapis.com/v4/${accountId}/${locationId}/reviews?pageSize=10`, accessToken
    );
  } catch(e) { reviewsData = { error: e.message }; }

  // Process & aggregate metrics
  const processed = processPerformanceData(perfData, location, keywordsData, reviewsData);
  return processed;
}

// ===== Process raw GBP data into dashboard format =====
function processPerformanceData(perfData, location, keywordsData, reviewsData) {
  // Sum daily values for each metric
  function sumMetric(timeSeries, metricName) {
    if (!timeSeries || !timeSeries.multiDailyMetricTimeSeries) return 0;
    const series = timeSeries.multiDailyMetricTimeSeries.find(
      s => s.dailyMetric === metricName
    );
    if (!series || !series.dailySubEntityType || !series.dailySubEntityType.timeSeries) return 0;
    let total = 0;
    for (const ts of series.dailySubEntityType.timeSeries) {
      if (ts.dataPoints) {
        for (const dp of ts.dataPoints) {
          total += parseInt(dp.value || 0);
        }
      }
    }
    return total;
  }

  // Build monthly trend from daily data
  function buildMonthlyTrend(timeSeries) {
    const months = {};
    if (!timeSeries || !timeSeries.multiDailyMetricTimeSeries) return [];
    // Combine all impression metrics
    const impressionMetrics = timeSeries.multiDailyMetricTimeSeries.filter(
      s => s.dailyMetric && s.dailyMetric.startsWith('BUSINESS_IMPRESSIONS')
    );
    for (const series of impressionMetrics) {
      if (!series.dailySubEntityType || !series.dailySubEntityType.timeSeries) continue;
      for (const ts of series.dailySubEntityType.timeSeries) {
        if (ts.dataPoints) {
          for (const dp of ts.dataPoints) {
            const d = dp.date;
            const key = `${d.year}-${String(d.month).padStart(2,'0')}`;
            if (!months[key]) months[key] = 0;
            months[key] += parseInt(dp.value || 0);
          }
        }
      }
    }
    return Object.entries(months).sort().map(([k,v]) => ({ month: k, views: v }));
  }

  const mapsViews = sumMetric(perfData, 'BUSINESS_IMPRESSIONS_DESKTOP_MAPS') +
                    sumMetric(perfData, 'BUSINESS_IMPRESSIONS_MOBILE_MAPS');
  const searchViews = sumMetric(perfData, 'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH') +
                      sumMetric(perfData, 'BUSINESS_IMPRESSIONS_MOBILE_SEARCH');
  const totalViews = mapsViews + searchViews;
  const directionRequests = sumMetric(perfData, 'BUSINESS_DIRECTION_REQUESTS');
  const callClicks = sumMetric(perfData, 'CALL_CLICKS');
  const websiteClicks = sumMetric(perfData, 'WEBSITE_CLICKS');

  // Process search keywords
  let searchQueries = [];
  if (keywordsData && keywordsData.searchKeywordsCounts) {
    searchQueries = keywordsData.searchKeywordsCounts.slice(0, 10).map(kw => ({
      keyword: kw.searchKeyword || '',
      impressions: parseInt(kw.insightsValue?.value || kw.insightsValue || 0),
    }));
    // Normalize to percentage of max
    const maxImp = Math.max(...searchQueries.map(q => q.impressions), 1);
    searchQueries = searchQueries.map(q => ({ ...q, pct: Math.round(q.impressions / maxImp * 100) }));
  }

  // Process reviews
  let reviews = [];
  if (reviewsData && reviewsData.reviews) {
    reviews = reviewsData.reviews.slice(0, 5).map(r => ({
      name: r.reviewer?.displayName || '匿名',
      rating: r.starRating === 'FIVE' ? 5 : r.starRating === 'FOUR' ? 4 : r.starRating === 'THREE' ? 3 : r.starRating === 'TWO' ? 2 : 1,
      text: (r.comment || '').substring(0, 200),
      date: r.updateTime ? new Date(r.updateTime).toLocaleDateString('ja-JP') : '',
    }));
  }

  // Build trend data
  const viewsTrend = buildMonthlyTrend(perfData);

  // Location info
  const addr = location.storefrontAddress;
  const address = addr ? [addr.administrativeArea, addr.locality, addr.addressLines?.join(' ')].filter(Boolean).join(' ') : '';

  return {
    store: {
      name: location.title || '',
      rating: location.metadata?.averageRating || 0,
      reviewCount: location.metadata?.reviewCount || 0,
      address: address,
      phone: location.phoneNumbers?.primaryPhone || '',
      website: location.websiteUri || '',
      hasHours: !!(location.regularHours),
    },
    kpi: {
      views: totalViews,
      viewsDelta: 0, // Would need previous period data for comparison
      searches: searchViews,
      searchesDelta: 0,
      calls: callClicks,
      callsDelta: 0,
      website: websiteClicks,
      websiteDelta: 0,
      directions: directionRequests,
    },
    viewsTrend,
    searchQueries,
    reviews,
    _real: true,
  };
}

const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST', 'Access-Control-Allow-Headers': 'Content-Type' });
    res.end();
    return;
  }

  // ===== OAuth: Start Google login =====
  if (parsedUrl.pathname === '/auth/google') {
    if (!GBP_CLIENT_ID) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'GBP_CLIENT_ID not configured. Set environment variables GBP_CLIENT_ID and GBP_CLIENT_SECRET.' }));
      return;
    }
    const state = crypto.randomBytes(16).toString('hex');
    const session = createSession(res);
    session.oauthState = state;
    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
      `client_id=${encodeURIComponent(GBP_CLIENT_ID)}` +
      `&redirect_uri=${encodeURIComponent(GBP_REDIRECT_URI)}` +
      `&response_type=code` +
      `&scope=${encodeURIComponent(GBP_SCOPE)}` +
      `&access_type=offline` +
      `&prompt=consent` +
      `&state=${state}`;
    res.writeHead(302, { 'Location': authUrl });
    res.end();
    return;
  }

  // ===== OAuth: Callback =====
  if (parsedUrl.pathname === '/auth/google/callback') {
    const code = parsedUrl.query.code;
    const errorParam = parsedUrl.query.error;
    if (errorParam || !code) {
      res.writeHead(302, { 'Location': '/?auth=error&reason=' + (errorParam || 'no_code') });
      res.end();
      return;
    }
    (async () => {
      try {
        const tokens = await exchangeCodeForTokens(code);
        if (tokens.error) {
          res.writeHead(302, { 'Location': '/?auth=error&reason=' + tokens.error });
          return res.end();
        }
        let session = getSessionFromReq(req);
        if (!session) session = createSession(res);
        session.accessToken = tokens.access_token;
        session.refreshToken = tokens.refresh_token;
        session.tokenExpiry = Date.now() + (tokens.expires_in * 1000);
        res.writeHead(302, { 'Location': '/?auth=success' });
        res.end();
      } catch (err) {
        res.writeHead(302, { 'Location': '/?auth=error&reason=' + encodeURIComponent(err.message) });
        res.end();
      }
    })();
    return;
  }

  // ===== API: Check auth status =====
  if (parsedUrl.pathname === '/api/auth/status') {
    const session = getSessionFromReq(req);
    const cors = { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' };
    const isAuthed = session && session.accessToken && session.tokenExpiry > Date.now();
    res.writeHead(200, cors);
    res.end(JSON.stringify({ authenticated: !!isAuthed, hasGbpConfig: !!GBP_CLIENT_ID }));
    return;
  }

  // ===== API: Fetch GBP dashboard data =====
  if (parsedUrl.pathname === '/api/gbp/dashboard') {
    const cors = { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' };
    const session = getSessionFromReq(req);
    if (!session || !session.accessToken) {
      res.writeHead(401, cors);
      res.end(JSON.stringify({ error: 'Not authenticated. Please connect your Google account.' }));
      return;
    }
    (async () => {
      try {
        const data = await fetchGBPDashboardData(session.accessToken);
        if (data.error) {
          res.writeHead(200, cors);
          res.end(JSON.stringify({ status: 'ERROR', message: data.error }));
        } else {
          res.writeHead(200, cors);
          res.end(JSON.stringify({ status: 'OK', data }));
        }
      } catch (err) {
        res.writeHead(500, cors);
        res.end(JSON.stringify({ status: 'ERROR', message: err.message }));
      }
    })();
    return;
  }

  // ===== API: Logout =====
  if (parsedUrl.pathname === '/api/auth/logout') {
    const session = getSessionFromReq(req);
    if (session) sessions.delete(session.id);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Set-Cookie': 'session_id=; Path=/; Max-Age=0' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // API endpoint: Places API
  if (parsedUrl.pathname === '/api/place') {
    const query = parsedUrl.query.q || parsedUrl.query.url || '';
    handlePlaceSearch(query, res);
    return;
  }

  // Static files
  let filePath = path.join(__dirname, parsedUrl.pathname === '/' ? 'index.html' : parsedUrl.pathname);
  const ext = path.extname(filePath);
  const contentType = MIME[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      fs.readFile(path.join(__dirname, 'index.html'), (err2, data2) => {
        if (err2) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(data2);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  if (!API_KEY) {
    console.log('⚠ Google Places API key not set. Running in demo mode.');
    console.log('  Set API_KEY in server.js or env var GOOGLE_PLACES_API_KEY');
  }
});
