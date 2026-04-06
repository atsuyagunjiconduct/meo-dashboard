const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const crypto = require('crypto');
const querystring = require('querystring');

const PORT = process.env.PORT || 3000;

// Google Business Profile OAuth settings
const GBP_CLIENT_ID = process.env.GBP_CLIENT_ID || '';
const GBP_CLIENT_SECRET = process.env.GBP_CLIENT_SECRET || '';
const GBP_REDIRECT_URI = process.env.GBP_REDIRECT_URI || `http://localhost:${PORT}/auth/google/callback`;
const GBP_SCOPE = 'https://www.googleapis.com/auth/business.manage';

// Simple in-memory session store
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

// ===== HTTPS fetch helpers =====
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

// ===== Cookie / Session helpers =====
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
  return await httpsRequest({
    hostname: 'oauth2.googleapis.com',
    path: '/token',
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(postData)
    }
  }, postData);
}

// ===== Token Refresh =====
async function refreshAccessToken(session) {
  if (!session.refreshToken) return false;
  const postData = querystring.stringify({
    refresh_token: session.refreshToken,
    client_id: GBP_CLIENT_ID,
    client_secret: GBP_CLIENT_SECRET,
    grant_type: 'refresh_token'
  });
  try {
    const result = await httpsRequest({
      hostname: 'oauth2.googleapis.com',
      path: '/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData)
      }
    }, postData);
    if (result.access_token) {
      session.accessToken = result.access_token;
      session.tokenExpiry = Date.now() + (result.expires_in * 1000);
      return true;
    }
    return false;
  } catch (e) {
    console.error('[Token Refresh] Error:', e.message);
    return false;
  }
}

// Ensure valid token, refresh if needed
async function ensureValidToken(session) {
  if (!session || !session.accessToken) return false;
  if (session.tokenExpiry && session.tokenExpiry > Date.now() + 60000) return true;
  // Token expired or about to expire, try refresh
  return await refreshAccessToken(session);
}

// ===== List all locations for the authenticated user =====
async function fetchLocations(accessToken) {
  // Step 1: List accounts
  const accountsRes = await gbpFetch('https://mybusinessaccountmanagement.googleapis.com/v1/accounts', accessToken);
  if (accountsRes.error) {
    return { error: accountsRes.error.message || 'Failed to fetch accounts' };
  }
  if (!accountsRes.accounts || accountsRes.accounts.length === 0) {
    return { error: 'このGoogleアカウントにはビジネスプロフィールが見つかりません。ビジネスオーナーの管理者権限があるアカウントでログインしてください。' };
  }

  const allLocations = [];
  for (const account of accountsRes.accounts) {
    try {
      const locationsRes = await gbpFetch(
        `https://mybusinessbusinessinformation.googleapis.com/v1/${account.name}/locations?readMask=name,title,storefrontAddress,websiteUri,phoneNumbers,regularHours,metadata`,
        accessToken
      );
      if (locationsRes.locations) {
        for (const loc of locationsRes.locations) {
          const addr = loc.storefrontAddress;
          const address = addr ? [addr.administrativeArea, addr.locality, addr.addressLines?.join(' ')].filter(Boolean).join(' ') : '';
          allLocations.push({
            name: loc.name,           // "locations/abc123"
            accountName: account.name, // "accounts/123"
            title: loc.title || '',
            address: address,
            phone: loc.phoneNumbers?.primaryPhone || '',
            website: loc.websiteUri || '',
            rating: loc.metadata?.averageRating || 0,
            reviewCount: loc.metadata?.reviewCount || 0,
          });
        }
      }
    } catch (e) {
      console.error(`[Locations] Error fetching for ${account.name}:`, e.message);
    }
  }

  if (allLocations.length === 0) {
    return { error: 'ビジネスプロフィールに登録された店舗が見つかりません。Googleビジネスプロフィールに店舗を登録してからお試しください。' };
  }

  return { locations: allLocations };
}

