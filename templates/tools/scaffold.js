#!/usr/bin/env node
'use strict';
/*
 * Local dry-run of a Backstage software template.
 *
 * Renders template.yaml the way the Backstage scaffolder does (nunjucks with ${{ }} syntax,
 * parameter defaults, step `if` conditions, fetch:template / fetch:plain), writes the generated
 * project to an output directory, and prints what the publish / register steps would do.
 *
 *   node tools/scaffold.js <template-dir> <output-dir> '<parameters as JSON>'
 */
const fs = require('node:fs');
const path = require('node:path');
const nunjucks = require('nunjucks');
const yaml = require('js-yaml');

const [templateDir, outDir, paramsJson = '{}'] = process.argv.slice(2);
if (!templateDir || !outDir) {
  console.error("usage: scaffold.js <template-dir> <output-dir> '<parameters JSON>'");
  process.exit(2);
}

// ---- nunjucks configured like the Backstage scaffolder -------------------------------------

const env = new nunjucks.Environment(null, {
  autoescape: false,
  tags: { variableStart: '${{', variableEnd: '}}' },
});

// Built-in Backstage scaffolder filters used by templates.
env.addFilter('parseRepoUrl', (url) => {
  const u = new URL(`https://${url}`);
  const owner = u.searchParams.get('owner') || undefined;
  const repo = u.searchParams.get('repo') || undefined;
  return { host: u.host, owner, repo, organization: u.searchParams.get('organization') || undefined,
    workspace: u.searchParams.get('workspace') || undefined, project: u.searchParams.get('project') || undefined };
});
env.addFilter('projectSlug', (url) => {
  const u = new URL(`https://${url}`);
  return `${u.searchParams.get('owner')}/${u.searchParams.get('repo')}`;
});
env.addFilter('parseEntityRef', (ref, ctx = {}) => {
  const m = /^(?:([^:]+):)?(?:([^/]+)\/)?(.+)$/.exec(ref);
  return { kind: m[1] || ctx.defaultKind, namespace: m[2] || ctx.defaultNamespace || 'default', name: m[3] };
});
env.addFilter('pick', (obj, key) => (obj ? obj[key] : undefined));

const isSingleExpression = (s) => /^\s*\$\{\{(?:(?!\$\{\{|\}\}).)*\}\}\s*$/s.test(s);

function render(value, ctx) {
  if (typeof value === 'string') {
    const out = env.renderString(value, ctx);
    if (isSingleExpression(value)) { // Backstage keeps the type of a lone expression (bool, number, object)
      try { return JSON.parse(out); } catch { return out; }
    }
    return out;
  }
  if (Array.isArray(value)) return value.map((v) => render(v, ctx));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, render(v, ctx)]));
  }
  return value;
}

// ---- parameters: defaults, required fields, patterns ---------------------------------------

const template = yaml.load(fs.readFileSync(path.join(templateDir, 'template.yaml'), 'utf8'));
const params = JSON.parse(paramsJson);
const pages = [].concat(template.spec.parameters || []);
const errors = [];
const secrets = {};

function validate(section) {
  for (const [key, schema] of Object.entries(section.properties || {})) {
    if (params[key] === undefined && schema.default !== undefined) params[key] = schema.default;
    const v = params[key];
    if ((section.required || []).includes(key) && (v === undefined || v === '')) errors.push(`${key}: required`);
    if (schema['ui:field'] === 'Secret') {
      // Backstage's Secret field moves the value to the secrets context and masks the parameter.
      if (typeof v === 'string' && v !== '') {
        secrets[key] = v;
        params[key] = '*'.repeat(v.length);
      }
      continue;
    }
    if (typeof v === 'string' && v !== '' && schema.pattern && !new RegExp(schema.pattern).test(v)) {
      errors.push(`${key}: "${v}" does not match ${schema.pattern}`);
    }
    if (v !== undefined && schema.enum && !schema.enum.includes(v)) errors.push(`${key}: must be one of ${schema.enum.join(', ')}`);
  }
  // Conditional fields: apply the oneOf branch selected by the controlling parameter.
  for (const [key, dependency] of Object.entries(section.dependencies || {})) {
    const branch = (dependency.oneOf || []).find((b) => b.properties?.[key]?.enum?.includes(params[key]));
    if (branch) validate({ required: branch.required, properties: omit(branch.properties, key) });
  }
}
const omit = (obj, key) => Object.fromEntries(Object.entries(obj).filter(([k]) => k !== key));

