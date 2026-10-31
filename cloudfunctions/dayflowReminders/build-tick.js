const fs = require('node:fs');
const path = require('node:path');
function buildContents() {
  return Object.fromEntries(['jobs.js','repository.js','configuration.js'].map(name => [name, fs.readFileSync(path.join(__dirname, name), 'utf8')]));
}
if (require.main === module) {
  const directory = path.join(__dirname, '../dayflowReminderTick/shared');
  fs.mkdirSync(directory, { recursive: true });
  for (const [name, source] of Object.entries(buildContents())) fs.writeFileSync(path.join(directory, name), source, 'utf8');
  process.stdout.write('Reminder timer runtime rebuilt.\n');
}
module.exports = { buildContents };
