export interface Env {
  GROQ_API_KEY: string;
  XAI_API_KEY: string;
  ACCESS_TOKEN?: string;
  GOOGLE_CLIENT_ID?: string;
  DB: D1Database;
}

export interface UserIdentity {
  id: string;
  email?: string;
  name?: string;
  picture?: string;
  provider: 'google' | 'token';
}

interface GoogleTokenInfo {
  sub: string;
  email?: string;
  name?: string;
  picture?: string;
  aud?: string;
  exp?: string;
  error?: string;
}

interface UserRow {
  id: string;
  tier: 'free' | 'paid';
}

interface TopicRow {
  occurred_on: string;
  topic: string;
  gist: string | null;
  hit_count: number;
}

interface TopicCacheEntry {
  date: string;
  topic: string;
  gist?: string;
}

/** Per-device cache limits — like a small LRU + TTL cache, not a transcript store */
const CACHE_LIMITS = {
  free: { maxEntries: 25, ttlDays: 30, gistInPrompt: 0 },
  paid: { maxEntries: 300, ttlDays: 365, gistInPrompt: 5 },
} as const;

const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'i', 'me', 'my', 'we', 'our', 'you', 'your', 'it', 'its', 'this', 'that',
  'what', 'how', 'why', 'when', 'where', 'who', 'can', 'could', 'would',
  'should', 'do', 'does', 'did', 'have', 'has', 'had', 'will', 'just',
  'about', 'with', 'for', 'on', 'in', 'to', 'of', 'and', 'or', 'but',
  'please', 'tell', 'help', 'want', 'need', 'like',
]);

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/demo') {
      return publicDemoStream();
    }

    const authHeader = request.headers.get('Authorization') || '';
    const token = authHeader.replace('Bearer ', '');
    const auth = await resolveAuth(token, env);

    if (!auth) {
      return Response.json({ error: 'Unauthorized' }, { status: 401, headers: corsHeaders });
    }

    const { user, tokenExpiresAt } = auth;
    const deviceId = url.searchParams.get('device_id')
      || request.headers.get('X-Device-Id')
      || 'unknown-device';

    if (request.method === 'GET' && url.pathname === '/me') {
      const profile = await buildUserProfile(env.DB, user, deviceId, tokenExpiresAt);
      return Response.json(profile, { headers: corsHeaders });
    }

    if (request.method === 'DELETE' && url.pathname === '/topics') {
      const body = await request.json() as {
        topic?: string;
        date?: string;
        occurredOn?: string;
        clearAll?: boolean;
        deviceId?: string;
      };
      const dev = body.deviceId || deviceId;

      await upsertUser(env.DB, user);

      if (body.clearAll) {
        await env.DB.prepare(
          'DELETE FROM topic_cache WHERE user_id = ? AND device_id = ?',
        ).bind(user.id, dev).run();
      } else if (body.topic && (body.date || body.occurredOn)) {
        const occurredOn = body.date || body.occurredOn!;
        await env.DB.prepare(`
          DELETE FROM topic_cache
          WHERE user_id = ? AND device_id = ? AND topic = ? AND occurred_on = ?
        `).bind(user.id, dev, body.topic, occurredOn).run();
      } else {
        return Response.json({ error: 'topic+date or clearAll required' }, {
          status: 400,
          headers: corsHeaders,
        });
      }

      const profile = await buildUserProfile(env.DB, user, dev, tokenExpiresAt);
      return Response.json({ ok: true, user: profile }, { headers: corsHeaders });
    }

    if (request.method === 'POST' && url.pathname === '/memories') {
      const body = await request.json() as { content?: string; deviceId?: string };
      const dev = body.deviceId || deviceId;
      if (!body.content?.trim()) {
        return Response.json({ error: 'content is required' }, { status: 400, headers: corsHeaders });
      }
      await upsertUser(env.DB, user);
      const parsed = parseRememberText(body.content.trim());
      const saved = await touchTopicCache(env.DB, user.id, dev, parsed, await getTier(env.DB, user.id), true);
      if (!saved.ok) {
        return Response.json({ error: saved.error, tier: saved.tier, limit: saved.limit }, {
          status: 429,
          headers: corsHeaders,
        });
      }
      const profile = await buildUserProfile(env.DB, user, dev, tokenExpiresAt);
      return Response.json({ ok: true, entry: saved.entry, user: profile }, { headers: corsHeaders });
    }

    if (request.method !== 'POST' || url.pathname !== '/') {
      return new Response('Method Not Allowed', { status: 405, headers: corsHeaders });
    }

    try {
      const body = await request.json() as {
        message?: string;
        image?: string;
        temperament?: number;
        location?: { lat: number; lon: number; accuracy?: number };
        deviceId?: string;
        stream?: boolean;
      };

      const dev = body.deviceId || deviceId;
      const { message, image, temperament = 0.5, location } = body;

      if (!message || typeof message !== 'string') {
        return Response.json({ error: 'Message is required' }, { status: 400, headers: corsHeaders });
      }

      await upsertUser(env.DB, user);
      const tier = await getTier(env.DB, user.id);
      const profile = await buildUserProfile(env.DB, user, dev, tokenExpiresAt);

      const remember = extractRememberCommand(message);
      if (remember) {
        const saved = await touchTopicCache(env.DB, user.id, dev, remember, tier, true);
        const refreshed = await buildUserProfile(env.DB, user, dev, tokenExpiresAt);
        if (saved.ok) {
          return Response.json({
            response: `Saved to this device's topic cache: ${formatTopicLine(saved.entry!)}`,
            provider: 'system',
            user: refreshed,
            cacheSaved: true,
          }, { headers: corsHeaders });
        }
        return Response.json({
          response: `Cache full on ${saved.tier} plan (${saved.limit} topics per device). Upgrade for more.`,
          provider: 'system',
          user: refreshed,
          cacheSaved: false,
        }, { headers: corsHeaders });
      }

      const t = Math.max(0, Math.min(1, temperament));
      const systemPrompt = getSystemPrompt(t, profile);
      let fullMessage = message;
      if (location) {
        fullMessage = `${message}\n\n[User location: lat=${location.lat.toFixed(5)}, lon=${location.lon.toFixed(5)}${location.accuracy ? ` (accuracy ±${Math.round(location.accuracy)}m)` : ''}]`;
      }

      const temp = 0.7 + (t * 0.3);
      const groqModel = image ? 'llava-v1.5-7b-4096-preview' : 'llama-3.1-8b-instant';

      if (body.stream && !image) {
        return streamChatResponse({
          fullMessage,
          message,
          env,
          systemPrompt,
          temp,
          groqModel,
          user,
          dev,
          tier,
          tokenExpiresAt,
        });
      }

      let groqErr: unknown = null;
      let responseText: string;
      let provider: string;

      try {
        responseText = await callGroq(fullMessage, env.GROQ_API_KEY, systemPrompt, temp, image, groqModel);
        provider = 'groq';
      } catch (groqError) {
        groqErr = groqError;
        try {
          responseText = await callGrok(fullMessage, env.XAI_API_KEY, systemPrompt, temp, image);
          provider = 'grok';
        } catch (grokError) {
          return Response.json({
            error: 'Both AI providers failed',
            groqError: groqErr ? String(groqErr) : null,
            grokError: String(grokError),
          }, { status: 502, headers: corsHeaders });
        }
      }

      // Auto-index topic + date only (no gist) — like writing cache keys, not values
      if (!image && message.length > 8) {
        const autoTopic = deriveTopic(message);
        if (autoTopic) {
          await touchTopicCache(env.DB, user.id, dev, {
            topic: autoTopic,
            gist: null,
            occurredOn: todayUtc(),
          }, tier, false);
        }
      }

      const refreshed = await buildUserProfile(env.DB, user, dev, tokenExpiresAt);
      return Response.json({ response: responseText, provider, user: refreshed }, { headers: corsHeaders });
    } catch (error) {
      console.error('Worker error:', error);
      return Response.json({ error: 'Internal error' }, { status: 500, headers: corsHeaders });
    }
  },
};

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function formatTopicLine(entry: TopicCacheEntry): string {
  const d = entry.date.slice(5).replace('-', '/');
  return entry.gist ? `${d} · ${entry.topic} (${entry.gist})` : `${d} · ${entry.topic}`;
}

