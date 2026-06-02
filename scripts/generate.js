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
                      committedDate
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
  let totalCommits = 0;

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

      // Active hours, adjusted to Taiwan time (UTC+8)
      const h = new Date(c.committedDate).getUTCHours();
      hourBucket[(h + 8) % 24]++;
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

  return { totalCommits, leaderboard, topLangs, hourBucket, memberCount: Object.keys(members).length };
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

// ── 6. Main ───────────────────────────────────────────────────────────────────
const data = await aggregate();

fs.writeFileSync(path.join(OUT_DIR, 'org-leaderboard.svg'), svgLeaderboard(data));
fs.writeFileSync(path.join(OUT_DIR, 'org-languages.svg'),   svgLanguages(data));
fs.writeFileSync(path.join(OUT_DIR, 'org-hours.svg'),       svgHourly(data));
fs.writeFileSync(path.join(OUT_DIR, 'data.json'), JSON.stringify(data, null, 2));

console.log('Done. SVGs written to assets/');
