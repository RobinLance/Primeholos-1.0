
function imageHashScore(left, right) {
  if (!left || !right || left.length !== right.length) return 0;
  let differences = 0;
  for (let index = 0; index < left.length; index++) if (left[index] !== right[index]) differences++;
  return Math.round((1 - differences / left.length) * 100);
}
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const port = Number(process.env.PORT || 8000);
const clientId = process.env.TCGPLAYER_PUBLIC_KEY;
const clientSecret = process.env.TCGPLAYER_PRIVATE_KEY;
const googleVisionApiKey = process.env.GOOGLE_VISION_API_KEY;
const ximilarApiToken = process.env.XIMILAR_API_TOKEN;
const ximilarApiBase = 'https://api.ximilar.com/account';
let token = null;
let tokenExpiresAt = 0;
let usdPhpRate = null;
let usdPhpRateExpiresAt = 0;

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
  return true;
}

function normalizeName(value) {
  return String(value || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');
}

function matchScore(query, candidate) {
  const left = normalizeName(query);
  const right = normalizeName(candidate);
  if (!left || !right) return 0;
  if (left === right) return 100;
  if (right.startsWith(left) || left.startsWith(right)) return 92;
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row++) {
    let diagonal = previous[0];
    previous[0] = row;
    for (let column = 1; column <= right.length; column++) {
      const above = previous[column];
      previous[column] = left[row - 1] === right[column - 1]
        ? diagonal
        : Math.min(diagonal, previous[column - 1], above) + 1;
      diagonal = above;
    }
  }
  return Math.round((1 - previous[right.length] / Math.max(left.length, right.length)) * 100);
}

function findChaseCards(query, game) {
  const chaseCards = chaseCardsForLookup();
  return chaseCards.map(card => {
    const names = [card.name, ...(card.aliases || [])];
    return { card, score: Math.max(...names.map(name => matchScore(query, name))) };
  }).filter(result => (!game || result.card.game === game) && result.score >= 70)
    .sort((left, right) => right.score - left.score)
    .slice(0, 10)
    .map(result => ({ ...result.card, score: result.score }));
}

function chaseCardsForLookup() {
  try { return JSON.parse(fs.readFileSync(path.join(process.cwd(), 'chase-cards.json'), 'utf8')); }
  catch { return []; }
}

function readRequestBody(req, maxBytes = 100000) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > maxBytes) reject(new Error('Request is too large.')); });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

