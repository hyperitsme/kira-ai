import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import fetch from 'node-fetch';

const app = express();
const PORT = process.env.PORT || 10000;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

// --- CORS whitelist
const allow = (process.env.ALLOW_ORIGIN || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // curl/postman
    if (allow.length === 0 || allow.includes(origin)) return cb(null, true);
    return cb(new Error('CORS blocked: ' + origin));
  }
}));

app.use(helmet());
app.use(express.json({ limit: '1mb' }));
app.use(morgan('tiny'));

// ---- helpers ----
async function getUsdPrice(symbol) {
  try {
    const map = { BTC: 'BTCUSDT', ETH: 'ETHUSDT', SOL: 'SOLUSDT' };
    const pair = map[symbol] || `${symbol.toUpperCase()}USDT`;
    const r = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${pair}`);
    if (!r.ok) return null;
    const j = await r.json();
    return Number(j.price) || null;
  } catch {
    return null;
  }
}

// Health
app.get('/health', (_, res) => res.json({ ok: true }));

// ===== TradeGPT: Ask (price-aware) =====
app.post('/api/tradegpt/ask', async (req, res) => {
  try {
    const { prompt, model = OPENAI_MODEL } = req.body || {};
    if (!prompt) return res.status(400).json({ error: 'Missing prompt' });

    // detect tickers and fetch live prices
    const tickers = ['BTC', 'ETH', 'SOL', 'BNB', 'AVAX', 'ARB', 'OP', 'SUI', 'TON', 'DOGE'];
    const found = tickers.filter(s => new RegExp(`\\b${s}\\b`, 'i').test(prompt));
    const prices = {};
    for (const s of found.slice(0, 3)) prices[s] = await getUsdPrice(s); // simple cap

    const priceLine = Object.keys(prices).length
      ? `Approx live prices (USDT): ${Object.entries(prices).map(([k,v]) => `${k} ~ ${v?.toFixed(2) ?? 'n/a'}`).join(', ')}.`
      : '';

    const system = [
      'You are TradeGPT, a concise trading mentor for crypto.',
      'Answer in this structure: Definition → Price context → Confirmation → Risk → Disclaimer.',
      'When quoting price levels, ONLY use levels given by user or live context injected here; otherwise speak in relative terms (recent swing high/low, % move, EMA retest, OB zone).',
      'Do not invent dollar amounts.',
      'Prefer BTC/ETH/SOL examples when relevant.',
      priceLine
    ].join(' ');

    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: prompt }
        ]
      })
    });

    if (!r.ok) return res.status(502).json({ error: 'OpenAI error', detail: await r.text() });
    const data = await r.json();
    const reply = data.choices?.[0]?.message?.content || '';
    const tokens = data.usage?.total_tokens ?? null;
    return res.json({ reply, tokens, cost: null, live: prices });
  } catch (e) {
    return res.status(500).json({ error: 'Server error', detail: String(e) });
  }
});

// ===== Daily Adaptive Quiz =====
app.get('/api/tradegpt/quiz', async (req, res) => {
  try {
    const elo = Number(req.query.elo || 1200);
    if ((process.env.QUIZ_MODE || 'static') === 'llm') {
      const prompt = `Create a concise trading quiz JSON tuned for ELO ${elo}.
Fields: {type:'mcq'|'image_mcq', img?, q, opts:[A,B,C], a(0-2)}. Keep it short.`;
      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: OPENAI_MODEL,
          temperature: 0.3,
          messages: [{ role: 'user', content: prompt }]
        })
      });
      if (r.ok) {
        const data = await r.json();
        const txt = data.choices?.[0]?.message?.content || '{}';
        try { return res.json(JSON.parse(txt)); } catch {}
      }
    }
    const bank = [
      { type:'image_mcq', img:'https://i.imgur.com/0Z9z9zG.png', q:'Which candle shows a bullish engulfing?', opts:['A','B','C'], a:1 },
      { type:'mcq', q:'A valid 1H order block is usually confirmed after…', opts:['a gap down','mitigation + retest + BOS','RSI > 60'], a:1 },
      { type:'mcq', q:'Bullish RSI divergence means…', opts:['Price LL, RSI HL','Price HL, RSI LL','Price HH, RSI HH'], a:0 }
    ];
    const item = bank[Math.floor(Math.random() * bank.length)];
    return res.json(item);
  } catch (e) {
    return res.status(500).json({ error: 'Server error', detail: String(e) });
  }
});

app.listen(PORT, () => console.log('TradeGPT API listening on', PORT));
