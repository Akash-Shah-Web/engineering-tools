// Builds the single self-contained loopforge/index.html from src/ and data/samples/.
// Usage: node tools/build.js
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const rd = p => fs.readFileSync(path.join(root, p), 'utf8');

const REC = [
  ['validation_experiment_env_2_step_50_run_1.csv', 'run1', 'Step 0→50 % · run 1', 'step run 1', 'step'],
  ['validation_experiment_env_2_step_50_run_2.csv', 'run2', 'Step 0→50 % · run 2', 'step run 2', 'step'],
  ['validation_experiment_env_2_step_50_run_3.csv', 'run3', 'Step 0→50 % · run 3', 'step run 3', 'step'],
  ['validation_experiment_env_2_sin_5_50_run_1.csv', 'sin300', 'Sine, 300 s period', 'sine 300 s', 'sine 300 s'],
  ['validation_experiment_env_2_sin_2_50_run_1.csv', 'sin120', 'Sine, 120 s period', 'sine 120 s', 'sine 120 s'],
  ['validation_experiment_env_2_sin_50_50_run_1.csv', 'sin30', 'Sine, 30 s period', 'sine 30 s', 'sine 30 s'],
];
const data = {
  tclab: REC.map(([file, id, name, short, input]) => ({
    id, name, short, input, file,
    desc: `Measured TCLab (heater Q1 → T1), ${name}. dowlinglab/pyomo-doe data/${file} @ d250c5b.`,
    csv: rd('data/samples/' + file).split('\n').map(l => l.split(',').slice(0, 5).join(',')).join('\n'),
  })),
  license: rd('data/samples/LICENSE-pyomo-doe.txt'),
};
const js = ['src/core.js', 'src/codegen.js', 'src/ui/plot.js', 'src/ui/app.js'].map(p => `/* ---- ${p} ---- */\n` + rd(p)).join('\n');
let html = rd('src/ui/template.html');
const guard = s => s.replace(/<\/script/gi, '<\\/script');
html = html.replace('/*@CSS@*/', () => rd('src/ui/style.css'))
  .replace('/*@DATA@*/', () => 'window.LF_DATA = ' + guard(JSON.stringify(data)) + ';')
  .replace('/*@JS@*/', () => guard(js));
fs.writeFileSync(path.join(root, 'index.html'), html);
console.log(`index.html written: ${(html.length / 1024).toFixed(0)} KiB`);