// ===== Fetch dashboard data for a specific location =====
async function fetchGBPDashboardData(accessToken, accountName, locationName) {
  // Step 1: Get location details
  const locationRes = await gbpFetch(
    `https://mybusinessbusinessinformation.googleapis.com/v1/${locationName}?readMask=name,title,storefrontAddress,websiteUri,phoneNumbers,regularHours,metadata,profile`,
    accessToken
  );
  if (locationRes.error) {
    return { error: locationRes.error.message || 'Failed to fetch location details' };
  }

  // Step 2: Fetch performance metrics (current 28 days)
  const endDate = new Date();
  endDate.setDate(endDate.getDate() - 3); // data has 3-day delay
  const startDate = new Date(endDate);
  startDate.setDate(startDate.getDate() - 28);

  // Previous 28 days for comparison
  const prevEndDate = new Date(startDate);
  prevEndDate.setDate(prevEndDate.getDate() - 1);
  const prevStartDate = new Date(prevEndDate);
  prevStartDate.setDate(prevStartDate.getDate() - 28);

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

  function buildPerfUrl(sDate, eDate) {
    return `https://businessprofileperformance.googleapis.com/v1/${locationName}:fetchMultiDailyMetricsTimeSeries?${metricsParams}&dailyRange.startDate.year=${sDate.getFullYear()}&dailyRange.startDate.month=${sDate.getMonth()+1}&dailyRange.startDate.day=${sDate.getDate()}&dailyRange.endDate.year=${eDate.getFullYear()}&dailyRange.endDate.month=${eDate.getMonth()+1}&dailyRange.endDate.day=${eDate.getDate()}`;
  }

  let perfData = {}, prevPerfData = {};
  try {
    perfData = await gbpFetch(buildPerfUrl(startDate, endDate), accessToken);
  } catch(e) { console.error('[Perf] Current period error:', e.message); }
  try {
    prevPerfData = await gbpFetch(buildPerfUrl(prevStartDate, prevEndDate), accessToken);
  } catch(e) { console.error('[Perf] Previous period error:', e.message); }

  // Step 3: Fetch search keywords
  let keywordsData = {};
  try {
    keywordsData = await gbpFetch(
      `https://businessprofileperformance.googleapis.com/v1/${locationName}/searchkeywords/impressions/monthly`,
      accessToken
    );
  } catch(e) { console.error('[Keywords] Error:', e.message); }

  // Step 4: Fetch reviews
  let reviewsData = {};
  try {
    reviewsData = await gbpFetch(
      `https://mybusiness.googleapis.com/v4/${accountName}/${locationName}/reviews?pageSize=50&orderBy=updateTime%20desc`,
      accessToken
    );
  } catch(e) { console.error('[Reviews] Error:', e.message); }

  // Process all data
  const processed = processPerformanceData(perfData, prevPerfData, locationRes, keywordsData, reviewsData);
  return processed;
}

