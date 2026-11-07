// Least privilege for the Pages publication (idb-vector-yfdc). The job that runs `npm ci` executes
// third-party install scripts and the research build runs project scripts, so a compromise there must
// not inherit the ability to publish to Pages or mint a Pages OIDC token. That only holds while the
// deploy grants live on a separate, artifact-only job; the split is easy to undo by pasting
// `pages: write` back onto the build job, so it is pinned here. The other half of the same compromise
// is pinned here too: which bytes that job stages (idb-vector-5yqb), i.e. that the published tree
// comes from the commit rather than from the worktree those scripts ran in.
//
// Text-level on purpose: the fast tier has no YAML parser and this must cost nothing.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync(new URL('../../.github/workflows/pages.yml', import.meta.url), 'utf8');

// The jobs under `jobs:` keyed by name, each value the job's own lines. A job key is a two-space
// indented `name:` line inside the jobs block; everything deeper belongs to that job.
function jobBlocks(yaml) {
  const lines = yaml.split('\n');
  const jobsAt = lines.findIndex(line => /^jobs:\s*$/.test(line));
  assert.notEqual(jobsAt, -1, 'pages.yml must declare a jobs: block');
  const jobs = new Map();
  let current = null;
  for (const line of lines.slice(jobsAt + 1)) {
    const key = /^ {2}([A-Za-z][\w-]*):\s*$/.exec(line);
    if (key) {
      current = { name: key[1], lines: [] };
      jobs.set(current.name, current.lines);
    } else if (current && line.trim() !== '') {
      current.lines.push(line);
    }
  }
  return new Map([...jobs].map(([name, body]) => [name, body.join('\n')]));
}

const jobs = jobBlocks(workflow);
const deployGrantNames = ['pages: write', 'id-token: write'];
// Everything above `jobs:` is the workflow-level scope every job inherits unless it overrides it.
const workflowScope = workflow.slice(0, workflow.indexOf('\njobs:'));

test('the job that installs and builds holds no Pages or OIDC capability', () => {
  const buildJob = [...jobs].find(([, body]) => /\bnpm ci\b/.test(body));
  assert.ok(buildJob, 'some job must still run npm ci');
  const [buildName, buildBody] = buildJob;
  assert.match(buildBody, /\bnpm run build:research\b/, 'the research build stays in the installing job');
  for (const grant of deployGrantNames) {
    assert.doesNotMatch(buildBody, new RegExp(grant), `job "${buildName}" runs npm ci and must not carry ${grant}`);
    assert.doesNotMatch(workflowScope, new RegExp(grant), `the workflow-level permissions block is inherited by "${buildName}" and must not carry ${grant}`);
  }
  assert.doesNotMatch(buildBody, /^\s*permissions:/m, `job "${buildName}" needs no permissions override at all; contents: read is already the workflow default`);
  assert.doesNotMatch(buildBody, /actions\/deploy-pages/, 'the installing job must not publish');
  assert.doesNotMatch(buildBody, /github-pages/, 'the installing job must not join the publication environment');
});

test('deployment is a separate artifact-only job that needs the build', () => {
  assert.deepEqual([...jobs.keys()], ['build', 'deploy'], 'the publication path is exactly a build job and a deploy job');
  const build = jobs.get('build');
  const deploy = jobs.get('deploy');
  assert.match(build, /actions\/upload-pages-artifact/, 'the build job hands the site over as an artifact');
  assert.match(deploy, /actions\/deploy-pages/, 'the deploy job publishes that artifact and nothing else');
  assert.doesNotMatch(deploy, /\bnpm (ci|run)\b/, 'the deploy job runs no project or dependency script');
  assert.match(deploy, /^ {4}needs: build$/m, 'the deploy job must wait for the build job');
  for (const grant of deployGrantNames) {
    assert.match(deploy, new RegExp(`permissions:[\\s\\S]*\\n {6}${grant}`, 'm'), `the deploy job carries ${grant}`);
  }
  // actions/deploy-pages requires the github-pages environment; its page_url comes from the deploy step.
  assert.match(deploy, /environment:[\s\S]*name: github-pages/, 'the deploy job publishes through the github-pages environment');
  assert.match(deploy, /url: \$\{\{ steps\.deployment\.outputs\.page_url \}\}/, 'the environment URL is the live page URL');
  assert.match(deploy, /id: deployment[\s\S]*actions\/deploy-pages/, 'the deploy step is still id: deployment');
});