function deriveTopic(text: string): string | null {
  const words = text.toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
  if (!words.length) return null;
  return words.slice(0, 5).join(' ').slice(0, 48);
}

function parseRememberText(text: string): { topic: string; gist: string | null; occurredOn: string } {
  const dated = text.match(/^(\d{4}-\d{2}-\d{2})\s+(.+)$/);
  if (dated) {
    const detail = dated[2].trim();
    return {
      occurredOn: dated[1],
      topic: deriveTopic(detail) || detail.slice(0, 48),
      gist: detail.length > 48 ? detail.slice(0, 96) : null,
    };
  }
  const topic = deriveTopic(text) || text.slice(0, 48);
  return {
    occurredOn: todayUtc(),
    topic,
    gist: text.length > topic.length ? text.slice(0, 96) : null,
  };
}

function extractRememberCommand(message: string): { topic: string; gist: string | null; occurredOn: string } | null {
  const match = message.trim().match(/^remember(?:\s+that)?(?:\s+(\d{4}-\d{2}-\d{2}))?[:\s]+(.+)$/i)
    || message.trim().match(/^please remember(?:\s+that)?(?:\s+(\d{4}-\d{2}-\d{2}))?[:\s]+(.+)$/i);
  if (!match) return null;
  const detail = match[2].trim();
  const occurredOn = match[1] || todayUtc();
  const topic = deriveTopic(detail) || detail.slice(0, 48);
  return {
    occurredOn,
    topic,
    gist: detail.length > topic.length ? detail.slice(0, 96) : null,
  };
}

