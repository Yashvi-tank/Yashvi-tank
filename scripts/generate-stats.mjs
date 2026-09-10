#!/usr/bin/env node
/**
 * Generates a fully custom, live-data GitHub stats panel as a single SVG —
 * no third-party badge service. Pulls real numbers via the GitHub GraphQL
 * API and renders: a stat strip, a language-mix bar, and a contribution
 * heat-strip, all drawn in one consistent hand-built design system.
 *
 * Usage in CI:   GH_TOKEN=... GH_USERNAME=Yashvi-tank node scripts/generate-stats.mjs
 * Local preview: MOCK=1 node scripts/generate-stats.mjs
 */
import { writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";

const USERNAME = process.env.GH_USERNAME || "Yashvi-tank";
const TOKEN = process.env.GH_TOKEN;
const OUT = process.env.OUT_PATH || "assets/stats-live.svg";

const FONT = "'Inter','Segoe UI',system-ui,sans-serif";
const BG = "#0B0F19";
const INDIGO = "#6366F1";
const TEAL = "#2DD4BF";
const TEXT = "#F1F5F9";
const MUTED = "#94A3B8";
const FAINT = "#64748B";

const LANG_COLORS = {
  Python: "#3572A5",
  TypeScript: "#3178c6",
  JavaScript: "#f1e05a",
  Java: "#b07219",
  "C#": "#178600",
  PHP: "#4F5D95",
  HTML: "#e34c26",
  CSS: "#563d7c",
  Vue: "#41b883",
  Dockerfile: "#384d54",
  "Jupyter Notebook": "#DA5B0B",
  Shell: "#89e051",
  Kotlin: "#A97BFF",
};

async function fetchGraphQL(query, variables) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    throw new Error(`GitHub GraphQL request failed: ${res.status} ${await res.text()}`);
  }
  const json = await res.json();
  if (json.errors) {
    throw new Error("GraphQL errors: " + JSON.stringify(json.errors));
  }
  return json.data;
}

const QUERY = `
query($login: String!) {
  user(login: $login) {
    followers { totalCount }
    repositories(first: 100, ownerAffiliations: OWNER, isFork: false, privacy: PUBLIC) {
      totalCount
      nodes {
        stargazerCount
        languages(first: 10, orderBy: {field: SIZE, direction: DESC}) {
          edges { size node { name color } }
        }
      }
    }
    contributionsCollection {
      contributionCalendar {
        totalContributions
        weeks { contributionDays { contributionCount date } }
      }
    }
  }
}`;

async function getStats() {
  if (process.env.MOCK) {
    return mockStats();
  }
  if (!TOKEN) throw new Error("GH_TOKEN is required (set via workflow secrets.GITHUB_TOKEN)");
  const data = await fetchGraphQL(QUERY, { login: USERNAME });
  const user = data.user;

  const totalRepos = user.repositories.totalCount;
  let totalStars = 0;
  const langTotals = new Map();
  for (const repo of user.repositories.nodes) {
    totalStars += repo.stargazerCount;
    for (const edge of repo.languages.edges) {
      const name = edge.node.name;
      const prev = langTotals.get(name) || { size: 0, color: edge.node.color };
      prev.size += edge.size;
      langTotals.set(name, prev);
    }
  }
  const topLangs = [...langTotals.entries()]
    .sort((a, b) => b[1].size - a[1].size)
    .slice(0, 5)
    .map(([name, v]) => ({ name, size: v.size, color: v.color || LANG_COLORS[name] || MUTED }));

  const weeks = user.contributionsCollection.contributionCalendar.weeks;
  const days = weeks.flatMap((w) => w.contributionDays.map((d) => d.contributionCount));

  return {
    totalRepos,
    totalStars,
    followers: user.followers.totalCount,
    totalContributions: user.contributionsCollection.contributionCalendar.totalContributions,
    topLangs,
    contributionDays: days,
  };
}

function mockStats() {
  const days = Array.from({ length: 371 }, () => Math.floor(Math.random() * Math.random() * 12));
  return {
    totalRepos: 42,
    totalStars: 7,
    followers: 7,
    totalContributions: 73,
    topLangs: [
      { name: "Python", size: 480000, color: LANG_COLORS.Python },
      { name: "TypeScript", size: 210000, color: LANG_COLORS.TypeScript },
      { name: "JavaScript", size: 150000, color: LANG_COLORS.JavaScript },
      { name: "Java", size: 90000, color: LANG_COLORS.Java },
      { name: "HTML", size: 40000, color: LANG_COLORS.HTML },
    ],
    contributionDays: days,
  };
}

function level(count) {
  if (count <= 0) return 0;
  if (count <= 2) return 1;
  if (count <= 5) return 2;
  if (count <= 9) return 3;
  return 4;
}

const LEVEL_COLOR = ["#161B26", "#2b2f6b", "#3f3fa0", "#4c6fd6", "#2DD4BF"];