// Provenance of the published bytes (idb-vector-5yqb). demo/integrity.js and demo/README.md pin the
// page's own HTML/CSS/JS to "the repository commit that ships this code", and every published path is
// tracked in that commit - research/index.html included, since the build has to reproduce its
// committed bytes. The build job runs third-party install scripts in the worktree it used to stage
// from, so staging there would publish whatever a postinstall (or a build step) wrote, under the
// commit's trust root. The staging step must therefore take its bytes from the commit, out of a tree
// extracted after the install and the build, so a write to demo/ during either reaches a file nothing
// publishes.
test('the site is staged from the published commit, not from the worktree the install scripts ran in', () => {
  const build = [...jobs].find(([, body]) => /\bnpm ci\b/.test(body));
  assert.ok(build, 'some job must still run npm ci');
  const [buildName, buildBody] = build;
  const position = (pattern, step) => {
    const match = pattern.exec(buildBody);
    assert.ok(match, `job "${buildName}": ${step} must appear in the publication build, matching ${pattern}`);
    return match.index;
  };
  // Ordering is the property: the install and the research build are the steps that write into the
  // worktree, and the extraction is what makes their writes unpublishable, so it comes after both.
  // The research check comes after the build it checks and before the staging that publishes the
  // committed page, which is why the generated page and the published page cannot drift apart.
  const install = position(/\bnpm ci\b/, 'the install step');
  const researchBuild = position(/\bnpm run build:research\b/, 'the research build step');
  const researchCheck = position(/git diff --exit-code -- research\/index\.html/, 'the check that the built research page matches its committed bytes');
  const extract = position(/git archive "\$GITHUB_SHA" \| tar -x -C \.site-src/, 'the extraction of the published commit');
  const stage = position(/\(cd \.site-src && node tools\/stage-site\.mjs \.\.\/site\)/, 'the staging step, run inside the extracted commit');
  assert.deepEqual(
    [['npm ci', install], ['npm run build:research', researchBuild], ['the research diff check', researchCheck], ['the commit extraction', extract], ['the staging step', stage]]
      .sort(([, left], [, right]) => left - right).map(([step]) => step),
    ['npm ci', 'npm run build:research', 'the research diff check', 'the commit extraction', 'the staging step'],
    `job "${buildName}" must install, build, check the built research page, then extract the commit and stage from it, in that order`,
  );
  // One staging path, sourced from the extraction: a second `node tools/stage-site.mjs …` would stage
  // the worktree again, and demo/ must never be copied by hand out of it either.
  assert.equal(buildBody.match(/node tools\/stage-site\.mjs/g)?.length, 1, `job "${buildName}" must run the stager exactly once, from the extracted commit`);
  assert.doesNotMatch(buildBody, /cp -r (?:\.\/)?demo\b/, `job "${buildName}" must not copy demo/ out of the worktree; the stager copies it from the extracted commit`);
  // research/ ships from the extraction too: its index.html is generated, but the diff check above has
  // already held the generated page to the committed bytes at this point in the job.
  assert.match(buildBody, /cp -r \.site-src\/research site\/research/, `job "${buildName}" must publish research/ from the extracted commit`);
  assert.doesNotMatch(buildBody, /cp -r research site\/research/, `job "${buildName}" must not copy research/ out of the worktree`);
  // The artifact root is still `site`, so the published URLs do not move and the redirect stub is
  // written into the same tree the stager filled.
  assert.match(buildBody, /^ {10}path: site$/m, `job "${buildName}" uploads the staged site as the artifact root`);
  assert.match(buildBody, /> site\/index\.html$/m, 'the redirect stub is still written at the artifact root');
});

// The staging roots are plain worktree paths, so the install and build steps above can write into
// them, and the extraction does not contain that: `tar -x` only overlays a tree it did not create,
// and the artifact upload publishes `site` whole (idb-vector-5yqb review). A postinstall that
// created `.site-src/demo/preseed.js` or `site/preseed.html` used to publish both - the same trust
// boundary broken one level sideways, by writing into the staging directory instead of mutating a
// tracked file. The staging step must therefore delete both roots before it writes anything, which
// is what this pins: the delete is the step's first executed line, ahead of the extraction that
// overlays and the stager that fills `site`.
test('the staging step deletes both staging roots before it writes into them (idb-vector-5yqb review)', () => {
  const build = [...jobs].find(([, body]) => /\bnpm ci\b/.test(body));
  assert.ok(build, 'some job must still run npm ci');
  const [buildName, buildBody] = build;
  const stepAt = buildBody.indexOf('- name: Stage public demo');
  assert.notEqual(stepAt, -1, `job "${buildName}": the staging step must be identified by name`);
  const nextStepAt = buildBody.indexOf('\n      - ', stepAt + 1);
  const step = buildBody.slice(stepAt, nextStepAt === -1 ? buildBody.length : nextStepAt);
  // The `run: |` block's content is the lines indented past the step's own keys; comments are prose,
  // so only the executed lines are compared.
  const commands = step.split('\n')
    .filter(line => line.startsWith('          '))
    .map(line => line.trim())
    .filter(line => line !== '' && !line.startsWith('#'));
  assert.equal(commands[0], 'set -o pipefail', `job "${buildName}": the staging step still fails when a stage of the pipeline fails`);
  // Shell options are not writes; the first real command is the delete of both roots, so nothing can
  // create or fill a staging root before it is gone.
  const firstWrite = commands.findIndex(command => !command.startsWith('set '));
  assert.equal(commands[firstWrite], 'rm -rf .site-src site',
    `job "${buildName}" must delete .site-src and site before staging: the install and build steps can create files there, the extraction only overlays and the upload publishes site whole, so a pre-seeded file would ship (idb-vector-5yqb review)`);
  const extract = commands.findIndex(command => command.startsWith('git archive "$GITHUB_SHA"'));
  const stage = commands.findIndex(command => command.startsWith('(cd .site-src && node tools/stage-site.mjs'));
  assert.notEqual(extract, -1, `job "${buildName}" still extracts the published commit before staging`);
  assert.notEqual(stage, -1, `job "${buildName}" still stages from the extracted commit`);
  assert.ok(extract > firstWrite && stage > extract, `job "${buildName}" must clean the roots, then extract the commit, then stage`);
});

test('the publication triggers and concurrency are unchanged', () => {
  assert.match(workflowScope, /^on:[\s\S]*push:[\s\S]*branches: \[main\]/m, 'main still publishes');
  assert.match(workflowScope, /^ {2}workflow_dispatch:/m, 'manual dispatch still publishes');
  assert.match(workflowScope, /^concurrency:[\s\S]*group: pages[\s\S]*cancel-in-progress: true/m, 'one publication at a time');
});
