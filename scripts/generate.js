import { graphql } from '@octokit/graphql';
import fs from 'fs';
import path from 'path';

const TOKEN    = process.env.GH_TOKEN;
const ORG      = process.env.ORG      || 'M2Station';
const USERNAME = process.env.USERNAME || 'oahsiao';
const OUT_DIR  = path.resolve('assets');

if (!TOKEN) { console.error('GH_TOKEN not set'); process.exit(1); }
fs.mkdirSync(OUT_DIR, { recursive: true });

const api = graphql.defaults({ headers: { authorization: `token ${TOKEN}` } });

// Taiwan-time timestamp string, e.g. "2026-06-02 15:30 TWN"
function nowTWN() {
  const d = new Date(Date.now() + 8 * 3600 * 1000); // shift to UTC+8
  const p = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth()+1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} TWN`;
}
const UPDATED = nowTWN();

// ── 1. Fetch all org repos ────────────────────────────────────────────────────
async function fetchRepos() {
  let repos = [], cursor = null;
  while (true) {
    const { organization } = await api(`
      query($org:String!, $after:String) {
        organization(login:$org) {
          repositories(first:50, after:$after, isFork:false) {
            pageInfo { hasNextPage endCursor }
            nodes { name defaultBranchRef { name } }
          }
        }
      }`, { org: ORG, after: cursor });
    const page = organization.repositories;
    repos.push(...page.nodes.filter(r => r.defaultBranchRef));
    if (!page.pageInfo.hasNextPage) break;
    cursor = page.pageInfo.endCursor;
  }
  return repos;
}

// ── 2. Fetch ALL commits (every author) in each repo, paginated ───────────────
async function fetchCommits(repoName, branch) {
  let nodes = [], cursor = null, total = 0;
  try {
    while (true) {
      const { repository } = await api(`
        query($org:String!, $repo:String!, $branch:String!, $after:String) {
          repository(owner:$org, name:$repo) {
            ref(qualifiedName:$branch) {
              target {
                ... on Commit {
                  history(first:100, after:$after) {
                    totalCount
                    pageInfo { hasNextPage endCursor }
                    nodes {
                      oid
                      abbreviatedOid
                      url
                      committedDate
                      message
                      author {
                        user { login avatarUrl }
                        name
                        email
                      }
                    }
                  }
                }
              }
            }
          }
        }`, { org: ORG, repo: repoName, branch, after: cursor });

      const history = repository?.ref?.target?.history;
      if (!history) break;
      total = history.totalCount;
      nodes.push(...history.nodes);

      if (!history.pageInfo.hasNextPage) break;
      cursor = history.pageInfo.endCursor;

      // Safety cap: stop after 1000 commits per repo to avoid rate limits
      if (nodes.length >= 1000) break;
    }
    return { total, nodes };
  } catch { return { total: 0, nodes: [] }; }
}

// ── 3. Fetch language breakdown per repo ──────────────────────────────────────
async function fetchLanguages(repoName) {
  try {
    const { repository } = await api(`
      query($org:String!, $repo:String!) {
        repository(owner:$org, name:$repo) {
          languages(first:10, orderBy:{field:SIZE, direction:DESC}) {
            edges { size node { name color } }
          }
        }
      }`, { org: ORG, repo: repoName });
    return repository?.languages?.edges || [];
  } catch { return []; }
}

// ── 4. Aggregate ──────────────────────────────────────────────────────────────
async function aggregate() {
  console.log(`Fetching repos for ${ORG}...`);
  const repos = await fetchRepos();
  console.log(`Found ${repos.length} repos`);

  const members    = {};   // login -> { commits, avatar }
  const langBytes  = {};
  const hourBucket = new Array(24).fill(0);
  const dailyMap   = {};   // 'YYYY-MM-DD' -> count (last 90 days)
  const recentCommits = []; // last 5 days, for typing banner
  const allChanges = [];    // every commit, for "latest changes" list
  let totalCommits = 0;

  // Build last-90-day window (Taiwan time)
  const DAYS = 90;
  const todayTWN = new Date(Date.now() + 8 * 3600 * 1000);
  const cutoff = new Date(todayTWN);
  cutoff.setUTCDate(cutoff.getUTCDate() - (DAYS - 1));
  cutoff.setUTCHours(0, 0, 0, 0);

  // 5-day window for typing banner
  const recentCutoff = new Date(todayTWN);
  recentCutoff.setUTCDate(recentCutoff.getUTCDate() - 5);

  for (const repo of repos) {
    const branch  = repo.defaultBranchRef.name;
    const commits = await fetchCommits(repo.name, branch);
    const langs   = await fetchLanguages(repo.name);

    // Aggregate per-author commits
    for (const c of commits.nodes) {
      const login  = c.author?.user?.login || c.author?.name || 'unknown';
      const avatar = c.author?.user?.avatarUrl || '';
      if (!members[login]) members[login] = { login, commits: 0, avatar };
      members[login].commits++;
      totalCommits++;

      const committed = new Date(c.committedDate);
      const dateTWN = new Date(committed.getTime() + 8 * 3600 * 1000);

      // Active hours
      hourBucket[dateTWN.getUTCHours()]++;

      // Daily trend (only within window)
      if (dateTWN >= cutoff) {
        const key = dateTWN.toISOString().slice(0, 10);
        dailyMap[key] = (dailyMap[key] || 0) + 1;
      }

      // Recent commits for typing banner (last 5 days, first line of message)
      if (committed >= recentCutoff) {
        const header = (c.message || '').split('\n')[0].trim();
        if (header && !/^Merge /i.test(header)) {
          recentCommits.push({ date: committed.getTime(), header, repo: repo.name });
        }
      }

      // Every commit, for the "latest changes" clickable list
      {
        const header = (c.message || '').split('\n')[0].trim();
        if (header && !/^Merge /i.test(header) && c.url) {
          allChanges.push({
            date: committed.getTime(),
            committedDate: c.committedDate,
            header,
            repo: repo.name,
            url: c.url,
            sha: c.abbreviatedOid || (c.oid || '').slice(0, 7),
            login,
          });
        }
      }
    }

    // Languages
    for (const { size, node } of langs) {
      langBytes[node.name] = (langBytes[node.name] || { bytes: 0, color: node.color });
      langBytes[node.name].bytes += size;
    }

    process.stdout.write(`  ${repo.name}: ${commits.nodes.length} commits\n`);
  }

  // Member leaderboard (top 10)
  const leaderboard = Object.values(members)
    .sort((a, b) => b.commits - a.commits)
    .slice(0, 10);

  // Top 10 languages by bytes
  const totalBytes = Object.values(langBytes).reduce((s, v) => s + v.bytes, 0) || 1;
  const topLangs = Object.entries(langBytes)
    .sort(([,a],[,b]) => b.bytes - a.bytes)
    .slice(0, 10)
    .map(([name, { bytes, color }]) => ({
      name, color: color || '#888',
      pct: Math.round(bytes / totalBytes * 1000) / 10
    }));

  // Daily commit series (last 90 days, filled with 0 for gaps)
  const daily = [];
  for (let i = 0; i < DAYS; i++) {
    const d = new Date(cutoff);
    d.setUTCDate(d.getUTCDate() + i);
    const key = d.toISOString().slice(0, 10);
    daily.push({ date: key, count: dailyMap[key] || 0 });
  }

  // Recent commit headers (newest first, deduped, top 8)
  const seen = new Set();
  const recentHeaders = recentCommits
    .sort((a, b) => b.date - a.date)
    .filter(c => { if (seen.has(c.header)) return false; seen.add(c.header); return true; })
    .slice(0, 8)
    .map(c => c.header);

  // Latest 10 changes across ALL repos (newest first, deduped by sha)
  const seenSha = new Set();
  const latestChanges = allChanges
    .sort((a, b) => b.date - a.date)
    .filter(c => { if (seenSha.has(c.sha)) return false; seenSha.add(c.sha); return true; })
    .slice(0, 10);

  return { totalCommits, leaderboard, topLangs, hourBucket, daily, recentHeaders, latestChanges, memberCount: Object.keys(members).length };
}

// ── 5. SVG renderers ──────────────────────────────────────────────────────────

function svgLeaderboard({ leaderboard, totalCommits, memberCount }) {
  const W = 480, BAR_MAX = 280, ROW = 38, PAD = 16;
  const maxC = leaderboard[0]?.commits || 1;
  const H = 24 + leaderboard.length * ROW + 24;

  const rows = leaderboard.map((m, i) => {
    const barW = Math.round(m.commits / maxC * BAR_MAX);
    const y = PAD + i * ROW;
    const rank = i + 1;
    const rankColor = i === 0 ? '#ffd700' : i === 1 ? '#c0c0c0' : i === 2 ? '#cd7f32' : '#007a6a';
    return `
    <text x="14" y="${y+22}" font-family="Orbitron,monospace" font-size="13" font-weight="700" fill="${rankColor}">${rank}</text>
    <text x="32" y="${y+22}" font-family="DM Mono,monospace" font-size="12" fill="#00c9a7">${m.login}</text>
    <rect x="150" y="${y+10}" width="${BAR_MAX}" height="16" fill="#00f5d4" opacity="0.07" rx="2"/>
    <rect x="150" y="${y+10}" width="${barW}" height="16" fill="#00f5d4" opacity="0.6" rx="2">
      <animate attributeName="width" from="0" to="${barW}" dur="1.2s" begin="${(i*0.08).toFixed(2)}s" fill="freeze"/>
    </rect>
    <text x="${154+barW}" y="${y+22}" font-family="DM Mono,monospace" font-size="11" fill="#00f5d4">${m.commits}</text>`;
  }).join('');

  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${W}" height="${H}" fill="#060a0f" rx="8"/>
  <text x="12" y="14" font-family="DM Mono,monospace" font-size="9" fill="#007a6a" letter-spacing="3">// M2STATION · MEMBER LEADERBOARD</text>
  <text x="${W-12}" y="14" text-anchor="end" font-family="DM Mono,monospace" font-size="9" fill="#004a3e">${memberCount} DEVS · ${totalCommits} COMMITS</text>
  <line x1="8" y1="22" x2="${W-8}" y2="22" stroke="#00f5d4" stroke-width="0.3" opacity="0.3"/>
  <g transform="translate(0,24)">${rows}</g>
  <text x="${W/2}" y="${H-6}" text-anchor="middle" font-family="DM Mono,monospace" font-size="8" fill="#004a3e">M2Station · UPDATED ${UPDATED}</text>
</svg>`;
}

