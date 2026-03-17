export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { date } = req.body;
  if (!date) return res.status(400).json({ error: 'Missing date parameter' });

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  const INTERCOM_TOKEN = process.env.INTERCOM_ACCESS_TOKEN;

  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured in Vercel environment variables' });
  if (!INTERCOM_TOKEN) return res.status(500).json({ error: 'INTERCOM_ACCESS_TOKEN not configured in Vercel environment variables' });

  try {
    // ── 1. Fetch data directly from Intercom ──────────────────────────────
    const dayStart = Math.floor(new Date(date + 'T00:00:00Z').getTime() / 1000);
    const dayEnd   = Math.floor(new Date(date + 'T23:59:59Z').getTime() / 1000);

    async function fetchIntercom(url) {
      const r = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${INTERCOM_TOKEN}`,
          'Accept': 'application/json',
          'Intercom-Version': '2.11'
        }
      });
      if (!r.ok) throw new Error(`Intercom error ${r.status}: ${await r.text()}`);
      return r.json();
    }

    // Fetch open tickets
    const openData = await fetchIntercom(
      'https://api.intercom.io/conversations?state=open&per_page=150'
    );

    // Fetch closed tickets (up to 3 pages to cover the date range)
    let closedConvos = [];
    let cursor = null;
    for (let page = 0; page < 3; page++) {
      const url = cursor
        ? `https://api.intercom.io/conversations?state=closed&per_page=150&starting_after=${cursor}`
        : 'https://api.intercom.io/conversations?state=closed&per_page=150';
      const d = await fetchIntercom(url);
      closedConvos = closedConvos.concat(d.conversations || []);
      cursor = d.pages?.next?.starting_after;
      if (!cursor) break;
    }

    // Filter yesterday's tickets
    const allConvos = [...(openData.conversations || []), ...closedConvos];
    const yesterdayConvos = allConvos.filter(c => {
      const ca = c.created_at || 0;
      return ca >= dayStart && ca <= dayEnd;
    });

    // ── 2. Build raw data summary for Claude to analyse ───────────────────
    const rawSummary = yesterdayConvos.map(c => {
      const tca = c.ticket?.custom_attributes || {};
      const rating = tca.Rating?.value ?? tca.Rating ?? null;
      const desc = tca._default_description_?.value || '';
      const fbMatch = desc.match(/Feedback:\s*(.+)/);
      const feedback = fbMatch ? fbMatch[1].trim() : '';
      const tags = tca.Tags?.value || tca.Tags || '';
      const sport = tca.Sport?.value || tca.Sport || '';
      const loc = tca['Location Name']?.value || tca['Location Name'] || '';
      const ttc = c.statistics?.time_to_first_close || null;
      return {
        id: c.id,
        type: c.ticket?.ticket_type || 'direct',
        ai: c.ai_agent_participated || false,
        rating, feedback, tags, sport, loc, ttc
      };
    });

    // Build 7-day trend
    const trend = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(date + 'T12:00:00Z');
      d.setUTCDate(d.getUTCDate() - i);
      const ds = Math.floor(new Date(d.toISOString().split('T')[0] + 'T00:00:00Z').getTime() / 1000);
      const de = ds + 86399;
      const dayConvos = allConvos.filter(c => c.created_at >= ds && c.created_at <= de);
      const aiCount = dayConvos.filter(c => c.ai_agent_participated).length;
      const label = d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
      trend.push({
        date: d.toISOString().split('T')[0],
        label,
        total: dayConvos.length,
        ai: aiCount,
        human: dayConvos.length - aiCount
      });
    }

    // Open tickets formatted
    const openTickets = (openData.conversations || []).map(c => {
      const tca = c.ticket?.custom_attributes || {};
      const rating = tca.Rating?.value ?? tca.Rating ?? null;
      const title = tca._default_title_?.value || tca._default_title_ || 'Ticket';
      const desc = tca._default_description_?.value || '';
      const fbMatch = desc.match(/Feedback:\s*(.+)/);
      const issue = fbMatch ? fbMatch[1].trim() : title;
      const loc = tca['Location Name']?.value || tca.Location?.value || tca.Location || '';
      const user = (tca['User First Name']?.value || '') + ' ' + (tca['User Last Name']?.value || tca.Name?.value || '');
      const ts = c.created_at ? new Date(c.created_at * 1000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '';
      const type = c.ticket?.ticket_type?.toLowerCase().includes('non') ? 'non_return' : rating <= 2 ? 'bad_rating' : 'other';
      return {
        id: c.id,
        title,
        user: user.trim() || 'Unknown',
        issue: issue || title,
        location: loc,
        time: ts,
        rating,
        type,
        url: `https://app.intercom.com/a/apps/uf97uhs1/conversations/${c.id}`
      };
    });

    // ── 3. Ask Claude to categorise the bad rating feedback ───────────────
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        system: 'You are a data analyst. Return ONLY valid JSON, no markdown, no preamble.',
        messages: [{
          role: 'user',
          content: `Analyse this support ticket data for ${date} and return ONLY this JSON:

Ticket data: ${JSON.stringify(rawSummary)}

Return:
{
  "bad_reason_categories": [{"name": "...", "count": N}],
  "user_quotes": [{"text": "...", "rating": N, "sport": "...", "location": "..."}],
  "sports_breakdown": [{"sport": "...", "count": N}]
}

Rules:
- bad_reason_categories: group 1★ and 2★ feedback+tags into: "Deflated/flat ball", "Worn/broken equipment", "App/connectivity", "Dirty equipment", "Wrong pod/slot", "Pod damaged", "Bad location", "Billing/pricing", "Other". Only include categories with count > 0. Sort by count desc.
- user_quotes: up to 5 real verbatim non-empty feedback strings from 1★/2★ tickets only.
- sports_breakdown: count of bad-rating tickets (rating <= 2) per sport, sort by count desc, exclude nulls.`
        }]
      })
    });

    const claudeData = await claudeRes.json();
    const claudeText = claudeData.content?.map(b => b.text || '').join('').trim().replace(/```json|```/g, '').trim();
    let analysis = { bad_reason_categories: [], user_quotes: [], sports_breakdown: [] };
    try { analysis = JSON.parse(claudeText); } catch(e) {}

    // ── 4. Assemble final response ────────────────────────────────────────
    const ai_count = yesterdayConvos.filter(c => c.ai_agent_participated).length;
    const human_count = yesterdayConvos.length - ai_count;
    const ttcs = rawSummary.filter(c => c.ttc).map(c => c.ttc);
    const avg_close = ttcs.length > 0 ? Math.round(ttcs.reduce((a,b)=>a+b,0)/ttcs.length/60) : 0;

    const ratingDist = { '1':0, '2':0, '3':0, '4':0, '5':0 };
    rawSummary.forEach(c => { if (c.rating >= 1 && c.rating <= 5) ratingDist[String(c.rating)]++; });

    const typeCount = {};
    rawSummary.forEach(c => { typeCount[c.type] = (typeCount[c.type]||0)+1; });
    const ticket_types = Object.entries(typeCount).sort((a,b)=>b[1]-a[1]).map(([name,count])=>({name,count}));

    res.status(200).json({
      date,
      yesterday: {
        total: yesterdayConvos.length,
        ai_resolved: ai_count,
        human_resolved: human_count,
        avg_close_min: avg_close,
        ticket_types,
        ratings: ratingDist,
        bad_reason_categories: analysis.bad_reason_categories || [],
        user_quotes: analysis.user_quotes || [],
        sports_breakdown: analysis.sports_breakdown || []
      },
      open_tickets: openTickets,
      trend_7days: trend
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
}