async function getTcgplayerToken() {
  if (token && Date.now() < tokenExpiresAt) return token;
  if (!clientId || !clientSecret) throw new Error('Set TCGPLAYER_PUBLIC_KEY and TCGPLAYER_PRIVATE_KEY before using TCGplayer.');
  const credentials = Buffer.from(clientId + ':' + clientSecret).toString('base64');
  const response = await fetch('https://api.tcgplayer.com/token', {
    method: 'POST',
    headers: {
      accept: 'application/json',
      authorization: 'Basic ' + credentials,
      'content-type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });
  if (!response.ok) throw new Error('TCGplayer authorization returned ' + response.status);
  const data = await response.json();
  token = data.access_token;
  tokenExpiresAt = Date.now() + Math.max(60, Number(data.expires_in || 3600) - 60) * 1000;
  return token;
}

async function tcgplayerSearch(query, categoryId) {
  const accessToken = await getTcgplayerToken();
  const searchUrl = new URL('https://api.tcgplayer.com/catalog/products');
  searchUrl.searchParams.set('categoryId', categoryId);
  searchUrl.searchParams.set('productName', query);
  searchUrl.searchParams.set('limit', '12');
  const productsResponse = await fetch(searchUrl, { headers: { accept: 'application/json', authorization: 'bearer ' + accessToken } });
  if (!productsResponse.ok) throw new Error('TCGplayer catalog returned ' + productsResponse.status);
  const products = (await productsResponse.json()).results || [];
  if (!products.length) return [];
  const ids = products.map(product => product.productId).join(',');
  const pricesResponse = await fetch('https://api.tcgplayer.com/pricing/product/' + ids, { headers: { accept: 'application/json', authorization: 'bearer ' + accessToken } });
  const prices = pricesResponse.ok ? ((await pricesResponse.json()).results || []) : [];
  const priceByProduct = new Map(prices.map(price => [price.productId, price]));
  return products.map(product => ({
    id: String(product.productId),
    name: product.name,
    setName: product.groupName || '',
    image: product.imageUrl || '',
    price: priceByProduct.get(product.productId)?.marketPrice ?? priceByProduct.get(product.productId)?.midPrice ?? null
  }));
}

async function getUsdPhpRate() {
  if (usdPhpRate && Date.now() < usdPhpRateExpiresAt) return usdPhpRate;
  const response = await fetch('https://open.er-api.com/v6/latest/USD');
  if (!response.ok) throw new Error('Exchange-rate service returned ' + response.status);
  const data = await response.json();
  const rate = Number(data.rates?.PHP);
  if (!Number.isFinite(rate) || rate <= 0) throw new Error('USD/PHP exchange rate is unavailable.');
  usdPhpRate = rate;
  usdPhpRateExpiresAt = Date.now() + 6 * 60 * 60 * 1000;
  return rate;
}

async function submitXimilarGrade(image) {
  if (!ximilarApiToken) throw new Error('Set XIMILAR_API_TOKEN before using card grading.');
  const response = await fetch(ximilarApiBase + '/v2/request/', {
    method: 'POST',
    headers: { authorization: 'Token ' + ximilarApiToken, 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'card-grader',
      endpoint: 'grade',
      records: [{ _base64: image.replace(/^data:[^;]+;base64,/, '') }]
    })
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!response.ok) throw new Error('Ximilar grading submission returned ' + response.status + (text ? ': ' + text.slice(0, 300) : '.'));
  if (!data) throw new Error('Ximilar returned an empty grading result.');
  return data;
}

async function getXimilarGrade(id) {
  if (!ximilarApiToken) throw new Error('Set XIMILAR_API_TOKEN before using card grading.');
  const response = await fetch(ximilarApiBase + '/v2/request/' + encodeURIComponent(id), {
    headers: { authorization: 'Token ' + ximilarApiToken }
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!response.ok) throw new Error('Ximilar grading status returned ' + response.status + (text ? ': ' + text.slice(0, 300) : '.'));
  if (!data) throw new Error('Ximilar returned an empty grading status.');
  return data;
}

async function googleVisionOcr(imageBase64) {
  if (!googleVisionApiKey) throw new Error('Set GOOGLE_VISION_API_KEY environment variable.');
  const url = new URL('https://vision.googleapis.com/v1/images:annotate');
  url.searchParams.set('key', googleVisionApiKey);
  const requestBody = {
    requests: [
      {
        image: { content: imageBase64 },
        features: [
          { type: 'TEXT_DETECTION', maxResults: 5 },
          { type: 'DOCUMENT_TEXT_DETECTION', maxResults: 5 }
        ]
      }
    ]
  };
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(requestBody)
  });
  if (!response.ok) {
    const errData = await response.text();
    throw new Error('Google Vision returned ' + response.status + ': ' + errData);
  }
  const result = await response.json();
  const textAnnotation = result.responses?.[0]?.textAnnotation;
  if (!textAnnotation) return { text: '', blocks: [] };
  
  // Extract text and blocks with bounding boxes
  const fullText = textAnnotation.text || '';
  const blocks = textAnnotation.pages?.[0]?.blocks || [];
  
  // Process each block to find text segments with bounding boxes
  const textBlocks = [];
  for (const block of blocks) {
    const blockText = block.text || '';
    const vertices = block.boundingBox?.vertices || [];
    if (blockText.length >= 3 && vertices.length >= 4) {
      // Calculate center and dimensions
      const xs = vertices.map(v => v.x);
      const ys = vertices.map(v => v.y);
      const centerX = (xs.reduce((a, b) => a + b, 0) / xs.length);
      const centerY = (ys.reduce((a, b) => a + b, 0) / ys.length);
      const width = Math.max(...xs) - Math.min(...xs);
      const height = Math.max(...ys) - Math.min(...ys);
      const area = width * height;
      
      // Filter: card-like sizes (aspect ratio ~2:3, area thresholds)
      // TCG cards are approximately 63.5mm x 88.9mm = ratio ~0.71
      const aspectRatio = width / height;
      const isCardLike = aspectRatio > 0.5 && aspectRatio < 1.5 && area > 500 && area < 50000;
      
      textBlocks.push({
        text: blockText,
        centerX,
        centerY,
        width,
        height,
        area,
        aspectRatio,
        isCardLike
      });
    }
  }
  
  // Sort by area (largest first) and pick the most likely card region
  textBlocks.sort((a, b) => b.area - a.area);
  
  // Find the best card-like block, or fall back to largest text block
  let bestBlock = textBlocks.find(b => b.isCardLike);
  if (!bestBlock && textBlocks.length > 0) {
    bestBlock = textBlocks[0];
  }
  
  return {
    text: fullText,
    bestBlock,
    allBlocks: textBlocks,
    cardRegion: bestBlock ? {
      x: bestBlock.centerX - bestBlock.width / 2,
      y: bestBlock.centerY - bestBlock.height / 2,
      width: bestBlock.width,
      height: bestBlock.height
    } : null
  };
}

function base64ToImage(base64) {
  const decoded = Buffer.from(base64, 'base64');
  return decoded;
}

async function ocrCroppedImage(imageBase64, cropX, cropY, cropW, cropH) {
  try {
    const decoded = base64ToImage(imageBase64);
    const image = await Jimp.read(decoded);
    // Crop to the card region
    const cropped = image.crop(cropX, cropY, cropW, cropH);
    // Resize for better OCR, convert to grayscale, add contrast
    const resized = cropped.resize(1200, Jimp.AUTO);
    // Invert if needed and threshold
    const gray = resized.greyscale();
    const thresholded = gray.threshold(128);
    // Run Tesseract (we need to check if tesseract is available, but for now return empty)
    // In a full implementation, would call tesseract.js on the buffer
    // For now return the base64 of the processed image
    return thresholded.base64;
  } catch (e) {
    console.log('Cropped OCR error:', e.message);
    return '';
  }
}

async function handleApi(req, res, url) {
  if (url.pathname === '/api/chase-cards') {
    if (req.method === 'POST') {
      try {
        const card = JSON.parse(await readRequestBody(req));
        if (!card.name || !card.game) return sendJson(res, 400, { error: 'game and name are required' });
        const databasePath = path.join(process.cwd(), 'chase-cards.json');
        const cards = JSON.parse(fs.readFileSync(databasePath, 'utf8'));
        const duplicate = cards.some(existing => existing.game === card.game && normalizeName(existing.name) === normalizeName(card.name));
        if (duplicate) return sendJson(res, 409, { error: 'That card is already in the chase database.' });
        const savedCard = {
          game: String(card.game), name: String(card.name).trim(),
          aliases: Array.isArray(card.aliases) ? card.aliases.map(String).map(value => value.trim()).filter(Boolean) : [],
          set: String(card.set || '').trim(), number: String(card.number || '').trim(),
          image: String(card.image || '').trim(), imageHash: String(card.imageHash || '').trim(),
          priceUsd: Number.isFinite(Number(card.priceUsd)) && Number(card.priceUsd) > 0 ? Number(card.priceUsd) : null,
          pricePhp: Number.isFinite(Number(card.pricePhp)) && Number(card.pricePhp) > 0 ? Number(card.pricePhp) : null
        };
        cards.push(savedCard);
        fs.writeFileSync(databasePath, JSON.stringify(cards, null, 2) + '\n');
        return sendJson(res, 201, { data: savedCard });
      } catch (error) { return sendJson(res, 400, { error: 'Invalid chase card: ' + error.message }); }
    }
    if (req.method === 'GET' && url.searchParams.has('search')) {
      const search = normalizeName(url.searchParams.get('search'));
      const cards = chaseCardsForLookup().map((card, index) => ({ ...card, id: index }))
        .filter(card => !search || [card.name, card.set, ...(card.aliases || [])].some(value => normalizeName(value).includes(search)));
      return sendJson(res, 200, { data: cards });
    }
    const query = url.searchParams.get('q');
    const game = url.searchParams.get('game');
    const imageHash = url.searchParams.get('imageHash');
    const nameMatches = findChaseCards(query, game);
    const imageMatches = imageHash && chaseCardsForLookup().map(card => ({ ...card, score: imageHashScore(imageHash, card.imageHash), imageMatch: true }))
      .filter(card => card.game === game && card.imageHash && card.score >= 82).sort((left, right) => right.score - left.score).slice(0, 10);
    const merged = new Map([...nameMatches, ...imageMatches].map(card => [card.game + '|' + card.name, card]));
    return sendJson(res, 200, { data: Array.from(merged.values()).sort((left, right) => right.score - left.score) });
  }
  if (url.pathname.startsWith('/api/chase-cards/') && req.method === 'PUT') {
    try {
      const id = Number(url.pathname.split('/').pop());
      const databasePath = path.join(process.cwd(), 'chase-cards.json');
      const cards = JSON.parse(fs.readFileSync(databasePath, 'utf8'));
      const existing = cards[id];
      if (!existing) return sendJson(res, 404, { error: 'Chase card was not found.' });
      const card = JSON.parse(await readRequestBody(req));
      if (!card.name || !card.game) return sendJson(res, 400, { error: 'game and name are required' });
      const duplicate = cards.some((other, index) => index !== id && other.game === card.game && normalizeName(other.name) === normalizeName(card.name));
      if (duplicate) return sendJson(res, 409, { error: 'That card is already in the chase database.' });
      cards[id] = {
        game: String(card.game), name: String(card.name).trim(),
        aliases: Array.isArray(card.aliases) ? card.aliases.map(String).map(value => value.trim()).filter(Boolean) : [],
        set: String(card.set || '').trim(), number: String(card.number || '').trim(),
        image: String(card.image || '').trim(), imageHash: String(card.imageHash || '').trim(),
        priceUsd: Number.isFinite(Number(card.priceUsd)) && Number(card.priceUsd) > 0 ? Number(card.priceUsd) : null,
        pricePhp: Number.isFinite(Number(card.pricePhp)) && Number(card.pricePhp) > 0 ? Number(card.pricePhp) : null
      };
      fs.writeFileSync(databasePath, JSON.stringify(cards, null, 2) + '\n');
      return sendJson(res, 200, { data: { ...cards[id], id } });
    } catch (error) { return sendJson(res, 400, { error: 'Invalid chase card: ' + error.message }); }
  }
  if (url.pathname === '/api/exchange/usd-php') {
    try { return sendJson(res, 200, { base: 'USD', target: 'PHP', rate: await getUsdPhpRate() }); }
    catch (error) { return sendJson(res, 502, { error: error.message }); }
  }
  if (url.pathname === '/api/card-grade' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readRequestBody(req, 15 * 1024 * 1024));
      if (typeof body.image !== 'string' || !body.image.startsWith('data:image/')) {
        return sendJson(res, 400, { error: 'A captured or uploaded image is required.' });
      }
      return sendJson(res, 202, await submitXimilarGrade(body.image));
    } catch (error) {
      return sendJson(res, 502, { error: error.message });
    }
  }
  if (url.pathname.startsWith('/api/card-grade/') && req.method === 'GET') {
    try {
      const id = url.pathname.slice('/api/card-grade/'.length);
      if (!id) return sendJson(res, 400, { error: 'A grading request id is required.' });
      return sendJson(res, 200, await getXimilarGrade(id));
    } catch (error) {
      return sendJson(res, 502, { error: error.message });
    }
  }
  if (url.pathname !== '/api/tcgplayer/search') return false;
  const query = url.searchParams.get('q')?.trim();
  const categoryId = url.searchParams.get('categoryId')?.trim();
  if (!query || !categoryId) return sendJson(res, 400, { error: 'q and categoryId are required' });
  try {
    return sendJson(res, 200, { data: await tcgplayerSearch(query, categoryId) });
  } catch (error) {
    return sendJson(res, 502, { error: error.message });
  }
  if (url.pathname === '/api/ocr') {
    try {
      let body = '';
      req.on('data', chunk => { body += chunk; if (body.length > 100000) throw new Error('Request too large.'); });
      req.on('end', async () => {
        try {
          const result = await googleVisionOcr(body);
          // Return the card region and full text for frontend to crop/OCR
          const output = {
            text: result.text,
            bestBlock: result.bestBlock,
            cardRegion: result.cardRegion,
            allBlocks: result.allBlocks
          };
          sendJson(res, 200, { data: output });
        } catch (error) {
          sendJson(res, 502, { error: error.message });
        }
      });
      req.on('error', (e) => { sendJson(res, 400, { error: 'Request error: ' + e.message }); });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return true;
  }
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (await handleApi(req, res, url)) return;
  let requested;
  if (url.pathname === '/') {
    const files = fs.readdirSync(process.cwd());
    const indexFile = files.find(f => /^index.*\.html$/i.test(f))
      || files.find(f => /^prime\s+holos/i.test(f) && f.endsWith('.html'))
      || files.find(f => f.endsWith('.html') && f !== 'server.js');
    requested = indexFile ? '/' + indexFile : '/';
  } else {
    requested = decodeURIComponent(url.pathname);
  }
  const filePath = path.join(process.cwd(), requested);
  if (!filePath.startsWith(process.cwd()) || !fs.existsSync(filePath)) {
    res.writeHead(404); res.end('Not found'); return;
  }
  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml'
  };
  const contentType = mimeTypes[ext] || 'application/octet-stream';
  res.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-cache' });
  fs.createReadStream(filePath).pipe(res);
}).listen(port, () => console.log('Slabcheck running at http://localhost:' + port));