function svgLanguages({ topLangs }) {
  const W = 480, H = 160, CX = 80, CY = 78, R = 60, r = 34;
  let angle = -Math.PI / 2;
  let slices = '';
  for (const lang of topLangs) {
    const sweep = (lang.pct / 100) * 2 * Math.PI;
    const x1 = CX + R * Math.cos(angle), y1 = CY + R * Math.sin(angle);
    angle += sweep;
    const x2 = CX + R * Math.cos(angle), y2 = CY + R * Math.sin(angle);
    const large = sweep > Math.PI ? 1 : 0;
    slices += `<path d="M${CX},${CY} L${x1.toFixed(1)},${y1.toFixed(1)} A${R},${R} 0 ${large} 1 ${x2.toFixed(1)},${y2.toFixed(1)} Z"
      fill="${lang.color}" opacity="0.85" stroke="#060a0f" stroke-width="1.5"/>`;
  }

  const legend = topLangs.slice(0, 8).map((l, i) => {
    const row = Math.floor(i / 2), col = i % 2;
    const x = 170 + col * 150, y = 36 + row * 22;
    return `<rect x="${x}" y="${y}" width="10" height="10" fill="${l.color}" rx="2"/>
    <text x="${x+14}" y="${y+9}" font-family="DM Mono,monospace" font-size="11" fill="#00b890">${l.name}</text>
    <text x="${x+120}" y="${y+9}" text-anchor="end" font-family="DM Mono,monospace" font-size="10" fill="#007a6a">${l.pct}%</text>`;
  }).join('');

  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${W}" height="${H}" fill="#060a0f" rx="8"/>
  <text x="12" y="14" font-family="DM Mono,monospace" font-size="9" fill="#007a6a" letter-spacing="3">// M2STATION · LANGUAGE BREAKDOWN</text>
  <line x1="8" y1="22" x2="${W-8}" y2="22" stroke="#00f5d4" stroke-width="0.3" opacity="0.3"/>
  ${slices}
  <circle cx="${CX}" cy="${CY}" r="${r}" fill="#060a0f"/>
  <text x="${CX}" y="${CY-4}" text-anchor="middle" font-family="DM Mono,monospace" font-size="9" fill="#00f5d4">LANG</text>
  <text x="${CX}" y="${CY+10}" text-anchor="middle" font-family="DM Mono,monospace" font-size="9" fill="#007a6a">MIX</text>
  ${legend}
  <text x="${W/2}" y="${H-6}" text-anchor="middle" font-family="DM Mono,monospace" font-size="8" fill="#004a3e">oahsiao @ M2Station · UPDATED ${UPDATED}</text>
</svg>`;
}

function svgHourly({ hourBucket }) {
  const W = 480, H = 130, PAD = 20, INNER_W = W - PAD * 2, INNER_H = 60;
  const maxH = Math.max(...hourBucket, 1);
  const barW = Math.floor(INNER_W / 24) - 2;
  const baseY = 34 + INNER_H;

  const bars = hourBucket.map((v, h) => {
    const bh = Math.round(v / maxH * INNER_H);
    const x = PAD + h * (barW + 2);
    const y = baseY - bh;
    const alpha = 0.15 + (v / maxH) * 0.75;
    const label = h === 0 ? '00' : h === 6 ? '06' : h === 12 ? '12' : h === 18 ? '18' : h === 23 ? '23' : '';
    return `<rect x="${x}" y="${y}" width="${barW}" height="${bh}" fill="#00f5d4" opacity="${alpha.toFixed(2)}" rx="1">
      <animate attributeName="height" from="0" to="${bh}" dur="1s" begin="${(h*0.03).toFixed(2)}s" fill="freeze"/>
      <animate attributeName="y" from="${baseY}" to="${y}" dur="1s" begin="${(h*0.03).toFixed(2)}s" fill="freeze"/>
    </rect>
    ${label ? `<text x="${x+barW/2}" y="${baseY+12}" text-anchor="middle" font-family="DM Mono,monospace" font-size="8" fill="#004a3e">${label}</text>` : ''}`;
  }).join('');

  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${W}" height="${H}" fill="#060a0f" rx="8"/>
  <text x="12" y="14" font-family="DM Mono,monospace" font-size="9" fill="#007a6a" letter-spacing="3">// M2STATION · ACTIVE HOURS (TWN UTC+8)</text>
  <line x1="8" y1="22" x2="${W-8}" y2="22" stroke="#00f5d4" stroke-width="0.3" opacity="0.3"/>
  ${bars}
  <text x="${W/2}" y="${H-6}" text-anchor="middle" font-family="DM Mono,monospace" font-size="8" fill="#004a3e">M2Station · UPDATED ${UPDATED}</text>
</svg>`;
}