function getSystemPrompt(
  t: number,
  profile: UserIdentity & { topicCache: TopicCacheEntry[]; tier: string; deviceId: string },
): string {
  const tone = t < 0.3 ? 'kind, warm, and gentle' :
               t > 0.7 ? 'sharp, irritated, and frustrated' :
               'neutral but direct';

  const intensity = t > 0.7 ? 'Be blunt and a bit short.' :
                    t < 0.3 ? 'Be patient and encouraging.' : '';

  const who = profile.name
    ? `Speaking with ${profile.name}${profile.email ? ` (${profile.email})` : ''}.`
    : profile.email ? `Speaking with ${profile.email}.` : '';

  let cacheBlock = '';
  if (profile.topicCache.length) {
    const lines = profile.topicCache.map((e) => {
      const label = formatTopicLine(e);
      return profile.tier === 'paid' && e.gist ? `- ${label}` : `- ${e.date.slice(5).replace('-', '/')} · ${e.topic}`;
    });
    cacheBlock = ` Device topic cache for this user (dates + topics only, not full chats — like a cache index):\n${lines.join('\n')}`;
  }

  return `You are a ${tone} voice assistant. Short, natural replies. Max 2 sentences. ${intensity} ${who}${cacheBlock}`;
}

async function upsertUser(db: D1Database, user: UserIdentity): Promise<void> {
  if (user.provider === 'token') return;
  await db.prepare(`
    INSERT INTO users (id, email, name, picture, provider, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      email = excluded.email, name = excluded.name, picture = excluded.picture,
      provider = excluded.provider, updated_at = datetime('now')
  `).bind(user.id, user.email ?? null, user.name ?? null, user.picture ?? null, user.provider).run();
}

async function getTier(db: D1Database, userId: string): Promise<'free' | 'paid'> {
  const row = await db.prepare('SELECT tier FROM users WHERE id = ?').bind(userId).first<UserRow>();
  return row?.tier ?? 'free';
}

