const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const project = path.resolve(__dirname, '../..');
const header = '// Generated from shared pure validation sources. Rebuild with node cloudfunctions/dayflowSync/build-validation.js\n';
function compile(source, filename) {
  return header + ts.transpileModule(source, {
    fileName: filename,
    compilerOptions: { target: ts.ScriptTarget.ES2018, module: ts.ModuleKind.CommonJS, newLine: ts.NewLineKind.LineFeed }
  }).outputText;
}
function buildContents() {
  const result = {};
  for (const name of ['plan-validation', 'record-validation']) {
    const filename = path.join(project, 'miniprogram/utils', name + '.ts');
    result[name + '.js'] = compile(fs.readFileSync(filename, 'utf8'), filename);
  }
  result['calendar.js'] = header + fs.readFileSync(path.join(project, 'miniprogram/utils/calendar.js'), 'utf8');
  // Only these pure declarations are bundled, never the wx storage/permission
  // service functions. The generated module has no wx or client-service imports.
  const filename = path.join(project, 'miniprogram/services/preferences.ts');
  const text = fs.readFileSync(filename, 'utf8');
  const source = ts.createSourceFile(filename, text, ts.ScriptTarget.ES2018, true);
  const names = new Set(['defaults', 'copy', 'invalid', 'validatePreferences']);
  const fragments = ["import { minutesOf } from './calendar';"];
  const found = new Set();
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && names.has(statement.name.text)) {
      fragments.push(statement.getText(source)); found.add(statement.name.text);
    } else if (ts.isVariableStatement(statement)) {
      const declarations = statement.declarationList.declarations;
      if (declarations.length === 1 && ts.isIdentifier(declarations[0].name) && names.has(declarations[0].name.text)) {
        fragments.push(statement.getText(source)); found.add(declarations[0].name.text);
      }
    }
  }
  if (found.size !== names.size) throw new Error('Shared preferences validator declarations changed; update the bundler explicitly');
  result['preferences-validation.js'] = compile(fragments.join('\n'), filename);
  if (/\bwx\./.test(result['preferences-validation.js'])) throw new Error('Cloud validators must not reference wx services');
  for (const spec of [
    { service: 'plans', output: 'instance-validation', names: ['object', 'assertDate', 'validateInstances'], imports: "import { parseLocalDate, minutesOf } from './calendar';\nimport { validatePlan } from './plan-validation';" },
    { service: 'media', output: 'media-validation', names: ['validatePhotos'], imports: "import { parseLocalDate } from './calendar';" }
  ]) {
    const file = path.join(project, 'miniprogram/services', spec.service + '.ts');
    const parsed = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.ES2018, true);
    const declarations = [spec.imports]; const foundNames = new Set();
    for (const statement of parsed.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name && spec.names.includes(statement.name.text)) {
        declarations.push(statement.getText(parsed)); foundNames.add(statement.name.text);
      } else if (ts.isVariableStatement(statement) && statement.declarationList.declarations.length === 1) {
        const name = statement.declarationList.declarations[0].name;
        if (ts.isIdentifier(name) && spec.names.includes(name.text)) { declarations.push(statement.getText(parsed)); foundNames.add(name.text); }
      }
    }
    if (foundNames.size !== spec.names.length) throw new Error('Shared pure validator declarations changed: ' + spec.service);
    result[spec.output + '.js'] = compile(declarations.join('\n'), file);
    if (/\bwx\./.test(result[spec.output + '.js'])) throw new Error('Cloud validators must not reference wx services');
  }
  return result;
}
if (require.main === module) {
  const target = path.join(__dirname, 'shared');
  fs.mkdirSync(target, { recursive: true });
  for (const [name, content] of Object.entries(buildContents())) fs.writeFileSync(path.join(target, name), content, 'utf8');
  process.stdout.write('Cloud pure validators rebuilt.\n');
}
module.exports = { buildContents };
