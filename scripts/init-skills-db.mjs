#!/usr/bin/env node
/**
 * Initialize the skills.db for a plugin repository.
 * Creates schema and seeds skill inventory from the filesystem.
 *
 * Usage: node scripts/init-skills-db.mjs [--plugin-name heathdev-workshop]
 *
 * Uses Node 24 native SQLite (experimental but zero-dependency).
 */

import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');

// Parse args
const args = process.argv.slice(2);
const pluginNameIdx = args.indexOf('--plugin-name');
const pluginName = pluginNameIdx >= 0 ? args[pluginNameIdx + 1] : 'heathdev-workshop';

const dbPath = join(projectRoot, 'skills.db');
const db = new DatabaseSync(dbPath);

// Enable WAL mode for better concurrent read performance
db.exec('PRAGMA journal_mode=WAL;');

// Schema v1
db.exec(`
  CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS skills (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    plugin TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'skill',  -- skill | command | agent
    tier INTEGER,                         -- 1=standard, 2=methodology, 3=personal
    status TEXT NOT NULL DEFAULT 'active', -- active | archived | deprecated
    description TEXT,
    created_at TEXT,
    updated_at TEXT
  );

  CREATE TABLE IF NOT EXISTS assessments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    skill_id TEXT NOT NULL REFERENCES skills(id),
    assessed_at TEXT NOT NULL,
    -- Scores (1-5)
    output_quality INTEGER,
    description_quality INTEGER,
    composability INTEGER,
    agent_readiness INTEGER,
    eval_coverage INTEGER,         -- 0=none, 1=manual, 3=partial, 5=automated
    usage_frequency INTEGER,       -- 1=never, 2=rare, 3=monthly, 4=weekly, 5=daily
    karpathy_eligible INTEGER DEFAULT 0, -- 0=no, 1=yes (has measurable metric)
    -- Freeform
    notes TEXT,
    gaps TEXT,                     -- JSON array
    next_actions TEXT              -- JSON array
  );

  CREATE TABLE IF NOT EXISTS eval_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    skill_id TEXT NOT NULL REFERENCES skills(id),
    run_at TEXT NOT NULL,
    metric_name TEXT,
    metric_before REAL,
    metric_after REAL,
    delta REAL,                    -- computed: after - before
    iterations INTEGER,
    duration_seconds INTEGER,
    model TEXT,                    -- which model ran the loop
    notes TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_assessments_skill ON assessments(skill_id, assessed_at);
  CREATE INDEX IF NOT EXISTS idx_eval_runs_skill ON eval_runs(skill_id, run_at);
`);

// Record schema version
const existingVersion = db.prepare('SELECT MAX(version) as v FROM schema_version').get();
if (!existingVersion?.v) {
  db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(1, new Date().toISOString());
  console.log('Schema v1 applied.');
} else {
  console.log(`Schema v${existingVersion.v} already exists.`);
}

// Discover skills from filesystem
function extractFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const fm = {};
  for (const line of match[1].split('\n')) {
    const [key, ...rest] = line.split(':');
    if (key && rest.length) {
      fm[key.trim()] = rest.join(':').trim().replace(/^["']|["']$/g, '');
    }
  }
  return fm;
}

function discoverSkills(skillsDir, kind = 'skill') {
  if (!existsSync(skillsDir)) return [];
  const items = [];
  for (const entry of readdirSync(skillsDir)) {
    if (entry.startsWith('.')) continue; // skip .archive
    const entryPath = join(skillsDir, entry);
    if (!statSync(entryPath).isDirectory()) continue;

    // Look for SKILL.md or the md file
    const skillFile = join(entryPath, 'SKILL.md');
    if (existsSync(skillFile)) {
      const content = readFileSync(skillFile, 'utf-8');
      const fm = extractFrontmatter(content);
      items.push({
        id: fm.name || entry,
        name: fm.name || entry,
        kind,
        description: fm.description || null,
      });
    }
  }
  return items;
}

function discoverFlatMdFiles(dir, kind) {
  if (!existsSync(dir)) return [];
  const items = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.md')) continue;
    const content = readFileSync(join(dir, entry), 'utf-8');
    const fm = extractFrontmatter(content);
    const id = fm.name || entry.replace('.md', '');
    items.push({
      id,
      name: fm.name || id,
      kind,
      description: fm.description || null,
    });
  }
  return items;
}

// Seed skills
const insert = db.prepare(`
  INSERT OR IGNORE INTO skills (id, name, plugin, kind, description, status, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
`);

const now = new Date().toISOString();
let seeded = 0;

// Skills live in skills/<name>/SKILL.md
const skills = discoverSkills(join(projectRoot, 'skills'));
for (const s of skills) {
  insert.run(s.id, s.name, pluginName, s.kind, s.description, now, now);
  seeded++;
}

// Optional: flat-file agents in agents/<category>/<name>.md (none by default).
for (const category of ['general', 'dotnet', 'quality']) {
  const agents = discoverFlatMdFiles(join(projectRoot, 'agents', category), 'agent');
  for (const s of agents) {
    s.id = `agent:${category}:${s.id}`;
    insert.run(s.id, s.name, pluginName, s.kind, s.description, now, now);
    seeded++;
  }
}

console.log(`Seeded ${seeded} items into ${dbPath}`);

// Print inventory
const all = db.prepare('SELECT id, kind, status FROM skills ORDER BY kind, id').all();
console.log('\nInventory:');
for (const row of all) {
  console.log(`  [${row.kind}] ${row.id} (${row.status})`);
}

db.close();