async function evictStaleCache(db: D1Database, userId: string, deviceId: string, ttlDays: number): Promise<void> {
  await db.prepare(`
    DELETE FROM topic_cache
    WHERE user_id = ? AND device_id = ?
      AND occurred_on < date('now', ?)
  `).bind(userId, deviceId, `-${ttlDays} days`).run();
}

async function evictOverflow(db: D1Database, userId: string, deviceId: string, maxEntries: number): Promise<void> {
  const count = await db.prepare(
    'SELECT COUNT(*) as n FROM topic_cache WHERE user_id = ? AND device_id = ?',
  ).bind(userId, deviceId).first<{ n: number }>();

  const excess = (count?.n ?? 0) - maxEntries;
  if (excess <= 0) return;

  await db.prepare(`
    DELETE FROM topic_cache WHERE id IN (
      SELECT id FROM topic_cache
      WHERE user_id = ? AND device_id = ?
      ORDER BY last_seen_at ASC
      LIMIT ?
    )
  `).bind(userId, deviceId, excess).run();
}

async function touchTopicCache(
  db: D1Database,
  userId: string,
  deviceId: string,
  entry: { topic: string; gist: string | null; occurredOn: string },
  tier: 'free' | 'paid',
  isExplicit: boolean,
): Promise<{ ok: boolean; entry?: TopicCacheEntry; tier?: string; limit?: number; error?: string }> {
  const limits = CACHE_LIMITS[tier];
  await evictStaleCache(db, userId, deviceId, limits.ttlDays);

  const count = await db.prepare(
    'SELECT COUNT(*) as n FROM topic_cache WHERE user_id = ? AND device_id = ?',
  ).bind(userId, deviceId).first<{ n: number }>();

  const exists = await db.prepare(`
    SELECT id FROM topic_cache
    WHERE user_id = ? AND device_id = ? AND topic = ? AND occurred_on = ?
  `).bind(userId, deviceId, entry.topic, entry.occurredOn).first();

  if (!exists && (count?.n ?? 0) >= limits.maxEntries) {
    await evictOverflow(db, userId, deviceId, limits.maxEntries - 1);
    const after = await db.prepare(
      'SELECT COUNT(*) as n FROM topic_cache WHERE user_id = ? AND device_id = ?',
    ).bind(userId, deviceId).first<{ n: number }>();
    if ((after?.n ?? 0) >= limits.maxEntries) {
      return { ok: false, tier, limit: limits.maxEntries, error: 'cache_limit_reached' };
    }
  }

  const gist = isExplicit ? entry.gist : null;

  await db.prepare(`
    INSERT INTO topic_cache (user_id, device_id, topic, gist, occurred_on, last_seen_at, hit_count)
    VALUES (?, ?, ?, ?, ?, datetime('now'), 1)
    ON CONFLICT(user_id, device_id, topic, occurred_on) DO UPDATE SET
      last_seen_at = datetime('now'),
      hit_count = hit_count + 1,
      gist = COALESCE(excluded.gist, topic_cache.gist)
  `).bind(userId, deviceId, entry.topic, gist, entry.occurredOn).run();

  return {
    ok: true,
    entry: { date: entry.occurredOn, topic: entry.topic, gist: gist ?? undefined },
    tier,
    limit: limits.maxEntries,
  };
}

async function getTopicCache(
  db: D1Database,
  userId: string,
  deviceId: string,
  tier: 'free' | 'paid',
): Promise<TopicCacheEntry[]> {
  const limits = CACHE_LIMITS[tier];
  await evictStaleCache(db, userId, deviceId, limits.ttlDays);

  const promptLimit = tier === 'paid' ? 20 : 12;
  const rows = await db.prepare(`
    SELECT occurred_on, topic, gist, hit_count FROM topic_cache
    WHERE user_id = ? AND device_id = ?
    ORDER BY last_seen_at DESC
    LIMIT ?
  `).bind(userId, deviceId, promptLimit).all<TopicRow>();

  const entries = (rows.results ?? []).map((r) => ({
    date: r.occurred_on,
    topic: r.topic,
    gist: r.gist && tier === 'paid' ? r.gist : undefined,
  }));

  return entries.reverse();
}