pages.forEach(validate);
if (errors.length) {
  console.error(`Invalid parameters for ${template.metadata.name}:\n  ${errors.join('\n  ')}`);
  process.exit(1);
}

// ---- steps ---------------------------------------------------------------------------------

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));
}

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

console.log(`Template ${template.metadata.name}`);
console.log(`  parameters ${JSON.stringify(params)}`);
const steps = {};
for (const step of template.spec.steps) {
  const ctx = { parameters: params, secrets, steps };
  if (step.if !== undefined) {
    const cond = render(step.if, ctx);
    if (!cond || cond === 'false') { console.log(`  skip  ${step.id}`); continue; }
  }
  const input = render(step.input || {}, ctx);
  console.log(`  run   ${step.id} (${step.action})`);
  const target = path.join(outDir, input.targetPath || '.');

  switch (step.action) {
    case 'fetch:template': {
      const src = path.join(templateDir, input.url);
      for (const file of walk(src)) {
        const rel = env.renderString(path.relative(src, file), { values: input.values });
        if (!rel) continue; // Backstage skips files whose templated name renders empty
        const dest = path.join(target, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, env.renderString(fs.readFileSync(file, 'utf8'), { values: input.values }));
      }
      break;
    }
    case 'fetch:plain':
      fs.cpSync(path.join(templateDir, input.url), target, { recursive: true });
      break;
    case 'publish:github':
    case 'publish:gitlab': {
      const u = new URL(`https://${input.repoUrl}`);
      const web = `https://${u.host}/${u.searchParams.get('owner')}/${u.searchParams.get('repo')}`;
      steps[step.id] = { output: { remoteUrl: web, repoContentsUrl: `${web}/blob/${input.defaultBranch || 'main'}` } };
      console.log(`        would publish ${web} (${input.repoVisibility || 'default'} visibility)`);
      break;
    }
    case 'publish:github:pull-request': {
      const u = new URL(`https://${input.repoUrl}`);
      const web = `https://${u.host}/${u.searchParams.get('owner')}/${u.searchParams.get('repo')}`;
      steps[step.id] = { output: { remoteUrl: `${web}/pull/0` } };
      console.log(`        would open a pull request on ${web}: "${input.title}" (${input.branchName} -> ${input.targetPath || '/'})`);
      break;
    }
    case 'github:actions:dispatch':
      steps[step.id] = { output: { workflowRunHtmlUrl: 'https://github.com/example/runs/0' } };
      console.log(`        would start ${input.workflowId} on ${input.repoUrl} (${input.branchOrTagName}) with ${JSON.stringify(input.workflowInputs)}`);
      break;
    case 'github:environment:create':
      console.log(`        would set environment "${input.name}" on ${input.repoUrl}, secrets: ${Object.keys(input.secrets || {}).join(', ') || 'none'}`);
      break;
    case 'catalog:register':
      steps[step.id] = { output: { entityRef: `component:default/${params.name}` } };
      console.log(`        would register ${input.repoContentsUrl}${input.catalogInfoPath || '/catalog-info.yaml'}`);
      break;
    default:
      console.log(`        (action ${step.action} is not simulated)`);
  }
}

// ---- checks on the generated project -------------------------------------------------------

const leftovers = walk(outDir).filter((f) => !f.includes(`${path.sep}.github${path.sep}`))
  .filter((f) => /\$\{\{|\{%/.test(fs.readFileSync(f, 'utf8')) || /\$\{\{/.test(f));
if (leftovers.length) {
  console.error(`Unrendered template syntax left in:\n  ${leftovers.join('\n  ')}`);
  process.exit(1);
}
const leaks = walk(outDir).filter((f) => Object.values(secrets)
  .some((secret) => fs.readFileSync(f, 'utf8').includes(secret)));
if (leaks.length) {
  console.error(`Secret value written to generated files:\n  ${leaks.join('\n  ')}`);
  process.exit(1);
}
const catalogFile = path.join(outDir, 'catalog-info.yaml');
if (fs.existsSync(catalogFile)) {
  const entity = yaml.load(fs.readFileSync(catalogFile, 'utf8'));
  for (const f of ['apiVersion', 'kind', 'metadata', 'spec']) {
    if (!entity[f]) { console.error(`catalog-info.yaml is missing ${f}`); process.exit(1); }
  }
}
console.log(`  output ${JSON.stringify(render(template.spec.output || {}, { parameters: params, steps }))}`);
console.log(`Generated ${outDir}`);