function buildHeatStrip(days, x0, y0, targetWidth, targetHeight) {
  const cols = Math.ceil(days.length / 7);
  const gap = 3;
  const cellByWidth = (targetWidth - gap * (cols - 1)) / cols;
  const cellByHeight = (targetHeight - gap * 6) / 7;
  const cell = Math.max(3, Math.min(cellByWidth, cellByHeight));
  const rects = [];
  for (let c = 0; c < cols; c++) {
    const colDelay = (0.9 * c) / cols;
    const colRects = [];
    for (let r = 0; r < 7; r++) {
      const idx = c * 7 + r;
      if (idx >= days.length) continue;
      const lvl = level(days[idx]);
      const x = x0 + c * (cell + gap);
      const y = y0 + r * (cell + gap);
      colRects.push(
        `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${cell}" height="${cell}" rx="1.5" fill="${LEVEL_COLOR[lvl]}"/>`
      );
    }
    rects.push(
      `<g opacity="0">${colRects.join("")}<animate attributeName="opacity" values="0;1" dur="0.4s" begin="${colDelay.toFixed(3)}s" fill="freeze"/></g>`
    );
  }
  const width = cols * (cell + gap);
  return { markup: rects.join(""), width, height: 7 * (cell + gap) };
}

function buildLangBar(topLangs, x0, y0, width) {
  const total = topLangs.reduce((s, l) => s + l.size, 0) || 1;
  let x = x0;
  const segs = [];
  const legend = [];
  topLangs.forEach((l, i) => {
    const w = (l.size / total) * width;
    segs.push(
      `<rect x="${x.toFixed(1)}" y="${y0}" width="0" height="8" fill="${l.color}">` +
        `<animate attributeName="width" values="0;${w.toFixed(1)}" dur="0.9s" begin="${(0.15 * i).toFixed(2)}s" fill="freeze"/>` +
        `</rect>`
    );
    x += w;
  });
  const legendY = y0 + 24;
  let lx = x0;
  topLangs.forEach((l, i) => {
    const pct = ((l.size / total) * 100).toFixed(0);
    const label = `${l.name} ${pct}%`;
    legend.push(
      `<circle cx="${lx + 4}" cy="${legendY}" r="4" fill="${l.color}"/>` +
        `<text x="${lx + 13}" y="${legendY + 4}" font-family="${FONT}" font-size="11" fill="${MUTED}">${label}</text>`
    );
    lx += 13 + label.length * 6.4 + 22;
  });
  return `<g><rect x="${x0}" y="${y0}" width="${width}" height="8" rx="4" fill="#161B26"/><clipPath id="langClip"><rect x="${x0}" y="${y0}" width="${width}" height="8" rx="4"/></clipPath><g clip-path="url(#langClip)">${segs.join("")}</g>${legend.join("")}</g>`;
}

function buildSVG(stats) {
  const W = 860;
  const stat = [
    { label: "PUBLIC REPOS", value: stats.totalRepos },
    { label: "TOTAL STARS", value: stats.totalStars },
    { label: "FOLLOWERS", value: stats.followers },
    { label: "CONTRIBUTIONS / YR", value: stats.totalContributions },
  ];
  const colW = W / 4;
  const statBlocks = stat
    .map((s, i) => {
      const cx = colW * i + colW / 2;
      const delay = 0.15 * i;
      return `
      <g text-anchor="middle">
        <text x="${cx}" y="46" font-family="${FONT}" font-size="30" font-weight="800" fill="${TEXT}" opacity="0">${s.value}
          <animate attributeName="opacity" values="0;0;1" keyTimes="0;0.1;1" dur="${(0.6 + delay).toFixed(2)}s" begin="${delay.toFixed(2)}s" fill="freeze"/>
        </text>
        <text x="${cx}" y="64" font-family="${FONT}" font-size="10" font-weight="600" letter-spacing="0.6" fill="${FAINT}">${s.label}</text>
        <rect x="${(cx - 16).toFixed(1)}" y="72" width="0" height="2" rx="1" fill="${i % 2 === 0 ? INDIGO : TEAL}">
          <animate attributeName="width" values="0;32" dur="0.5s" begin="${(delay + 0.3).toFixed(2)}s" fill="freeze"/>
        </rect>
      </g>`;
    })
    .join("");

  const heatY0 = 136;
  const heat = buildHeatStrip(stats.contributionDays, 20, heatY0, W - 40, 56);

  const langLabelY = heatY0 + heat.height + 34;
  const langBarY = langLabelY + 10;
  const langBar = buildLangBar(stats.topLangs, 20, langBarY, W - 40);
  const legendY = langBarY + 24;

  const height = Math.round(legendY + 24);

  return `<svg width="${W}" height="${height}" viewBox="0 0 ${W} ${height}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${W}" height="${height}" fill="${BG}"/>
  <rect x="0.5" y="0.5" width="${W - 1}" height="${height - 1}" fill="none" stroke="#ffffff" stroke-opacity="0.06" stroke-width="1"/>

  ${statBlocks}

  <line x1="20" y1="100" x2="${W - 20}" y2="100" stroke="#ffffff" stroke-opacity="0.06"/>

  <text x="20" y="126" font-family="${FONT}" font-size="10" font-weight="700" letter-spacing="1" fill="${FAINT}">CONTRIBUTIONS — LAST 12 MONTHS</text>
  ${heat.markup}

  <text x="20" y="${langLabelY}" font-family="${FONT}" font-size="10" font-weight="700" letter-spacing="1" fill="${FAINT}">LANGUAGE MIX</text>
  ${langBar}
</svg>
`;
}

async function main() {
  const stats = await getStats();
  const svg = buildSVG(stats);
  mkdirSync(OUT.split("/").slice(0, -1).join("/") || ".", { recursive: true });
  writeFileSync(OUT, svg);
  console.log(`wrote ${OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