function svgDailyTrend({ daily }) {
  const W = 960, H = 210, PADX = 40, PADT = 36, PADB = 44;
  const plotW = W - PADX * 2, plotH = H - PADT - PADB;
  const max = Math.max(...daily.map(d => d.count), 1);
  const n = daily.length;

  const x = i => PADX + (i / (n - 1)) * plotW;
  const y = v => PADT + plotH - (v / max) * plotH;

  // Build smooth-ish polyline points
  const pts = daily.map((d, i) => `${x(i).toFixed(1)},${y(d.count).toFixed(1)}`);
  const linePath = 'M' + pts.join(' L');
  const areaPath = `M${x(0).toFixed(1)},${(PADT+plotH).toFixed(1)} L` + pts.join(' L') + ` L${x(n-1).toFixed(1)},${(PADT+plotH).toFixed(1)} Z`;

  // Total commits in window
  const windowTotal = daily.reduce((s, d) => s + d.count, 0);
  const peak = daily.reduce((m, d) => d.count > m.count ? d : m, daily[0]);

  // Gridlines (4 horizontal)
  let grid = '';
  for (let g = 0; g <= 4; g++) {
    const gy = PADT + (plotH / 4) * g;
    const val = Math.round(max - (max / 4) * g);
    grid += `<line x1="${PADX}" y1="${gy}" x2="${W-PADX}" y2="${gy}" stroke="#00f5d4" stroke-width="0.3" opacity="0.12"/>
    <text x="${PADX-6}" y="${gy+3}" text-anchor="end" font-family="DM Mono,monospace" font-size="8" fill="#005a4e">${val}</text>`;
  }

  // Month labels along x-axis
  let xlabels = '';
  let lastMonth = '';
  daily.forEach((d, i) => {
    const m = d.date.slice(0, 7);
    if (m !== lastMonth) {
      lastMonth = m;
      const label = d.date.slice(5); // MM-DD
      xlabels += `<text x="${x(i).toFixed(1)}" y="${H-22}" text-anchor="middle" font-family="DM Mono,monospace" font-size="8" fill="#005a4e">${label}</text>`;
    }
  });

  const pathLen = 2000;

  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#00f5d4" stop-opacity="0.4"/>
      <stop offset="100%" stop-color="#00f5d4" stop-opacity="0.02"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="#060a0f" rx="8"/>
  <text x="14" y="16" font-family="DM Mono,monospace" font-size="9" fill="#007a6a" letter-spacing="3">// M2STATION · DAILY COMMIT TREND (90D)</text>
  <text x="${W-14}" y="16" text-anchor="end" font-family="DM Mono,monospace" font-size="9" fill="#004a3e">${windowTotal} COMMITS · PEAK ${peak.count} (${peak.date.slice(5)})</text>
  <line x1="8" y1="24" x2="${W-8}" y2="24" stroke="#00f5d4" stroke-width="0.3" opacity="0.3"/>
  ${grid}
  <path d="${areaPath}" fill="url(#areaGrad)"/>
  <path d="${linePath}" fill="none" stroke="#00f5d4" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"
    stroke-dasharray="${pathLen}" stroke-dashoffset="${pathLen}">
    <animate attributeName="stroke-dashoffset" from="${pathLen}" to="0" dur="2s" fill="freeze" calcMode="spline" keySplines="0.4 0 0.2 1" keyTimes="0;1"/>
  </path>
  <circle cx="${x(peak.date ? daily.indexOf(peak) : 0).toFixed(1)}" cy="${y(peak.count).toFixed(1)}" r="3" fill="#ff4db8">
    <animate attributeName="opacity" values="0;1" begin="2s" dur="0.4s" fill="freeze"/>
  </circle>
  ${xlabels}
  <text x="${W/2}" y="${H-7}" text-anchor="middle" font-family="DM Mono,monospace" font-size="7" fill="#003a30">M2Station · UPDATED ${UPDATED}</text>
</svg>`;
}

// ── Typing banner: typewriter cycle through recent commit headers ─────────────
function svgTypingBanner({ recentHeaders }) {
  const W = 600, H = 56;
  const lines = (recentHeaders && recentHeaders.length)
    ? recentHeaders.slice(0, 6)
    : ['no recent commits'];

  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const clean = lines.map(l => esc(l.length > 50 ? l.slice(0, 47) + '...' : l));

  const CHAR_W = 8.4;          // approx px per char at 15px DM Mono
  const PREFIX = '> ';
  const typeSpeed = 0.06;      // seconds per char
  const hold = 1.6;            // seconds to hold full line
  const erase = 0.5;           // seconds to clear

  // Compute per-line timings sequentially
  let t = 0;
  const segments = clean.map((txt) => {
    const full = PREFIX + txt;
    const w = full.length * CHAR_W + 4;
    const typeDur = txt.length * typeSpeed;
    const begin = t;
    const seg = { full, w, begin, typeDur };
    t += typeDur + hold + erase;
    return seg;
  });
  const cycle = t;

  // Each line: a clipped text whose clip-rect width animates 0→full (type), holds, then →0 (erase)
  const blocks = segments.map((s, i) => {
    const clipId = `clip${i}`;
    const typeEnd = (s.typeDur / cycle);
    const holdEnd = ((s.typeDur + hold) / cycle);
    const eraseEnd = ((s.typeDur + hold + erase) / cycle);
    const visStart = (s.begin / cycle);
    const visEnd = ((s.begin + s.typeDur + hold + erase) / cycle);

    return `
    <clipPath id="${clipId}"><rect x="14" y="20" height="26" width="0">
      <animate attributeName="width"
        values="0;0;${s.w};${s.w};0;0"
        keyTimes="0;${visStart.toFixed(3)};${(visStart+typeEnd).toFixed(3)};${(visStart+holdEnd).toFixed(3)};${(visStart+eraseEnd).toFixed(3)};1"
        dur="${cycle.toFixed(1)}s" repeatCount="indefinite" calcMode="linear"/>
    </rect></clipPath>
    <g clip-path="url(#${clipId})">
      <text x="14" y="38" font-family="'DM Mono',monospace" font-size="15" fill="#00f5d4"><tspan fill="#007a6a">&gt; </tspan>${s.full.slice(2)}</text>
    </g>`;
  }).join('');

  // Cursor that sits at the end of whatever is currently typed: simpler to just blink at line start area
  const cursor = `<rect x="14" y="24" width="9" height="18" fill="#00f5d4" opacity="0.8">
    <animate attributeName="opacity" values="0.8;0.8;0;0" dur="1s" repeatCount="indefinite"/>
  </rect>`;

  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  <text x="14" y="13" font-family="'DM Mono',monospace" font-size="8" fill="#005a4e" letter-spacing="2">// RECENT COMMITS · LAST 5 DAYS</text>
  ${cursor}
  ${blocks}
</svg>`;
}