// ===== Process raw GBP data into dashboard format =====
function processPerformanceData(perfData, prevPerfData, location, keywordsData, reviewsData) {
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

  function buildMonthlyTrend(timeSeries) {
    const months = {};
    if (!timeSeries || !timeSeries.multiDailyMetricTimeSeries) return [];
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
    return Object.entries(months).sort().map(([k,v]) => {
      const [y,m] = k.split('-');
      return { month: `${parseInt(m)}月`, views: v };
    });
  }

  // Current period
  const mapsViews = sumMetric(perfData, 'BUSINESS_IMPRESSIONS_DESKTOP_MAPS') +
                    sumMetric(perfData, 'BUSINESS_IMPRESSIONS_MOBILE_MAPS');
  const searchViews = sumMetric(perfData, 'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH') +
                      sumMetric(perfData, 'BUSINESS_IMPRESSIONS_MOBILE_SEARCH');
  const totalViews = mapsViews + searchViews;
  const directionRequests = sumMetric(perfData, 'BUSINESS_DIRECTION_REQUESTS');
  const callClicks = sumMetric(perfData, 'CALL_CLICKS');
  const websiteClicks = sumMetric(perfData, 'WEBSITE_CLICKS');

  // Previous period for delta
  const prevMapsViews = sumMetric(prevPerfData, 'BUSINESS_IMPRESSIONS_DESKTOP_MAPS') +
                        sumMetric(prevPerfData, 'BUSINESS_IMPRESSIONS_MOBILE_MAPS');
  const prevSearchViews = sumMetric(prevPerfData, 'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH') +
                          sumMetric(prevPerfData, 'BUSINESS_IMPRESSIONS_MOBILE_SEARCH');
  const prevTotalViews = prevMapsViews + prevSearchViews;
  const prevDirectionRequests = sumMetric(prevPerfData, 'BUSINESS_DIRECTION_REQUESTS');
  const prevCallClicks = sumMetric(prevPerfData, 'CALL_CLICKS');
  const prevWebsiteClicks = sumMetric(prevPerfData, 'WEBSITE_CLICKS');

  // Search keywords
  let searchQueries = [];
  if (keywordsData && keywordsData.searchKeywordsCounts) {
    searchQueries = keywordsData.searchKeywordsCounts.slice(0, 10).map(kw => ({
      keyword: kw.searchKeyword || '',
      impressions: parseInt(kw.insightsValue?.value || kw.insightsValue || 0),
    }));
    const maxImp = Math.max(...searchQueries.map(q => q.impressions), 1);
    searchQueries = searchQueries.map(q => ({ ...q, pct: Math.round(q.impressions / maxImp * 100) }));
  }

  // Reviews
  let reviews = [];
  let reviewDistribution = [0, 0, 0, 0, 0]; // 1-star to 5-star
  if (reviewsData && reviewsData.reviews) {
    reviews = reviewsData.reviews.slice(0, 10).map(r => {
      const starNum = r.starRating === 'FIVE' ? 5 : r.starRating === 'FOUR' ? 4 : r.starRating === 'THREE' ? 3 : r.starRating === 'TWO' ? 2 : 1;
      return {
        name: r.reviewer?.displayName || '匿名',
        rating: starNum,
        text: (r.comment || '').substring(0, 200),
        date: r.updateTime ? new Date(r.updateTime).toLocaleDateString('ja-JP') : '',
      };
    });
    // Build distribution from all reviews
    for (const r of reviewsData.reviews) {
      const starNum = r.starRating === 'FIVE' ? 5 : r.starRating === 'FOUR' ? 4 : r.starRating === 'THREE' ? 3 : r.starRating === 'TWO' ? 2 : 1;
      reviewDistribution[starNum - 1]++;
    }
  }

  // Trend data
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
      photoCount: location.metadata?.photoCount || 0,
      category: location.profile?.description || '',
      status: '営業中',
    },
    kpi: {
      views: totalViews,
      viewsPrev: prevTotalViews,
      directions: directionRequests,
      directionsPrev: prevDirectionRequests,
      calls: callClicks,
      callsPrev: prevCallClicks,
      website: websiteClicks,
      websitePrev: prevWebsiteClicks,
    },
    viewsTrend,
    searchQueries,
    reviews,
    reviewDistribution,
    _real: true,
  };
}