async function buildUserProfile(
  db: D1Database,
  user: UserIdentity,
  deviceId: string,
  tokenExpiresAt?: number,
) {
  const tier = user.provider === 'token' ? 'free' : await getTier(db, user.id);
  const limits = CACHE_LIMITS[tier];
  const topicCache = user.provider === 'token' ? [] : await getTopicCache(db, user.id, deviceId, tier);

  const countRow = user.provider === 'token' ? null : await db.prepare(
    'SELECT COUNT(*) as n FROM topic_cache WHERE user_id = ? AND device_id = ?',
  ).bind(user.id, deviceId).first<{ n: number }>();

  return {
    ...user,
    tier,
    deviceId,
    topicCache,
    cacheLimit: limits.maxEntries,
    cacheCount: countRow?.n ?? 0,
    cacheTtlDays: limits.ttlDays,
    memoryLimit: limits.maxEntries,
    memoryCount: countRow?.n ?? 0,
    memories: topicCache.map((e) => formatTopicLine(e)),
    tokenExpiresAt,
    tokenIssuer: user.provider === 'google' ? 'google' : user.provider,
  };
}

interface StreamChatParams {
  fullMessage: string;
  message: string;
  env: Env;
  systemPrompt: string;
  temp: number;
  groqModel: string;
  user: UserIdentity;
  dev: string;
  tier: 'free' | 'paid';
  tokenExpiresAt?: number;
}

const DEMO_RESPONSE = 'Hi! I am the Xylaphone Tango voice agent. Groq answers first; Grok backs me up if needed. Sign in at xylaphonetango.com to try the real mic.';

function publicDemoStream(): Response {
  return streamNdjsonResponse(async (write) => {
    const words = DEMO_RESPONSE.split(/(\s+)/);
    for (const chunk of words) {
      await write({ type: 'token', text: chunk });
      await new Promise((r) => setTimeout(r, 35));
    }
    await write({
      type: 'done',
      provider: 'demo',
      response: DEMO_RESPONSE,
      demo: true,
      app: 'https://xylaphonetango.com',
      docs: 'https://xylaphonetango.com/demo.html',
    });
  });
}

function streamNdjsonResponse(run: (write: (obj: object) => Promise<void>) => Promise<void>): Response {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  const write = async (obj: object) => {
    await writer.write(encoder.encode(`${JSON.stringify(obj)}\n`));
  };

  (async () => {
    try {
      await run(write);
    } catch (error) {
      try {
        await write({ type: 'error', error: String(error) });
      } catch { /* stream may be closed */ }
    } finally {
      try {
        await writer.close();
      } catch { /* already closed */ }
    }
  })();

  return new Response(readable, {
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/x-ndjson',
      'Cache-Control': 'no-cache',
    },
  });
}

async function streamChatResponse(params: StreamChatParams): Promise<Response> {
  const {
    fullMessage, message, env, systemPrompt, temp, groqModel,
    user, dev, tier, tokenExpiresAt,
  } = params;

  return streamNdjsonResponse(async (write) => {
    let fullText = '';
    let provider = 'groq';
    let groqErr: unknown = null;

    try {
      const groqBody = await openAIStreamRequest(
        'https://api.groq.com/openai/v1/chat/completions',
        env.GROQ_API_KEY,
        groqModel,
        systemPrompt,
        fullMessage,
        temp,
      );
      provider = 'groq';
      for await (const token of parseOpenAISSE(groqBody)) {
        fullText += token;
        await write({ type: 'token', text: token });
      }
    } catch (groqError) {
      groqErr = groqError;
      try {
        const grokBody = await openAIStreamRequest(
          'https://api.x.ai/v1/chat/completions',
          env.XAI_API_KEY,
          'grok-4.3',
          systemPrompt,
          fullMessage,
          temp,
        );
        provider = 'grok';
        for await (const token of parseOpenAISSE(grokBody)) {
          fullText += token;
          await write({ type: 'token', text: token });
        }
      } catch (grokError) {
        await write({
          type: 'error',
          error: 'Both AI providers failed',
          groqError: groqErr ? String(groqErr) : null,
          grokError: String(grokError),
        });
        return;
      }
    }

    if (message.length > 8) {
      const autoTopic = deriveTopic(message);
      if (autoTopic) {
        await touchTopicCache(env.DB, user.id, dev, {
          topic: autoTopic,
          gist: null,
          occurredOn: todayUtc(),
        }, tier, false);
      }
    }

    const refreshed = await buildUserProfile(env.DB, user, dev, tokenExpiresAt);
    await write({
      type: 'done',
      provider,
      response: fullText.trim() || 'No response',
      user: refreshed,
    });
  });
}