// ── Last-updated badge ────────────────────────────────────────────────────────
function svgUpdatedBadge() {
  const label = 'LAST UPDATED';
  const value = UPDATED; // e.g. "2026-06-02 17:07 TWN"
  const CHAR = 7.2, PAD = 12, GAP = 10;
  const labelW = label.length * CHAR + PAD * 2;
  const valueW = value.length * CHAR + PAD * 2 + 12;
  const W = labelW + valueW, H = 28;

  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  <rect x="0.5" y="0.5" width="${W-1}" height="${H-1}" rx="4" fill="#060a0f" stroke="#00f5d4" stroke-opacity="0.25"/>
  <rect x="0.5" y="0.5" width="${labelW}" height="${H-1}" rx="4" fill="#00f5d4" fill-opacity="0.08"/>
  <text x="${labelW/2}" y="${H/2+4}" text-anchor="middle" font-family="'DM Mono',monospace" font-size="11" fill="#007a6a" letter-spacing="1.5">${label}</text>
  <text x="${labelW + valueW/2 + 6}" y="${H/2+4}" text-anchor="middle" font-family="'DM Mono',monospace" font-size="11" fill="#00f5d4" letter-spacing="1">${value}</text>
  <circle cx="${labelW + 12}" cy="${H/2}" r="3" fill="#00f5d4">
    <animate attributeName="opacity" values="1;0.2;1" dur="2s" repeatCount="indefinite"/>
  </circle>
</svg>`;
}

// ── Inject latest-changes list into README between markers ────────────────────
function injectLatestChanges({ latestChanges }) {
  const README = path.resolve('README.md');
  if (!fs.existsSync(README)) { console.warn('README.md not found, skip injection'); return; }

  const esc = s => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
  const rows = (latestChanges || []).map((c, i) => {
    const d = new Date(c.committedDate);
    const p = n => String(n).padStart(2, '0');
    const dt = `${d.getUTCFullYear()}-${p(d.getUTCMonth()+1)}-${p(d.getUTCDate())}`;
    const msg = esc(c.header.length > 60 ? c.header.slice(0, 57) + '...' : c.header);
    return `${String(i+1).padStart(2,'0')}. [\`${c.repo}@${c.sha}\`](${c.url}) — ${msg} · \`${dt}\` · ${c.login}`;
  }).join('\n');

  const block = rows || '_No recent commits._';
  const START = '<!-- LATEST-CHANGES:START -->';
  const END   = '<!-- LATEST-CHANGES:END -->';

  let md = fs.readFileSync(README, 'utf8');
  if (md.includes(START) && md.includes(END)) {
    md = md.replace(
      new RegExp(`${START}[\\s\\S]*?${END}`),
      `${START}\n${block}\n${END}`
    );
    fs.writeFileSync(README, md);
    console.log(`Injected ${latestChanges?.length || 0} latest changes into README.md`);
  } else {
    console.warn('LATEST-CHANGES markers not found in README.md, skip injection');
  }
}

// ── 6. Main ───────────────────────────────────────────────────────────────────
const data = await aggregate();

fs.writeFileSync(path.join(OUT_DIR, 'org-leaderboard.svg'), svgLeaderboard(data));
fs.writeFileSync(path.join(OUT_DIR, 'org-languages.svg'),   svgLanguages(data));
fs.writeFileSync(path.join(OUT_DIR, 'org-hours.svg'),       svgHourly(data));
fs.writeFileSync(path.join(OUT_DIR, 'org-trend.svg'),       svgDailyTrend(data));
fs.writeFileSync(path.join(OUT_DIR, 'org-typing.svg'),      svgTypingBanner(data));
fs.writeFileSync(path.join(OUT_DIR, 'org-updated.svg'),     svgUpdatedBadge());
fs.writeFileSync(path.join(OUT_DIR, 'data.json'), JSON.stringify(data, null, 2));

injectLatestChanges(data);

console.log('Done. SVGs written to assets/');