// ===== HTTP SERVER =====
const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const cors = { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' };

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST', 'Access-Control-Allow-Headers': 'Content-Type' });
    res.end();
    return;
  }

  // ===== OAuth: Start Google login =====
  if (parsedUrl.pathname === '/auth/google') {
    if (!GBP_CLIENT_ID) {
      res.writeHead(302, { 'Location': '/?auth=error&reason=not_configured' });
      res.end();
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
        console.error('[OAuth Callback] Error:', err);
        res.writeHead(302, { 'Location': '/?auth=error&reason=' + encodeURIComponent(err.message) });
        res.end();
      }
    })();
    return;
  }

  // ===== API: Check auth status =====
  if (parsedUrl.pathname === '/api/auth/status') {
    (async () => {
      const session = getSessionFromReq(req);
      let isAuthed = false;
      if (session && session.accessToken) {
        isAuthed = await ensureValidToken(session);
      }
      res.writeHead(200, cors);
      res.end(JSON.stringify({ authenticated: isAuthed, hasGbpConfig: !!GBP_CLIENT_ID }));
    })();
    return;
  }

  // ===== API: List locations =====
  if (parsedUrl.pathname === '/api/gbp/locations') {
    (async () => {
      const session = getSessionFromReq(req);
      if (!session || !session.accessToken) {
        res.writeHead(401, cors);
        res.end(JSON.stringify({ error: '認証されていません。Googleアカウントを連携してください。' }));
        return;
      }
      const valid = await ensureValidToken(session);
      if (!valid) {
        res.writeHead(401, cors);
        res.end(JSON.stringify({ error: 'セッションが期限切れです。再度ログインしてください。' }));
        return;
      }
      try {
        const result = await fetchLocations(session.accessToken);
        if (result.error) {
          res.writeHead(200, cors);
          res.end(JSON.stringify({ status: 'ERROR', message: result.error }));
        } else {
          res.writeHead(200, cors);
          res.end(JSON.stringify({ status: 'OK', locations: result.locations }));
        }
      } catch (err) {
        console.error('[Locations API] Error:', err);
        res.writeHead(500, cors);
        res.end(JSON.stringify({ status: 'ERROR', message: err.message }));
      }
    })();
    return;
  }

  // ===== API: Fetch GBP dashboard data =====
  if (parsedUrl.pathname === '/api/gbp/dashboard') {
    (async () => {
      const session = getSessionFromReq(req);
      if (!session || !session.accessToken) {
        res.writeHead(401, cors);
        res.end(JSON.stringify({ error: '認証されていません。Googleアカウントを連携してください。' }));
        return;
      }
      const valid = await ensureValidToken(session);
      if (!valid) {
        res.writeHead(401, cors);
        res.end(JSON.stringify({ error: 'セッションが期限切れです。再度ログインしてください。' }));
        return;
      }
      const accountName = parsedUrl.query.account;
      const locationName = parsedUrl.query.location;
      if (!accountName || !locationName) {
        res.writeHead(400, cors);
        res.end(JSON.stringify({ error: 'account と location パラメータが必要です。' }));
        return;
      }
      try {
        const data = await fetchGBPDashboardData(session.accessToken, accountName, locationName);
        if (data.error) {
          res.writeHead(200, cors);
          res.end(JSON.stringify({ status: 'ERROR', message: data.error }));
        } else {
          res.writeHead(200, cors);
          res.end(JSON.stringify({ status: 'OK', data }));
        }
      } catch (err) {
        console.error('[Dashboard API] Error:', err);
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

  // ===== Privacy Policy =====
  if (parsedUrl.pathname === '/privacy') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>プライバシーポリシー - 店舗集客のミカタ</title><style>body{font-family:-apple-system,sans-serif;max-width:800px;margin:0 auto;padding:2rem;line-height:1.8;color:#333}h1{color:#1a73e8;border-bottom:2px solid #1a73e8;padding-bottom:.5rem}h2{color:#444;margin-top:2rem}a{color:#1a73e8}</style></head><body>
<h1>プライバシーポリシー</h1>
<p>最終更新日: 2026年4月6日</p>
<h2>1. 収集する情報</h2>
<p>本サービス「店舗集客のミカタ」は、Googleビジネスプロフィール（GBP）の管理権限をお持ちの方が、ご自身のビジネスデータを診断・分析するためのツールです。Google OAuth認証を通じて以下の情報にアクセスします：</p>
<ul><li>Googleアカウントの基本情報（メールアドレス、名前）</li><li>Googleビジネスプロフィールのパフォーマンスデータ（閲覧数、検索数、アクション数等）</li><li>ビジネスのクチコミ情報</li></ul>
<h2>2. 情報の利用目的</h2>
<p>取得した情報は、診断レポートの表示のみに使用し、以下の目的以外では使用しません：</p>
<ul><li>ビジネスプロフィールのパフォーマンス診断結果の表示</li><li>改善提案の生成</li></ul>
<h2>3. 情報の保存・共有</h2>
<p>本サービスは取得したデータを永続的に保存しません。セッション中のみ一時的にメモリ上で保持し、セッション終了後に自動的に削除されます。第三者への情報共有・販売は一切行いません。</p>
<h2>4. データの安全性</h2>
<p>すべての通信はHTTPSで暗号化されています。OAuthトークンはサーバーのメモリ上でのみ管理され、データベースやファイルへの永続保存は行いません。</p>
<h2>5. ユーザーの権利</h2>
<p>ユーザーはいつでもGoogleアカウントの設定（<a href="https://myaccount.google.com/permissions" target="_blank">https://myaccount.google.com/permissions</a>）からアプリのアクセス権を取り消すことができます。</p>
<h2>6. お問い合わせ</h2>
<p>プライバシーに関するお問い合わせは、サービス提供者までご連絡ください。</p>
<p><a href="/">← トップページに戻る</a></p>
</body></html>`);
    return;
  }

  // ===== Static files =====
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
  if (!GBP_CLIENT_ID) {
    console.log('');
    console.log('⚠ Googleビジネスプロフィール連携が未設定です。');
    console.log('  以下の環境変数を設定してください:');
    console.log('  - GBP_CLIENT_ID: Google Cloud OAuthクライアントID');
    console.log('  - GBP_CLIENT_SECRET: OAuthクライアントシークレット');
    console.log('  - GBP_REDIRECT_URI: コールバックURL (例: https://your-domain.com/auth/google/callback)');
    console.log('');
    console.log('  デモモードは利用可能です。');
  } else {
    console.log('✓ Googleビジネスプロフィール連携: 設定済み');
    console.log('  Redirect URI:', GBP_REDIRECT_URI);
  }
});