async function openAIStreamRequest(
  url: string,
  apiKey: string,
  model: string,
  systemPrompt: string,
  message: string,
  temp: number,
): Promise<ReadableStream<Uint8Array>> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: message }],
      max_tokens: 120,
      temperature: temp,
      stream: true,
    }),
  });

  if (!res.ok) throw new Error(`API error: ${res.status} ${await res.text()}`);
  if (!res.body) throw new Error('No response stream');
  return res.body;
}

async function* parseOpenAISSE(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data: ')) continue;
      const data = trimmed.slice(6);
      if (data === '[DONE]') return;
      try {
        const parsed = JSON.parse(data) as { choices?: { delta?: { content?: string } }[] };
        const delta = parsed.choices?.[0]?.delta?.content;
        if (delta) yield delta;
      } catch { /* skip malformed chunks */ }
    }
  }
}

async function callGroq(message: string, apiKey: string, systemPrompt: string, temp: number, image?: string, model?: string): Promise<string> {
  const useModel = model || 'llama-3.1-8b-instant';
  const content: unknown = image
    ? [{ type: 'text', text: message }, { type: 'image_url', image_url: { url: image } }]
    : message;

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: useModel,
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content }],
      max_tokens: 120,
      temperature: temp,
    }),
  });

  if (!res.ok) throw new Error(`Groq error: ${res.status} ${await res.text()}`);
  const data = await res.json() as { choices?: { message?: { content?: string } }[] };
  return data.choices?.[0]?.message?.content?.trim() || 'No response';
}

async function callGrok(message: string, apiKey: string, systemPrompt: string, temp: number, image?: string): Promise<string> {
  const content: unknown = image
    ? [{ type: 'text', text: message }, { type: 'image_url', image_url: { url: image } }]
    : message;

  const res = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'grok-4.3',
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content }],
      max_tokens: 120,
      temperature: temp,
    }),
  });

  if (!res.ok) throw new Error(`Grok error: ${res.status} ${await res.text()}`);
  const data = await res.json() as { choices?: { message?: { content?: string } }[] };
  return data.choices?.[0]?.message?.content?.trim() || 'No response';
}

async function resolveAuth(token: string, env: Env): Promise<{ user: UserIdentity; tokenExpiresAt?: number } | null> {
  if (!token) return null;

  const google = await verifyGoogleIdToken(token, env.GOOGLE_CLIENT_ID);
  if (google) {
    return {
      user: {
        id: google.sub,
        email: google.email,
        name: google.name,
        picture: google.picture,
        provider: 'google',
      },
      tokenExpiresAt: google.exp ? Number(google.exp) : undefined,
    };
  }

  if (env.ACCESS_TOKEN && token === env.ACCESS_TOKEN) {
    return { user: { id: 'access-token', provider: 'token' } };
  }

  return null;
}

async function verifyGoogleIdToken(token: string, clientId?: string): Promise<GoogleTokenInfo | null> {
  if (!token) return null;
  try {
    const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(token)}`);
    if (!res.ok) return null;
    const data = await res.json() as GoogleTokenInfo;
    if (data.error || !data.sub) return null;
    if (clientId && data.aud !== clientId) return null;
    return data;
  } catch {
    return null;
  }
}
