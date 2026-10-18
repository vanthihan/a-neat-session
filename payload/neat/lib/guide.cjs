'use strict';

// Short procedures the orchestrator prints on demand (`neat guide <topic>`),
// so the main command file stays small. Each topic is a markdown file in
// ../guides; `{{NEAT_BIN}}` becomes the running helper's path at print time.

const fs = require('node:fs');
const path = require('node:path');
const { UsageError } = require('./cli-args.cjs');

const GUIDES_DIR = path.resolve(__dirname, '..', 'guides');
const TOPIC = /^[a-z]+$/;
const PLACEHOLDER = /\{\{NEAT_BIN\}\}/g;

// Sorted topic names: basenames of the `*.md` files whose name is lowercase letters.
function listTopics(dir = GUIDES_DIR) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.slice(0, -'.md'.length))
    .filter((t) => TOPIC.test(t))
    .sort();
}

function topicError(topics) {
  return new UsageError(`usage: neat guide <topic> (topics: ${topics.join(', ') || 'none'})`);
}

// Guide text for `topic` with every `{{NEAT_BIN}}` replaced by `helper`.
// The topic is checked against the listed topics before any path is built.
function guideText(topic, helper, dir = GUIDES_DIR) {
  const topics = listTopics(dir);
  if (typeof topic !== 'string' || !topics.includes(topic)) throw topicError(topics);
  const text = fs.readFileSync(path.join(dir, `${topic}.md`), 'utf8');
  return text.replace(PLACEHOLDER, () => helper);
}

module.exports = { listTopics, guideText, topicError };
